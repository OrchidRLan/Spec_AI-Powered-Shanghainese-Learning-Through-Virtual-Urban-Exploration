"""Production boundary checks use isolated databases and no provider calls."""
from contextlib import contextmanager
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.auth import digest
from app.main import create_app
from app.runtime import CLIENT_IP_HEADER, PROXY_SECRET_HEADER, RuntimeSettings

SECRET = "test-proxy-secret-not-a-real-credential-0123456789"
ORIGIN = "https://learning.example"
IP = "198.51.100.7"


@pytest.fixture
def production_env(monkeypatch, tmp_path):
    values = {"APP_ENV": "production", "COOKIE_SECURE": "true", "ALLOWED_ORIGINS": ORIGIN,
              "DATABASE_PATH": str(tmp_path / "production.db"), "BACKEND_PROXY_SECRET": SECRET}
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    return values


@pytest.fixture
def app(production_env):
    return create_app()


@pytest.fixture
def client(app):
    with TestClient(app, base_url=ORIGIN, headers={PROXY_SECRET_HEADER: SECRET, CLIENT_IP_HEADER: IP,
                                                "Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"}) as browser:
        yield browser


@pytest.mark.parametrize("key,value", [
    ("APP_ENV", "staging-typo"), ("COOKIE_SECURE", "false"), ("COOKIE_SECURE", "1"),
    ("ALLOWED_ORIGINS", ""), ("ALLOWED_ORIGINS", "http://learning.example"),
    ("ALLOWED_ORIGINS", "https://localhost"), ("ALLOWED_ORIGINS", "https://*.vercel.app"),
    ("ALLOWED_ORIGINS", "https://learning.example/path"), ("ALLOWED_ORIGINS", "https://user@learning.example"),
    ("ALLOWED_ORIGINS", "https://learning.example:bad"), ("ALLOWED_ORIGINS", "https://bad host.example"),
    ("DATABASE_PATH", "relative.db"), ("DATABASE_PATH", ""),
    ("BACKEND_PROXY_SECRET", ""), ("BACKEND_PROXY_SECRET", "short"),
    ("BACKEND_PROXY_SECRET", "x" * 32 + " "),
])
def test_invalid_production_configuration_fails_before_opening_database(production_env, monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    with pytest.raises(ValueError) as error:
        create_app()
    assert key in str(error.value)
    assert SECRET not in str(error.value)


def test_settings_accept_exact_comma_separated_https_origins(production_env, monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGINS", f" {ORIGIN}/, https://second.example ")
    settings = RuntimeSettings.from_env("unused")
    assert settings.allowed_origins == {ORIGIN, "https://second.example"}
    assert SECRET not in repr(settings)


def test_health_is_public_database_aware_and_does_not_expose_configuration(app, monkeypatch):
    with TestClient(app) as external:
        response = external.get("/api/health")
        assert response.status_code == 200
        assert response.json()["mode"] == "production"
        assert response.json()["status"] == "ok"
        assert "content_version" in response.json()
        assert SECRET not in response.text
        assert app.state.database.path not in response.text
        assert response.headers["cache-control"] == "no-store"
        assert external.head("/api/health").status_code == 200
        assert external.post("/api/health", json={}).status_code == 403

        @contextmanager
        def unavailable():
            raise sqlite3.OperationalError("private database location")
            yield

        monkeypatch.setattr(app.state.database, "transaction", unavailable)
        failure = external.get("/api/health")
        assert failure.status_code == 503
        assert failure.json() == {"status": "unavailable", "mode": "production"}
        assert "private" not in failure.text


@pytest.mark.parametrize("headers", [
    {}, {PROXY_SECRET_HEADER: "wrong", CLIENT_IP_HEADER: IP},
    {"x-vercel-forwarded-for": IP, "x-forwarded-for": IP, CLIENT_IP_HEADER: IP},
    {PROXY_SECRET_HEADER: SECRET}, {PROXY_SECRET_HEADER: SECRET, CLIENT_IP_HEADER: "invalid"},
    {PROXY_SECRET_HEADER: SECRET, CLIENT_IP_HEADER: f"{IP}, 203.0.113.1"},
    {PROXY_SECRET_HEADER: SECRET, CLIENT_IP_HEADER: "fe80::1%eth0"},
])
def test_direct_or_malformed_proxy_requests_are_denied_before_any_session_is_created(app, headers):
    with TestClient(app, headers={**headers, "Origin": ORIGIN}) as external:
        response = external.post("/api/auth/guest", json={})
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "proxy_required"
        assert response.headers["cache-control"] == "no-store"
        assert external.get("/api/auth").status_code == 403
    with app.state.database.transaction() as connection:
        assert connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0


@pytest.mark.parametrize("headers", [
    {"Origin": "https://attacker.example", "Host": "attacker.example"},
    {"Origin": "https://backend.onrender.com", "Host": "backend.onrender.com"},
    {"Origin": "null"}, {"Origin": ""}, {"Sec-Fetch-Site": "cross-site"},
])
def test_production_writes_require_application_origin_even_with_valid_proxy(client, headers):
    response = client.post("/api/auth/guest", json={}, headers=headers)
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "cross_origin_denied"


def test_secure_account_cookie_and_progress_survive_a_backend_restart(client, app):
    registration = client.post("/api/auth/register", json={"username": "OnlineWalker", "password": "testpass8"})
    assert registration.status_code == 200
    cookie = registration.headers["set-cookie"]
    assert "Secure" in cookie and "HttpOnly" in cookie and "SameSite=strict" in cookie
    session = registration.json()["session"]
    assert session["mode"] == "production"
    preference = client.patch("/api/session", json={"locale": "en"})
    assert preference.status_code == 200
    cookies = dict(client.cookies)
    reopened = create_app(app.state.database.path)
    with TestClient(reopened, base_url=ORIGIN, cookies=cookies, headers=dict(client.headers)) as browser:
        restored = browser.get("/api/auth").json()
        assert restored["mode"] == "account"
        assert restored["session"]["id"] == session["id"]
        assert restored["session"]["locale"] == "en"
        assert browser.post("/api/auth/register", json={"username": "onlinewalker", "password": "testpass8"}).status_code == 409


def test_auth_rate_limit_uses_verified_ip_not_forwarded_headers(client, app):
    for _ in range(50):
        assert client.post("/api/auth/guest", json={}).status_code == 200
    spoofed = {"x-forwarded-for": "203.0.113.9", "x-vercel-forwarded-for": "203.0.113.9"}
    assert client.post("/api/auth/guest", json={}, headers=spoofed).status_code == 429
    # Equivalent IPv4-mapped IPv6 must use the same bucket.
    assert client.post("/api/auth/guest", json={}, headers={CLIENT_IP_HEADER: f"::ffff:{IP}"}).status_code == 429
    assert client.post("/api/auth/guest", json={}, headers={CLIENT_IP_HEADER: "203.0.113.9"}).status_code == 200
    with app.state.database.transaction() as connection:
        buckets = {row["bucket"] for row in connection.execute("SELECT bucket FROM auth_rate_limits")}
    assert buckets == {f"guest:ip:{digest(IP)}", f"guest:ip:{digest('203.0.113.9')}"}


def test_development_does_not_trust_client_ip_headers(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    application = create_app(str(tmp_path / "development.db"))
    with TestClient(application, headers={CLIENT_IP_HEADER: IP, PROXY_SECRET_HEADER: SECRET}) as browser:
        assert browser.post("/api/auth/guest", json={}).status_code == 200
    with application.state.database.transaction() as connection:
        bucket = connection.execute("SELECT bucket FROM auth_rate_limits").fetchone()["bucket"]
        assert bucket == f"guest:ip:{digest('testclient')}"


def test_production_api_docs_are_not_served(client):
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


def test_database_unavailable_returns_recoverable_api_error(client, app, monkeypatch):
    @contextmanager
    def unavailable():
        raise sqlite3.OperationalError("private database location")
        yield

    monkeypatch.setattr(app.state.database, "transaction", unavailable)
    response = client.get("/api/auth")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "save_failed"
    assert response.json()["detail"]["retryable"] is True
    assert "private" not in response.text
    assert response.headers["cache-control"] == "no-store"
