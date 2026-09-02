---
created: 2026-03-29
updated: 2026-09-02
---

# Reference — REST API

Summary. Full documentation lives in the vault at **`_system/API.md`**; the code
is in the `seb7152/obsidian-headless-mcp` repository.

Base URL `https://obsidian-api.<DOMAIN>` (production instance:
`obsidian-api.srv1119889.hstgr.cloud`; local `http://localhost:3000`).
Every endpoint except `GET /health` requires:

```
Authorization: Bearer <API_TOKEN>
```

Use the REST API for automations (n8n, scripts) and for webhooks. Inside an
agent session, prefer the MCP tools — they proxy these same endpoints.

---

## Endpoints

### Files — single

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/file/{path}` | Read — returns `frontmatter`, `body`, `content` |
| `POST` | `/api/file/{path}` | Create / overwrite |
| `PATCH` | `/api/file/{path}` | Merge frontmatter fields (body untouched) |
| `PATCH` | `/api/file/{path}/body` | Replace body only |
| `PATCH` | `/api/file/{path}/patch` | Surgical `old_text` → `new_text` |
| `POST` | `/api/file/{path}/append` | Append at end |
| `POST` | `/api/file/{path}/move` | Move / rename |
| `DELETE` | `/api/file/{path}` | Soft delete → `.trash/`; `?hard=true` = permanent |
| `GET` | `/api/file/{path}/links` | Broken wikilinks (`?suggest=true` for fuzzy suggestions) |
| `POST` | `/api/links/check` | Broken wikilinks in an arbitrary text snippet |

### Files — bulk

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/files` | List with filters: `path`, `since`, `before`, **any frontmatter key** |
| `POST` | `/api/files/batch` | Read up to 100 files |
| `PATCH` | `/api/files/batch` | Same frontmatter patch on up to 100 files |
| `POST` | `/api/files/move` | Move several files into one `destination_folder` |

### Folders, directory, search

| Method | Path | Description |
|---|---|---|
| `POST` / `DELETE` | `/api/folders` | Create / delete up to 100 folders |
| `POST` | `/api/folders/move` | Up to 100 independent `{from,to}` moves |
| `GET` | `/api/directory[/{path}]` | List a directory |
| `GET` | `/api/search?q=…` | `fuzzy=true`, `since`, `before` |

### Index, projects, sync

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/query` | `SELECT` over the SQLite index (`files`, `tasks`) |
| `GET` | `/api/projects` | Subfolders of `20_Projects/Pro/` only |
| `GET` | `/api/agent/context` | `agent.md` + endpoint list |
| `POST` | `/api/sync` | Trigger Obsidian Sync |
| `GET` | `/api/sync/status` | Sync + index/watcher health |

### Webhooks — REST only

| Method | Path |
|---|---|
| `GET` | `/api/webhooks`, `/api/webhooks/{id}` |
| `POST` | `/api/webhooks`, `/api/webhooks/{id}/test` |
| `PATCH` / `DELETE` | `/api/webhooks/{id}` |

Fire on `add` / `change` / `unlink` of `.md` files. Filters: `folder`
(recursive, wildcards per segment — `20_Projects/*/00_Raw`), `frontmatter`
(subset match), `frontmatter_not` (skip if matched — this is how write loops are
broken, e.g. `{"last_write_origin":"todoist"}`). Optional `secret` signs each
delivery with `X-Obsidian-Signature: sha256=<hmac>`; `include_body` adds the file
body. SSRF is blocked by default — public `https://` targets only.

MCP can only **list** webhooks.

---

## Error codes

| Code | Meaning |
|---|---|
| `400` | Malformed request / missing parameter |
| `401` | Missing or invalid token |
| `403` | Access denied (directory traversal, missing OAuth role) |
| `404` | File or folder not found |
| `422` | `old_text` not found on a surgical patch — **nothing was modified** |
| `500` | Server error |

---

## Examples

```bash
# Drafts of a given type in a project
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/files?type=extraction&status=draft&path=20_Projects/Pro/Agents%20IA"

# Frontmatter-only update
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"validated","processed_at":"2026-09-02","updated":"2026-09-02"}' \
  "$BASE/api/file/<path>.md"

# Surgical patch
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"old_text":"status: draft","new_text":"status: active"}' \
  "$BASE/api/file/<path>.md/patch"

# SQL
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sql":"SELECT path FROM files WHERE json_extract(frontmatter,'\''$.status'\'')='\''draft'\'' LIMIT 20"}' \
  "$BASE/api/query"
```

## Operational note

The index and the webhooks share one chokidar watcher. On Docker bind mounts
inotify often doesn't propagate, hence `CHOKIDAR_USEPOLLING=true` in the compose
file. If a new file never appears in `/api/query`, the watcher is blind —
`/api/webhooks/{id}/test` bypasses it, so a successful test proves nothing about
it. Check `GET /api/sync/status` → `watcher_closed`, `in_sync`, `last_event.at`.
