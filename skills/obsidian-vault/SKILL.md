---
name: obsidian-vault
description: Navigate Sébastien's Obsidian vault (myVault) through the obsidian MCP server. Trigger on any mention of Obsidian, the vault, a note, a project folder (20_Projects, 00_Inbox, 10_Context, 15_Chantiers, 30_Knowledge, 60_Tools), the Raw/Refined/Context pipeline, project context retrieval, or the vault REST API. This skill is a router, not a rulebook - it says which reference file in the vault answers which question (structure, note types and statuses, agent permissions, per-type writing instructions), and documents the MCP tool catalogue and REST API, which the vault itself does not cover.
created: 2026-04-27
updated: 2026-09-02
---

# Obsidian Vault Skill

Router for **myVault** — Sébastien's Obsidian vault, served headless through the
`obsidian` **MCP server** (primary) and a **REST API** (automations).

**This skill does not restate the vault's governance.** The vault documents its
own structure, note types, statuses and agent rules, and those files change
faster than this skill. The skill's job is to get you to the right file fast,
and to cover the one thing the vault doesn't document: the MCP and REST tooling.

> When this skill and the vault disagree, **the vault wins** — say so and follow
> the vault.

---

## 1. Startup — read these, in this order

Imposed by `CLAUDE.md` at the vault root:

| # | File | Answers |
|---|---|---|
| 1 | `agent.md` (root) | Who the user is, how to route the session, which files matter |
| 2 | `_system/Gouvernance/vault-structure.md` | The whole tree, the role of every folder, the canonical project layout, migration state |
| 3 | `_system/Gouvernance/agent-rules.md` | What you may and may not do. **Never modify this file** |
| 4 | `_system/Gouvernance/referentiel-types-statuts.md` | Every governed note type, its status cycle, where it lives |

Then, by task:

| Task | Open |
|---|---|
| Writing a note of any governed type | `_system/Instructions/<type>.md` — see §3 |
| Anything touching a project's pipeline | `_system/Instructions/raw-refined-context.md` |
| Creating a project | `20_Projects/_Template_projet.md` |
| Understanding a project's domain | that project's `02_Context/` — query it first, see §4 |
| Calling the REST API | `_system/API.md` |

---

## 2. Reference map — which file answers what

Full index with paths: `references/reference-map.md`.

| Question | Reference |
|---|---|
| Where does this note go? What is this folder for? | `_system/Gouvernance/vault-structure.md` |
| What type should this note be? Which status next? | `_system/Gouvernance/referentiel-types-statuts.md` |
| Am I allowed to write here? Delete this? Rename this? | `_system/Gouvernance/agent-rules.md` |
| What exact fields does a `stakeholder` / `decision` / … need? | `_system/Instructions/Context/<type>.md` |
| How does extraction / validation / promotion work? | `_system/Instructions/raw-refined-context.md` |
| How do dictated daily notes become chantiers? | `_system/Instructions/Refinement/daily-note-routing.md` |
| What folders does a new project get? | `20_Projects/_Template_projet.md` |
| Which MCP tool should I call? | `references/mcp-tools.md` |
| Which REST endpoint? | `references/rest-api.md`, then `_system/API.md` |

`_system/Gouvernance/` holds the three referentials and nothing else. Everything
about *how to write* a given note type lives in `_system/Instructions/`, one
file per type.

---

## 3. Finding the right instruction

`_system/Instructions/_index.md` is the Dataview entry point. The tree, as of
2026-09-02:

| Folder | Instructions |
|---|---|
| `Raw/` | `document`, `transcript`, `email-inbox-archiving` |
| `Refinement/` | `extraction`, `meeting-summary`, `daily-note-routing`, `daily-refinement`, `weekly-refinement`, `weekly-summary`, `weekly-synthesis-by-theme`, `weekly-synthesis-evolution` |
| `Context/` | `stakeholder`, `organization`, `topic`, `decision`, `decision-capitalisation`, `vendor`, `project`, `use-case`, `process`, `insight`, `synthesis`, `knowledge-note`, `context`, `reflection`, `cockpit`, `wiki-lint` |
| `Notes atomiques/` | `permanent-note`, `atomic-note-formatting`, `Atomic-note-deconstruction`, `MOC-model-detection`, `quickstart-zettelkasten`, `gemini-permanent-note-extraction` |
| `Coding/` | `session-log`, `coding-session-log`, `debug-log`, `pattern` |
| `Pro/` | `email-writing`, `email-minutes` |
| `Cadeaux/`, `Checklist/`, `Finance/`, `Podcast/` | domain-specific |

Don't trust that list over the vault — re-derive it whenever it matters:

```sql
SELECT path, json_extract(frontmatter,'$.summary') AS summary
FROM files
WHERE path LIKE '_system/Instructions/%'
  AND json_extract(frontmatter,'$.type') = 'instruction'
ORDER BY path;
```

**No instruction exists for a type → do not create that type without human
validation** (rule from `agent-rules.md`).

---

## 4. MCP tools

This is the part the vault does not document. Full catalogue, signatures and
gotchas: **`references/mcp-tools.md`**.

**Navigate & read**
```
list_directory(dir_path="")                    # "" = vault root
get_projects()                                 # 20_Projects/Pro/ only
search_vault(query, fuzzy=True, since, before)
query_vault(sql)                               # SELECT over the SQLite index
read_file(file_path, resolve_links=True)       # content + resolved wikilinks
```

**Write** — pick the narrowest tool that does the job:

| Need | Tool |
|---|---|
| A few frontmatter fields | `update_frontmatter` (body untouched) |
| Same patch on many files | `bulk_update_frontmatter` (≤ 100) |
| A precise passage | `patch_file(old_text, new_text)` — errors if not found |
| Add at the end | `append_to_file` |
| New file / full rewrite | `write_file` |
| Move / rename | `move_file`, `move_folders` |
| Delete | `delete_file` / `delete_folders` (soft by default → `.trash/`) |
| Scaffold a project tree | `create_folders([...])` in one call |

Never `write_file` a whole note to change one field.

**Also available**: `run_index` (execute a cockpit's SQL blocks), `extract_tasks`,
comment threads (`extract_comments`, `create_comment`, `reply_to_comment`,
`set_comment_status`, `delete_comment`), `sync_vault`, `get_sync_status`,
`list_webhooks` (read-only — webhooks are created via REST).

### Map a project before reading it

```sql
SELECT path, json_extract(frontmatter,'$.type')    AS type,
             json_extract(frontmatter,'$.summary') AS summary
FROM files
WHERE path LIKE '20_Projects/<Zone>/<Projet>/02_Context/%'
  AND json_extract(frontmatter,'$.status') != 'archived'
ORDER BY type, path;
```

This is the sanctioned substitute for a static index — see
`raw-refined-context.md`, "Carte sémantique". Tables: `files(path, title,
created, modified, tags, frontmatter)` and `tasks(file_path, text, completed,
due)`. `SELECT` only. `.trash/` and dotfiles are not indexed.

---

## 5. REST API

For automations (n8n, scripts) and webhooks — inside an agent session prefer
MCP. Summary in `references/rest-api.md`, full reference in **`_system/API.md`**.

Base `https://obsidian-api.<DOMAIN>`, `Authorization: Bearer <API_TOKEN>` on
everything except `GET /health`. Webhooks are REST-only; MCP can only list them.

---

## 6. Tool-level reflexes

Not governance — consequences of how the tools behave. The authoritative rule is
always in the file named alongside.

- **Wikilinks: filename only**, no folder path, no `.md`. Write tools return a
  warning listing broken links in what you just wrote — read it. Exceptions and
  the pipe-alias case: `agent-rules.md`.
- **Set `updated: YYYY-MM-DD` on every MCP write.** The *Update Time on Edit*
  plugin only fires in the Obsidian UI.
- **Forbidden in a title**, because it becomes a filename: `/ \ : * ? " < > |`.
- **`_index.md` is generated** — read it or `run_index` it, never write it.
- **`00_Raw/` content is immutable** — frontmatter only (`status`,
  `processed_at`). See `raw-refined-context.md`.
- **`get_projects()` covers `Pro/` only** — use `list_directory` for `Perso/`.
- **`patch_file` fails loudly** when `old_text` is absent. That is the point;
  never fall back to `write_file` to force the edit through.
- **A file that never appears in `query_vault`** means the watcher is likely
  dead — check `get_sync_status()`.

---

## 7. Reflexes on the work itself

- **Project not named in the request?** Ask. Don't guess the container.
- **Can't find the context?** Say so and propose fixing the index, rather than
  inventing a location.
- **Before creating anything:** search for what exists (`search_vault` fuzzy +
  `query_vault`), then open the type's instruction and follow it.
- **Zone check:** never mix pro and perso in one note; never open
  `10_Context/Perso/` during a pro session (`agent-rules.md`).
