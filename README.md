# Obsidian Headless + MCP Server

Complete deployment of Obsidian Headless with a REST API wrapper and MCP server for remote access via HTTPS.

## Architecture

```
Internet
  ↓
Traefik (reverse proxy + SSL/TLS)
  ├─ obsidian-api.votredomaine.com   → Node.js API wrapper
  └─ mcp.votredomaine.com             → Python MCP server
       ↓
Obsidian Headless (syncs with Obsidian Sync service)
       ↓
Your vault files
```

## Services

### 1. **Traefik**
- Reverse proxy with automatic SSL/TLS (Let's Encrypt)
- Routes HTTPS traffic to services

### 2. **Obsidian Headless**
- Synchronizes your vault from command line
- Uses Obsidian Sync for end-to-end encrypted backup
- Stores vault in `./vault` directory

### 3. **Obsidian API** (Node.js)
- REST API wrapper around Obsidian Headless
- Endpoints for file operations, search, sync
- Exposed at `https://obsidian-api.DOMAIN`

### 4. **MCP Server** (Python)
- Model Context Protocol server
- Exposes vault as resources and tools to AI models
- Exposed at `https://mcp.DOMAIN`

## Prerequisites

- Docker & Docker Compose installed on Hostinger
- Obsidian Sync subscription (for encryption & backup)
- Valid domain with DNS pointing to your server
- Obsidian account credentials

## Setup

### 1. Clone/Download Files

Get these files:
```
.
├── docker-compose.yml
├── .env.example → rename to .env
├── obsidian-api.js
├── obsidian_mcp.py
└── vault/          (created automatically)
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in:

```bash
ACME_EMAIL=your-email@example.com
DOMAIN=yourdomain.com
OBSIDIAN_EMAIL=your-obsidian-email@example.com
OBSIDIAN_PASSWORD=your-obsidian-password
VAULT_NAME=Your-Vault-Name
```

### 3. Deploy

In your Hostinger Docker Compose editor (hPanel):

1. Paste the `docker-compose.yml` content
2. Add environment variables (ACME_EMAIL, DOMAIN, etc.)
3. Deploy

The first start will take a minute as services initialize.

## Endpoints

### REST API
```
GET  /api/files                    # List all files
GET  /api/file/{path}              # Read a file
POST /api/file/{path}              # Write/create a file
GET  /api/search?q={query}         # Search vault
POST /api/sync                     # Trigger sync
GET  /api/sync/status              # Get sync status
GET  /health                       # Health check
```

### MCP Server
- `obsidian://files` - Resource listing all files
- `obsidian://health` - Resource checking vault status
- `read_file()` - Tool to read files
- `write_file()` - Tool to create/modify files
- `append_to_file()` - Tool to append content
- `search_vault()` - Tool to search
- `sync_vault()` - Tool to trigger sync
- `get_sync_status()` - Tool to get sync status

## Usage Examples

### Reading a file via API
```bash
curl https://obsidian-api.yourdomain.com/api/file/notes%2Fmy-note.md
```

### Writing a file via API
```bash
curl -X POST https://obsidian-api.yourdomain.com/api/file/notes%2Fnew.md \
  -H "Content-Type: application/json" \
  -d '{"content": "# My Note\n\nContent here"}'
```

### Using with Claude Code

Add to your Claude Code config:
```json
{
  "mcpServers": {
    "obsidian": {
      "url": "https://mcp.yourdomain.com",
      "transport": "http"
    }
  }
}
```

Then Claude can read/write your notes directly!

## Troubleshooting

### Obsidian Headless not syncing
- Check credentials in `.env`
- Verify vault name matches exactly
- Check logs: `docker logs obsidian-headless`

### API not responding
- Check if obsidian-headless is running first
- Verify Traefik routing: `docker logs traefik`
- Check DOMAIN environment variable matches your DNS

### SSL certificate issues
- Wait 5 minutes for Let's Encrypt challenge
- Check firewall allows port 80 (for ACME validation)
- Verify ACME_EMAIL is correct

## Security Notes

⚠️ **Important:**
- Keep `.env` file secure (never commit to Git)
- Use strong Obsidian passwords
- The API doesn't have built-in auth—consider adding OAuth or API keys in production
- Obsidian Sync provides end-to-end encryption

## Files Reference

### obsidian-api.js
Express server that wraps Obsidian Headless CLI with REST endpoints.

Features:
- File read/write with directory traversal protection
- Full-text search using `grep`
- Sync management
- CORS enabled

### obsidian_mcp.py
FastMCP server exposing vault as Model Context Protocol resources and tools.

Features:
- Resource for listing files
- Tools for common operations
- Streamable HTTP transport for remote access

## License

MIT
