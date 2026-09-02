---
created: 2026-04-11
updated: 2026-09-02
---

# Quick Reference — Obsidian Vault Skill

Cheat sheet. Details in `SKILL.md` and `references/`.

---

## 1. Startup

```
agent.md
  → _system/Gouvernance/vault-structure.md      (tree)
  → _system/Gouvernance/agent-rules.md          (permissions)
  → _system/Gouvernance/referentiel-types-statuts.md   (types & statuses)
  → _system/Instructions/_index.md              (if writing/methodology)
  → _system/Instructions/raw-refined-context.md (if touching a project)
```

## 2. Where does this note go?

```
Unclear zone/project?          → 00_Inbox/
Idea, not yet a project?       → 15_Chantiers/          (type: chantier)
Piloted project?               → 20_Projects/<Pro|Perso>/<Projet>/
   raw source                  →   00_Raw/<Transcripts|Emails|Documents|Notes>/
   summary / one-fact note     →   01_Refined/<01_Meetings|02_Podcasts|0N_Extraction>/
   validated entity            →   02_Context/<00_Meta|01_Stakeholders|02_Topics|03_Décisions|…>/
Personal tool sheet?           → 60_Tools/
User context?                  → 10_Context/<Pro|Perso>/
Mature, promoted knowledge?    → 30_Knowledge/[thème]/   (human-validated only)
Zettelkasten draft?            → 30_Knowledge/permanent-notes/staging/
```

## 3. Which write tool?

| Need | Tool |
|---|---|
| A few frontmatter fields | `update_frontmatter` |
| Same fields, many files | `bulk_update_frontmatter` (≤100) |
| A precise passage | `patch_file` (errors if `old_text` not found) |
| Add at the end | `append_to_file` |
| New file / full rewrite | `write_file` |
| Move / rename | `move_file`, `move_folders` |
| Delete | `delete_file` (soft → `.trash/`) |
| Scaffold a tree | `create_folders([...])` |

Never `write_file` a whole note just to change one field.

## 4. Frontmatter skeleton

```yaml
---
title: "Titre lisible"
type: stakeholder                # governed type
zone: pro | perso | technique    # must match the path
project: "Agents IA"
status: draft                    # cycle imposed by the type
created: '2026-09-02'
updated: '2026-09-02'            # ALWAYS set on an MCP write
tags: []
agent: claude-ai
summary: >-
  1–3 lines.
---
```

## 5. Status cheat sheet

```
00_Raw      : draft → validated (+ processed_at once ingested) | skipped
01_Refined  : draft → validated
02_Context  : draft → active → archived
15_Chantiers: draft → active → archived   (archived = dropped or promoted)
debug-log / reflection : open → resolved
index, log  : active
```

## 6. Hard nos

| Don't | Do instead |
|---|---|
| Rewrite `00_Raw/` content | Frontmatter only (`status`, `processed_at`) |
| Create/edit an `_index.md` | Read it, or `run_index()` |
| Modify `agent-rules.md` | Propose the change to Sébastien |
| Write straight into `30_Knowledge/` | Promote from a `02_Context/`, human-validated |
| Open `10_Context/Perso/` in a pro session | Stay in the pro zone |
| Leave a broken wikilink | Create a `draft` stub in `02_Context/` |
| Stub an ambiguous entity | Leave the extraction `draft`, state the ambiguity |
| Stub a `decision` | Flag it for manual creation |
| A wikilink carrying a folder path | Filename only |
| `/ \ : * ? " < > \|` in a title | Rephrase (`€/m²` → `€ par m²`) |
| Delete/archive silently | Propose first |

## 7. Useful SQL

```sql
-- project referential map (run before opening sheets)
SELECT path, json_extract(frontmatter,'$.type') AS type,
       json_extract(frontmatter,'$.summary') AS summary
FROM files WHERE path LIKE '%/02_Context/%'
  AND json_extract(frontmatter,'$.status') != 'archived' ORDER BY type, path;

-- raw sources waiting to be ingested
SELECT path FROM files WHERE path LIKE '%/00_Raw/%'
  AND json_extract(frontmatter,'$.status') = 'validated'
  AND json_extract(frontmatter,'$.processed_at') IS NULL;

-- open tasks due within 7 days
SELECT file_path, text, due FROM tasks
WHERE completed = 0 AND due <= date('now','+7 days') ORDER BY due;
```

## 8. Where to look

| Question | File |
|---|---|
| Full tree, migration state | `references/vault-structure.md` |
| How the pipeline behaves | `references/pipeline.md` |
| MCP tool signatures & gotchas | `references/mcp-tools.md` |
| Frontmatter, types, zones | `references/file-format.md` |
| Which governance file to read | `references/key-files.md` |
| REST endpoints | `references/rest-api.md` → `_system/API.md` |
| Common task recipes | `references/workflows.md` |
