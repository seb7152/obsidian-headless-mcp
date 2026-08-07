# Obsidian Headless + MCP Server

Complete deployment of Obsidian Headless with a REST API wrapper and MCP server for remote access via HTTPS.

## Architecture

```
Internet
  ↓
Traefik (reverse proxy + SSL/TLS)
  ├─ obsidian-api.yourdomain.com   → Node.js REST API
  └─ mcp.yourdomain.com            → Python MCP server
       ↓
Obsidian Headless (syncs with Obsidian Sync)
       ↓
Your vault files  ←→  SQLite index (vault-indexer)
```

## Services

### 1. **Traefik**
Reverse proxy with automatic SSL/TLS (Let's Encrypt). Routes HTTPS traffic to services.

### 2. **Obsidian Headless**
Synchronizes your vault from the command line using Obsidian Sync (end-to-end encrypted). Stores files in `./vault`.

### 3. **Obsidian API** (Node.js)
REST API wrapping vault file operations. All endpoints require `Authorization: Bearer <API_TOKEN>` except `/health`. Exposed at `https://obsidian-api.DOMAIN`.

### 4. **Vault Indexer** (Node.js)
Embedded SQLite index kept in sync with the vault via a file watcher. Indexes frontmatter, tags, and tasks from every `.md` file. Queried via `POST /api/query`. The same watcher drives **webhooks**, POSTing to external URLs when files change (see [Webhooks](#webhooks)).

### 5. **MCP Server** (Python)
Model Context Protocol server exposing the vault as tools and resources to AI models. Exposed at `https://mcp.DOMAIN`.

## Prerequisites

- Docker & Docker Compose
- Obsidian Sync subscription
- Valid domain with DNS pointing to your server
- Obsidian account credentials

## Setup

### 1. Clone/Download Files

```
.
├── docker-compose.yml
├── .env           (copy from .env.example)
├── obsidian-api.js
├── obsidian_mcp.py
├── vault-indexer.js
└── vault/         (created automatically)
```

### 2. Configure Environment

```bash
ACME_EMAIL=your-email@example.com
DOMAIN=yourdomain.com
OBSIDIAN_EMAIL=your-obsidian-email@example.com
OBSIDIAN_PASSWORD=your-account-password       # Obsidian account password (for `ob login`)
VAULT_PASSWORD=your-vault-encryption-password # Vault encryption key (Obsidian → Settings → Sync → Encryption)
VAULT_NAME=Your-Vault-Name                    # Exact vault name in Obsidian Sync
API_TOKEN=your-secret-token                   # Shared token for REST API + MCP auth
```

### 3. Deploy

Paste `docker-compose.yml` into your host's Docker Compose editor, add the environment variables, and deploy. First start takes ~1 minute.

---

## REST API

Base URL: `https://obsidian-api.DOMAIN`

All endpoints require:
```
Authorization: Bearer <API_TOKEN>
```
Exception: `GET /health` is public.

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health check (no auth required) |

```bash
curl https://obsidian-api.yourdomain.com/health
# → {"status":"ok","vault":"/vault"}
```

### Files — single file

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/file/{path}` | Read a file — returns `frontmatter`, `body`, and `content` |
| `POST` | `/api/file/{path}` | Write or create a file (full content replace) |
| `PATCH` | `/api/file/{path}` | Merge-update frontmatter fields (body untouched) |
| `PATCH` | `/api/file/{path}/body` | Replace body only (frontmatter untouched) |
| `PATCH` | `/api/file/{path}/patch` | Surgical text replace — swap `old_text` for `new_text`, rest untouched |
| `POST` | `/api/file/{path}/append` | Append content at end of file |
| `POST` | `/api/file/{path}/move` | Move file to a new path |
| `DELETE` | `/api/file/{path}` | Delete a file — soft by default (moved to `.trash/`); `?hard=true` removes it permanently |
| `GET` | `/api/file/{path}/links` | List broken wikilinks in a file (optionally with fuzzy suggestions) |
| `POST` | `/api/links/check` | List broken wikilinks in an arbitrary text snippet — not tied to a file, for checking just-changed text |

**Read a file**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://obsidian-api.yourdomain.com/api/file/notes%2Fmy-note.md
# → {"path":"notes/my-note.md","frontmatter":{...},"body":"...","content":"..."}
```

**Write a file**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"# My Note\n\nContent here"}' \
  https://obsidian-api.yourdomain.com/api/file/notes%2Fnew.md
```

**Update frontmatter only**
```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"done","reviewed":true}' \
  https://obsidian-api.yourdomain.com/api/file/notes%2Fmy-note.md
```

**Append content**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"## New Section\n\nAdded text."}' \
  https://obsidian-api.yourdomain.com/api/file/notes%2Fmy-note.md/append
```

**Surgical text patch**

Replace a precise piece of text without rewriting the whole file. By default only the
**first** occurrence is replaced; pass `"replace_all": true` to replace every occurrence.
Omit `new_text` (or set it to `""`) to delete the matched text.

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"old_text":"- [ ] Draft proposal","new_text":"- [x] Draft proposal"}' \
  https://obsidian-api.yourdomain.com/api/file/notes%2Fmy-note.md/patch
# → {"success":true,"path":"notes/my-note.md","occurrences":1,"replacements":1,"replace_all":false,"changed":true}
```

Edge cases:
- `400` — `old_text` missing/empty, or `new_text` is not a string
- `404` — file does not exist
- `422` — `old_text` not found in the file (nothing is changed; the edit never applies silently)

**Move a file**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"destination":"archive/my-note.md"}' \
  https://obsidian-api.yourdomain.com/api/file/notes%2Fmy-note.md/move
```

**Delete a file**
```bash
# Soft delete (default) — moved to .trash/, recoverable
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://obsidian-api.yourdomain.com/api/file/notes%2Fmy-note.md
# → {"success":true,"deleted":"notes/my-note.md","mode":"soft","trashed_to":".trash/notes/my-note.md"}

# Permanent delete
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://obsidian-api.yourdomain.com/api/file/notes%2Fmy-note.md?hard=true"
# → {"success":true,"deleted":"notes/my-note.md","mode":"hard"}
```
Soft delete moves the file to a hidden `.trash/` folder at the vault root. That folder is **not indexed** (excluded from search/SQL like all dotfiles), and the deletion still fires the `unlink` webhook event. Trashed files are **auto-purged after `TRASH_RETENTION_DAYS` days** (default `30`; set to `0` to keep them forever) — the purge runs on startup and once a day, ageing files from when they were trashed.

**Check broken wikilinks**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://obsidian-api.yourdomain.com/api/file/notes%2Fmy-note.md/links?suggest=true"
# → {"path":"notes/my-note.md","count":5,"broken_count":1,"broken_links":[{"raw":"...","target":"...","suggestions":["..."]}]}
```
Scans the whole file, frontmatter included — a `related: "[[Note]]"` field is checked the same as a `[[Note]]` in the body.

To check a text snippet instead of a file on disk (e.g. before writing it):
```bash
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text": "See [[Some Note]]", "suggest": true}' \
  https://obsidian-api.yourdomain.com/api/links/check
# → {"count":1,"broken_count":0}
```

### Files — bulk operations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/files` | List all `.md` files with optional filters |
| `POST` | `/api/files/batch` | Read up to 100 files in one request |
| `PATCH` | `/api/files/batch` | Apply same frontmatter patch to up to 100 files |
| `POST` | `/api/files/move` | Move multiple files to a destination folder |

**List files with filters**

Query parameters (all optional):
- `path` — substring match on file path
- `since=YYYY-MM-DD` — only files created on or after this date
- `before=YYYY-MM-DD` — only files created on or before this date
- any frontmatter key — e.g. `status=done&type=note`

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://obsidian-api.yourdomain.com/api/files?status=reviewed&since=2025-01-01"
# → {"files":[{"path":"...","frontmatter":{...},"hasContent":true}],"count":12,"filters":{...}}
```

**Batch read**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths":["notes/a.md","notes/b.md"]}' \
  https://obsidian-api.yourdomain.com/api/files/batch
```

**Bulk frontmatter update**
```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths":["notes/a.md","notes/b.md"],"frontmatter":{"status":"archive"}}' \
  https://obsidian-api.yourdomain.com/api/files/batch
```

**Bulk move**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths":["inbox/note1.md","inbox/note2.md"],"destination_folder":"30_Knowledge"}' \
  https://obsidian-api.yourdomain.com/api/files/move
```

### Folders

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/folders` | Create one or more folders (batch), including missing parent folders |
| `DELETE` | `/api/folders` | Delete one or more folders (batch), recursively |
| `POST` | `/api/folders/move` | Move or rename one or more folders (batch), each to its own destination |

**Create**

Body: `{ "paths": ["20_Projects/Alpha", "20_Projects/Alpha/Docs"] }` — up to 100 entries.
Useful for scaffolding a directory structure in one call. Creating a folder that
already exists is not an error.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths":["20_Projects/Alpha","20_Projects/Alpha/Docs","20_Projects/Alpha/Assets"]}' \
  https://obsidian-api.yourdomain.com/api/folders
# → {"results":[{"path":"20_Projects/Alpha","success":true,"already_existed":false},...],"count":3,"failed_count":0}
```

**Delete**

Body: `{ "paths": ["20_Projects/Alpha", "20_Projects/Beta"] }` — up to 100 entries.
Soft-deletes by default (each folder tree is moved into `.trash/`, recoverable);
pass `?hard=true` (or `{ "hard": true }` in the body) to remove permanently. The
vault root cannot be deleted this way.

```bash
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths":["20_Projects/Alpha"]}' \
  https://obsidian-api.yourdomain.com/api/folders
# → {"results":[{"path":"20_Projects/Alpha","success":true,"mode":"soft","trashed_to":".trash/20_Projects/Alpha"}],"count":1,"failed_count":0}
```

**Move / rename**

Body: `{ "moves": [{"from": "20_Projects/Alpha", "to": "20_Projects/AlphaRenamed"}] }` — up
to 100 entries. Each entry is an independent `{from, to}` pair (unlike bulk file
move, which relocates several files into one shared destination folder). Missing
parent folders in the destination are created automatically.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"moves":[{"from":"20_Projects/Alpha","to":"20_Projects/AlphaRenamed"}]}' \
  https://obsidian-api.yourdomain.com/api/folders/move
# → {"results":[{"from":"20_Projects/Alpha","to":"20_Projects/AlphaRenamed","success":true}],"count":1,"failed_count":0}
```

### Directory

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/directory` | List vault root (files and subdirectories) |
| `GET` | `/api/directory/{path}` | List a specific directory |

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://obsidian-api.yourdomain.com/api/directory/20_Projects
# → {"path":"20_Projects","entries":[{"name":"ProjectA","path":"20_Projects/ProjectA","type":"directory"},...],"count":5}
```

### Search

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/search` | Search vault content |

Query parameters:
- `q` (required) — search term
- `fuzzy=true` — fuzzy title matching with scoring (default: exact keyword match via grep)
- `since=YYYY-MM-DD` — filter by creation date
- `before=YYYY-MM-DD` — filter by creation date

```bash
# Keyword search
curl -H "Authorization: Bearer $TOKEN" \
  "https://obsidian-api.yourdomain.com/api/search?q=meeting+notes&since=2025-01-01"

# Fuzzy search
curl -H "Authorization: Bearer $TOKEN" \
  "https://obsidian-api.yourdomain.com/api/search?q=meting+nots&fuzzy=true"
# → {"query":"...","results":[{"file":"...","title":"...","matches":["..."],"date":"2025-03-10","score":0.82}],"count":3,"fuzzy":true}
```

### SQL Query

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/query` | Run a SQL `SELECT` against the vault index |

The vault index has two tables:

**`files`**
| Column | Type | Description |
|--------|------|-------------|
| `path` | TEXT | Relative path from vault root |
| `title` | TEXT | Frontmatter `title` or filename |
| `created` | TEXT | Frontmatter `created` (YYYY-MM-DD) |
| `modified` | TEXT | Frontmatter `modified` or file mtime |
| `tags` | TEXT | JSON array of tags (frontmatter + inline `#tag`) |
| `frontmatter` | TEXT | Full frontmatter as JSON object |

**`tasks`**
| Column | Type | Description |
|--------|------|-------------|
| `file_path` | TEXT | Parent file path |
| `text` | TEXT | Task text (without the checkbox) |
| `completed` | INTEGER | `0` = open, `1` = done |
| `due` | TEXT | Due date YYYY-MM-DD (from `📅` or `due::` syntax), or null |

Only `SELECT` statements are allowed.

```bash
# Notes with status=active, most recent first
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT path, title, created FROM files WHERE json_extract(frontmatter, '\''$.status'\'') = '\''active'\'' ORDER BY created DESC LIMIT 10"}' \
  https://obsidian-api.yourdomain.com/api/query

# Open tasks due in the next 7 days
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT file_path, text, due FROM tasks WHERE completed = 0 AND due <= date('\''now'\'', '\''+7 days'\'') ORDER BY due"}' \
  https://obsidian-api.yourdomain.com/api/query
```

Useful JSON operators:
```sql
-- Filter by frontmatter field
WHERE json_extract(frontmatter, '$.status') = 'done'

-- Filter by tag
WHERE tags LIKE '%"project"%'

-- Extract nested field
SELECT path, json_extract(frontmatter, '$.priority') AS priority FROM files
```

### Projects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | List all subdirectories of `20_Projects/` |

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://obsidian-api.yourdomain.com/api/projects
# → {"projects":[{"name":"ProjectA","path":"20_Projects/ProjectA"}],"count":3}
```

### Agent Context

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agent/context` | Read `agent.md` from vault root |

Returns the contents of `agent.md`, which can hold instructions or context for AI agents working with the vault.

### Sync

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sync` | Trigger a vault sync with Obsidian Sync |
| `GET` | `/api/sync/status` | Get current sync status, plus SQLite index / file watcher health |

`/api/sync/status` also reports on the SQLite index and its file watcher —
useful because the watcher has occasionally stopped picking up changes
silently (e.g. inotify not propagating across Docker bind mounts), leaving
the index (and therefore `/api/search`, `/api/query`) stale without any
visible error.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://obsidian-api.yourdomain.com/api/sync/status
# → {
#     "status": "...",
#     "indexer": {
#       "watcher_ready": true,
#       "watcher_closed": false,
#       "db_file_count": 842,
#       "vault_file_count": 842,
#       "in_sync": true,
#       "last_event": {"type": "change", "path": "notes/a.md", "at": "2026-08-03T21:10:00.000Z"},
#       "last_error": null
#     }
#   }
```

- `watcher_closed: true` or a persistently old `last_event.at` while files keep changing on disk is a strong signal the watcher died and needs a restart.
- `in_sync: false` means the indexed file count doesn't match the vault's actual `.md` file count — a full reindex (restart the service) will resync it.

### Webhooks

Notify external systems (n8n, Zapier, your own service…) whenever vault files change. The embedded watcher detects `add` / `change` / `unlink` on `.md` files and POSTs a JSON payload to your URL. Webhooks are **created and managed only through the REST API** — the MCP server can list them but never create them.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/webhooks` | List all configured webhooks (secrets redacted) |
| `GET` | `/api/webhooks/{id}` | Get a single webhook |
| `POST` | `/api/webhooks` | Create a webhook |
| `PATCH` | `/api/webhooks/{id}` | Update a webhook (only supplied fields change) |
| `DELETE` | `/api/webhooks/{id}` | Delete a webhook |
| `POST` | `/api/webhooks/{id}/test` | Fire a test delivery and return the result |

**Webhook fields** (all optional except `url`):

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | **Required.** Destination URL. Must be public `https://` by default (see SSRF note below). |
| `name` | string | Friendly label. |
| `folder` | string \| null | Directory filter — matches every file beneath it. Wildcards allowed in segments, e.g. `20_Projects/*/notes`. `null`/omitted = whole vault. |
| `frontmatter` | object \| null | Subset match on frontmatter, e.g. `{"type":"action"}`. Every key must be present and equal. `null`/omitted = any. |
| `frontmatter_not` | object \| null | Negated match: **skip** delivery if any of these key=value pairs match, e.g. `{"last_write_origin":"todoist"}`. A missing field never matches (so it passes). Useful to break webhook loops. `null`/omitted = no exclusion. |
| `events` | string[] | Subset of `add`, `change`, `unlink`. Default: all three. |
| `secret` | string | If set, each delivery is signed: `X-Obsidian-Signature: sha256=<hmac>` (HMAC-SHA256 of the JSON body). Never returned by the API. |
| `include_body` | boolean | Include the file body in the payload. Default `false` (metadata only). |
| `enabled` | boolean | Set `false` to pause delivery. Default `true`. |

**Delivery payload:**
```json
{
  "event": "change",
  "path": "20_Projects/alpha/notes/idea.md",
  "frontmatter": { "type": "action", "status": "todo" },
  "timestamp": "2026-06-03T10:00:00.000Z",
  "webhook_id": "wh_…",
  "body": "…"
}
```
`body` is included only when `include_body=true`. Headers: `X-Obsidian-Event: <event>` and, when a secret is set, `X-Obsidian-Signature`. Deliveries run off the watcher with a per-request timeout, bounded concurrency, and exponential-backoff retries (on network errors / 5xx / 429).

```bash
# Create a webhook for "action" notes under 20_Projects, signed
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://hooks.example.com/obsidian","folder":"20_Projects","frontmatter":{"type":"action"},"secret":"s3cr3t"}' \
  https://obsidian-api.yourdomain.com/api/webhooks
# → {"id":"wh_…","url":"…","folder":"20_Projects","frontmatter":{"type":"action"},"events":["add","change","unlink"],"has_secret":true,...}

# Combined filter: type == action AND last_write_origin != todoist (loop-breaking)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://hooks.example.com/obsidian","frontmatter":{"type":"action"},"frontmatter_not":{"last_write_origin":"todoist"}}' \
  https://obsidian-api.yourdomain.com/api/webhooks

# List webhooks
curl -H "Authorization: Bearer $TOKEN" https://obsidian-api.yourdomain.com/api/webhooks

# Send a test delivery
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://obsidian-api.yourdomain.com/api/webhooks/wh_…/test
# → {"ok":true,"status":200,"attempts":1}
```

**Configuration & persistence**

- The config is stored at `/data/webhooks.json` (the `sqlite-data` Docker volume), so it survives restarts and is **not** synced to your Obsidian devices. Override with `WEBHOOKS_CONFIG_PATH`.
- `WEBHOOK_ALLOW_PRIVATE` (default `false`): by default the server **blocks SSRF** — only public `https://` targets are allowed; loopback, private, link-local and cloud-metadata addresses (and `http://`) are rejected, redirects are not followed, and the target is re-checked before each delivery (anti DNS-rebinding). Set it to `true` only if your receiver lives on a private/internal address (e.g. a self-hosted n8n on the same network).

---

## MCP Server

Exposes the vault as MCP tools and resources for AI agents. Base URL: `https://mcp.DOMAIN`.

### Authentication

Three methods are supported, checked in this order:

**1. Authorization header with the static token (recommended for Claude Code CLI / Codex CLI —
simpler than OAuth for those clients)**
```json
{
  "mcpServers": {
    "obsidian": {
      "url": "https://mcp.yourdomain.com",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer <API_TOKEN>"
      }
    }
  }
}
```

**2. Token in URL path (legacy — planned for removal later)**
```json
{
  "mcpServers": {
    "obsidian": {
      "url": "https://mcp.yourdomain.com/<API_TOKEN>",
      "transport": "http"
    }
  }
}
```

**3. OAuth 2.1 + PKCE (Zitadel)** — used automatically by OAuth-aware clients like claude.ai
when no static token is presented:
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
On first connection such a client will:
1. Get a `401` with a `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource`
2. Follow that to discover the Zitadel authorization server and start the Authorization Code + PKCE flow
3. Present you with a login/consent screen for your Zitadel account
4. Attach the resulting access token as `Authorization: Bearer <token>` on subsequent requests

For OAuth requests, access is granted only to users holding the `obsidian:access` project role
in Zitadel — the server checks this via `/oidc/v1/userinfo` on every request (see
[Security Notes](#security-notes)).

### Resources

| URI | Description |
|-----|-------------|
| `obsidian://files` | List all markdown files in the vault |
| `obsidian://health` | Check vault health status |

### Tools

#### File Operations

| Tool | Description |
|------|-------------|
| `read_file(file_path)` | Read a markdown file; returns full content |
| `write_file(file_path, content)` | Write or create a file (full replace); response includes an `obsidian://open` deep link when `VAULT_NAME` is set, and a warning listing any broken `[[wikilinks]]` (with fuzzy suggestions) found in `content` |
| `append_to_file(file_path, content)` | Append content at end of file (creates it if missing); response includes an `obsidian://open` deep link when `VAULT_NAME` is set, and a warning listing any broken `[[wikilinks]]` (with fuzzy suggestions) found in the appended `content` — pre-existing broken links elsewhere in the file aren't reported |
| `patch_file(file_path, old_text, new_text, replace_all=False)` | Surgical text replacement — swaps `old_text` for `new_text` (first occurrence, or all with `replace_all=True`); errors if not found; response includes an `obsidian://open` deep link when `VAULT_NAME` is set, and a warning listing any broken `[[wikilinks]]` (with fuzzy suggestions) found in `new_text` — pre-existing broken links elsewhere in the file aren't reported |
| `move_file(file_path, destination)` | Move or rename a file within the vault; missing destination folders are created automatically; response includes an `obsidian://open` deep link to the new path when `VAULT_NAME` is set |
| `delete_file(file_path, hard=False)` | Delete a file — soft by default (moved to `.trash/`, recoverable); `hard=True` deletes permanently |

#### Frontmatter

| Tool | Description |
|------|-------------|
| `update_frontmatter(file_path, updates)` | Merge-update frontmatter fields; body untouched; set a value to `null` to delete a field; response includes an `obsidian://open` deep link when `VAULT_NAME` is set |
| `bulk_update_frontmatter(file_paths, updates)` | Apply the same frontmatter patch to multiple files (up to 100); each succeeded file's line includes an `obsidian://open` deep link when `VAULT_NAME` is set |

#### Directory & Search

| Tool | Description |
|------|-------------|
| `create_folders(folder_paths)` | Create one or more folders (up to 100), including missing parent folders — scaffolds a directory structure in one call |
| `delete_folders(folder_paths, hard=False)` | Delete one or more folders (up to 100), recursively — soft by default (moved to `.trash/`, recoverable); `hard=True` deletes permanently |
| `move_folders(moves)` | Move or rename one or more folders (up to 100); each entry is its own `{"from": ..., "to": ...}` dict — missing destination parent folders are created automatically |
| `list_directory(dir_path)` | List files and subdirectories; leave `dir_path` empty for vault root |
| `search_vault(query, fuzzy, since, before)` | Search vault — keyword (default) or fuzzy with date filters |
| `get_projects()` | List project folders under `20_Projects/` |

#### SQL & Index

| Tool | Description |
|------|-------------|
| `query_vault(sql)` | Run a SQL `SELECT` against the vault index (same `files`/`tasks` schema as the REST API) |
| `run_index(file_path, section)` | Execute SQL blocks embedded in a `_index.md` file; leave `section` empty to list available sections |
| `extract_tasks(file_path, isolate_tags=False)` | Extract markdown checklist items (`- [ ]` / `- [x]`) from a file as JSON: `{"checked": bool, "text": str, "tags": [...]}`; `isolate_tags=True` pulls every inline `[...]` bracket group (e.g. `[if:plage]`, `[require:passeport]`) out of `text` into the `tags` array as raw strings |

#### Sync

| Tool | Description |
|------|-------------|
| `sync_vault()` | Trigger vault sync with Obsidian Sync |
| `get_sync_status()` | Get current sync status, plus SQLite index / file watcher health (watcher liveness, last event, last error, indexed vs actual file count) |

#### Webhooks (read-only)

| Tool | Description |
|------|-------------|
| `list_webhooks()` | List active vault-change webhooks (secrets redacted). Webhooks are created/managed via the REST API, not from MCP. |

---

## Troubleshooting

**Obsidian Headless not syncing**
- Check credentials in `.env` (`OBSIDIAN_EMAIL`, `OBSIDIAN_PASSWORD`, `VAULT_PASSWORD`)
- Verify `VAULT_NAME` matches exactly (case-sensitive)
- Check logs: `docker logs obsidian-headless`

**API returning 401**
- Confirm `API_TOKEN` is set in `.env` and matches your `Authorization: Bearer <token>` header
- `/health` is the only public endpoint — everything else requires the token

**API not responding**
- Check Traefik routing: `docker logs traefik`
- Verify DNS and `DOMAIN` env var

**SSL certificate issues**
- Wait ~5 minutes for the Let's Encrypt ACME challenge
- Ensure port 80 is open (required for ACME HTTP-01 validation)
- Verify `ACME_EMAIL` is correct

**SQL query errors**
- Only `SELECT` statements are allowed
- Tags are stored as JSON arrays: use `tags LIKE '%"tagname"%'`
- Frontmatter fields: use `json_extract(frontmatter, '$.field_name')`

**Index not updating / webhooks not firing on file changes**
- The live index and webhooks rely on a chokidar file watcher. On many Docker hosts (especially VPS bind mounts), inotify events don't propagate into the container, so changes go undetected.
- The compose file sets `CHOKIDAR_USEPOLLING=true` (with `CHOKIDAR_INTERVAL=1000` ms) on `obsidian-api` to poll instead. If you run the API outside this compose file, set those env vars yourself.
- Symptom check: create a `.md` file, then `POST /api/query` for it — if it never appears, the watcher isn't seeing changes (enable polling). The `/api/webhooks/{id}/test` endpoint bypasses the watcher, so it succeeding does **not** prove the watcher works.

---

## Security Notes

- Keep `.env` secure — never commit it to Git
- `API_TOKEN` is shared between the REST API and MCP server; all non-health endpoints are protected
- Obsidian Sync provides end-to-end encryption for vault data at rest
- Directory traversal is blocked server-side on all file endpoints
- **Webhooks**: created only via the authenticated REST API (never from MCP); the config lives outside the synced vault (`/data/webhooks.json`); secrets are stored server-side and redacted in all API/MCP responses. SSRF is blocked by default — only public `https://` targets are allowed, redirects are not followed, and the destination is re-validated before every delivery. Loosen this only via `WEBHOOK_ALLOW_PRIVATE=true` for trusted internal receivers.
- **MCP OAuth**: the MCP server (`mcp.DOMAIN`) also accepts OAuth 2.1 + PKCE via Zitadel
  alongside the static `API_TOKEN`. For OAuth requests, every bearer token is validated
  against Zitadel's `/oidc/v1/userinfo`, and access is denied (`403`) unless the token's
  claims include the `obsidian:access` project role. This role check matters because
  Zitadel doesn't support RFC 8707 resource indicators: a token issued for the shared
  `Claude-web` client can carry an audience covering every MCP server in the `mcp-servers`
  project, not just this one, so a valid signature alone isn't proof of authorization for
  this specific server. The URL-path token variant is planned for removal later; the
  static Bearer token is intended to stay alongside OAuth.

---

## Files Reference

### `obsidian-api.js`
Express REST API server. Handles file reads/writes, frontmatter parsing (js-yaml), search (grep + fuzzy), directory listing, wikilink resolution, and SQL queries via the vault indexer.

### `vault-indexer.js`
SQLite indexer (better-sqlite3). Bootstraps a full index on first start, then keeps it live via a chokidar file watcher. Indexes frontmatter, tags, and tasks from every `.md` file. Each `add`/`change`/`unlink` also fans out to the webhook dispatcher.

### `webhooks.js`
Webhook configuration, matching, and delivery. Persists webhooks to `/data/webhooks.json` (atomic writes), filters changes by folder glob and frontmatter subset, and POSTs signed payloads with bounded concurrency, timeouts, retries, and SSRF protection. Created/managed via the REST API; listed read-only via MCP.

### `obsidian_mcp.py`
FastMCP server with streamable HTTP transport. Proxies all operations to the REST API. Includes
`AuthMiddleware`, which accepts either the legacy static token (URL-path or Bearer header) or
an OAuth 2.1 access token validated against Zitadel, plus the `/.well-known/oauth-protected-resource`
metadata endpoint required by OAuth-aware MCP clients.

## License

MIT
