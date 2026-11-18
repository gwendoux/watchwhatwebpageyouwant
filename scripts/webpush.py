"""Envoi de notifications Web Push (RFC 8030 / 8291 / 8292) avec `cryptography` seulement.

Clé VAPID : clé privée P-256 au format « base64url brut » (32 octets), le même
format que `npx web-push generate-vapid-keys`. Un PEM est aussi accepté.

    python scripts/webpush.py generate   # nouvelle paire de clés
    python scripts/webpush.py public     # clé publique dérivée de $VAPID_PRIVATE_KEY (JSON)
"""

from __future__ import annotations

import base64
import json
import os
import struct
import sys
import time
from urllib.parse import urlsplit

import requests
from cryptography.hazmat.primitives import hashes, hmac, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64u_dec(text: str) -> bytes:
    text = text.strip()
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def load_private_key(text: str) -> ec.EllipticCurvePrivateKey:
    text = text.strip()
    if text.startswith("-----BEGIN"):
        key = serialization.load_pem_private_key(text.encode(), password=None)
        assert isinstance(key, ec.EllipticCurvePrivateKey)
        return key
    raw = b64u_dec(text)
    if len(raw) != 32:
        raise ValueError("VAPID_PRIVATE_KEY doit faire 32 octets en base64url")
    return ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())


def public_key_b64(key: ec.EllipticCurvePrivateKey) -> str:
    return b64u(key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))


def _hmac(key: bytes, data: bytes) -> bytes:
    h = hmac.HMAC(key, hashes.SHA256())
    h.update(data)
    return h.finalize()


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    """Chiffrement « aes128gcm » (RFC 8291), un seul enregistrement."""
    ua_public = b64u_dec(p256dh)
    auth_secret = b64u_dec(auth)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)

    as_private = ec.generate_private_key(ec.SECP256R1())
    as_public = as_private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    ecdh_secret = as_private.exchange(ec.ECDH(), ua_key)

    prk_key = _hmac(auth_secret, ecdh_secret)
    ikm = _hmac(prk_key, b"WebPush: info\x00" + ua_public + as_public + b"\x01")[:32]

    salt = os.urandom(16)
    prk = _hmac(salt, ikm)
    cek = _hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
    nonce = _hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12]

    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    header = salt + struct.pack("!IB", 4096, len(as_public)) + as_public
    return header + ciphertext


def vapid_header(endpoint: str, key: ec.EllipticCurvePrivateKey, subject: str) -> str:
    parts = urlsplit(endpoint)
    claims = {"aud": f"{parts.scheme}://{parts.netloc}",
              "exp": int(time.time()) + 12 * 3600, "sub": subject}
    signing_input = (b64u(json.dumps({"typ": "JWT", "alg": "ES256"}).encode()) + "."
                     + b64u(json.dumps(claims, separators=(",", ":")).encode()))
    r, s = decode_dss_signature(key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256())))
    jwt = signing_input + "." + b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"vapid t={jwt}, k={public_key_b64(key)}"


def send(subscription: dict, data: dict, key: ec.EllipticCurvePrivateKey, subject: str,
         ttl: int = 86400) -> requests.Response:
    body = encrypt(json.dumps(data, ensure_ascii=False).encode("utf-8"),
                   subscription["keys"]["p256dh"], subscription["keys"]["auth"])
    return requests.post(subscription["endpoint"], data=body, timeout=20, headers={
        "Authorization": vapid_header(subscription["endpoint"], key, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(ttl),
        "Urgency": "normal",
    })


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "generate":
        k = ec.generate_private_key(ec.SECP256R1())
        print("Clé privée (secret VAPID_PRIVATE_KEY) :", b64u(k.private_numbers().private_value.to_bytes(32, "big")))
        print("Clé publique :", public_key_b64(k))
    elif cmd == "public":
        secret = os.environ.get("VAPID_PRIVATE_KEY", "")
        print(json.dumps({"publicKey": public_key_b64(load_private_key(secret))} if secret.strip() else {}))
    else:
        print(__doc__)
