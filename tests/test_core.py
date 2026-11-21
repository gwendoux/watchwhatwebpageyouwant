"""Tests rapides (bibliothèque standard) : python -m unittest discover -s tests"""

from __future__ import annotations

import http.server
import json
import os
import shutil
import struct
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import ClassVar
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import check
import webpush
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def ua_keys():
    ua = ec.generate_private_key(ec.SECP256R1())
    pub = ua.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return ua, pub, os.urandom(16)


def decrypt(body: bytes, ua, ua_pub: bytes, auth: bytes) -> bytes:
    """Déchiffrement côté navigateur, écrit d'après la RFC 8291 indépendamment du module."""
    salt, (rs, idlen) = body[:16], struct.unpack("!IB", body[16:21])
    as_pub, ct = body[21 : 21 + idlen], body[21 + idlen :]
    hk = lambda s, k, i, n: HKDF(hashes.SHA256(), n, s, i).derive(k)
    secret = ua.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
    ikm = hk(auth, secret, b"WebPush: info\0" + ua_pub + as_pub, 32)
    pt = AESGCM(hk(salt, ikm, b"Content-Encoding: aes128gcm\0", 16)).decrypt(
        hk(salt, ikm, b"Content-Encoding: nonce\0", 12), ct, None
    )
    assert rs == 4096 and pt.endswith(b"\x02")
    return pt[:-1]


class WebPushTests(unittest.TestCase):
    def test_encrypt_roundtrip(self):
        ua, pub, auth = ua_keys()
        msg = "Modifié : prix 12 € ✓".encode()
        self.assertEqual(
            decrypt(webpush.encrypt(msg, webpush.b64u(pub), webpush.b64u(auth)), ua, pub, auth), msg
        )

    def test_vapid_jwt_signature(self):
        key = ec.generate_private_key(ec.SECP256R1())
        header = webpush.vapid_header("https://web.push.apple.com/abc", key, "https://x.github.io/")
        jwt = header.split("t=")[1].split(",")[0]
        h, c, sig = jwt.split(".")
        raw = webpush.b64u_dec(sig)
        key.public_key().verify(
            encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
            f"{h}.{c}".encode(),
            ec.ECDSA(hashes.SHA256()),
        )
        self.assertEqual(json.loads(webpush.b64u_dec(c))["aud"], "https://web.push.apple.com")

    def test_subscription_allowlist(self):
        _, pub, auth = ua_keys()
        keys = {"p256dh": webpush.b64u(pub), "auth": webpush.b64u(auth)}
        webpush.validate_subscription({"endpoint": "https://web.push.apple.com/x", "keys": keys})
        webpush.validate_subscription({"endpoint": "https://wns2-par02p.notify.windows.com/w", "keys": keys})
        for bad in (
            "http://web.push.apple.com/x",
            "https://evil.example/x",
            "https://web.push.apple.com.evil.example/x",
            "https://169.254.169.254/",
        ):
            with self.assertRaises(ValueError, msg=bad):
                webpush.validate_subscription({"endpoint": bad, "keys": keys})

    def test_private_key_formats(self):
        with self.assertRaises(ValueError):
            webpush.load_private_key("pas-une-cle")
        key = ec.generate_private_key(ec.SECP256R1())
        raw = webpush.b64u(key.private_numbers().private_value.to_bytes(32, "big"))
        self.assertEqual(webpush.public_key_b64(webpush.load_private_key(raw)), webpush.public_key_b64(key))


class CheckTests(unittest.TestCase):
    def test_ssrf_guard(self):
        for url in (
            "http://127.0.0.1/",
            "http://localhost:8080/",
            "http://169.254.169.254/latest",
            "http://10.0.0.1/",
            "http://[::1]/",
            "ftp://example.com/",
            "file:///etc/passwd",
        ):
            with self.assertRaises(check.FetchError, msg=url):
                check.check_public_host(url)

    def test_parse_entries(self):
        out = check.parse_entries(
            [
                {"name": "ok", "url": "https://example.com/", "selector": "#a"},
                {"name": "js", "url": "javascript:alert(1)"},
                {"url": "file:///etc/passwd"},
                "pas un objet",
            ]
        )
        self.assertIsInstance(out[0], check.Entry)
        self.assertTrue(all(isinstance(o, str) for o in out[1:]))

    def test_diff_and_preview(self):
        diff = check.make_diff("a\nb\nc", "a\nB\nc")
        self.assertEqual(check.diff_counts(diff), (1, 1))
        self.assertTrue(check.preview("\n".join(["+x"] * 100)).endswith("…"))

    def test_safe_log_strips_control_chars(self):
        self.assertNotIn("\n", check.safe_log("ligne\n::stop-commands::x"))


class Handler(http.server.BaseHTTPRequestHandler):
    pages: ClassVar[dict[str, tuple[str, bytes]]] = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/redirect-private":
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/")
            self.end_headers()
            return
        ctype, body = self.pages.get(self.path, ("text/html", b""))
        etag = f'"{hash(body)}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("ETag", etag)
        self.end_headers()
        self.wfile.write(body)


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.srv.server_port}"
        self.tmp = Path(tempfile.mkdtemp())
        self.patches = [
            mock.patch.object(check, n, self.tmp / p)
            for n, p in (
                ("URLS_FILE", "urls.json"),
                ("SNAPSHOTS", "data/snapshots"),
                ("HISTORY", "data/history"),
                ("STATUS_FILE", "data/status.json"),
            )
        ]
        self.patches.append(
            mock.patch.dict(os.environ, {"VEILLE_ALLOW_PRIVATE": "1", "NO_PROXY": "127.0.0.1"})
        )
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.srv.shutdown()
        shutil.rmtree(self.tmp)

    def run_check(self):
        with mock.patch("sys.stdout"):
            check.main()
        return json.loads((self.tmp / "data/status.json").read_text())

    def test_change_detection_304_and_errors(self):
        Handler.pages = {
            "/a": ("text/html; charset=utf-8", "<p id=p>10 €</p><script>x</script>".encode()),
            "/bin": ("application/octet-stream", b"\0\1"),
        }
        (self.tmp / "urls.json").write_text(
            json.dumps(
                [
                    {"name": "A", "url": f"{self.base}/a", "selector": "#p"},
                    {"name": "Bin", "url": f"{self.base}/bin"},
                    {"name": "Redir", "url": f"{self.base}/redirect-private"},
                ]
            )
        )
        pid = check.page_id(f"{self.base}/a", "#p")
        st = self.run_check()
        self.assertIsNone(st["pages"][pid]["last_change"])
        self.assertIn("type de contenu", st["pages"][check.page_id(f"{self.base}/bin", None)]["error"])
        st = self.run_check()  # ETag identique → 304
        self.assertIsNone(st["pages"][pid]["last_change"])
        Handler.pages["/a"] = ("text/html", "<p id=p>12 €</p>".encode())
        st = self.run_check()
        self.assertEqual(st["pages"][pid]["diff"], "@@ -1 +1 @@\n-10 €\n+12 €")
        hist = json.loads((self.tmp / f"data/history/{pid}.json").read_text())
        self.assertEqual(len(hist), 1)

    def test_redirect_to_private_ip_is_blocked(self):
        def guard(url):  # le serveur de test (127.0.0.1) est autorisé, la cible de la redirection non
            if not url.startswith(self.base):
                raise check.FetchError("adresse non publique refusée")

        with (
            mock.patch.object(check, "check_public_host", side_effect=guard) as spy,
            self.assertRaises(check.FetchError),
        ):
            check.fetch(check.make_session(), f"{self.base}/redirect-private", None, None)
        self.assertEqual(spy.call_args_list[-1].args[0], "http://169.254.169.254/")


if __name__ == "__main__":
    unittest.main()
