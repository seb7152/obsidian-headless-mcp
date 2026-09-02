---
created: 2026-04-11
updated: 2026-09-02
---

# Quick Reference

One screen. Everything here is a pointer — the answers live in the vault.

---

## Startup

```
agent.md
  → _system/Gouvernance/vault-structure.md          (tree, folder roles, project canon)
  → _system/Gouvernance/agent-rules.md              (permissions — never modify)
  → _system/Gouvernance/referentiel-types-statuts.md (types & status cycles)
  → _system/Instructions/<type>.md                  (before writing that type)
  → _system/Instructions/raw-refined-context.md     (before touching a project)
```

## Where do I look?

| Question | File |
|---|---|
| Where does this note go? | `Gouvernance/vault-structure.md` |
| Which type? which status? | `Gouvernance/referentiel-types-statuts.md` |
| May I write / delete / rename this? | `Gouvernance/agent-rules.md` |
| What fields does this type need? | `Instructions/<famille>/<type>.md` |
| How does the pipeline behave? | `Instructions/raw-refined-context.md` |
| Daily note → chantier? | `Instructions/Refinement/daily-note-routing.md` |
| New project folders? | `20_Projects/_Template_projet.md` |
| Project domain context? | `<projet>/02_Context/` (query it, §SQL below) |
| REST endpoints? | `_system/API.md` |
| MCP tools? | `references/mcp-tools.md` |
| Full index of references | `references/reference-map.md` |

## Which write tool?

| Need | Tool |
|---|---|
| A few frontmatter fields | `update_frontmatter` |
| Same fields, many files | `bulk_update_frontmatter` (≤100) |
| A precise passage | `patch_file` (errors if `old_text` absent) |
| Add at the end | `append_to_file` |
| New file / full rewrite | `write_file` |
| Move / rename | `move_file`, `move_folders` |
| Delete | `delete_file` (soft → `.trash/`) |
| Scaffold a tree | `create_folders([...])` |

Never `write_file` a whole note to change one field.

## SQL starters

```sql
-- map a project's referential before opening any sheet
SELECT path, json_extract(frontmatter,'$.type') AS type,
       json_extract(frontmatter,'$.summary') AS summary
FROM files WHERE path LIKE '%/02_Context/%'
  AND json_extract(frontmatter,'$.status') != 'archived' ORDER BY type, path;

-- raw sources waiting to be ingested
SELECT path FROM files WHERE path LIKE '%/00_Raw/%'
  AND json_extract(frontmatter,'$.status') = 'validated'
  AND json_extract(frontmatter,'$.processed_at') IS NULL;

-- the live list of instructions
SELECT path, json_extract(frontmatter,'$.summary') AS summary FROM files
WHERE path LIKE '_system/Instructions/%'
  AND json_extract(frontmatter,'$.type') = 'instruction' ORDER BY path;

-- open tasks due within 7 days
SELECT file_path, text, due FROM tasks
WHERE completed = 0 AND due <= date('now','+7 days') ORDER BY due;
```

## Tool-level reflexes

| Do | Why |
|---|---|
| Wikilink = filename only | Obsidian resolves by shortest path; write tools flag broken links |
| Set `updated` on every MCP write | The Obsidian plugin only fires in the UI |
| No `/ \ : * ? " < > \|` in a title | It becomes a filename |
| Never write `_index.md` | Generated — read it, or `run_index` |
| `00_Raw/` body is immutable | Frontmatter only (`status`, `processed_at`) |
| `get_projects()` = `Pro/` only | Use `list_directory` for `Perso/` |

Everything else — permissions, zones, statuses, formats — is in the vault. Open
the file rather than guessing.
