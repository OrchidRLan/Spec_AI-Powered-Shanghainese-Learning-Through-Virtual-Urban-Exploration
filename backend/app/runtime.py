"""Deployment settings and the authenticated boundary to the frontend proxy."""
from __future__ import annotations

import hmac
import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Request

PROXY_SECRET_HEADER = "x-shanghai-proxy-secret"
CLIENT_IP_HEADER = "x-shanghai-client-ip"


@dataclass(frozen=True)
class RuntimeSettings:
    environment: str
    database_path: str
    cookie_secure: bool
    allowed_origins: frozenset[str]
    proxy_secret: str = field(default="", repr=False)

    @property
    def production(self) -> bool:
        return self.environment == "production"

    @classmethod
    def from_env(cls, default_database: str, database_path: str | None = None) -> "RuntimeSettings":
        environment = os.getenv("APP_ENV", "development").strip().lower()
        if environment not in ("development", "production"):
            raise ValueError("APP_ENV must be development or production.")
        production = environment == "production"
        secure = os.getenv("COOKIE_SECURE", "false").strip().lower()
        if secure not in ("true", "false") or (production and secure != "true"):
            raise ValueError("COOKIE_SECURE must be true in production (true or false in development).")

        raw_origins = os.getenv("ALLOWED_ORIGINS", "" if production else "http://localhost:5173,http://127.0.0.1:5173")
        origins = set()
        for value in raw_origins.split(","):
            value = value.strip().rstrip("/")
            if not value:
                continue
            try:
                parts = urlsplit(value)
                port = parts.port
            except ValueError:
                raise ValueError("ALLOWED_ORIGINS must contain valid origins.") from None
            if (parts.scheme not in ("http", "https") or not parts.hostname
                    or parts.username is not None or parts.password is not None
                    or parts.path or parts.query or parts.fragment or "*" in value
                    or any(char.isspace() for char in value)
                    or (port is not None and port < 1)):
                raise ValueError("ALLOWED_ORIGINS must contain origins without paths, credentials, or wildcards.")
            if production and (parts.scheme != "https" or parts.hostname in ("localhost", "127.0.0.1", "::1")):
                raise ValueError("ALLOWED_ORIGINS must contain HTTPS application origins in production.")
            origins.add(value)
        if production and not origins:
            raise ValueError("ALLOWED_ORIGINS is required in production.")

        path = database_path or os.getenv("DATABASE_PATH")
        if production and (not path or not Path(path).is_absolute()):
            raise ValueError("DATABASE_PATH must name an absolute path on persistent storage in production.")
        secret = os.getenv("BACKEND_PROXY_SECRET", "")
        if production and (len(secret) < 32 or not secret.isascii() or any(char.isspace() for char in secret)):
            raise ValueError("BACKEND_PROXY_SECRET must contain at least 32 non-whitespace ASCII characters in production.")
        return cls(environment, path or default_database, secure == "true", frozenset(origins), secret)

    def proxy_client_ip(self, request: Request) -> str | None:
        """Trust one canonical IP only after verifying our server-only proxy secret."""
        supplied = request.headers.get(PROXY_SECRET_HEADER, "")
        if not hmac.compare_digest(supplied.encode(), self.proxy_secret.encode()):
            return None
        address = request.headers.get(CLIENT_IP_HEADER, "")
        if "%" in address:
            return None
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            return None
        if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped:
            return str(parsed.ipv4_mapped)
        return str(parsed)
