---
created: 2026-09-02
updated: 2026-09-02
---

# Reference — MCP tools (`obsidian` server)

Complete catalogue of the `obsidian` MCP server. All tools proxy the REST API
(`_system/API.md`). Prefix them as your client does — `obsidian:read_file`,
`mcp__obsidian__read_file`, etc.

---

## Resources

| URI | Content |
|---|---|
| `obsidian://files` | Every markdown file in the vault |
| `obsidian://health` | Vault health |

---

## Files

| Tool | Notes |
|---|---|
| `read_file(file_path, resolve_links=True)` | Default returns JSON: `{"content", "wikilinks":[{"raw","target","exists","resolved","ambiguous"?}]}`. `raw` is the link as written (with alias or heading anchor), `target` strips those, `resolved` is the real path (Obsidian resolves by *shortest path*, so it may differ from `target`), `ambiguous` lists candidates when several notes share a basename. `resolved` is `null` for broken links. Pass `resolve_links=False` for raw markdown — cheaper when you only need text. |
| `write_file(file_path, content)` | Create / full overwrite |
| `append_to_file(file_path, content)` | Append at end; creates the file if missing |
| `patch_file(file_path, old_text, new_text, replace_all=False)` | Surgical replace. First occurrence by default. **Errors if `old_text` is not found — nothing is written.** Empty `new_text` deletes the match |
| `move_file(file_path, destination)` | Move / rename; missing destination folders are created |
| `delete_file(file_path, hard=False)` | Soft by default → `.trash/` (recoverable, purged after 30 days) |

Every write tool returns:
- an `obsidian://open` deep link (when `VAULT_NAME` is set), and
- a **warning listing broken wikilinks in what you just wrote**, with fuzzy
  suggestions. Pre-existing broken links elsewhere in the file are not reported.

Read that warning: it is the cheapest signal that you owe `02_Context/` a stub.

**Choosing a write tool** — narrowest wins:

| Need | Tool |
|---|---|
| A few frontmatter fields | `update_frontmatter` |
| Same fields on many files | `bulk_update_frontmatter` |
| A precise passage | `patch_file` |
| Add at the end | `append_to_file` |
| New file / full rewrite | `write_file` |

Never `write_file` a whole note just to change `status:`.

## Frontmatter

| Tool | Notes |
|---|---|
| `update_frontmatter(file_path, updates)` | Merge; body untouched; set a value to `null` to delete the field |
| `bulk_update_frontmatter(file_paths, updates)` | Same patch on up to 100 files |

Always include `updated: YYYY-MM-DD` — the *Update Time on Edit* plugin only
covers edits made in the Obsidian UI, not MCP writes.

## Folders & navigation

| Tool | Notes |
|---|---|
| `create_folders(folder_paths)` | Up to 100, parents included — scaffold a whole project tree in one call |
| `delete_folders(folder_paths, hard=False)` | Up to 100, recursive, soft by default |
| `move_folders(moves)` | Up to 100 independent `{"from","to"}` dicts; missing parents created |
| `list_directory(dir_path="")` | `""` = vault root |
| `get_projects()` | **`20_Projects/Pro/` only** — for Perso use `list_directory("20_Projects/Perso")` |

## Search & index

| Tool | Notes |
|---|---|
| `search_vault(query, fuzzy=False, since="", before="")` | Content search; `fuzzy=True` adds scored title matching; dates are creation dates, `YYYY-MM-DD` |
| `query_vault(sql)` | `SELECT` only, over the SQLite index |
| `run_index(file_path, section="")` | Execute the SQL blocks embedded in an `_index.md`; empty `section` lists available sections |
| `extract_tasks(file_path, isolate_tags=False)` | Checklist items as `{"checked","text","tags"}`; `isolate_tags=True` pulls inline bracket groups (e.g. `if:plage`) out of `text` into `tags` |

**Index schema**

`files(path, title, created, modified, tags, frontmatter)` — `tags` is a JSON
array, `frontmatter` a JSON object.
`tasks(file_path, text, completed, due)` — `completed` is `0`/`1`, `due` from
`📅` or `due::`.

`.trash/` and dotfiles are **not indexed**.

```sql
-- map a project's referential before opening any sheet
SELECT path, json_extract(frontmatter,'$.type') AS type,
       json_extract(frontmatter,'$.summary') AS summary
FROM files
WHERE path LIKE '20_Projects/Pro/<Projet>/02_Context/%'
  AND json_extract(frontmatter,'$.status') != 'archived'
ORDER BY type, path;

-- raw sources waiting to be ingested
SELECT path FROM files
WHERE path LIKE '%/00_Raw/%'
  AND json_extract(frontmatter,'$.status') = 'validated'
  AND json_extract(frontmatter,'$.processed_at') IS NULL;

-- everything tagged, anywhere
SELECT path FROM files WHERE tags LIKE '%"gouvernance"%';
```

If a just-written file never shows up in `query_vault`, the file watcher is
likely dead — check `get_sync_status()` (`watcher_closed`, `in_sync`,
`last_event.at`).

## Comments (Document Comments plugin)

Round-trip compatible with Obsidian: a thread is an anchor span
`<!--c:ID-->text<!--/c:ID-->` plus a block
`<!--co:ID by:author at:timestamp status:open|resolved quote:"..."` with one
reply line per participant, closed by `-->`.

| Tool | Notes |
|---|---|
| `extract_comments(file_path, file_paths, folder)` | Provide **exactly one** argument; `folder` is recursive. Returns `{"id","status","quote","created_by","created_at","anchored_text","replies":[{"author","at","text"}]}` |
| `create_comment(file_path, quote, text, author="agent")` | `quote` must match the file text exactly; returns the new `comment_id` |
| `reply_to_comment(file_path, comment_id, text, author="agent")` | Status untouched |
| `set_comment_status(file_path, comment_id, resolved)` | Resolve / reopen |
| `delete_comment(file_path, comment_id)` | Removes the thread; the anchored text stays as plain markdown |

## Sync & webhooks

| Tool | Notes |
|---|---|
| `sync_vault()` | Trigger an Obsidian Sync run |
| `get_sync_status()` | Sync status + index/watcher health (`watcher_ready`, `watcher_closed`, `db_file_count`, `vault_file_count`, `in_sync`, `last_event`, `last_error`) |
| `list_webhooks()` | Read-only. Webhooks are created and managed **only** through the REST API |

---

## Gotchas

- **Wikilinks:** filename only, no path, no `.md`. Check the `ambiguous` field
  returned by `read_file` / the write warnings before assuming a link resolved
  where you expected.
- **Forbidden characters in titles:** `/ \ : * ? " < > |`. A title becomes a
  filename — `€/m²` once created a `€/` folder containing `m².md`.
- **`get_projects()` is Pro-only.**
- **`patch_file` fails loudly** (422 upstream) when `old_text` isn't found. That
  is the desired behaviour — never fall back to `write_file` to force it through.
- **`00_Raw/`:** frontmatter only (`status`, `processed_at`); never the body.
- **`_index.md`:** read and `run_index` it, never write it.
