#!/usr/bin/env python3
"""Surveillance de pages web.

Lit urls.json, récupère chaque page, extrait le texte (ou la zone d'un
sélecteur CSS), le compare au dernier état enregistré dans data/, garde
un historique des modifications, met à jour data/status.json et envoie
une issue GitHub pour chaque modification.
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
ISSUE_MAX_CHARS = 20000
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


class GitHubIssues:
    """Ouvre une issue GitHub par page modifiée (ou commente l'issue encore ouverte)."""

    LABEL = "veille"

    def __init__(self) -> None:
        self.token = os.environ.get("GITHUB_TOKEN", "").strip()
        self.repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
        self.api = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
        self.owner = os.environ.get("GITHUB_REPOSITORY_OWNER", "").strip()
        self._open: list[dict] | None = None
        self.enabled = bool(self.token and self.repo)

    def _req(self, method: str, path: str, **kw):
        r = requests.request(
            method, f"{self.api}/repos/{self.repo}{path}", timeout=20,
            headers={"Authorization": f"Bearer {self.token}",
                     "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28"}, **kw)
        return r

    def _open_issues(self) -> list[dict]:
        if self._open is None:
            # Crée l'étiquette si besoin (422 = elle existe déjà).
            self._req("POST", "/labels", json={"name": self.LABEL, "color": "2456d6",
                                               "description": "Modification détectée par la veille"})
            r = self._req("GET", "/issues", params={"labels": self.LABEL, "state": "open",
                                                     "per_page": 100})
            r.raise_for_status()
            self._open = r.json()
        return self._open

    def notify(self, entry: dict, pid: str, diff: str, when: str) -> None:
        if not self.enabled:
            print("  (GITHUB_TOKEN absent : pas d'issue créée)")
            return
        added, removed = diff_counts(diff)
        marker = f"<!-- veille:{pid} -->"
        shown = diff[:ISSUE_MAX_CHARS] + ("\n…" if len(diff) > ISSUE_MAX_CHARS else "")
        date = datetime.fromisoformat(when).strftime("%d/%m/%Y %H:%M UTC")
        links = [f"[Ouvrir la page]({entry['url']})"]
        dashboard = pages_url()
        if dashboard:
            links.append(f"[Tableau de bord]({dashboard})")
        fence = "`" * max(3, max((len(m) for m in re.findall(r"`+", shown)), default=0) + 1)
        body = (f"**{date}** · +{added} / −{removed} lignes · " + " · ".join(links)
                + f"\n\n{fence}diff\n{shown}\n{fence}")
        try:
            existing = next((i for i in self._open_issues()
                             if marker in (i.get("body") or "")), None)
            if existing:
                r = self._req("POST", f"/issues/{existing['number']}/comments", json={"body": body})
                r.raise_for_status()
                print(f"  commentaire ajouté à l'issue #{existing['number']}")
            else:
                mention = f"\n\n@{self.owner}" if self.owner else ""
                r = self._req("POST", "/issues", json={
                    "title": f"Modifié : {entry['name']}",
                    "body": f"{marker}\n{body}{mention}\n\n"
                            "_Fermez cette issue une fois lue : la prochaine modification "
                            "en ouvrira une nouvelle (sinon elle sera ajoutée en commentaire)._",
                    "labels": [self.LABEL],
                })
                r.raise_for_status()
                self._open.append(r.json())
                print(f"  issue #{r.json()['number']} créée")
        except requests.RequestException as exc:
            print(f"  ! création de l'issue échouée : {exc}")


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
    issues = GitHubIssues()

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
            issues.notify(entry, pid, diff, run_at)
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
