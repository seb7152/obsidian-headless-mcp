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
# by TokenAuthMiddleware (the API token is required in the URL path)
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

class TokenAuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            path = scope.get("path", "")
            # Expect /{token}/...
            if API_TOKEN and not path.startswith(f"/{API_TOKEN}"):
                async def send_401(send):
                    await send({"type": "http.response.start", "status": 401, "headers": []})
                    await send({"type": "http.response.body", "body": b"Unauthorized"})
                await send_401(send)
                return
            scope = dict(scope)
            # Strip the token prefix from path
            if API_TOKEN:
                new_path = path[len(f"/{API_TOKEN}"):] or "/"
                scope["path"] = new_path
                raw_path = scope.get("raw_path", path.encode())
                scope["raw_path"] = raw_path[len(f"/{API_TOKEN}".encode()):] or b"/"
            # Replace Host header with localhost to bypass FastMCP DNS rebinding protection
            headers = [(k, v) for k, v in scope.get("headers", []) if k.lower() != b"host"]
            headers.append((b"host", b"localhost"))
            scope["headers"] = headers
        await self.app(scope, receive, send)


if __name__ == "__main__":
    import uvicorn

    print(f"Starting Obsidian MCP Server on port {PORT}")
    print(f"Connected to Obsidian API at: {OBSIDIAN_API_URL}")

    mcp_app = mcp.streamable_http_app()
    app = TokenAuthMiddleware(mcp_app)

    uvicorn.run(app, host="0.0.0.0", port=PORT)
