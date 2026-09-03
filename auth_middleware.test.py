#!/usr/bin/env python3
"""Offline tests for obsidian_mcp.AuthMiddleware. Run with: python auth_middleware.test.py

No network: /oidc/v1/userinfo is stubbed, so only the middleware's own decisions
are under test — which credential is accepted, and which tools each may reach.
"""

import asyncio
import json
import os
import sys

os.environ.setdefault("API_TOKEN", "static-root-token")
os.environ.setdefault("OAUTH_REQUIRED_ROLE", "obsidian:access")
os.environ.setdefault("OAUTH_ADMIN_ROLE", "obsidian:admin")

import obsidian_mcp as m

PASSED, FAILED = [], []


def check(name, condition):
    (PASSED if condition else FAILED).append(name)
    print(f"  {'ok  ' if condition else 'FAIL'} {name}")


async def call(middleware, *, path="/mcp", headers=None, body=None, method="POST"):
    """Drive the middleware and report whether the inner app was reached."""
    reached = {"app": False}
    sent = []

    async def app(scope, receive, send):
        reached["app"] = True
        # Drain the body the way the real app would, to exercise the replay.
        drained = b""
        while True:
            msg = await receive()
            if msg["type"] != "http.request":
                break
            drained += msg.get("body", b"")
            if not msg.get("more_body", False):
                break
        reached["body"] = drained

    mw = m.AuthMiddleware(app)

    raw = json.dumps(body).encode() if body is not None else b""
    messages = [{"type": "http.request", "body": raw, "more_body": False}]
    it = iter(messages)

    async def receive():
        try:
            return next(it)
        except StopIteration:
            return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
    }
    await mw(scope, receive, send)

    status = next((s["status"] for s in sent if s["type"] == "http.response.start"), None)
    return reached, status


def tools_call(name):
    return {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name}}


async def main():
    original = m._fetch_userinfo

    def stub(roles):
        async def _fetch(token):
            return {m.ROLES_CLAIM: {r: {} for r in roles}}
        return _fetch

    async def _reject(token):
        return None

    # Stubbed from the first test on: a wrong bearer falls through to the OAuth
    # branch, which would otherwise hit the real Zitadel over the network.
    m._fetch_userinfo = _reject

    print("\nStatic token")
    r, st = await call(None, headers={"authorization": "Bearer static-root-token"},
                       body=tools_call("read_file"))
    check("Bearer <API_TOKEN> is accepted", r["app"] is True)

    r, st = await call(None, path="/static-root-token/mcp", headers={}, body=tools_call("read_file"))
    check("token in the URL path is REJECTED (401)", r["app"] is False and st == 401)

    r, st = await call(None, headers={"authorization": "Bearer wrong-token"}, body=tools_call("read_file"))
    check("a wrong bearer falls through to OAuth and 401s", r["app"] is False and st == 401)

    r, st = await call(None, headers={}, body=tools_call("read_file"))
    check("no credential at all is rejected", r["app"] is False and st == 401)

    r, st = await call(None, headers={"authorization": "Bearer static-root-token"},
                       body=tools_call("create_api_token"))
    check("static token may manage tokens", r["app"] is True)

    print("\nOAuth, role gating")
    m._fetch_userinfo = stub(["obsidian:access"])
    r, st = await call(None, headers={"authorization": "Bearer oauth-tok"}, body=tools_call("read_file"))
    check("access role reaches an ordinary tool", r["app"] is True)
    check("  and the body survives the buffering", r.get("body") == json.dumps(tools_call("read_file")).encode())

    r, st = await call(None, headers={"authorization": "Bearer oauth-tok"},
                       body=tools_call("create_api_token"))
    check("access role alone CANNOT create a token (403)", r["app"] is False and st == 403)

    r, st = await call(None, headers={"authorization": "Bearer oauth-tok"},
                       body=tools_call("revoke_api_token"))
    check("access role alone CANNOT revoke (403)", r["app"] is False and st == 403)

    r, st = await call(None, headers={"authorization": "Bearer oauth-tok"},
                       body=[tools_call("read_file"), tools_call("create_api_token")])
    check("an admin tool hidden in a batch is caught", r["app"] is False and st == 403)

    m._fetch_userinfo = stub(["obsidian:access", "obsidian:admin"])
    r, st = await call(None, headers={"authorization": "Bearer oauth-tok"},
                       body=tools_call("create_api_token"))
    check("admin role may create a token", r["app"] is True)

    m._fetch_userinfo = stub(["some:other:role"])
    r, st = await call(None, headers={"authorization": "Bearer oauth-tok"}, body=tools_call("read_file"))
    check("a token without the access role is refused (403)", r["app"] is False and st == 403)

    m._fetch_userinfo = _reject
    r, st = await call(None, headers={"authorization": "Bearer bad"}, body=tools_call("read_file"))
    check("an invalid OAuth token is refused (401)", r["app"] is False and st == 401)

    m._fetch_userinfo = original

    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        for f in FAILED:
            print(f"  FAILED: {f}")
        sys.exit(1)


asyncio.run(main())
