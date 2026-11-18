#!/usr/bin/env python3
"""Surveillance de pages web.

Lit urls.json, récupère chaque page, extrait le texte (ou la zone d'un
sélecteur CSS), le compare au dernier état enregistré dans data/, garde
un historique des modifications, met à jour data/status.json et envoie
une notification ntfy.sh pour chaque modification.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
URLS_FILE = ROOT / "urls.json"
DATA = ROOT / "data"
SNAPSHOTS = DATA / "snapshots"
HISTORY = DATA / "history"
STATUS_FILE = DATA / "status.json"

HISTORY_MAX = 100          # entrées gardées par page
PREVIEW_MAX_LINES = 40     # lignes de diff dans status.json
PREVIEW_MAX_CHARS = 4000
NTFY_MAX_CHARS = 1500
TIMEOUT = 30
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36 veille-web"
)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def page_id(entry: dict) -> str:
    key = entry["url"].strip() + "\n" + (entry.get("selector") or "").strip()
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize(text: str) -> str:
    lines = (re.sub(r"\s+", " ", line).strip() for line in text.splitlines())
    return "\n".join(line for line in lines if line)


def fetch_text(url: str, selector: str | None) -> str:
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.content, "html.parser")
    for tag in soup(["script", "style", "noscript", "template", "svg"]):
        tag.decompose()
    if selector:
        nodes = soup.select(selector)
        if not nodes:
            raise ValueError(f"Sélecteur introuvable : {selector}")
        text = "\n".join(n.get_text("\n") for n in nodes)
    else:
        text = (soup.body or soup).get_text("\n")
    return normalize(text)


def make_diff(old: str, new: str) -> str:
    lines = difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=1)
    # On retire les en-têtes « --- / +++ ».
    return "\n".join(l for l in lines if not l.startswith(("---", "+++")))


def preview(diff: str) -> str:
    lines = diff.splitlines()
    out = "\n".join(lines[:PREVIEW_MAX_LINES])[:PREVIEW_MAX_CHARS]
    if len(lines) > PREVIEW_MAX_LINES or len(out) < len("\n".join(lines)):
        out += "\n…"
    return out


def diff_counts(diff: str) -> tuple[int, int]:
    added = sum(1 for l in diff.splitlines() if l.startswith("+"))
    removed = sum(1 for l in diff.splitlines() if l.startswith("-"))
    return added, removed


def pages_url() -> str | None:
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not repo or "/" not in repo:
        return None
    owner, name = repo.split("/", 1)
    if name.lower() == f"{owner.lower()}.github.io":
        return f"https://{owner.lower()}.github.io/"
    return f"https://{owner.lower()}.github.io/{name}/"


def notify(entry: dict, diff: str) -> None:
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic:
        print("  (NTFY_TOPIC absent : pas de notification)")
        return
    server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    added, removed = diff_counts(diff)
    body = diff[:NTFY_MAX_CHARS] + ("\n…" if len(diff) > NTFY_MAX_CHARS else "")
    payload = {
        "topic": topic,
        "title": f"Modifié : {entry['name']}",
        "message": f"+{added} / −{removed} lignes\n\n{body}",
        "tags": ["mag"],
        "click": entry["url"],
        "actions": [{"action": "view", "label": "Ouvrir la page", "url": entry["url"]}],
    }
    dashboard = pages_url()
    if dashboard:
        payload["actions"].append({"action": "view", "label": "Tableau de bord", "url": dashboard})
    try:
        r = requests.post(server, json=payload, timeout=15)
        r.raise_for_status()
    except requests.RequestException as exc:
        print(f"  ! notification ntfy échouée : {exc}")


def main() -> int:
    entries = load_json(URLS_FILE, [])
    if not isinstance(entries, list):
        print("urls.json doit contenir une liste", file=sys.stderr)
        return 1

    status = load_json(STATUS_FILE, {})
    old_pages = status.get("pages", {})
    new_pages: dict[str, dict] = {}
    run_at = now_iso()
    changes = 0

    for entry in entries:
        if not entry.get("url"):
            continue
        entry.setdefault("name", entry["url"])
        pid = page_id(entry)
        selector = (entry.get("selector") or "").strip() or None
        snap_file = SNAPSHOTS / f"{pid}.txt"
        hist_file = HISTORY / f"{pid}.json"

        st = dict(old_pages.get(pid, {}))
        st.update({"name": entry["name"], "url": entry["url"], "selector": selector,
                   "last_check": run_at})
        print(f"- {entry['name']} ({entry['url']})")

        try:
            text = fetch_text(entry["url"], selector)
        except Exception as exc:  # noqa: BLE001
            st["error"] = str(exc)[:300]
            st["error_since"] = st.get("error_since") or run_at
            print(f"  ! erreur : {st['error']}")
            new_pages[pid] = st
            continue

        st.pop("error", None)
        st.pop("error_since", None)
        st["last_success"] = run_at
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()

        if not snap_file.exists():
            snap_file.parent.mkdir(parents=True, exist_ok=True)
            snap_file.write_text(text, encoding="utf-8")
            st.update({"hash": digest, "first_seen": run_at, "last_change": None,
                       "diff": None, "length": len(text)})
            print("  état initial enregistré")
        elif digest != st.get("hash") or snap_file.read_text(encoding="utf-8") != text:
            old = snap_file.read_text(encoding="utf-8")
            diff = make_diff(old, text)
            snap_file.write_text(text, encoding="utf-8")
            added, removed = diff_counts(diff)
            history = load_json(hist_file, [])
            history.insert(0, {"date": run_at, "added": added, "removed": removed, "diff": diff})
            save_json(hist_file, history[:HISTORY_MAX])
            st.update({"hash": digest, "last_change": run_at, "diff": preview(diff),
                       "added": added, "removed": removed, "length": len(text),
                       "changes": st.get("changes", 0) + 1})
            changes += 1
            print(f"  MODIFIÉ (+{added} / -{removed})")
            notify(entry, diff)
        else:
            st["hash"] = digest
            print("  inchangé")

        new_pages[pid] = st

    # Nettoyage des pages retirées de urls.json.
    for pid in set(old_pages) - set(new_pages):
        for f in (SNAPSHOTS / f"{pid}.txt", HISTORY / f"{pid}.json"):
            f.unlink(missing_ok=True)

    save_json(STATUS_FILE, {"last_run": run_at, "count": len(new_pages),
                            "changes_last_run": changes, "pages": new_pages})
    print(f"Terminé : {len(new_pages)} page(s), {changes} modification(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
