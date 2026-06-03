#!/usr/bin/env python3

import httpx
import os
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

# Configuration
OBSIDIAN_API_URL = os.getenv("OBSIDIAN_API_URL", "http://localhost:3000/api")
PORT = int(os.getenv("PORT", 3001))
API_TOKEN = os.getenv("API_TOKEN", "")

# HTTP client with auth header for all calls to obsidian-api
api_client = httpx.Client(headers={"Authorization": f"Bearer {API_TOKEN}"})

# Create MCP server — DNS rebinding protection disabled because token auth is handled
# by TokenAuthMiddleware (token required either in URL path or Authorization header)
mcp = FastMCP("Obsidian", transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False))

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
def read_file(file_path: str) -> str:
    """Read a markdown file from the vault

    Args:
        file_path: Path to the file relative to vault root (e.g., 'notes/my-note.md')
    """
    try:
        response = api_client.get(f"{OBSIDIAN_API_URL}/file/{file_path}")
        response.raise_for_status()
        data = response.json()
        return data.get("content", "")
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
        return f"File saved successfully: {file_path}"
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
        return f"Content appended to {file_path}"
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            # File doesn't exist, create it
            write_response = api_client.post(
                f"{OBSIDIAN_API_URL}/file/{file_path}",
                json={"content": content}
            )
            write_response.raise_for_status()
            return f"File created: {file_path}"
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
        return f"Frontmatter updated for {file_path}: {fields}"
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return f"File not found: {file_path}"
        return f"Error updating frontmatter: {e}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def bulk_update_frontmatter(file_paths: list, updates: dict) -> str:
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
        response = api_client.patch(
            f"{OBSIDIAN_API_URL}/file/{file_path}/patch",
            json={"old_text": old_text, "new_text": new_text, "replace_all": replace_all}
        )

        if response.status_code == 404:
            return f"File not found: {file_path}"
        if response.status_code == 422:
            return f"Text not found in {file_path} — no changes made"
        if response.status_code == 400:
            return f"Invalid patch request: {response.json().get('error', 'bad request')}"

        response.raise_for_status()
        data = response.json()
        count = data.get("replacements", 0)
        return f"Patched {file_path} ({count} replacement{'s' if count != 1 else ''})"
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
        return f"Moved {data.get('from', file_path)} → {data.get('to', destination)}"
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
    """Get current sync status of the vault"""
    try:
        response = api_client.get(f"{OBSIDIAN_API_URL}/sync/status")
        response.raise_for_status()
        data = response.json()
        return str(data.get("status", "Unknown status"))
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

class TokenAuthMiddleware:
    """Authenticate requests via either a URL path prefix /{token}/... or
    an `Authorization: Bearer <token>` header. Both schemes are accepted so
    clients that can't customize the request URL (path-only) and clients that
    prefer header-based auth (Bearer) both work."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            path = scope.get("path", "")
            headers = scope.get("headers", [])

            # Look for Authorization: Bearer <token>
            auth_header = next(
                (v for k, v in headers if k.lower() == b"authorization"),
                None,
            )
            header_token = None
            if auth_header:
                try:
                    decoded = auth_header.decode("latin-1").strip()
                except Exception:
                    decoded = ""
                if decoded.lower().startswith("bearer "):
                    header_token = decoded[7:].strip()

            path_has_token = bool(API_TOKEN) and path.startswith(f"/{API_TOKEN}")
            header_ok = bool(API_TOKEN) and header_token == API_TOKEN

            if API_TOKEN and not path_has_token and not header_ok:
                async def send_401(send):
                    await send({
                        "type": "http.response.start",
                        "status": 401,
                        "headers": [(b"www-authenticate", b'Bearer realm="mcp"')],
                    })
                    await send({"type": "http.response.body", "body": b"Unauthorized"})
                await send_401(send)
                return

            scope = dict(scope)
            # Strip the token prefix from path only if it's actually there
            if API_TOKEN and path_has_token:
                new_path = path[len(f"/{API_TOKEN}"):] or "/"
                scope["path"] = new_path
                raw_path = scope.get("raw_path", path.encode())
                scope["raw_path"] = raw_path[len(f"/{API_TOKEN}".encode()):] or b"/"
            # Replace Host header with localhost to bypass FastMCP DNS rebinding protection
            new_headers = [(k, v) for k, v in headers if k.lower() != b"host"]
            new_headers.append((b"host", b"localhost"))
            scope["headers"] = new_headers
        await self.app(scope, receive, send)


if __name__ == "__main__":
    import uvicorn

    print(f"Starting Obsidian MCP Server on port {PORT}")
    print(f"Connected to Obsidian API at: {OBSIDIAN_API_URL}")

    mcp_app = mcp.streamable_http_app()
    app = TokenAuthMiddleware(mcp_app)

    uvicorn.run(app, host="0.0.0.0", port=PORT)
