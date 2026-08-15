#!/usr/bin/env python3

import httpx
import os
import random
import re
from datetime import datetime, timezone
from urllib.parse import quote
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

# Configuration
OBSIDIAN_API_URL = os.getenv("OBSIDIAN_API_URL", "http://localhost:3000/api")
PORT = int(os.getenv("PORT", 3001))
API_TOKEN = os.getenv("API_TOKEN", "")
VAULT_NAME = os.getenv("VAULT_NAME", "")

# OAuth 2.1 resource-server configuration (Zitadel) — see AuthMiddleware below
ZITADEL_ISSUER = os.getenv("ZITADEL_ISSUER", "https://zitadel-k9z6.srv828065.hstgr.cloud")
OAUTH_REQUIRED_ROLE = os.getenv("OAUTH_REQUIRED_ROLE", "obsidian:access")
MCP_PUBLIC_URL = os.getenv("MCP_PUBLIC_URL", "")

# HTTP client with auth header for all calls to obsidian-api
api_client = httpx.Client(headers={"Authorization": f"Bearer {API_TOKEN}"})

# Create MCP server — DNS rebinding protection disabled because token auth is handled
# by AuthMiddleware (legacy static token or Zitadel bearer token validated on every request)
mcp = FastMCP("Obsidian", transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False))

# Document Comment plugin markers, shared by extract_comments and extract_comments_bulk:
# an anchor span `<!--c:ID-->text<!--/c:ID-->` wrapping the commented passage, and a
# thread block `<!--co:ID by:author at:timestamp status:status quote:"..."` followed by
# one reply line per participant (`Author (timestamp): text`), closed by `-->`.
_COMMENT_ANCHOR_RE = re.compile(r'<!--c:([\w-]+)-->(.*?)<!--/c:\1-->', re.DOTALL)
_COMMENT_THREAD_RE = re.compile(
    r'<!--co:([\w-]+)\s+by:(\S+)\s+at:(\S+)\s+status:(\S+)\s+quote:"((?:[^"\\]|\\.)*)"\s*\n(.*?)-->',
    re.DOTALL
)
_COMMENT_REPLY_RE = re.compile(r'^(.+?) \(([^)]+)\):\s?(.*)$')


def _parse_comment_threads(content: str) -> list[dict]:
    """Parse Document Comment plugin threads out of raw markdown content.

    Returns a list of `{"id", "status", "quote", "created_by", "created_at",
    "anchored_text", "replies"}` dicts — see extract_comments' docstring for
    the field semantics.
    """
    anchors = {m.group(1): m.group(2).strip() for m in _COMMENT_ANCHOR_RE.finditer(content)}

    comments = []
    for match in _COMMENT_THREAD_RE.finditer(content):
        comment_id, author, at, status, quote, body = match.groups()

        replies = []
        for line in body.strip("\n").split("\n"):
            line = line.strip()
            if not line:
                continue
            reply_match = _COMMENT_REPLY_RE.match(line)
            if reply_match:
                replies.append({
                    "author": reply_match.group(1),
                    "at": reply_match.group(2),
                    "text": _unescape_entry_text(reply_match.group(3)),
                })

        comments.append({
            "id": comment_id,
            "status": status,
            "quote": quote,
            "created_by": author,
            "created_at": at,
            "anchored_text": anchors.get(comment_id),
            "replies": replies,
        })

    return comments


# Generic version of _COMMENT_THREAD_RE used by the write tools below (create_comment,
# reply_to_comment, set_comment_status, delete_comment): captures the raw header-line
# remainder instead of assuming a fixed by:/at:/status:/quote: order, so edits round-trip
# any header fields untouched (including ones this server doesn't otherwise parse, like the
# plugin's code-comment `line:` attribute). A leading `\n` is included in the match when
# present, so callers that delete the whole match also clean up the blank line it sat on.
def _comment_block_pattern(comment_id: str) -> re.Pattern:
    return re.compile(r'\n?<!--co:' + re.escape(comment_id) + r'(?![A-Za-z0-9])([^\n]*)\n([\s\S]*?)-->')


_COMMENT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


def _generate_comment_id(existing_ids: set) -> str:
    """Generate a comment ID matching the plugin's own scheme: 5 lowercase alnum chars,
    falling back to 8 if that space is exhausted (mirrors src/format/ids.ts)."""
    for length in (5, 8):
        for _ in range(1000):
            candidate = "".join(random.choices(_COMMENT_ID_ALPHABET, k=length))
            if candidate not in existing_ids:
                return candidate
    raise RuntimeError("Could not generate a unique comment id")


def _now_iso() -> str:
    """UTC timestamp matching the plugin's `new Date().toISOString()` (ms precision, Z suffix)."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _sanitize_token(s: str) -> str:
    """Sanitize a `by:`/`at:` header token: collapse whitespace to `_`, break any `-->`
    sequence so it can't prematurely close the comment block."""
    s = re.sub(r"\s+", "_", s.strip())
    return s.replace("-->", "--\u200b>")


def _sanitize_quote(s: str) -> str:
    """Sanitize text for the `quote:"..."` header field: collapse whitespace to single
    spaces, swap `"` for `'` (the field's own delimiter), break `-->` sequences, trim."""
    s = re.sub(r"\s+", " ", s).strip()
    s = s.replace('"', "'")
    return s.replace("-->", "--\u200b>")


def _escape_entry_text(s: str) -> str:
    """Escape a reply/comment body for storage as a single thread-entry line."""
    return s.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r")


def _unescape_entry_text(s: str) -> str:
    """Inverse of _escape_entry_text — single-pass so `\\\\n` round-trips as a literal `\\n`."""
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s) and s[i + 1] in "nr\\":
            out.append({"n": "\n", "r": "\r", "\\": "\\"}[s[i + 1]])
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _patch_request(file_path: str, old_text: str, new_text: str, replace_all: bool = False):
    """Shared PATCH call backing patch_file and the comment write tools — a surgical,
    atomic old_text -> new_text swap performed server-side (no read-modify-write race)."""
    return api_client.patch(
        f"{OBSIDIAN_API_URL}/file/{file_path}/patch",
        json={"old_text": old_text, "new_text": new_text, "replace_all": replace_all}
    )


def _obsidian_uri(file_path: str) -> str | None:
    """Build an obsidian://open deep link for a vault-relative file path.

    Returns None when VAULT_NAME isn't configured, since the link would be
    missing its vault and unusable.
    """
    if not VAULT_NAME:
        return None
    path_without_ext = re.sub(r"\.md$", "", file_path)
    return f"obsidian://open?vault={quote(VAULT_NAME, safe='')}&file={quote(path_without_ext, safe='')}"


def _wikilink_warning(text: str) -> str | None:
    """Check a piece of text for broken [[wikilinks]] via POST /links/check.

    Scoped to just the text that changed (e.g. a patch's new_text, or content
    about to be appended) rather than the whole file, so the warning reflects
    only what the current write/patch/append actually introduced.

    Returns a human-readable warning listing each broken link (with fuzzy-matched
    suggestions when available), or None if the text has no broken links. Silently
    returns None on any request error — a failed link check shouldn't break the
    write/patch response it's attached to.
    """
    try:
        response = api_client.post(f"{OBSIDIAN_API_URL}/links/check", json={"text": text, "suggest": True})
        response.raise_for_status()
        broken = response.json().get("broken_links", [])
        if not broken:
            return None
        lines = [f"⚠ {len(broken)} broken wikilink{'s' if len(broken) != 1 else ''}:"]
        for link in broken:
            line = f"  [[{link['raw']}]]"
            suggestions = link.get("suggestions")
            if suggestions:
                line += f" — did you mean: {', '.join(suggestions)}?"
            lines.append(line)
        return "\n".join(lines)
    except Exception:
        return None


# ==================== RESOURCES ====================

@mcp.resource("obsidian://files")
def list_files() -> str:
    """List all markdown files in the vault"""
    try:
        response = api_client.get(f"{OBSIDIAN_API_URL}/files")
        response.raise_for_status()
        data = response.json()
        files = data.get("files", [])
        return f"Files in vault ({len(files)}):\n" + "\n".join(f"  - {f}" for f in files)
    except Exception as e:
        return f"Error listing files: {e}"

@mcp.resource("obsidian://health")
def vault_status() -> str:
    """Check vault sync status"""
    try:
        response = api_client.get(f"{OBSIDIAN_API_URL.replace('/api', '')}/health")
        response.raise_for_status()
        return f"Vault is healthy: {response.json()}"
    except Exception as e:
        return f"Vault error: {e}"

# ==================== TOOLS ====================

@mcp.tool()
def read_file(file_path: str, resolve_links: bool = True) -> str:
    """Read a markdown file from the vault

    By default, [[wikilinks]] in the file are also resolved server-side and
    returned as JSON: `{"content": str, "wikilinks": [{"raw", "target",
    "exists", "resolved", "ambiguous"?}]}`. `raw` is the link as written
    (e.g. `Note|Alias` or `folder/Note#Section`), `target` is it with the
    alias/heading anchor stripped, `resolved` is the actual note path if
    `exists` is True (Obsidian's shortest-path resolution can point `target`
    to a different folder than expected), and `ambiguous` — only present when
    relevant — lists every candidate path when multiple notes share a
    basename. `resolved` is None for broken links.

    Set resolve_links=False to skip this and get the raw markdown content
    only (no JSON envelope) — cheaper when you just need the text.

    Args:
        file_path: Path to the file relative to vault root (e.g., 'notes/my-note.md')
        resolve_links: Resolve [[wikilinks]] server-side and return as JSON (default: True)
    """
    import json

    try:
        params = {"resolve_links": "true"} if resolve_links else {}
        response = api_client.get(f"{OBSIDIAN_API_URL}/file/{file_path}", params=params)
        response.raise_for_status()
        data = response.json()

        if not resolve_links:
            return data.get("content", "")

        return json.dumps({
            "content": data.get("content", ""),
            "wikilinks": data.get("wikilinks", []),
        }, ensure_ascii=False, indent=2)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return f"File not found: {file_path}"
        return f"Error reading file: {e}"
    except Exception as e:
        return f"Error: {e}"

@mcp.tool()
def write_file(file_path: str, content: str) -> str:
    """Write or create a markdown file in the vault

    Args:
        file_path: Path where to save the file (e.g., 'notes/new-note.md')
        content: The markdown content to write
    """
    try:
        response = api_client.post(
            f"{OBSIDIAN_API_URL}/file/{file_path}",
            json={"content": content}
        )
        response.raise_for_status()
        message = f"File saved successfully: {file_path}"
        uri = _obsidian_uri(file_path)
        if uri:
            message += f"\nURL: {uri}"
        warning = _wikilink_warning(content)
        if warning:
            message += f"\n{warning}"
        return message
    except Exception as e:
        return f"Error writing file: {e}"

@mcp.tool()
def append_to_file(file_path: str, content: str) -> str:
    """Append content to an existing file

    Args:
        file_path: Path to the file
        content: Content to append
    """
    try:
        # Read current content
        read_response = api_client.get(f"{OBSIDIAN_API_URL}/file/{file_path}")
        read_response.raise_for_status()
        current_content = read_response.json().get("content", "")

        # Append and write back
        new_content = current_content + "\n" + content if current_content else content
        write_response = api_client.post(
            f"{OBSIDIAN_API_URL}/file/{file_path}",
            json={"content": new_content}
        )
        write_response.raise_for_status()
        message = f"Content appended to {file_path}"
        uri = _obsidian_uri(file_path)
        if uri:
            message += f"\nURL: {uri}"
        warning = _wikilink_warning(content)
        if warning:
            message += f"\n{warning}"
        return message
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            # File doesn't exist, create it
            write_response = api_client.post(
                f"{OBSIDIAN_API_URL}/file/{file_path}",
                json={"content": content}
            )
            write_response.raise_for_status()
            message = f"File created: {file_path}"
            uri = _obsidian_uri(file_path)
            if uri:
                message += f"\nURL: {uri}"
            warning = _wikilink_warning(content)
            if warning:
                message += f"\n{warning}"
            return message
        return f"Error appending: {e}"
    except Exception as e:
        return f"Error: {e}"

@mcp.tool()
def search_vault(query: str, fuzzy: bool = False, since: str = "", before: str = "") -> str:
    """Search for notes in the vault by keyword, with optional fuzzy matching and date filters.

    Regular search is case-insensitive and matches note content.
    Fuzzy search additionally scores notes by title similarity.

    Args:
        query: Text or keyword to search for
        fuzzy: Enable fuzzy matching on note titles in addition to content (default: False)
        since: Only return notes created on or after this date, format YYYY-MM-DD (optional)
        before: Only return notes created on or before this date, format YYYY-MM-DD (optional)
    """
    try:
        params: dict = {"q": query}
        if fuzzy:
            params["fuzzy"] = "true"
        if since:
            params["since"] = since
        if before:
            params["before"] = before

        response = api_client.get(f"{OBSIDIAN_API_URL}/search", params=params)
        response.raise_for_status()
        data = response.json()
        results = data.get("results", [])

        if not results:
            return f"No results found for: {query}"

        header = f"Found {len(results)} results for '{query}'"
        if fuzzy:
            header += " (fuzzy)"
        date_parts = []
        if since:
            date_parts.append(f"since {since}")
        if before:
            date_parts.append(f"before {before}")
        if date_parts:
            header += f" [{', '.join(date_parts)}]"
        output = header + ":\n"

        for result in results[:20]:
            line = f"\n  {result['file']}"
            if result.get("title") and result["title"] != result["file"].rsplit("/", 1)[-1].replace(".md", ""):
                line += f" — {result['title']}"
            if result.get("date"):
                line += f" [{result['date']}]"
            if result.get("score") is not None:
                line += f" (score: {result['score']})"
            output += line + "\n"
            for match in result.get("matches", []):
                if match:
                    output += f"    > {match}\n"

        return output
    except Exception as e:
        return f"Error searching: {e}"


@mcp.tool()
def list_directory(dir_path: str = "") -> str:
    """List the contents of a directory in the vault (files and subdirectories).

    Args:
        dir_path: Path to the directory relative to vault root (e.g., '10_Inbox' or '20_Projects/MyProject').
                  Leave empty to list the vault root.
    """
    try:
        endpoint = f"{OBSIDIAN_API_URL}/directory"
        if dir_path:
            endpoint = f"{endpoint}/{dir_path}"

        response = api_client.get(endpoint)
        response.raise_for_status()
        data = response.json()
        entries = data.get("entries", [])

        dirs = [e for e in entries if e["type"] == "directory"]
        files = [e for e in entries if e["type"] == "file"]

        output = f"Contents of '{data.get('path', '/')}' ({data.get('count', 0)} entries):\n"
        if dirs:
            output += "\nDirectories:\n"
            for d in dirs:
                output += f"  {d['name']}/\n"
        if files:
            output += "\nFiles:\n"
            for f in files:
                output += f"  {f['name']}\n"
        if not dirs and not files:
            output += "  (empty)\n"
        return output
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return f"Directory not found: {dir_path or '/'}"
        return f"Error listing directory: {e}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def create_folders(folder_paths: list[str]) -> str:
    """Create one or more folders in the vault, including any missing parent folders.

    Useful for scaffolding a directory structure in one call — e.g. a project
    skeleton made of several subfolders. Creating a folder that already exists
    is not an error. Processes up to 100 folders per call.

    Args:
        folder_paths: List of folder paths relative to vault root
                       (e.g., ["20_Projects/Alpha", "20_Projects/Alpha/Docs"])
    """
    try:
        response = api_client.post(
            f"{OBSIDIAN_API_URL}/folders",
            json={"paths": folder_paths}
        )
        response.raise_for_status()
        data = response.json()
        results = data.get("results", [])
        total = data.get("count", 0)

        ok = [r for r in results if r.get("success")]
        failed = [r for r in results if r.get("error")]

        lines = [f"Folder creation: {len(ok)}/{total} succeeded"]
        for r in ok:
            note = " (already existed)" if r.get("already_existed") else ""
            lines.append(f"  OK {r['path']}{note}")
        for r in failed:
            lines.append(f"  FAIL {r['path']}: {r['error']}")
        return "\n".join(lines)
    except httpx.HTTPStatusError as e:
        return f"Error: {e}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def delete_folders(folder_paths: list[str], hard: bool = False) -> str:
    """Delete one or more folders from the vault, recursively.

    By default this is a SOFT delete: each folder tree is moved to a hidden
    `.trash/` folder inside the vault (not indexed, recoverable). Set
    `hard=True` to remove them permanently instead. Processes up to 100
    folders per call.

    Args:
        folder_paths: List of folder paths relative to vault root
                       (e.g., ["20_Projects/Alpha", "20_Projects/Beta"])
        hard: Permanently delete instead of moving to .trash/ (default: False)
    """
    try:
        response = api_client.request(
            "DELETE",
            f"{OBSIDIAN_API_URL}/folders",
            params={"hard": "true"} if hard else None,
            json={"paths": folder_paths},
        )
        response.raise_for_status()
        data = response.json()
        results = data.get("results", [])
        total = data.get("count", 0)

        ok = [r for r in results if r.get("success")]
        failed = [r for r in results if r.get("error")]

        lines = [f"Folder deletion: {len(ok)}/{total} succeeded"]
        for r in ok:
            if r.get("mode") == "soft":
                lines.append(f"  OK {r['path']} → moved to {r.get('trashed_to')}")
            else:
                lines.append(f"  OK {r['path']} (permanently deleted)")
        for r in failed:
            lines.append(f"  FAIL {r['path']}: {r['error']}")
        return "\n".join(lines)
    except httpx.HTTPStatusError as e:
        return f"Error: {e}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def move_folders(moves: list[dict[str, str]]) -> str:
    """Move or rename one or more folders within the vault.

    Each entry renames/relocates one folder to its own destination — use this
    to restructure a vault (rename a project folder, regroup subfolders under
    a new parent, etc.). Any missing parent folders in the destination are
    created automatically. Processes up to 100 moves per call.

    Args:
        moves: List of {"from": ..., "to": ...} dicts, both paths relative to
               vault root (e.g., [{"from": "20_Projects/Alpha", "to": "20_Projects/AlphaRenamed"}])
    """
    try:
        response = api_client.post(
            f"{OBSIDIAN_API_URL}/folders/move",
            json={"moves": moves}
        )
        response.raise_for_status()
        data = response.json()
        results = data.get("results", [])
        total = data.get("count", 0)

        ok = [r for r in results if r.get("success")]
        failed = [r for r in results if r.get("error")]

        lines = [f"Folder move: {len(ok)}/{total} succeeded"]
        for r in ok:
            lines.append(f"  OK {r['from']} → {r['to']}")
        for r in failed:
            lines.append(f"  FAIL {r.get('from')} → {r.get('to')}: {r['error']}")
        return "\n".join(lines)
    except httpx.HTTPStatusError as e:
        return f"Error: {e}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def get_projects() -> str:
    """Get all project folders from the 20_Projects directory, with their vault path.

    Returns a list of project names and their paths relative to the vault root.
    """
    try:
        response = api_client.get(f"{OBSIDIAN_API_URL}/projects")
        response.raise_for_status()
        data = response.json()
        projects = data.get("projects", [])

        if not projects:
            return "No projects found in 20_Projects/"

        output = f"Projects ({len(projects)}):\n"
        for p in projects:
            output += f"\n  {p['name']}\n    Path: {p['path']}\n"
        return output
    except Exception as e:
        return f"Error getting projects: {e}"

@mcp.tool()
def update_frontmatter(file_path: str, updates: dict) -> str:
    """Update specific frontmatter fields of a file without touching the body.

    Merges the provided fields into the existing frontmatter — existing fields not
    mentioned in `updates` are preserved. To delete a field, set its value to null.

    Args:
        file_path: Path to the file relative to vault root (e.g., 'notes/my-note.md')
        updates: Dictionary of frontmatter fields to set or update (e.g., {"status": "done", "tags": ["a", "b"]})
    """
    try:
        response = api_client.patch(
            f"{OBSIDIAN_API_URL}/file/{file_path}",
            json=updates
        )
        response.raise_for_status()
        data = response.json()
        fm = data.get("frontmatter", {})
        fields = ", ".join(f"{k}={v!r}" for k, v in fm.items())
        message = f"Frontmatter updated for {file_path}: {fields}"
        uri = _obsidian_uri(file_path)
        if uri:
            message += f"\nURL: {uri}"
        return message
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return f"File not found: {file_path}"
        return f"Error updating frontmatter: {e}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def bulk_update_frontmatter(file_paths: list[str], updates: dict) -> str:
    """Apply the same frontmatter changes to multiple files at once.

    Merges `updates` into the frontmatter of every file in `file_paths`.
    Existing fields not in `updates` are preserved. Processes up to 100 files.

    Args:
        file_paths: List of file paths relative to vault root
                    (e.g., ["notes/a.md", "notes/b.md"])
        updates: Frontmatter fields to set on all files
                 (e.g., {"status": "archive", "reviewed": True})
    """
    try:
        response = api_client.patch(
            f"{OBSIDIAN_API_URL}/files/batch",
            json={"paths": file_paths, "frontmatter": updates}
        )
        response.raise_for_status()
        data = response.json()
        results = data.get("results", [])
        total = data.get("count", 0)

        ok = [r for r in results if r.get("success")]
        failed = [r for r in results if r.get("error")]

        lines = [f"Bulk frontmatter update: {len(ok)}/{total} succeeded"]
        for r in ok:
            line = f"  OK {r['path']}"
            uri = _obsidian_uri(r['path'])
            if uri:
                line += f" — {uri}"
            lines.append(line)
        for r in failed:
            lines.append(f"  FAIL {r['path']}: {r['error']}")
        return "\n".join(lines)
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def patch_file(file_path: str, old_text: str, new_text: str, replace_all: bool = False) -> str:
    """Replace a specific piece of text in a file — surgical edit without touching the rest.

    Searches for `old_text` in the file content and replaces it with `new_text`. By
    default only the first occurrence is replaced; set `replace_all` to replace every
    occurrence. Works on any part of the file (frontmatter or body), at any granularity:
    a word, a sentence, a whole section. The replacement is performed atomically on the
    server (no read-modify-write race).

    Returns an error if `old_text` is not found, so you know the edit didn't apply silently.

    Args:
        file_path: Path to the file relative to vault root (e.g., 'notes/my-note.md')
        old_text: Exact text to find (must match precisely, including whitespace)
        new_text: Text to replace it with (use an empty string to delete the matched text)
        replace_all: Replace every occurrence instead of just the first (default: False)
    """
    try:
        response = _patch_request(file_path, old_text, new_text, replace_all)

        if response.status_code == 404:
            return f"File not found: {file_path}"
        if response.status_code == 422:
            return f"Text not found in {file_path} — no changes made"
        if response.status_code == 400:
            return f"Invalid patch request: {response.json().get('error', 'bad request')}"

        response.raise_for_status()
        data = response.json()
        count = data.get("replacements", 0)
        message = f"Patched {file_path} ({count} replacement{'s' if count != 1 else ''})"
        uri = _obsidian_uri(file_path)
        if uri:
            message += f"\nURL: {uri}"
        warning = _wikilink_warning(new_text)
        if warning:
            message += f"\n{warning}"
        return message
    except httpx.HTTPStatusError as e:
        return f"Error: {e}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def move_file(file_path: str, destination: str) -> str:
    """Move (or rename) a file within the vault.

    Renames `file_path` to `destination`, both relative to the vault root. Any
    missing parent folders in the destination are created automatically. Use this
    to relocate a note to another folder or to rename it (move to a new name in
    the same folder).

    Args:
        file_path: Current path relative to vault root (e.g., '00_Inbox/idea.md')
        destination: New path relative to vault root (e.g., '20_Projects/Alpha/idea.md')
    """
    try:
        response = api_client.post(
            f"{OBSIDIAN_API_URL}/file/{file_path}/move",
            json={"destination": destination}
        )

        if response.status_code == 404:
            return f"File not found: {file_path}"
        if response.status_code == 400:
            return f"Invalid move request: {response.json().get('error', 'bad request')}"
        if response.status_code == 403:
            return f"Access denied: {response.json().get('error', 'path outside vault')}"

        response.raise_for_status()
        data = response.json()
        to_path = data.get('to', destination)
        message = f"Moved {data.get('from', file_path)} → {to_path}"
        uri = _obsidian_uri(to_path)
        if uri:
            message += f"\nURL: {uri}"
        return message
    except httpx.HTTPStatusError as e:
        return f"Error: {e}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def delete_file(file_path: str, hard: bool = False) -> str:
    """Delete a file from the vault.

    By default this is a SOFT delete: the file is moved to a hidden `.trash/`
    folder inside the vault (not indexed, recoverable). Set `hard=True` to remove
    it permanently instead. Either way the change syncs to your other devices.

    Args:
        file_path: Path to the file relative to vault root (e.g., '00_Inbox/old.md')
        hard: Permanently delete instead of moving to .trash/ (default: False)
    """
    try:
        params = {"hard": "true"} if hard else None
        response = api_client.delete(f"{OBSIDIAN_API_URL}/file/{file_path}", params=params)

        if response.status_code == 404:
            return f"File not found: {file_path}"
        if response.status_code == 403:
            return f"Access denied: {response.json().get('error', 'path outside vault')}"
        if response.status_code == 400:
            return f"Cannot delete {file_path}: {response.json().get('error', 'bad request')}"

        response.raise_for_status()
        data = response.json()
        if data.get("mode") == "soft":
            return f"Moved {file_path} to {data.get('trashed_to', '.trash/')} (soft delete)"
        return f"Permanently deleted {file_path}"
    except httpx.HTTPStatusError as e:
        return f"Error: {e}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def query_vault(sql: str) -> str:
    """Execute a SQL SELECT query against the vault index.

    The index has two tables:
      - files: path, title, created, modified, tags (JSON array), frontmatter (JSON object)
      - tasks: file_path, text, completed (0=open / 1=done), due (YYYY-MM-DD or null)

    Useful JSON operators: json_extract(frontmatter, '$.status'), tags LIKE '%"active"%'

    Only SELECT statements are allowed.

    Args:
        sql: SQL SELECT statement to run against the vault index
    """
    try:
        response = api_client.post(f"{OBSIDIAN_API_URL}/query", json={"sql": sql})
        response.raise_for_status()
        data = response.json()
        results = data.get("results", [])

        if not results:
            return "No results"

        headers = list(results[0].keys())
        rows = [[str(r.get(h) if r.get(h) is not None else "") for h in headers] for r in results]
        col_widths = [max(len(h), max((len(r[i]) for r in rows), default=0)) for i, h in enumerate(headers)]

        header_line = " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers))
        separator   = "-+-".join("-" * w for w in col_widths)
        row_lines   = [" | ".join(r[i].ljust(col_widths[i]) for i in range(len(headers))) for r in rows]

        return f"{len(results)} result(s):\n\n{header_line}\n{separator}\n" + "\n".join(row_lines)
    except httpx.HTTPStatusError as e:
        return f"Query error: {e.response.text}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def run_index(file_path: str, section: str = "") -> str:
    """List or execute SQL queries embedded in an _index.md file.

    _index.md files pair Dataview blocks (rendered in Obsidian) with ```sql blocks
    (executable by agents). Sections are identified by their nearest preceding heading.

    - Without `section`: lists all available sections and their status (SQL ready / Dataview only).
    - With `section`: executes the SQL for that section, or shows the Dataview query if no SQL exists yet.

    Args:
        file_path: Path to the _index.md file relative to vault root (e.g., '20_Projects/_index.md')
        section:   Heading name to execute (case-insensitive). Leave empty to list sections.
    """
    import re

    def parse_sections(content: str) -> list[dict]:
        """Return list of {heading, sql, dataview} dicts, one per heading that has at least one block."""
        # Split into chunks at each heading line
        heading_re = re.compile(r'^(#{1,6} .+)$', re.MULTILINE)
        positions = [(m.start(), m.group(1).lstrip('#').strip()) for m in heading_re.finditer(content)]

        # Add a sentinel at the end
        boundaries = positions + [(len(content), None)]

        sections = []
        for i, (start, heading) in enumerate(positions):
            chunk = content[start:boundaries[i + 1][0]]

            sql_match = re.search(r'```sql\n([\s\S]*?)```', chunk)
            dv_match  = re.search(r'```dataview\n([\s\S]*?)```', chunk)

            if sql_match or dv_match:
                sql_raw = sql_match.group(1) if sql_match else None
                # Strip inline SQL comments
                sql_clean = None
                if sql_raw:
                    sql_clean = '\n'.join(
                        l for l in sql_raw.split('\n') if not l.strip().startswith('--')
                    ).strip()
                sections.append({
                    "heading":  heading,
                    "sql":      sql_clean,
                    "dataview": dv_match.group(1).strip() if dv_match else None,
                })

        return sections

    try:
        response = api_client.get(f"{OBSIDIAN_API_URL}/file/{file_path}")
        response.raise_for_status()
        content = response.json().get("content", "")
        sections = parse_sections(content)

        if not sections:
            return f"No Dataview or SQL sections found in {file_path}"

        # -- List mode --
        if not section:
            lines = [f"Sections in {file_path}:\n"]
            for s in sections:
                if s["sql"]:
                    lines.append(f"  ✓ {s['heading']}  (SQL ready)")
                else:
                    lines.append(f"  ~ {s['heading']}  (Dataview only — no SQL yet)")
            return "\n".join(lines)

        # -- Execute mode --
        target = section.strip().lower()
        match = next((s for s in sections if s["heading"].lower() == target), None)
        if not match:
            available = ", ".join(f'"{s["heading"]}"' for s in sections)
            return f'Section "{section}" not found. Available: {available}'

        if match["sql"]:
            return query_vault(match["sql"])

        # Dataview only — return the query so the agent knows what it does
        return (
            f'Section "{match["heading"]}" has no SQL block yet.\n\n'
            f'Dataview query:\n```dataview\n{match["dataview"]}\n```'
        )

    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return f"File not found: {file_path}"
        return f"Error: {e}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def extract_tasks(file_path: str, isolate_tags: bool = False) -> str:
    """Extract markdown checklist items (- [ ] / - [x]) from a file, as JSON.

    Only lines matching Obsidian's checkbox syntax — `- [ ]` (unchecked) or
    `- [x]` / `- [X]` (checked) — are returned; plain bullet points without a
    checkbox are skipped. Each task is `{"checked": bool, "text": str, "tags": [...]}`.

    Some checklists (notably vacation packing lists) embed extra bracket tags in
    the task text, e.g. `[if:plage]`, `[require:passeport]` — any content in
    `[...]`, not limited to a fixed set of keywords. Set `isolate_tags=True` to
    pull every such bracket group out of the task text into the `tags` array
    (as raw strings, e.g. `["if:plage", "require:passeport"]`) instead of
    leaving it inline in `text`.

    Args:
        file_path: Path to the file relative to vault root (e.g., 'perso/voyage.md')
        isolate_tags: Extract inline [...] bracket tags into the `tags` array and
                      strip them out of `text` (default: False — left inline)
    """
    import json
    import re

    checkbox_re = re.compile(r'^\s*-\s+\[([ xX])\]\s*(.*)$')
    tag_re = re.compile(r'\[([^\[\]]+)\]')

    try:
        response = api_client.get(f"{OBSIDIAN_API_URL}/file/{file_path}")
        response.raise_for_status()
        content = response.json().get("content", "")

        tasks = []

        for line in content.split("\n"):
            checkbox_match = checkbox_re.match(line)
            if not checkbox_match:
                continue

            checked = checkbox_match.group(1).lower() == "x"
            text = checkbox_match.group(2).strip()

            tags = []
            if isolate_tags:
                tags = [t.strip() for t in tag_re.findall(text)]
                text = tag_re.sub("", text)
                text = re.sub(r'\s{2,}', ' ', text).strip()

            tasks.append({
                "checked": checked,
                "text": text,
                "tags": tags,
            })

        return json.dumps({"tasks": tasks}, ensure_ascii=False, indent=2)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return json.dumps({"error": f"File not found: {file_path}"})
        return json.dumps({"error": f"Error reading file: {e}"})
    except Exception as e:
        return json.dumps({"error": f"Error: {e}"})


@mcp.tool()
def extract_comments(file_path: str = None, file_paths: list[str] = None, folder: str = None) -> str:
    """Extract Document Comment plugin comment threads from one or more files, as JSON.

    Provide exactly one of:
    - file_path: a single file to inspect
    - file_paths: an explicit list of files (e.g., ["notes/a.md", "notes/b.md"])
    - folder: a folder path, scanned recursively for every .md file in it
              (e.g. '20_Projects/MyProject')

    Recognizes the plugin's two markers: an anchor span
    `<!--c:ID-->text<!--/c:ID-->` wrapping the commented passage, and a thread
    block `<!--co:ID by:author at:timestamp status:status quote:"..."` followed
    by one reply line per participant (`Author (timestamp): text`), closed by
    `-->`.

    Returns `{"files": [{"path", "comments": [...]}], "scanned_count",
    "files_with_comments_count"}`. Files with zero comment threads are omitted
    from `files` to keep the response focused — a single-file call with no
    comments returns an empty `files` list, not an error; `scanned_count`
    still reflects every file looked at.

    Each comment is `{"id", "status", "quote", "created_by", "created_at",
    "anchored_text", "replies": [{"author", "at", "text"}]}`. `quote` is the
    snapshot of the anchored text taken when the thread was created;
    `anchored_text` is what the `c:ID` span currently wraps in the body — the
    two can diverge if the passage was edited afterward. `anchored_text` is
    `null` if no matching span is found (e.g. the anchor was removed).

    Args:
        file_path: Single file path relative to vault root. Mutually exclusive
                   with file_paths/folder.
        file_paths: List of file paths relative to vault root. Mutually
                    exclusive with file_path/folder.
        folder: Folder path relative to vault root, scanned recursively.
                Mutually exclusive with file_path/file_paths.
    """
    import json

    if len([p for p in (file_path, file_paths, folder) if p]) != 1:
        return json.dumps({"error": "Provide exactly one of file_path, file_paths, or folder"})

    try:
        if file_path:
            paths = [file_path]
        elif folder:
            response = api_client.get(f"{OBSIDIAN_API_URL}/files", params={"path": folder})
            response.raise_for_status()
            paths = [f["path"] for f in response.json().get("files", [])]
        else:
            paths = file_paths

        if not paths:
            return json.dumps({"files": [], "scanned_count": 0, "files_with_comments_count": 0})

        results = []
        BATCH_SIZE = 100
        for i in range(0, len(paths), BATCH_SIZE):
            batch = paths[i:i + BATCH_SIZE]
            response = api_client.post(f"{OBSIDIAN_API_URL}/files/batch", json={"paths": batch})
            response.raise_for_status()
            results.extend(response.json().get("files", []))

        files_with_comments = []
        errors = []
        for entry in results:
            if entry.get("error"):
                errors.append({"path": entry["path"], "error": entry["error"]})
                continue

            comments = _parse_comment_threads(entry.get("content", ""))
            if comments:
                files_with_comments.append({"path": entry["path"], "comments": comments})

        output = {
            "files": files_with_comments,
            "scanned_count": len(results),
            "files_with_comments_count": len(files_with_comments),
        }
        if errors:
            output["errors"] = errors

        return json.dumps(output, ensure_ascii=False, indent=2)
    except httpx.HTTPStatusError as e:
        return json.dumps({"error": f"Error: {e}"})
    except Exception as e:
        return json.dumps({"error": f"Error: {e}"})


def _read_raw_content(file_path: str) -> tuple[str | None, str | None]:
    """Fetch a file's raw content for the comment write tools. Returns (content, error) —
    exactly one is None."""
    try:
        response = api_client.get(f"{OBSIDIAN_API_URL}/file/{file_path}")
        response.raise_for_status()
        return response.json().get("content", ""), None
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return None, f"File not found: {file_path}"
        return None, f"Error reading file: {e}"
    except Exception as e:
        return None, f"Error: {e}"


@mcp.tool()
def create_comment(file_path: str, quote: str, text: str, author: str = "agent") -> str:
    """Create a new Document Comment plugin thread anchored to a passage of text.

    Wraps the first occurrence of `quote` with the plugin's anchor markers
    (`<!--c:ID-->quote<!--/c:ID-->`) and inserts a comment thread block right after it,
    producing output fully compatible with the Obsidian "Document Comments" plugin
    (https://github.com/kylemcd/obsidian-document-comments) — threads created here show
    up and are editable in the plugin, and vice versa.

    `quote` must match the file's raw text exactly (including whitespace) — use
    `read_file` first if unsure. If `quote` occurs more than once, only the first
    occurrence is anchored; narrow the quote to target a different spot.

    Returns the new thread's ID, which `reply_to_comment`, `set_comment_status`, and
    `delete_comment` all take as `comment_id`.

    Args:
        file_path: Path to the file relative to vault root
        quote: Exact text to anchor the comment to (must appear verbatim in the file)
        text: The comment's text
        author: Name to attribute the comment to (default: "agent")
    """
    content, error = _read_raw_content(file_path)
    if error:
        return error

    occurrences = content.count(quote)
    if occurrences == 0:
        return f"Quote not found in {file_path} — it must match the file's text exactly"

    existing_ids = set(re.findall(r"<!--(?:c|/c|co):([A-Za-z0-9]+)", content))
    comment_id = _generate_comment_id(existing_ids)

    author_token = _sanitize_token(author)
    ts = _now_iso()
    anchored = f"<!--c:{comment_id}-->{quote}<!--/c:{comment_id}-->"
    body_block = (
        f'<!--co:{comment_id} by:{author_token} at:{ts} status:open quote:"{_sanitize_quote(quote)}"\n'
        f"{author_token} ({ts}): {_escape_entry_text(text)}\n"
        f"-->"
    )

    try:
        response = _patch_request(file_path, quote, f"{anchored}\n{body_block}", replace_all=False)
        if response.status_code == 404:
            return f"File not found: {file_path}"
        if response.status_code == 422:
            return f"Quote not found in {file_path} — it must match the file's text exactly"
        response.raise_for_status()
    except Exception as e:
        return f"Error creating comment: {e}"

    message = f"Comment created in {file_path} (id: {comment_id})"
    if occurrences > 1:
        message += f"\nNote: quote appeared {occurrences} times — anchored to the first occurrence"
    uri = _obsidian_uri(file_path)
    if uri:
        message += f"\nURL: {uri}"
    return message


@mcp.tool()
def reply_to_comment(file_path: str, comment_id: str, text: str, author: str = "agent") -> str:
    """Add a reply to an existing Document Comment plugin thread.

    Appends a new entry to the thread in place — the plugin renders entries in order,
    most recent last. Does not change the thread's status; use `set_comment_status` to
    resolve or reopen it.

    Args:
        file_path: Path to the file relative to vault root
        comment_id: The thread's ID, as returned by create_comment or extract_comments
        text: The reply text
        author: Name to attribute the reply to (default: "agent")
    """
    content, error = _read_raw_content(file_path)
    if error:
        return error

    match = _comment_block_pattern(comment_id).search(content)
    if not match:
        return f"Comment not found: {comment_id} in {file_path}"

    leading_nl = "\n" if match.group(0).startswith("\n") else ""
    header_rest, body = match.group(1), match.group(2)

    author_token = _sanitize_token(author)
    entry_line = f"{author_token} ({_now_iso()}): {_escape_entry_text(text)}"
    stripped_body = body.strip("\n")
    new_body = f"{stripped_body}\n{entry_line}\n" if stripped_body else f"{entry_line}\n"
    new_block = f"{leading_nl}<!--co:{comment_id}{header_rest}\n{new_body}-->"

    try:
        response = _patch_request(file_path, match.group(0), new_block, replace_all=False)
        response.raise_for_status()
    except Exception as e:
        return f"Error replying to comment: {e}"

    message = f"Reply added to comment {comment_id} in {file_path}"
    uri = _obsidian_uri(file_path)
    if uri:
        message += f"\nURL: {uri}"
    return message


@mcp.tool()
def set_comment_status(file_path: str, comment_id: str, resolved: bool) -> str:
    """Resolve or reopen a Document Comment plugin thread — this is how the plugin
    represents "closing" a comment.

    Only the thread's status changes; the anchored text, its quote, and every reply are
    left untouched (matching the plugin's own resolve/reopen toggle). To remove a thread
    entirely instead, use `delete_comment`.

    Args:
        file_path: Path to the file relative to vault root
        comment_id: The thread's ID, as returned by create_comment or extract_comments
        resolved: True to mark the thread resolved ("closed"), False to reopen it
    """
    content, error = _read_raw_content(file_path)
    if error:
        return error

    match = _comment_block_pattern(comment_id).search(content)
    if not match:
        return f"Comment not found: {comment_id} in {file_path}"

    leading_nl = "\n" if match.group(0).startswith("\n") else ""
    header_rest, body = match.group(1), match.group(2)
    new_status = "resolved" if resolved else "open"
    currently_resolved = bool(re.search(r"status:resolved(?:\s|$)", header_rest))
    if currently_resolved == resolved:
        return f"Comment {comment_id} in {file_path} is already {new_status}"

    if re.search(r"status:\S+", header_rest):
        new_header_rest = re.sub(r"status:\S+", f"status:{new_status}", header_rest, count=1)
    else:
        new_header_rest = header_rest + f" status:{new_status}"
    new_block = f"{leading_nl}<!--co:{comment_id}{new_header_rest}\n{body}-->"

    try:
        response = _patch_request(file_path, match.group(0), new_block, replace_all=False)
        response.raise_for_status()
    except Exception as e:
        return f"Error updating comment status: {e}"

    message = f"Comment {comment_id} in {file_path} marked {new_status}"
    uri = _obsidian_uri(file_path)
    if uri:
        message += f"\nURL: {uri}"
    return message


@mcp.tool()
def delete_comment(file_path: str, comment_id: str) -> str:
    """Delete a Document Comment plugin thread entirely.

    Removes the anchor markers and the whole thread block, leaving the previously
    anchored text in place as plain markdown — matching the plugin's own delete
    behavior. This cannot be undone; to close a thread without losing its history, use
    `set_comment_status` instead.

    Args:
        file_path: Path to the file relative to vault root
        comment_id: The thread's ID, as returned by create_comment or extract_comments
    """
    content, error = _read_raw_content(file_path)
    if error:
        return error

    open_tag = f"<!--c:{comment_id}-->"
    close_tag = f"<!--/c:{comment_id}-->"
    body_pattern = _comment_block_pattern(comment_id)

    if open_tag not in content and close_tag not in content and not body_pattern.search(content):
        return f"Comment not found: {comment_id} in {file_path}"

    new_content = body_pattern.sub("", content)
    new_content = new_content.replace(open_tag, "").replace(close_tag, "")

    try:
        response = api_client.post(f"{OBSIDIAN_API_URL}/file/{file_path}", json={"content": new_content})
        response.raise_for_status()
    except Exception as e:
        return f"Error deleting comment: {e}"

    message = f"Comment {comment_id} deleted from {file_path}"
    uri = _obsidian_uri(file_path)
    if uri:
        message += f"\nURL: {uri}"
    return message


@mcp.tool()
def sync_vault() -> str:
    """Manually trigger a vault sync with Obsidian Sync service"""
    try:
        response = api_client.post(f"{OBSIDIAN_API_URL}/sync")
        response.raise_for_status()
        return "Vault synchronized successfully"
    except Exception as e:
        return f"Error syncing vault: {e}"

@mcp.tool()
def get_sync_status() -> str:
    """Get the current sync status of the vault, plus the health of the SQLite
    index and its file watcher.

    The watcher has occasionally stopped picking up file changes silently
    (e.g. inotify not propagating across Docker bind mounts), leaving the
    index — and therefore search_vault/query_vault — stale without any
    visible error. This surfaces whether the watcher is still alive, when it
    last processed a file, its last error (if any), and whether the indexed
    file count matches the vault's actual file count.
    """
    try:
        response = api_client.get(f"{OBSIDIAN_API_URL}/sync/status")
        response.raise_for_status()
        data = response.json()

        lines = [f"Obsidian Sync: {data.get('status', 'Unknown status')}"]
        if data.get("error"):
            lines.append(f"  Sync error: {data['error']}")

        indexer = data.get("indexer") or {}
        if indexer.get("error"):
            lines.append(f"Index status: error — {indexer['error']}")
            return "\n".join(lines)

        lines.append("")
        lines.append(f"Index watcher: {'ready' if indexer.get('watcher_ready') else 'not ready'}"
                      f"{' (closed!)' if indexer.get('watcher_closed') else ''}")
        lines.append(f"Indexed files: {indexer.get('db_file_count')} / vault files: {indexer.get('vault_file_count')}"
                      f" ({'in sync' if indexer.get('in_sync') else 'MISMATCH — index may be stale'})")

        last_event = indexer.get("last_event")
        if last_event:
            lines.append(f"Last index event: {last_event.get('type')} {last_event.get('path') or ''} at {last_event.get('at')}")
        else:
            lines.append("Last index event: none recorded")

        last_error = indexer.get("last_error")
        if last_error:
            lines.append(f"Last index error: {last_error.get('message')} at {last_error.get('at')}")

        return "\n".join(lines)
    except Exception as e:
        return f"Error getting sync status: {e}"

@mcp.tool()
def list_webhooks() -> str:
    """List active vault-change webhooks (read-only; secrets are redacted).

    Webhooks are created and managed through the REST API, not from MCP."""
    try:
        response = api_client.get(f"{OBSIDIAN_API_URL}/webhooks")
        response.raise_for_status()
        return response.text
    except Exception as e:
        return f"Error listing webhooks: {e}"

# ==================== RUN ====================

ROLES_CLAIM = "urn:zitadel:iam:org:project:roles"
_USERINFO_CACHE_TTL = 45  # seconds — short-lived cache to avoid hitting /userinfo on every request
_userinfo_cache: dict[str, tuple[float, dict | None]] = {}


async def _fetch_userinfo(token: str) -> dict | None:
    """Validate a bearer token against Zitadel's /oidc/v1/userinfo and return the
    claims, or None if the token is invalid/expired. Results are cached briefly,
    keyed by a hash of the token (never the token itself) — never log the raw token."""
    import hashlib
    import time

    token_hash = hashlib.sha256(token.encode()).hexdigest()
    now = time.monotonic()
    cached = _userinfo_cache.get(token_hash)
    if cached and cached[0] > now:
        return cached[1]

    userinfo = None
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{ZITADEL_ISSUER}/oidc/v1/userinfo",
                headers={"Authorization": f"Bearer {token}"},
            )
        if response.status_code == 200:
            userinfo = response.json()
    except httpx.HTTPError:
        userinfo = None

    _userinfo_cache[token_hash] = (now + _USERINFO_CACHE_TTL, userinfo)
    return userinfo


def _protected_resource_metadata_url() -> str:
    return f"{MCP_PUBLIC_URL.rstrip('/')}/.well-known/oauth-protected-resource"


class AuthMiddleware:
    """Accepts two authentication schemes, checked in this order:

    1. Legacy static token (kept for continuity — Claude Code CLI / Codex CLI use this
       today, and it's simpler for them than OAuth):
         - token as URL path prefix /{API_TOKEN}/...
         - `Authorization: Bearer <API_TOKEN>` exact match
       The URL-path variant is intended to be removed later; the static bearer token
       is intended to stay.

    2. OAuth 2.1 resource-server flow (MCP spec, revisions 2025-06 / 2025-11), used by
       clients like claude.ai: any other bearer token is validated against Zitadel's
       /oidc/v1/userinfo endpoint. Zitadel is the authorization server; this server
       never handles login, it only validates the token presented on each request.

       Zitadel doesn't support RFC 8707 resource indicators, so a token issued for the
       shared `Claude-web` client can carry an audience covering every MCP server in the
       `mcp-servers` project — not just this one. A valid, correctly-signed token is
       therefore NOT sufficient proof of authorization here: we must explicitly check
       for the `obsidian:access` project role in the userinfo response, otherwise a
       token minted for a different MCP server could be replayed against this one
       (confused deputy)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")

        if path == "/.well-known/oauth-protected-resource":
            await self._send_metadata(send)
            return

        headers = scope.get("headers", [])
        auth_header = next(
            (v for k, v in headers if k.lower() == b"authorization"),
            None,
        )
        bearer_token = None
        if auth_header:
            try:
                decoded = auth_header.decode("latin-1").strip()
            except Exception:
                decoded = ""
            if decoded.lower().startswith("bearer "):
                bearer_token = decoded[7:].strip()

        # -- 1. Legacy static token (path prefix or exact bearer match) --
        path_has_static_token = bool(API_TOKEN) and path.startswith(f"/{API_TOKEN}")
        header_matches_static = bool(API_TOKEN) and bearer_token == API_TOKEN

        if path_has_static_token or header_matches_static:
            scope = dict(scope)
            if path_has_static_token:
                new_path = path[len(f"/{API_TOKEN}"):] or "/"
                scope["path"] = new_path
                raw_path = scope.get("raw_path", path.encode())
                scope["raw_path"] = raw_path[len(f"/{API_TOKEN}".encode()):] or b"/"
            new_headers = [(k, v) for k, v in headers if k.lower() != b"host"]
            new_headers.append((b"host", b"localhost"))
            scope["headers"] = new_headers
            await self.app(scope, receive, send)
            return

        # -- 2. OAuth 2.1 (Zitadel) --
        if not bearer_token:
            await self._send_401(send, "invalid_request", "Missing bearer token")
            return

        userinfo = await _fetch_userinfo(bearer_token)
        if userinfo is None:
            await self._send_401(send, "invalid_token", "Token is invalid or expired")
            return

        roles = userinfo.get(ROLES_CLAIM) or {}
        if OAUTH_REQUIRED_ROLE not in roles:
            await self._send_403(send)
            return

        scope = dict(scope)
        # Replace Host header with localhost to bypass FastMCP DNS rebinding protection
        new_headers = [(k, v) for k, v in headers if k.lower() != b"host"]
        new_headers.append((b"host", b"localhost"))
        scope["headers"] = new_headers
        await self.app(scope, receive, send)

    async def _send_metadata(self, send):
        import json

        body = json.dumps({
            "resource": MCP_PUBLIC_URL,
            "authorization_servers": [ZITADEL_ISSUER],
        }).encode()
        await send({
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"application/json")],
        })
        await send({"type": "http.response.body", "body": body})

    async def _send_401(self, send, error, description):
        www_auth = (
            f'Bearer error="{error}", error_description="{description}", '
            f'resource_metadata="{_protected_resource_metadata_url()}"'
        )
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [(b"www-authenticate", www_auth.encode())],
        })
        await send({"type": "http.response.body", "body": description.encode()})

    async def _send_403(self, send):
        import json

        body = json.dumps({
            "error": "forbidden",
            "error_description": f"Missing required role: {OAUTH_REQUIRED_ROLE}",
        }).encode()
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [(b"content-type", b"application/json")],
        })
        await send({"type": "http.response.body", "body": body})


if __name__ == "__main__":
    import uvicorn

    if not MCP_PUBLIC_URL:
        print("⚠️  MCP_PUBLIC_URL is not set — the OAuth protected-resource metadata will be invalid")

    print(f"Starting Obsidian MCP Server on port {PORT}")
    print(f"Connected to Obsidian API at: {OBSIDIAN_API_URL}")
    print(f"🔐 Authentication: legacy static token (path/Bearer) + OAuth 2.1 via Zitadel ({ZITADEL_ISSUER}), role required: {OAUTH_REQUIRED_ROLE}")

    mcp_app = mcp.streamable_http_app()
    app = AuthMiddleware(mcp_app)

    uvicorn.run(app, host="0.0.0.0", port=PORT)
