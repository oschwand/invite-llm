"""Static file server and invite backend for the invite-litellm frontend build."""

import json
import logging
import os
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _package_version
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse

_PROJECT_ROOT = Path(__file__).resolve().parents[2]

load_dotenv(_PROJECT_ROOT / ".env")

_STATIC_ROOT = Path(os.environ.get("STATIC_DIR", _PROJECT_ROOT / "frontend" / "dist")).resolve()

_LITELLM_URL = os.environ.get("LITELLM_URL", "http://localhost:4000").rstrip("/")
_LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
try:
    _VERSION = _package_version("invite-litellm")
except PackageNotFoundError:
    _VERSION = "unknown"
_MEMBER_PERMISSIONS = ("/key/generate", "/key/delete")

_client = httpx.AsyncClient(base_url=_LITELLM_URL, timeout=30.0)

_logger = logging.getLogger(__name__)
if not _logger.handlers:
    _log_handler = logging.StreamHandler()
    _log_handler.setFormatter(logging.Formatter("%(levelname)s:     %(message)s"))
    _logger.addHandler(_log_handler)
    _logger.setLevel(logging.INFO)


async def _check_litellm_reachable() -> None:
    try:
        await _client.get("/health/liveliness", timeout=5.0)
    except httpx.HTTPError:
        _logger.warning(
            "Cannot reach the LiteLLM server at %s — check that it is running. Invite redemption will fail until it is back.",
            _LITELLM_URL,
        )
    else:
        _logger.info("LiteLLM server at %s is reachable", _LITELLM_URL)


@asynccontextmanager
async def _lifespan(_: FastAPI):
    await _check_litellm_reachable()
    yield
    await _client.aclose()


app = FastAPI(title="invite-litellm", lifespan=_lifespan)


@app.get("/invite/{team_id}/{invite_code}")
async def invite(team_id: str, invite_code: str) -> FileResponse:
    del team_id, invite_code
    index = _STATIC_ROOT / "index.html"
    if not index.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(index, headers={"Cache-Control": "no-cache"})


async def _litellm(method: str, path: str, *, json_body: dict[str, Any] | None = None, params: dict[str, str] | None = None) -> tuple[int, Any]:
    response = await _client.request(
        method,
        path,
        json=json_body,
        params=params,
        headers={"Authorization": f"Bearer {_LITELLM_MASTER_KEY}"},
    )
    try:
        body: Any = response.json()
    except ValueError:
        body = None
    return response.status_code, body


def _error_message(body: Any, fallback: str) -> str:
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, str):
            return error
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"]
        detail = body.get("detail")
        if isinstance(detail, str):
            return detail
        if isinstance(detail, dict):
            for field in ("message", "error"):
                if isinstance(detail.get(field), str):
                    return detail[field]
        if isinstance(body.get("message"), str):
            return body["message"]
    return fallback


async def _check_invite(team_id: str, invite_key: str) -> float | None:
    """Validate the invite code; return the team member budget for the new key."""
    status, body = await _litellm("GET", "/team/info", params={"team_id": team_id})
    if status == 404:
        raise HTTPException(status_code=404, detail="Team not found")
    if status != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Could not read the team from the LiteLLM server: {_error_message(body, f'HTTP {status}')}",
        )
    info = body.get("team_info") if isinstance(body, dict) else None
    if not isinstance(info, dict):
        raise HTTPException(status_code=502, detail="Unexpected team info response from the LiteLLM server")
    metadata = info.get("metadata")
    stored_code = metadata.get("invite_code") if isinstance(metadata, dict) else None
    if not isinstance(stored_code, str) or stored_code != invite_key:
        raise HTTPException(status_code=403, detail="Invalid invite code")
    budget_table = info.get("team_member_budget_table")
    max_budget = budget_table.get("max_budget") if isinstance(budget_table, dict) else None

    current = info.get("team_member_permissions")
    existing = {route for route in current if isinstance(route, str)} if isinstance(current, list) else set()
    missing = [route for route in _MEMBER_PERMISSIONS if route not in existing]
    if missing:
        status, body = await _litellm(
            "POST",
            "/team/permissions_update",
            json_body={"team_id": team_id, "team_member_permissions": sorted(existing | set(_MEMBER_PERMISSIONS))},
        )
        if status != 200:
            raise HTTPException(
                status_code=502,
                detail=f"Could not grant key management permissions to team members: {_error_message(body, f'HTTP {status}')}",
            )
    return max_budget if isinstance(max_budget, (int, float)) else None


def _bearer_token(request: Request) -> str:
    authorization = request.headers.get("Authorization", "")
    if not authorization.startswith("Bearer "):
        return ""
    return authorization.removeprefix("Bearer ").strip()


async def _user_id_from_key(api_key: str) -> str:
    status, body = await _litellm("GET", "/key/info", params={"key": api_key})
    if status in (401, 404):
        raise HTTPException(status_code=401, detail="Invalid session key")
    if status != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Could not look up the session key on the LiteLLM server: {_error_message(body, f'HTTP {status}')}",
        )
    info = body.get("info") if isinstance(body, dict) else None
    user_id = info.get("user_id") if isinstance(info, dict) else None
    if not isinstance(user_id, str) or user_id == "":
        raise HTTPException(status_code=502, detail="The LiteLLM server did not report an owner for this key")
    return user_id


def _parse_account(raw: bytes) -> dict[str, str]:
    if not raw:
        raise HTTPException(status_code=401, detail="Sign in first, or provide an account (full_name, email, password) to accept this invite")
    try:
        data = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="The request body must be a JSON object")
    account: dict[str, str] = {}
    for field in ("full_name", "email", "password"):
        value = data.get(field)
        if not isinstance(value, str) or value.strip() == "":
            raise HTTPException(status_code=400, detail=f"Missing field: {field}")
        account[field] = value.strip()
    return account


async def _create_user(account: dict[str, str]) -> str:
    status, body = await _litellm(
        "POST",
        "/user/new",
        json_body={
            "user_email": account["email"],
            "user_alias": account["full_name"],
            "user_role": "internal_user",
            "auto_create_key": False,
        },
    )
    if status in (400, 409):
        message = _error_message(body, "The account could not be created")
        if "already exists" in message.lower():
            raise HTTPException(status_code=409, detail="An account with this email already exists. Sign in with it instead")
        raise HTTPException(status_code=400, detail=message)
    if status != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Could not create the account on the LiteLLM server: {_error_message(body, f'HTTP {status}')}",
        )
    user_id = body.get("user_id") if isinstance(body, dict) else None
    if not isinstance(user_id, str) or user_id == "":
        raise HTTPException(status_code=502, detail="The LiteLLM server did not return the new user id")
    status, body = await _litellm("POST", "/user/update", json_body={"user_id": user_id, "password": account["password"]})
    if status != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Could not set the account password on the LiteLLM server: {_error_message(body, f'HTTP {status}')}",
        )
    return user_id


async def _add_team_member(team_id: str, user_id: str) -> None:
    status, body = await _litellm(
        "POST",
        "/team/member_add",
        json_body={"team_id": team_id, "member": {"user_id": user_id, "role": "user"}},
    )
    if status == 200:
        return
    message = _error_message(body, f"HTTP {status}")
    if "already" in message.lower():
        return
    raise HTTPException(status_code=502, detail=f"Could not add the user to the team: {message}")


async def _create_team_key(team_id: str, user_id: str, max_budget: float | None) -> str:
    payload: dict[str, Any] = {
        "team_id": team_id,
        "user_id": user_id,
        "metadata": {"created_via": "invite"},
    }
    if max_budget is not None:
        payload["max_budget"] = max_budget
    status, body = await _litellm("POST", "/key/generate", json_body=payload)
    if status != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Could not create the virtual key on the LiteLLM server: {_error_message(body, f'HTTP {status}')}",
        )
    key = body.get("key") if isinstance(body, dict) else None
    if not isinstance(key, str) or key == "":
        raise HTTPException(status_code=502, detail="The LiteLLM server did not return the new key")
    return key


@app.post("/invite/{team_id}/{invite_key}")
async def redeem_invite(team_id: str, invite_key: str, request: Request) -> dict[str, Any]:
    if not _LITELLM_MASTER_KEY:
        raise HTTPException(status_code=503, detail="Invite backend is not configured: set LITELLM_MASTER_KEY")
    member_budget = await _check_invite(team_id, invite_key)

    bearer = _bearer_token(request)
    if bearer != "":
        user_id = await _user_id_from_key(bearer)
    else:
        user_id = await _create_user(_parse_account(await request.body()))

    await _add_team_member(team_id, user_id)
    key = await _create_team_key(team_id, user_id, member_budget)
    return {"key": key, "user_id": user_id, "team_id": team_id}


@app.get("/config")
async def config() -> dict[str, str]:
    return {"litellm_url": _LITELLM_URL, "version": _VERSION}


@app.get("/{file_path:path}")
async def serve_static(file_path: str) -> FileResponse:
    if file_path in ("", "index.html"):
        index = _STATIC_ROOT / "index.html"
        if not index.is_file():
            raise HTTPException(status_code=404, detail="Not found")
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    target = (_STATIC_ROOT / file_path).resolve()
    if not target.is_relative_to(_STATIC_ROOT) or not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(target)
