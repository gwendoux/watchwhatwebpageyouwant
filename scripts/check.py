#!/usr/bin/env python3
"""Surveillance de pages web.

Lit urls.json, récupère chaque page, extrait le texte (ou la zone d'un
sélecteur CSS), le compare au dernier état enregistré dans data/, garde
un historique des modifications, met à jour data/status.json et envoie
une notification Web Push pour chaque modification.
"""

from __future__ import annotations

import difflib
import hashlib
import ipaddress
import json
import os
import re
import secrets
import socket
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

import webpush

ROOT = Path(__file__).resolve().parent.parent
URLS_FILE = ROOT / "urls.json"
DATA = ROOT / "data"
SNAPSHOTS = DATA / "snapshots"
HISTORY = DATA / "history"
STATUS_FILE = DATA / "status.json"

HISTORY_MAX = 100  # entrées gardées par page
HISTORY_DIFF_MAX = 50_000  # caractères de diff gardés par entrée
PREVIEW_MAX_LINES = 40  # lignes de diff dans status.json
PREVIEW_MAX_CHARS = 4_000
NOTIF_MAX_CHARS = 180
MAX_BYTES = 5 * 1024 * 1024  # taille maximale d'une page téléchargée
MAX_REDIRECTS = 5
MAX_WORKERS = 8
TIMEOUT = (10, 30)  # (connexion, lecture) en secondes
MAX_NAME, MAX_URL, MAX_SELECTOR = 200, 2_000, 500
ALLOWED_TYPES = ("text/html", "application/xhtml+xml", "text/plain", "application/xml", "text/xml")
USER_AGENT = "Mozilla/5.0 (compatible; veille-web/2.0; +https://github.com/)"


class FetchError(Exception):
    """Erreur affichable telle quelle dans l'interface."""


# ---------------------------------------------------------------- utilitaires


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def short_id(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8"), usedforsecurity=False).hexdigest()[:12]


def page_id(url: str, selector: str | None) -> str:
    return short_id(url.strip() + "\n" + (selector or "").strip())


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_atomic(path: Path, text: str) -> None:
    """Écrit via un fichier temporaire : jamais de fichier à moitié écrit."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def save_json(path: Path, data: Any) -> None:
    write_atomic(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def safe_log(text: str) -> str:
    """Une seule ligne, sans caractères de contrôle (le texte peut venir d'un site tiers)."""
    return re.sub(r"[\x00-\x1f\x7f]+", " ", str(text))[:300]


def normalize(text: str) -> str:
    lines = (re.sub(r"\s+", " ", line).strip() for line in text.splitlines())
    return "\n".join(line for line in lines if line)


def make_diff(old: str, new: str) -> str:
    lines = difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=1)
    return "\n".join(l for l in lines if not l.startswith(("---", "+++")))


def preview(diff: str) -> str:
    lines = diff.splitlines()
    out = "\n".join(lines[:PREVIEW_MAX_LINES])[:PREVIEW_MAX_CHARS]
    return out + "\n…" if len(out) < len(diff) else out


def diff_counts(diff: str) -> tuple[int, int]:
    lines = diff.splitlines()
    return (sum(l.startswith("+") for l in lines), sum(l.startswith("-") for l in lines))


def pages_url() -> str | None:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if "/" not in repo:
        return None
    owner, name = repo.lower().split("/", 1)
    return f"https://{owner}.github.io/" + ("" if name == f"{owner}.github.io" else f"{name}/")


# ---------------------------------------------------------------- entrées


@dataclass(frozen=True)
class Entry:
    name: str
    url: str
    selector: str | None

    @property
    def id(self) -> str:
        return page_id(self.url, self.selector)


def parse_entries(raw: Any) -> list[Entry | str]:
    """Valide urls.json. Renvoie une Entry par ligne valide, un message pour les autres."""
    if not isinstance(raw, list):
        raise SystemExit("urls.json doit contenir une liste")
    out: list[Entry | str] = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("url"), str):
            out.append("entrée ignorée : objet sans « url »")
            continue
        url = item["url"].strip()
        name = str(item.get("name") or url).strip()[:MAX_NAME]
        selector = str(item.get("selector") or "").strip() or None
        if urlsplit(url).scheme not in ("http", "https") or len(url) > MAX_URL:
            out.append(f"URL refusée (http/https uniquement) : {safe_log(url)}")
        elif selector and len(selector) > MAX_SELECTOR:
            out.append(f"sélecteur trop long pour {safe_log(name)}")
        else:
            out.append(Entry(name, url, selector))
    return out


# ---------------------------------------------------------------- récupération


def check_public_host(url: str) -> None:
    """Refuse les adresses privées, locales ou réservées (protection SSRF)."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FetchError("seules les URL http(s) sont acceptées")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise FetchError(f"nom de domaine introuvable : {parts.hostname}") from exc
    if os.environ.get("VEILLE_ALLOW_PRIVATE") == "1":  # tests locaux uniquement
        return
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            raise FetchError(f"adresse non publique refusée : {parts.hostname}")


def make_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=2,
        connect=2,
        read=1,
        backoff_factor=1.5,
        status_forcelist=(429, 502, 503, 504),
        allowed_methods=("GET",),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=MAX_WORKERS, pool_maxsize=MAX_WORKERS)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
            "Accept-Language": "fr,en;q=0.8",
        }
    )
    return session


@dataclass
class Fetched:
    status: int  # 200 ou 304
    body: bytes = b""
    etag: str | None = None
    last_modified: str | None = None


def fetch(session: requests.Session, url: str, etag: str | None, last_modified: str | None) -> Fetched:
    """GET avec redirections vérifiées une par une, taille limitée et requête conditionnelle."""
    headers = {}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    for _ in range(MAX_REDIRECTS + 1):
        check_public_host(url)
        with session.get(url, headers=headers, timeout=TIMEOUT, stream=True, allow_redirects=False) as resp:
            if resp.is_redirect:
                url = urljoin(url, resp.headers.get("Location", ""))
                headers = {}  # pas de requête conditionnelle vers une autre adresse
                continue
            if resp.status_code == 304:
                return Fetched(304, etag=etag, last_modified=last_modified)
            if resp.status_code >= 400:
                raise FetchError(f"HTTP {resp.status_code}")
            ctype = resp.headers.get("Content-Type", "text/html").split(";")[0].strip().lower()
            if ctype not in ALLOWED_TYPES:
                raise FetchError(f"type de contenu non pris en charge : {safe_log(ctype)}")
            if int(resp.headers.get("Content-Length") or 0) > MAX_BYTES:
                raise FetchError("page trop volumineuse (> 5 Mo)")
            body = bytearray()
            for chunk in resp.iter_content(64 * 1024):
                body += chunk
                if len(body) > MAX_BYTES:
                    raise FetchError("page trop volumineuse (> 5 Mo)")
            return Fetched(
                resp.status_code, bytes(body), resp.headers.get("ETag"), resp.headers.get("Last-Modified")
            )
    raise FetchError("trop de redirections")


def extract_text(body: bytes, selector: str | None) -> str:
    soup = BeautifulSoup(body, "html.parser")
    for tag in soup(["script", "style", "noscript", "template", "svg", "iframe"]):
        tag.decompose()
    if selector:
        try:
            nodes = soup.select(selector)
        except Exception as exc:  # soupsieve lève plusieurs types d'erreurs
            raise FetchError(f"sélecteur CSS invalide : {safe_log(selector)}") from exc
        if not nodes:
            raise FetchError(f"sélecteur introuvable : {safe_log(selector)}")
        text = "\n".join(n.get_text("\n") for n in nodes)
    else:
        text = (soup.body or soup).get_text("\n")
    return normalize(text)


# ---------------------------------------------------------------- notifications


class Pusher:
    """Notifications Web Push vers les appareils abonnés depuis l'interface."""

    def __init__(self) -> None:
        self.key = None
        self.subs: list[dict] = []
        self.dead: set[str] = set()
        self.errors: list[str] = []
        self.sent = 0
        self.session = requests.Session()
        self.subject = pages_url() or "mailto:veille@example.invalid"
        try:
            raw = json.loads(os.environ.get("PUSH_SUBSCRIPTIONS", "").strip() or "[]")
        except json.JSONDecodeError:
            raw = []
            self.errors.append("variable PUSH_SUBSCRIPTIONS illisible")
        for sub in raw if isinstance(raw, list) else []:
            try:
                webpush.validate_subscription(sub)
                self.subs.append(sub)
            except ValueError as exc:
                self.errors.append(f"abonnement ignoré : {exc}")
        secret = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
        if secret:
            try:
                self.key = webpush.load_private_key(secret)
            except ValueError as exc:
                self.errors.append(f"VAPID_PRIVATE_KEY invalide : {exc}")

    def send(self, data: dict, topic: str | None = None) -> None:
        if self.key is None or not self.subs:
            print("  (pas de notification : aucun appareil abonné ou clé VAPID absente)")
            return
        for sub in self.subs:
            sid = short_id(sub["endpoint"])
            label = safe_log(sub.get("label") or sid)[:60]
            if sid in self.dead:
                continue
            try:
                r = webpush.send(sub, data, self.key, self.subject, topic=topic, session=self.session)
            except (requests.RequestException, ValueError) as exc:
                self.errors.append(safe_log(f"{label} : {exc}")[:200])
                continue
            if r.status_code in (404, 410):
                self.dead.add(sid)
                print(f"  abonnement expiré : {label}")
            elif r.status_code >= 300:
                self.errors.append(safe_log(f"{label} : HTTP {r.status_code} {r.text[:120]}"))
                print(f"  ! push refusé ({r.status_code})")
            else:
                self.sent += 1

    def notify_change(self, entry: Entry, diff: str) -> None:
        added, removed = diff_counts(diff)
        changed = [l[1:].strip() for l in diff.splitlines() if l[:1] in "+-" and l[1:].strip()]
        excerpt = " · ".join(changed)
        if len(excerpt) > NOTIF_MAX_CHARS:
            excerpt = excerpt[:NOTIF_MAX_CHARS] + "…"
        self.send(
            {
                "title": f"Modifié : {entry.name}"[:120],
                "body": f"+{added} / −{removed}  {excerpt}",
                "tag": entry.id,
                "url": f"./#p-{entry.id}",
            },
            topic=entry.id,
        )

    def summary(self) -> dict:
        return {
            "subscriptions": len(self.subs),
            "configured": self.key is not None,
            "sent_last_run": self.sent,
            "dead": sorted(self.dead),
            "errors": self.errors[:10],
        }


# ---------------------------------------------------------------- programme


def main() -> int:
    # Neutralise les commandes de workflow (« ::… ») que contiendrait du texte tiers dans les logs.
    stop_token = secrets.token_hex(16)
    print(f"::stop-commands::{stop_token}")

    entries = parse_entries(load_json(URLS_FILE, []))
    status = load_json(STATUS_FILE, {})
    old_pages: dict[str, dict] = status.get("pages", {}) if isinstance(status, dict) else {}
    run_at = now_iso()
    pusher = Pusher()
    warnings = [e for e in entries if isinstance(e, str)]
    valid = list({e.id: e for e in entries if isinstance(e, Entry)}.values())  # sans doublons

    session = make_session()

    def job(entry: Entry) -> tuple[Entry, Fetched | Exception]:
        st = old_pages.get(entry.id, {})
        has_snapshot = (SNAPSHOTS / f"{entry.id}.txt").exists()
        try:
            return entry, fetch(
                session,
                entry.url,
                st.get("etag") if has_snapshot else None,
                st.get("last_modified") if has_snapshot else None,
            )
        except (FetchError, requests.RequestException) as exc:
            return entry, exc

    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(valid) or 1)) as pool:
        results = list(pool.map(job, valid))

    new_pages: dict[str, dict] = {}
    changes = 0
    for entry, result in results:
        snap_file = SNAPSHOTS / f"{entry.id}.txt"
        hist_file = HISTORY / f"{entry.id}.json"
        st = dict(old_pages.get(entry.id, {}))
        st.update({"name": entry.name, "url": entry.url, "selector": entry.selector, "last_check": run_at})
        print(f"- {safe_log(entry.name)}")
        new_pages[entry.id] = st

        try:
            if isinstance(result, Exception):
                raise result
            if result.status == 304:
                print("  inchangé (304)")
                st.pop("error", None)
                st.pop("error_since", None)
                st["last_success"] = run_at
                continue
            text = extract_text(result.body, entry.selector)
        except (FetchError, requests.RequestException) as exc:
            msg = str(exc) if isinstance(exc, FetchError) else f"erreur réseau ({type(exc).__name__})"
            st["error"] = safe_log(msg)
            st["error_since"] = st.get("error_since") or run_at
            print(f"  ! erreur : {st['error']}")
            continue

        st.pop("error", None)
        st.pop("error_since", None)
        st.update(
            {
                "last_success": run_at,
                "etag": result.etag,
                "last_modified": result.last_modified,
                "length": len(text),
            }
        )
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()

        if not snap_file.exists():
            write_atomic(snap_file, text)
            st.update({"hash": digest, "first_seen": run_at, "last_change": None, "diff": None})
            print("  état initial enregistré")
        elif digest != st.get("hash"):
            old = snap_file.read_text(encoding="utf-8")
            if old == text:  # hash absent ou ancien format
                st["hash"] = digest
                print("  inchangé")
                continue
            diff = make_diff(old, text)
            write_atomic(snap_file, text)
            added, removed = diff_counts(diff)
            history = load_json(hist_file, [])
            history.insert(
                0, {"date": run_at, "added": added, "removed": removed, "diff": diff[:HISTORY_DIFF_MAX]}
            )
            save_json(hist_file, history[:HISTORY_MAX])
            st.update(
                {
                    "hash": digest,
                    "last_change": run_at,
                    "diff": preview(diff),
                    "added": added,
                    "removed": removed,
                    "changes": st.get("changes", 0) + 1,
                }
            )
            changes += 1
            print(f"  MODIFIÉ (+{added} / -{removed})")
            pusher.notify_change(entry, diff)
        else:
            print("  inchangé")

    # Nettoyage des pages retirées de urls.json.
    for pid in set(old_pages) - set(new_pages):
        for f in (SNAPSHOTS / f"{pid}.txt", HISTORY / f"{pid}.json"):
            f.unlink(missing_ok=True)

    if os.environ.get("PUSH_TEST", "").lower() == "true":
        print("Notification de test")
        pusher.send(
            {"title": "Veille", "body": "Les notifications fonctionnent ✓", "tag": "test", "url": "./"}
        )

    for w in warnings:
        print(f"  ! {w}")
    save_json(
        STATUS_FILE,
        {
            "last_run": run_at,
            "count": len(new_pages),
            "changes_last_run": changes,
            "warnings": warnings[:20],
            "push": pusher.summary(),
            "pages": new_pages,
        },
    )
    print(f"Terminé : {len(new_pages)} page(s), {changes} modification(s).")
    print(f"::{stop_token}::")
    return 0


if __name__ == "__main__":
    sys.exit(main())
