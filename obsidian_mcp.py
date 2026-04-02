#!/usr/bin/env python3

import httpx
import os
import secrets
import uvicorn
from mcp.server.fastmcp import FastMCP

# Configuration
API_TOKEN = os.getenv("API_TOKEN", "")
if not API_TOKEN:
    raise RuntimeError("API_TOKEN environment variable must be set")

OBSIDIAN_API_URL = os.getenv("OBSIDIAN_API_URL", "http://localhost:3000/api")
OBSIDIAN_BASE_URL = OBSIDIAN_API_URL.removesuffix("/api")
PORT = int(os.getenv("PORT", 3001))

# Shared HTTP client — injects Bearer token on every request to the REST API
api_client = httpx.Client(
    headers={"Authorization": f"Bearer {API_TOKEN}"},
    timeout=30.0
)

# Create MCP server
mcp = FastMCP("Obsidian")


# ==================== ASGI MIDDLEWARE ====================

class URLTokenAuthMiddleware:
    """Validate the API token embedded in the URL path prefix.

    Expected URL format: /{token}/...
    Claude web MCP URL:  https://mcp.example.com/{API_TOKEN}/mcp
    """

    def __init__(self, app, token: str):
        self.app = app
        self.token = token

    async def __call__(self, scope, receive, send):
        # Lifespan events must pass through so FastMCP can manage its session lifecycle
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return

        if scope["type"] in ("http", "websocket"):
            path = scope.get("path", "")
            parts = path.lstrip("/").split("/", 1)
            provided_token = parts[0] if parts else ""

            # Timing-safe comparison to prevent token enumeration
            if not self.token or not secrets.compare_digest(provided_token, self.token):
                if scope["type"] == "http":
                    await send({
                        "type": "http.response.start",
                        "status": 401,
                        "headers": [(b"content-type", b"application/json")],
                    })
                    await send({
                        "type": "http.response.body",
                        "body": b'{"error":"Unauthorized"}',
                        "more_body": False,
                    })
                return

            # Strip the token prefix — Starlette uses both path and raw_path for routing
            new_path = "/" + parts[1] if len(parts) > 1 and parts[1] else "/"
            scope = dict(scope)
            scope["path"] = new_path
            scope["raw_path"] = new_path.encode("utf-8")

        await self.app(scope, receive, send)


# ==================== RESOURCES ====================

@mcp.resource("obsidian://files")
def list_files() -> str:
    """List all markdown files in the vault"""
    try:
        response = api_client.get(f"{OBSIDIAN_API_URL}/files")
        response.raise_for_status()
        data = response.json()
        files = data.get("files", [])
        return f"Files in vault ({len(files)}):\n" + "\n".join(f"  - {f['path']}" for f in files)
    except Exception as e:
        return f"Error listing files: {e}"

@mcp.resource("obsidian://health")
def vault_status() -> str:
    """Check vault sync status"""
    try:
        response = api_client.get(f"{OBSIDIAN_BASE_URL}/health")
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
def read_files_batch(file_paths: list[str]) -> str:
    """Read multiple markdown files in a single request

    Args:
        file_paths: List of paths relative to vault root (e.g., ['notes/a.md', 'notes/b.md'])
    """
    try:
        response = api_client.post(
            f"{OBSIDIAN_API_URL}/files/batch",
            json={"paths": file_paths}
        )
        response.raise_for_status()
        files = response.json().get("files", [])

        output = []
        for f in files:
            if "error" in f:
                output.append(f"## {f['path']}\nError: {f['error']}")
            else:
                output.append(f"## {f['path']}\n{f.get('content', '')}")
        return "\n\n---\n\n".join(output)
    except Exception as e:
        return f"Error fetching batch: {e}"

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
    """Append content to an existing file (creates it if it doesn't exist)

    Args:
        file_path: Path to the file
        content: Content to append
    """
    try:
        response = api_client.post(
            f"{OBSIDIAN_API_URL}/file/{file_path}/append",
            json={"content": content}
        )
        response.raise_for_status()
        return f"Content appended to {file_path}"
    except Exception as e:
        return f"Error appending: {e}"

@mcp.tool()
def search_vault(query: str) -> str:
    """Search for text in the vault

    Args:
        query: Text to search for
    """
    try:
        response = api_client.get(f"{OBSIDIAN_API_URL}/search", params={"q": query})
        response.raise_for_status()
        data = response.json()
        results = data.get("results", [])

        if not results:
            return f"No results found for: {query}"

        output = f"Found {len(results)} results for '{query}':\n"
        for result in results[:20]:  # Limit to 20 results
            output += f"\n  {result['file']}\n"
            output += f"    {result['match']}\n"
        return output
    except Exception as e:
        return f"Error searching: {e}"

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


# ==================== RUN ====================

if __name__ == "__main__":
    print(f"Starting Obsidian MCP Server on port {PORT}")
    print(f"Connected to Obsidian API at: {OBSIDIAN_API_URL}")
    print(f"Claude web MCP URL: https://<your-domain>/{API_TOKEN}/mcp")

    # streamable_http_app() returns a Starlette ASGI app (mcp SDK >= 1.9)
    if hasattr(mcp, "streamable_http_app"):
        mcp_asgi = mcp.streamable_http_app()
    else:
        mcp_asgi = mcp.sse_app()

    wrapped_app = URLTokenAuthMiddleware(mcp_asgi, API_TOKEN)

    uvicorn.run(wrapped_app, host="0.0.0.0", port=PORT, lifespan="on")
