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

### 5. **Hybrid Search Index** (Node.js)
Lives in the same SQLite file as the vault index. Every note is split into chunks and indexed twice: **BM25** through SQLite's FTS5, and **semantically** as a vector embedding. A query hits both and the two rankings are fused, so a note is found whether you remember its wording or only its meaning. An optional cloud **reranker** can reorder the top candidates. See [Hybrid search](#hybrid-search).

### 6. **MCP Server** (Python)
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
API_TOKEN=your-secret-token                   # Root token for REST API + MCP auth
                                              # (scoped, revocable tokens are minted from it)
```

### 3. Deploy

Paste `docker-compose.yml` into your host's Docker Compose editor, add the environment variables, and deploy. First start takes ~1 minute.

---

## REST API

Base URL: `https://obsidian-api.DOMAIN`

All endpoints require:
```
Authorization: Bearer <token>
```
Exception: `GET /health` is public.

The token is either the `API_TOKEN` from the environment (full access, not
revocable without a restart) or a **scoped API token** — named, revocable,
optionally read-only, path-restricted and expiring. See [API tokens](#api-tokens).

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
| `GET` | `/api/search` | Search vault content (hybrid by default) |
| `GET` | `/api/search/status` | Chunk counts, embedding progress, provider health |
| `POST` | `/api/search/reindex` | Kick the background embedding worker |

Query parameters:
- `q` (required) — search term
- `mode` — `auto` (default) · `hybrid` · `semantic` · `bm25` · `grep` · `fuzzy`
- `rerank=true` — reorder candidates with the cloud reranker (off by default)
- `limit` — max notes returned (default 20, max 100)
- `path` — restrict to a vault folder prefix, e.g. `20_Projects`
- `since=YYYY-MM-DD` / `before=YYYY-MM-DD` — filter by note date
- `fuzzy=true` — legacy alias for `mode=fuzzy`

Which mode to use:

| Mode | What it does | Reach for it when |
|------|--------------|-------------------|
| `auto` | Hybrid if the semantic index is ready, else `bm25` | Almost always |
| `hybrid` | BM25 + vector, fused with RRF | Best general recall |
| `semantic` | Vector only | The query's wording won't appear in the notes |
| `bm25` | Ranked full-text only | Names, acronyms, jargon |
| `grep` | Literal substring, unranked | An exact string: an ID, a URL, a snippet |
| `fuzzy` | Title similarity | A half-remembered note name |

```bash
# Default: hybrid
curl -H "Authorization: Bearer $TOKEN" \
  "https://obsidian-api.yourdomain.com/api/search?q=migration+du+serveur&since=2026-01-01"
# → {"query":"...","mode":"hybrid","results":[{"file":"...","title":"...","heading":"Bascule",
#     "matches":["..."],"date":"2026-03-10","score":0.0328,
#     "chunks":[{"heading":"Bascule","start_line":4,"end_line":18}]}],"count":3,"warnings":[]}

# Meaning only — finds "migration serveur" from "changement d'hébergeur"
curl -H "Authorization: Bearer $TOKEN" \
  "https://obsidian-api.yourdomain.com/api/search?q=changement+d'hebergeur&mode=semantic"

# Hard query: pay for a reranking pass
curl -H "Authorization: Bearer $TOKEN" \
  "https://obsidian-api.yourdomain.com/api/search?q=...&rerank=true"

# Exact string
curl -H "Authorization: Bearer $TOKEN" \
  "https://obsidian-api.yourdomain.com/api/search?q=INC-4471&mode=grep"
```

`warnings` is not decoration: it is how a degraded answer announces itself
(`"semantic index not ready — answered with BM25 only"`). An empty `warnings`
array means the mode you asked for is the mode you got.

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
| `GET` | `/api/projects` | List all subdirectories of `20_Projects/Pro/` |

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://obsidian-api.yourdomain.com/api/projects
# → {"projects":[{"name":"ProjectA","path":"20_Projects/Pro/ProjectA"}],"count":3}
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
#     },
#     "search": {
#       "chunks": 5120, "embedded": 5120, "pending": 0,
#       "semantic_ready": true,
#       "embed_provider": "local", "embed_model": "Xenova/multilingual-e5-small",
#       "embed_error": null, "rerank_available": true
#     }
#   }
```

- `watcher_closed: true` or a persistently old `last_event.at` while files keep changing on disk is a strong signal the watcher died and needs a restart.
- `in_sync: false` means the indexed file count doesn't match the vault's actual `.md` file count — a full reindex (restart the service) will resync it.
- `search.semantic_ready: false` with a non-zero `search.pending` means the embedding backfill is still running; searches answer with BM25 in the meantime. A non-null `search.embed_error` means it is stuck, not slow.

### API tokens

Hand a caller its own credential instead of sharing `API_TOKEN`. Each token
carries scopes, path restrictions and an optional expiry, and can be revoked on
its own without disturbing anything else.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tokens` | List tokens (metadata only — secrets are never returned) |
| `GET` | `/api/tokens/{id}` | Get one token |
| `POST` | `/api/tokens` | Create a token — the plaintext is in this response and nowhere else |
| `DELETE` | `/api/tokens/{id}` | Revoke, effective on the next request |
| `POST` | `/api/tokens/verify` | Resolve a token to its principal — used by the MCP server |

All four need the `admin` scope, which only `API_TOKEN` and tokens you
explicitly create with it have.

**Fields**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | **Required.** What this token is for — it is what you will read when deciding whether to revoke it. |
| `scopes` | string[] | `read`, `write`, `admin`. Default `["read"]`. `write` implies `read`; `admin` implies both. |
| `path_allow` | string[] | Vault-relative prefixes this token may reach. Empty = whole vault. |
| `path_deny` | string[] | Prefixes it may never reach. **Deny always wins over allow.** |
| `expires_at` | `YYYY-MM-DD` | After this date the token stops authenticating. Optional, but set one for anything living on a machine you don't fully control. |

Prefixes match on whole path segments, so `10_Context/Perso` covers
`10_Context/Perso/profil.md` but never `10_Context/Perso2/`.

```bash
# A read-only token for a machine that should never see the personal zone
curl -X POST -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"work laptop","scopes":["read"],
       "path_allow":["20_Projects/Pro","30_Knowledge"],
       "path_deny":["10_Context/Perso"],
       "expires_at":"2026-12-01"}' \
  https://obsidian-api.yourdomain.com/api/tokens
# → {"token":"obsv_…","id":"tok_a1b2c3d4e5f6","name":"work laptop",…}
#   Copy the token now — only its SHA-256 is stored, it cannot be shown again.

# See who is using what
curl -H "Authorization: Bearer $API_TOKEN" https://obsidian-api.yourdomain.com/api/tokens
# → each entry carries last_used_at and last_used_ip

# Revoke
curl -X DELETE -H "Authorization: Bearer $API_TOKEN" \
  https://obsidian-api.yourdomain.com/api/tokens/tok_a1b2c3d4e5f6
```

**How restrictions are enforced**

- Endpoints addressing one path (`/api/file/{path}` and its `/append`, `/move`,
  `/body`, `/patch`, `/links` variants, `/api/directory/{path}`) return `403`
  with the offending path.
- Endpoints taking paths in the body (`/api/files/batch`, `/api/files/move`,
  `/api/folders`, `/api/folders/move`) reject the **whole** request if any path
  is out of scope, rather than silently doing part of the work.
- Listing endpoints (`/api/files`, `/api/search`, `/api/directory`,
  `/api/projects`) filter results silently, so a restricted token cannot probe
  for the existence of files it may not read. A directory that merely leads to
  an allowed prefix stays browsable; its files do not become readable.
- **`/api/query` is refused to path-restricted tokens.** An arbitrary `SELECT`
  cannot be filtered safely — an aggregate such as `group_concat(path)` would
  leak content without ever returning a path column. Use `/api/files` with
  frontmatter filters, which is properly scoped. Unrestricted tokens keep SQL.
- **`/api/webhooks` and `/api/tokens` require `admin`**, because both can bypass
  path restrictions: a webhook with `include_body` streams file contents to an
  arbitrary URL, and token creation can mint an unrestricted credential.
- `/api/files/batch`, `/api/query` and `/api/links/check` are reads that use
  POST for their body, and need `read`, not `write`.

**Storage.** `/data/tokens.json` (the `sqlite-data` volume), outside the synced
vault, written atomically. Override with `TOKENS_CONFIG_PATH`. Only SHA-256
hashes are kept: a leak of that file yields nothing usable. Revoked tokens stay
in the file so their audit trail survives.

**From MCP**: `list_api_tokens()` and `revoke_api_token(id)` are exposed.
Creation deliberately is not — the MCP server proxies to the REST API with the
root `API_TOKEN`, so exposing creation would let any MCP caller mint an
unrestricted credential. Revocation is safe to expose because it only ever
removes access.

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

Two methods are supported, checked in this order:

**1. Authorization header — the env `API_TOKEN`, or any named token from the store
(recommended for Claude Code CLI / Codex CLI — simpler than OAuth for those clients)**

Prefer a named token over the shared `API_TOKEN`: one per client means you can
revoke the laptop's without touching n8n's, and `last_used_at` tells you whether
a key is still in use before you kill it.

> **MCP takes only unrestricted tokens.** This server calls the REST API with the
> root `API_TOKEN`, so a token's scopes and paths are *not* enforced on what you
> do through MCP. A path-restricted or read-only token is therefore **refused**
> with a `403` explaining why, rather than quietly running as root. Use such
> tokens against the REST API directly, where they are enforced. Scoping over
> MCP would require forwarding the caller's credential per request — separate
> work, not done here.
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

> **Removed 2026-09-03 — token in the URL path.** `https://mcp.DOMAIN/<API_TOKEN>`
> is no longer accepted and returns `401`. A token in a URL is written to every
> proxy and access log it crosses, lands in browser history and `Referer`
> headers, and cannot be scrubbed from any of them afterwards; a header is not
> logged by default anywhere in that chain. Clients configured that way must
> move the token into `Authorization: Bearer`, as in method 1 above.

**2. OAuth 2.1 + PKCE (Zitadel)** — used automatically by OAuth-aware clients like claude.ai
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

A second role, **`obsidian:admin`** (`OAUTH_ADMIN_ROLE`), gates the API-token
tools on top of that. `obsidian:access` lets an identity work in the vault;
`obsidian:admin` lets it hand out and revoke credentials.

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
| `search_vault(query, mode, rerank, limit, fuzzy, since, before, path)` | Search vault — hybrid by default (`mode`: `auto`/`hybrid`/`semantic`/`bm25`/`grep`/`fuzzy`), optional cloud reranking, date and folder filters |
| `get_projects()` | List project folders under `20_Projects/Pro/` |

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

#### Comments

Read and write [Document Comments](https://github.com/kylemcd/obsidian-document-comments) plugin threads directly in markdown — output is fully compatible with the plugin (created/edited here shows up and is editable in Obsidian, and vice versa). A thread is an anchor span `<!--c:ID-->text<!--/c:ID-->` wrapping the commented passage, plus a block `<!--co:ID by:author at:timestamp status:open|resolved quote:"..."` followed by one reply line per participant, closed by `-->`.

| Tool | Description |
|------|-------------|
| `extract_comments(file_path, file_paths, folder)` | Extract every comment thread from one or more files as JSON: `{"id", "status", "quote", "created_by", "created_at", "anchored_text", "replies": [{"author", "at", "text"}]}`. Provide exactly one of `file_path` / `file_paths` / `folder` (recursive) |
| `create_comment(file_path, quote, text, author="agent")` | Create a new thread anchored to the first occurrence of `quote` (must match the file's text exactly); returns the new thread's `comment_id` |
| `reply_to_comment(file_path, comment_id, text, author="agent")` | Append a reply to an existing thread without touching its status |
| `set_comment_status(file_path, comment_id, resolved)` | Resolve (`resolved=True`, i.e. "close") or reopen (`resolved=False`) a thread; anchored text and replies are untouched |
| `delete_comment(file_path, comment_id)` | Remove a thread entirely — anchor markers and thread block are deleted, the previously-anchored text is left in place as plain markdown |

#### Webhooks (read-only)

| Tool | Description |
|------|-------------|
| `list_webhooks()` | List active vault-change webhooks (secrets redacted). Webhooks are created/managed via the REST API, not from MCP. |

#### API tokens

| Tool | Description |
|------|-------------|
| `list_api_tokens()` | List the scoped REST API tokens — name, scopes, path restrictions, expiry, last use. Secrets are never returned. |
| `create_api_token(name, scopes, path_allow, path_deny, expires_at)` | Mint a token. The plaintext is in the response and nowhere else. |
| `revoke_api_token(token_id)` | Revoke a token by id, effective on the next request. |

These three require the **`obsidian:admin`** role (`OAUTH_ADMIN_ROLE`) on top of
`obsidian:access`. Using the vault and handing out credentials that reach it are
separate privileges: an identity can be given one without the other, and the
capability is withdrawn by removing the role in Zitadel — no redeploy, nothing
else affected.

The check runs in `AuthMiddleware`, which inspects the JSON-RPC body for a
`tools/call` naming one of these tools and returns `403` before the request ever
reaches the tool. It is deliberately not a contextvar set around the app call:
under streamable HTTP a tool can execute in a task created before the current
request, which would either lose the principal or — worse — inherit the previous
request's.

Callers presenting the static `API_TOKEN` pass this gate. That is not a
loophole so much as an acknowledgement: `API_TOKEN` is already root on the REST
API, so anyone holding it can `POST /api/tokens` directly. The role separation
is meaningful **between OAuth identities**, and becomes airtight once the static
Bearer path is removed from the MCP server too (the URL-path one already is).

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

### Search returns nothing, or only keyword-quality results

Check `GET /api/search/status` (or `get_sync_status` from MCP) first — it says
which half of the index is actually working.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `chunks: 0` | The chunk backfill never ran | Restart `obsidian-api`; `reconcile()` chunks every note missing from the index on boot |
| `pending` stuck > 0, `embed_error` set | An API-key provider (`jina`/`openai`/`voyage`) has no key, or `EMBED_PROVIDER=local` hit a transient failure (e.g. the HuggingFace download) | A missing/wrong key needs the env var fixed **and the container recreated** — Docker never re-reads `.env` into a running container. A transient `local`-provider failure just needs `POST /api/search/reindex` |
| `pending` slowly decreasing | Backfill in progress (10–20 min for ~2k notes on CPU) | Wait; searches answer with BM25 meanwhile |
| `semantic_ready: false`, no error | `EMBED_PROVIDER=none`, or `@huggingface/transformers` missing from the install | Set a provider and make sure the package is in the container's `npm install` |
| `warnings: ["rerank: ..."]` | Reranker call failed | Results are still the hybrid ones; check `JINA_API_KEY` |
| Results look stale | Watcher died — see above | Restart the service |

## Security Notes

- Keep `.env` secure — never commit it to Git
- `API_TOKEN` is shared between the REST API and MCP server; all non-health endpoints are protected
- Obsidian Sync provides end-to-end encryption for vault data at rest
- Directory traversal is blocked server-side on all file endpoints
- **Webhooks**: created only via the authenticated REST API (never from MCP); the config lives outside the synced vault (`/data/webhooks.json`); secrets are stored server-side and redacted in all API/MCP responses. SSRF is blocked by default — only public `https://` targets are allowed, redirects are not followed, and the destination is re-validated before every delivery. Loosen this only via `WEBHOOK_ALLOW_PRIVATE=true` for trusted internal receivers.
- **MCP credential management**: `create_api_token` / `list_api_tokens` /
  `revoke_api_token` require the `obsidian:admin` role, checked in the auth
  middleware before the request reaches the tool. Note that the static
  `API_TOKEN` also passes, since it is already root on the REST API and could
  call `POST /api/tokens` directly — the separation bites between OAuth
  identities, and would become absolute if the static Bearer path were retired
  too (the URL-path variant already is).
- **MCP OAuth**: the MCP server (`mcp.DOMAIN`) also accepts OAuth 2.1 + PKCE via Zitadel
  alongside the static `API_TOKEN`. For OAuth requests, every bearer token is validated
  against Zitadel's `/oidc/v1/userinfo`, and access is denied (`403`) unless the token's
  claims include the `obsidian:access` project role. This role check matters because
  Zitadel doesn't support RFC 8707 resource indicators: a token issued for the shared
  `Claude-web` client can carry an audience covering every MCP server in the `mcp-servers`
  project, not just this one, so a valid signature alone isn't proof of authorization for
  this specific server. The URL-path token variant was removed on 2026-09-03 (a
  token in a URL is logged everywhere it travels and cannot be scrubbed back
  out); the static Bearer token, compared in constant time, stays alongside OAuth.

---

## Hybrid search

Search is chunked, ranked, and hybrid: every note is split into ~2200-character
sections and each chunk is indexed twice — lexically (BM25 via FTS5) and
semantically (a vector embedding). A query runs against both and the two
rankings are fused.

### Why both halves

Neither retriever alone is enough on a real vault:

- BM25 finds `INC-4471`, `Nokia`, `WALB` — exact tokens a vector model blurs.
  It cannot find a note that says *migration serveur* when you searched for
  *changement d'hébergeur*.
- The vector half finds exactly that, and fails on rare identifiers it never
  saw in training.

They are fused with **Reciprocal Rank Fusion** (`score = Σ 1/(60 + rank)`).
Rank-based fusion is the point: BM25 scores and cosine similarities live on
different scales, and RRF needs no per-corpus calibration to combine them.

### The pipeline

```
query
  ├─ FTS5 BM25          ─┐
  │   (diacritic-folded, │
  │    prefix variants)  ├─ RRF fusion ─→ top 40 chunks ─→ [rerank] ─→ group by note
  └─ vector search      ─┘
      (cosine over the
       in-memory matrix)
```

Notes on each stage:

- **Chunking** splits on markdown headings, merges consecutive small sections,
  and splits oversized ones at paragraph boundaries with a 300-character
  overlap. Headings inside fenced code blocks are not treated as headings.
- **BM25** uses the `unicode61 remove_diacritics 2` tokenizer, so `reunion`
  matches `réunion`. FTS5 has no French stemmer, so tokens of 4+ characters
  also get a prefix variant — that is what makes `réunion` match `réunions`.
  Column weights favour a hit in the note title or section heading.
- **Vector search** is a brute-force scan over an in-memory `Float32Array`.
  At this vault's scale (~2k notes → ~5k chunks → ~8 MB) a full scan is a few
  milliseconds; an ANN index would add a native dependency for no gain. Revisit
  past ~100k chunks.
- **Embedding** happens in a background worker, in batches, after indexing.
  Chunks are content-hashed, so an unchanged section keeps its vector when the
  note around it is edited, and a moved or renamed note is never re-embedded.

### Embedding provider

`EMBED_PROVIDER=local` (the default) runs `multilingual-e5-small` on CPU
through transformers.js. Measured on 4 vCPU: **~100 ms per chunk** to index,
**~4 ms** to embed a query, and **~1 GB RSS** once the model is loaded. A
~2000-note vault backfills in roughly 10–20 minutes, once.

That gigabyte is the real cost of keeping everything local. If it is too much
for the box, `EMBED_PROVIDER=jina|openai|voyage` embeds through an API instead:
near-zero RAM, a few cents to index the whole vault at $0.02/M tokens — at the
price of sending note text to that provider. `EMBED_PROVIDER=none` disables the
semantic half; search still works, ranked, on BM25 alone.

Switching embedding model or provider invalidates the vectors. Clear them and
let the worker rebuild:

```bash
sqlite3 /data/vault-index.db "UPDATE chunks SET embedding = NULL, embed_model = NULL;"
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://obsidian-api.yourdomain.com/api/search/reindex
```

### Reranking (optional)

A cross-encoder reranker reorders the top candidates and is the single largest
quality win available — but it is **off by default** and needs two things to
fire: an API key, and `rerank=true` on the request.

Local reranking is deliberately not supported. A 0.6B cross-encoder on a 2 vCPU
VPS costs *minutes* per query; the hosted call costs a few hundred milliseconds
and ~$0.0003 per search (Jina/Voyage, ~16k tokens at $0.02/M — roughly $1/month
at 100 searches a day).

The privacy trade-off is sharper than for embeddings, and worth being explicit
about: embedding a query sends ~5 words to the provider, while **reranking
sends the full text of every candidate passage**. `RERANK_EXCLUDE_PATHS` holds
back whole folders — their chunks are never put in the payload and keep their
pre-rerank position:

```bash
RERANK_EXCLUDE_PATHS=10_Context/perso,50_Archives/prive
```

A reranker outage degrades to the fused hybrid order and reports itself in
`warnings`; it never empties a result page.

### Tuning

| Variable | Default | Effect |
|----------|---------|--------|
| `SEARCH_CHUNK_MAX_CHARS` | `2200` | Chunk size ceiling (~550 tokens) |
| `SEARCH_CHUNK_OVERLAP_CHARS` | `300` | Overlap carried across a split |
| `SEARCH_CANDIDATE_LIMIT` | `40` | Chunks kept after fusion (and sent to the reranker) |
| `SEARCH_RRF_K` | `60` | RRF constant; lower favours top ranks more sharply |
| `EMBED_BATCH_SIZE` | `8` local / `64` remote | Chunks per embedding call — lower this if a remote provider's per-minute token limit gets tripped often |
| `EMBED_WORKER_BATCH` | `32` | Chunks pulled from the DB per worker pass |
| `EMBED_RETRY_MAX_ATTEMPTS` | `5` | Retries for a single batch on 429/5xx before giving up until the next scheduled pass |
| `EMBED_RETRY_BASE_MS` / `EMBED_RETRY_MAX_MS` | `5000` / `60000` | Backoff between retries (a provider's own `Retry-After` header wins when present) |

## Files Reference

### `obsidian-api.js`
Express REST API server. Handles file reads/writes, frontmatter parsing (js-yaml), search (hybrid, plus legacy grep/fuzzy modes), directory listing, wikilink resolution, and SQL queries via the vault indexer.

### `vault-indexer.js`
SQLite indexer (better-sqlite3). Bootstraps a full index on first start, then keeps it live via a chokidar file watcher. Indexes frontmatter, tags, and tasks from every `.md` file. Each `add`/`change`/`unlink` also fans out to the webhook dispatcher.

### `search-index.js`
Hybrid search: markdown chunking, the FTS5/BM25 index, the vector index and its
brute-force cosine scan, RRF fusion, and the background embedding worker. Shares
the indexer's SQLite handle rather than opening its own.

### `embeddings.js`
Embedding providers behind one interface — `local` (transformers.js on CPU),
`jina`, `openai`, `voyage`, `none`. Always returns L2-normalised vectors, and
never throws fatally: an unavailable provider degrades search to BM25.

### `rerank.js`
Optional cloud reranking of search candidates (Jina, Cohere, Voyage), with the
`RERANK_EXCLUDE_PATHS` guard and a failure path that preserves the hybrid order.

### `webhooks.js`
Webhook configuration, matching, and delivery. Persists webhooks to `/data/webhooks.json` (atomic writes), filters changes by folder glob and frontmatter subset, and POSTs signed payloads with bounded concurrency, timeouts, retries, and SSRF protection. Created/managed via the REST API; listed read-only via MCP.

### `tokens.js`
Scoped API tokens: creation, hashing, lookup and the allow/deny path logic.
Persists to `/data/tokens.json` (atomic writes), stores SHA-256 only, and never
returns a secret after creation.

### `obsidian_mcp.py`
FastMCP server with streamable HTTP transport. Proxies all operations to the REST API. Includes
`AuthMiddleware`, which accepts either the static token (Bearer header, constant-time compare) or
an OAuth 2.1 access token validated against Zitadel, plus the `/.well-known/oauth-protected-resource`
metadata endpoint required by OAuth-aware MCP clients.

## License

MIT
