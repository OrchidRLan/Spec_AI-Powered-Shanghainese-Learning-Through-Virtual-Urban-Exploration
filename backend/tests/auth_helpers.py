"""Explicit identities for course regressions; no implicit anonymous boot."""
import hashlib
import secrets


def start_guest(client):
    response = client.post("/api/auth/guest", json={})
    assert response.status_code == 200, response.text
    client.headers["X-Guest-Token"] = response.json()["guest_token"]
    return response.json()["session"]


def seed_legacy(client):
    """Model an already-persisted pre-auth browser for historical course tests."""
    session = start_guest(client)
    token = secrets.token_urlsafe(32)
    with client.app.state.database.transaction() as connection:
        connection.execute("DELETE FROM guest_tokens WHERE session_id=?", (session["id"],))
        connection.execute("DELETE FROM guest_sessions WHERE session_id=?", (session["id"],))
        connection.execute("UPDATE sessions SET token_hash=? WHERE id=?", (hashlib.sha256(token.encode()).hexdigest(), session["id"]))
    del client.headers["X-Guest-Token"]
    client.cookies.set("shanghai_session", token, domain="testserver.local", path="/")
    return session
