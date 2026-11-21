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
from functools import lru_cache
from urllib.parse import urlsplit

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# Services push des navigateurs : on n'envoie rien ailleurs (protection SSRF).
PUSH_HOSTS = (
    "web.push.apple.com",  # Safari / iOS
    "fcm.googleapis.com",  # Chrome, Edge (Android), Samsung…
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    ".notify.windows.com",  # Edge (Windows) : sous-domaines
)
MAX_PAYLOAD = 3_000  # marge sous la limite de 4 096 octets
RECORD_SIZE = 4096


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64u_dec(text: str) -> bytes:
    text = text.strip()
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _point(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def load_private_key(text: str) -> ec.EllipticCurvePrivateKey:
    text = text.strip()
    try:
        if text.startswith("-----BEGIN"):
            key = serialization.load_pem_private_key(text.encode(), password=None)
        else:
            raw = b64u_dec(text)
            if len(raw) != 32:
                raise ValueError("32 octets attendus en base64url")
            key = ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())
    except (ValueError, TypeError) as exc:
        raise ValueError(str(exc) or "format inconnu") from None
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise ValueError("clé P-256 attendue")
    return key


def public_key_b64(key: ec.EllipticCurvePrivateKey) -> str:
    return b64u(_point(key.public_key()))


def validate_subscription(sub: object) -> None:
    """Lève ValueError si l'abonnement n'est pas exploitable ou pointe hors d'un service push."""
    if not isinstance(sub, dict) or not isinstance(sub.get("keys"), dict):
        raise ValueError("format invalide")
    parts = urlsplit(str(sub.get("endpoint", "")))
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not any(
        host == h or (h.startswith(".") and host.endswith(h)) for h in PUSH_HOSTS
    ):
        raise ValueError(f"service push non reconnu : {host or '?'}")
    if (
        len(b64u_dec(str(sub["keys"].get("p256dh", "")))) != 65
        or len(b64u_dec(str(sub["keys"].get("auth", "")))) != 16
    ):
        raise ValueError("clés de chiffrement invalides")


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(hashes.SHA256(), length, salt, info).derive(ikm)


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    """Chiffrement « aes128gcm » (RFC 8291 + RFC 8188), un seul enregistrement."""
    ua_public = b64u_dec(p256dh)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    as_private = ec.generate_private_key(ec.SECP256R1())
    as_public = _point(as_private.public_key())

    ikm = _hkdf(
        b64u_dec(auth),
        as_private.exchange(ec.ECDH(), ua_key),
        b"WebPush: info\x00" + ua_public + as_public,
        32,
    )
    salt = os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)

    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return salt + struct.pack("!IB", RECORD_SIZE, len(as_public)) + as_public + ciphertext


@lru_cache(maxsize=16)
def _jwt(audience: str, key: ec.EllipticCurvePrivateKey, subject: str, hour: int) -> str:
    """JWT VAPID, mis en cache par service push et par heure (exp = 12 h)."""
    claims = {"aud": audience, "exp": hour * 3600 + 12 * 3600, "sub": subject}
    signing_input = (
        b64u(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
        + "."
        + b64u(json.dumps(claims, separators=(",", ":")).encode())
    )
    r, s = decode_dss_signature(key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256())))
    return signing_input + "." + b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


def vapid_header(endpoint: str, key: ec.EllipticCurvePrivateKey, subject: str) -> str:
    parts = urlsplit(endpoint)
    jwt = _jwt(f"{parts.scheme}://{parts.netloc}", key, subject, int(time.time()) // 3600)
    return f"vapid t={jwt}, k={public_key_b64(key)}"


def send(
    subscription: dict,
    data: dict,
    key: ec.EllipticCurvePrivateKey,
    subject: str,
    *,
    topic: str | None = None,
    ttl: int = 86400,
    session: requests.Session | None = None,
) -> requests.Response:
    validate_subscription(subscription)
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_PAYLOAD:
        raise ValueError("notification trop volumineuse")
    body = encrypt(payload, subscription["keys"]["p256dh"], subscription["keys"]["auth"])
    headers = {
        "Authorization": vapid_header(subscription["endpoint"], key, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(ttl),
        "Urgency": "normal",
    }
    if topic:  # une notification plus récente remplace celle en attente (RFC 8030 §5.4)
        headers["Topic"] = topic[:32]
    return (session or requests).post(
        subscription["endpoint"], data=body, headers=headers, timeout=(5, 15), allow_redirects=False
    )


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "generate":
        k = ec.generate_private_key(ec.SECP256R1())
        print(
            "Clé privée (secret VAPID_PRIVATE_KEY) :",
            b64u(k.private_numbers().private_value.to_bytes(32, "big")),
        )
        print("Clé publique :", public_key_b64(k))
    elif cmd == "public":
        secret = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
        print(json.dumps({"publicKey": public_key_b64(load_private_key(secret))} if secret else {}))
    else:
        print(__doc__)
