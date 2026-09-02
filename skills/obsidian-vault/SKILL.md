---
name: obsidian-vault
description: Work with Sébastien's Obsidian vault (myVault) through the obsidian MCP server. Trigger on any mention of Obsidian, the vault, a note, a project folder (20_Projects, 00_Inbox, 10_Context, 15_Chantiers, 30_Knowledge, 60_Tools), the Raw/Refined/Context pipeline, project context retrieval, or the vault REST API. Covers the current vault structure, the governance files to read first (agent.md, agent-rules, referentiel-types-statuts), the full MCP tool catalogue (read/write/patch, frontmatter, folders, SQL index, comments, webhooks), note types and status cycles, YAML frontmatter conventions, and the REST API.
created: 2026-04-27
updated: 2026-09-02
---

# Obsidian Vault Skill

Working guide for **myVault** — Sébastien's Obsidian vault, hosted headless and
exposed through the `obsidian` **MCP server** (primary) and a **REST API**
(automations). Everything is markdown + YAML frontmatter.

> Structure and governance below reflect the vault as of **2026-09-02**. The
> vault is the source of truth: when this file and the vault disagree, trust
> `_system/Gouvernance/vault-structure.md` and say so.

---

## 1. Startup — read these first

Order imposed by `CLAUDE.md` at the vault root:

1. **`agent.md`** — entry point: identity, routing, key files
2. **`_system/Gouvernance/vault-structure.md`** — full tree
3. **`_system/Gouvernance/agent-rules.md`** — permissions, prohibitions
4. **`_system/Gouvernance/referentiel-types-statuts.md`** — every note type and its status cycle

Then, depending on the task:
- **Writing / methodology task** → `_system/Instructions/_index.md`, pick the instruction for the note type
- **Anything touching a project** → `_system/Instructions/raw-refined-context.md` (pipeline behaviour)
- **Project context** → that project's `02_Context/`

> ⚠️ **Known ambiguity:** two divergent copies of `vault-structure.md` exist —
> one at the vault root, one in `_system/Gouvernance/`. `agent.md` links
> `[[vault-structure]]`, which resolves ambiguously. The root copy is more
> recent (2026-08-31) and more detailed; the Gouvernance copy is the one
> `CLAUDE.md` names. Read both if the answer matters, and flag the divergence.

---

## 2. Vault structure (2026-09-02)

```
myVault/
├── agent.md                          # AI agent entry point
├── CLAUDE.md                         # mandatory reading order
├── vault-structure.md                # ⚠ duplicate of _system/Gouvernance/vault-structure.md
├── Suivi des drafts.base             # Obsidian Bases (.base views)
├── Suivi des workflows.base
│
├── 00_Inbox/                         # raw capture, to triage
│   ├── Granola/                      # imported meeting notes
│   └── Notes quotidiennes/           # daily journal
│
├── 10_Context/                       # who the user is
│   ├── Pro/  → profil-pro.md, sia-partners.md, clients/
│   └── Perso/ → profil-perso.md, Aspirations.md, Mémoire agent/
│
├── 15_Chantiers/                     # cross-cutting ideas not yet projects (type: chantier)
│
├── 20_Projects/                      # all piloted work
│   ├── _Template_projet.md           # canonical project folder structure
│   ├── Pro/                          # client & internal projects
│   └── Perso/                        # Coding projects/, Finance knowledge/
│
├── 30_Knowledge/                     # long-term memory — fed ONLY by promotion from a 02_Context/
│   ├── ai/  ai-coding/  Obsidian/  real-estate/
│   └── permanent-notes/staging/      # only agent-writable entry point for the Zettelkasten
│
├── 40_Resources/                     # external references
│   └── Frameworks/ ia-research/ skills/ Tools/ Web/
│
├── 50_Archives/                      # archived notes
├── 60_Tools/                         # direct-write sheets, NO Raw/Refined pipeline
│   └── Activities/ Checklists/ Gift-assistant/
├── Excalidraw/                       # drawings
│
├── _system/                          # governance & agent tooling
│   ├── Gouvernance/                  # agent-rules.md, vault-structure.md, referentiel-types-statuts.md
│   ├── Instructions/                 # _index.md, raw-refined-context.md + Cadeaux/ Checklist/ Coding/
│   │                                 #   Context/ Finance/ Notes atomiques/ Podcast/ Pro/ Raw/ Refinement/
│   ├── API.md                        # REST + MCP reference
│   ├── Classes/ claude-plugins/ copilot/ skills/ Templates/
│   └── *.base                        # Hygiène — drafts, Last-modified-items
│
└── .trash/                           # soft deletes — NOT indexed, purged after 30 days
```

**What changed vs. the old skill:** `10_context/perso` → `10_Context/Perso/`;
`_system/agent_rules.md` + `_system/MEMORY.md` **no longer exist** (replaced by
`_system/Gouvernance/agent-rules.md` and `referentiel-types-statuts.md`);
`20_Projects/` is now split `Pro/` vs `Perso/`; `15_Chantiers/`, `60_Tools/`,
`50_Archives/`, `Excalidraw/` are new; per-project folders follow the
Raw/Refined/Context canon instead of `Réunions/`, `Decisions/`, `Coding-Notes/`.

### 2.1 Canonical project structure

Every project under `20_Projects/[Pro|Perso]/[Projet]/` should follow
`20_Projects/_Template_projet.md` (2026-08-05 refit, 3 folders):

```
NOM_PROJET/
├── 00_Raw/                    ← SOURCE OF TRUTH, never rewritten
│   ├── Transcripts/           ← every audio transcription (meetings + podcasts)
│   │   └── Granola/
│   ├── Emails/                ← archived emails (IMAP Checker)
│   ├── Documents/             ← deliverables, external docs
│   └── Notes/                 ← quick capture
├── 01_Refined/
│   ├── 01_Meetings/           ← meeting-summary
│   ├── 02_Podcasts/           ← podcast-summary
│   └── 0N_Extraction/         ← structured extraction notes
├── 02_Context/                ← distilled, validated referential — single source of truth
│   ├── 00_Meta/               ← project sheet (type: project)
│   ├── 01_Stakeholders/  02_Topics/  03_Décisions/  …
│   └── log/                   ← append-only journal, one file per month (YYYY-MM.md)
└── _index.md                  ← cockpit — Dataview/SQL only, never hand-edited
```

**Numbering is load-bearing.** n8n workflows target paths by prefix
(`*/02_Context/%`); shifting a prefix makes the project invisible to them.

### 2.2 Migration state (verified 2026-09-02)

| Project (`20_Projects/Pro/`) | State |
|---|---|
| `Agents IA` | New canon (pilot, 2026-08-06) + a `reflexions/` folder |
| `ENGIE-Lease-Management` | New canon |
| `ENGIE-Parking-Room-Booking` | New canon |
| `Praemia REIM - Application mobile` | New canon |
| `MEN` | **Mid-migration** — new (`00_Raw/01_Refined/02_Context`) *and* legacy (`01_pilotage/02_Refinement/04_Contexte`) coexist |
| `SANOFI - Smartbuilding` | **Mid-migration** — new folders *and* legacy `01_pilotage/02_Contexte/03_knowledge` |
| `The-Link` | Historical layout: `Contexte/ Décisions/ Livrables/ Planning/ Réflexions/ Réunions/` |
| `Business - Recherche` | Off-pipeline (`Artisans/ Freelance/ Garages/`) |
| `Business development` | Off-pipeline — `00_Raw/` + `value-proposal/` only |
| `Interne` | Off-pipeline — `00_Raw/` only |

> **Anomaly still open:** `20_Projects/Pro/00_Raw/Emails/` — a `00_Raw` sitting
> directly under `Pro/`, outside any project. Do not write there; flag it.

Never migrate a project automatically — migration is explicit, project by project.

---

## 3. Note types & status cycles

Reference: `_system/Gouvernance/referentiel-types-statuts.md`. Generic cycle
`draft → active → archived`, with exceptions. Downstream n8n/Dataview queries
filter on `status: active`.

| Where | Types | Status cycle |
|---|---|---|
| `00_Raw/` | `document` (+ `doc_type`), `email`, `transcript` | `draft → validated \| skipped` |
| `01_Refined/` | `meeting-summary`, `podcast-summary`, `extraction` | `draft → validated` (`skipped` for summaries) |
| `02_Context/` | `stakeholder`, `organization`, `topic`, `decision`, `vendor`, `project`, `use-case`, `process`, `insight`, `synthesis`, `knowledge-note` | `draft → active → archived` |
| `15_Chantiers/` | `chantier` | `draft → active → archived` (archived = dropped or promoted, set `related_project`) |
| `_system/Instructions/` | `instruction` | `draft → active` |
| `30_Knowledge/` | `pattern`, `debug-log` | `draft → active` / `open → resolved` |
| anywhere | `index` (`active`), `log` (`active`), `reflection` (`open → resolved`), `session-log` (`active → partial → completed`) | — |

`skipped` = a deliberate decision **not** to run a source through extraction.
Distinct from `validated` + `processed_at` (extraction actually done). Never use
it to hide an untreated backlog.

**Organization linking:** `organization` (single short-name wikilink) on a
`stakeholder`; `organizations` (list) on `extraction` and `use-case`. Targets
always live in the current container's `02_Context/`.

---

## 4. Hard rules (from `agent-rules.md`)

🔴 **Never**
- Mix pro and perso in one note; never touch `10_Context/Perso/` during a pro session.
- Modify `_system/Gouvernance/agent-rules.md`.
- Create or hand-edit an `_index.md` or an existing Dataview query.
- Delete or archive a note without proposing it first.
- Rewrite anything in `00_Raw/` — whatever the content.
- Feed `30_Knowledge/` directly from work in progress (promotion from a `02_Context/` only).
- Export raw sensitive data, or mix it with examples in a note.

🟢 **Always**
- Search before creating.
- When unsure of the zone, write to `00_Inbox/`.
- Set `updated: YYYY-MM-DD` on every create/modify done through MCP (the
  *Update Time on Edit* plugin only covers the Obsidian UI).
- No `/ \ : * ? " < > |` in a note title — it becomes a filename. Rephrase
  (`€/m²` → `€ par m²`, `avant/après` → `avant-après`), never drop the info.
- **Wikilinks: filename only.** A double-bracket link contains the bare
  filename — never a folder path, never a `.md` extension. This includes
  (especially) frontmatter fields like `source`, `stakeholders`, `topics`,
  `decisions`. Obsidian resolves by shortest path. Only exception, for a
  *structural* collision (e.g. dated `YYYY-MM-DD.md` notes in several folders):
  the full path **followed by a pipe alias** (`dossier/Nom` then `|Nom`), never
  a bare full path.
- An entity unknown to `02_Context/` gets an immediate `status: draft` stub —
  never leave a broken link.
- An extraction note carries real wikilinks in YAML, never JSON.

**Creation checklist:** identify zone → search existing → pick a governed type
and its location → fill frontmatter per its instruction in `_system/Instructions/`
→ link with wikilinks → leave indexes alone → check type/zone coherence.

---

## 5. MCP tools

The `obsidian` MCP server is the primary access path. Full catalogue and
semantics: `references/mcp-tools.md`; endpoint-level detail: `_system/API.md`.

**Navigate & read**
```
list_directory(dir_path="")                    # "" = vault root
get_projects()                                 # 20_Projects/Pro/ only
search_vault(query, fuzzy=True, since, before)
query_vault(sql)                               # SELECT over the SQLite index
read_file(file_path, resolve_links=True)       # returns content + resolved wikilinks
```

**Write** — pick the narrowest tool that does the job:

| Need | Tool |
|---|---|
| Change a few frontmatter fields | `update_frontmatter` (body untouched) |
| Same patch on many files | `bulk_update_frontmatter` (≤ 100) |
| Change a precise passage | `patch_file(old_text, new_text)` — errors if not found |
| Add at the end | `append_to_file` |
| New file / full rewrite | `write_file` |
| Move / rename | `move_file`, `move_folders` |
| Delete | `delete_file` / `delete_folders` (soft by default → `.trash/`) |
| Scaffold a project tree | `create_folders([...])` in one call |

`write_file` / `append_to_file` / `patch_file` return a warning listing any
**broken wikilinks** in what you just wrote, plus fuzzy suggestions, and
an `obsidian://open` deep link. Read that warning — it is the cheapest way to
catch a stub you owe `02_Context/`.

**Other**: `run_index(file_path, section)` (execute a cockpit's SQL blocks),
`extract_tasks`, comment threads (`extract_comments`, `create_comment`,
`reply_to_comment`, `set_comment_status`, `delete_comment`), `sync_vault`,
`get_sync_status`, `list_webhooks` (read-only — webhooks are created via REST).

### Typical navigation
```
1. get_projects()                                → what exists under Pro/
2. list_directory("20_Projects/Pro/<Projet>")    → which canon this project is on
3. list_directory(".../02_Context/01_Stakeholders")
4. search_vault("lease management", fuzzy=True)  → find across the vault
5. read_file("<path>.md")                        → content + wikilink resolution
```

### Useful SQL
```sql
-- everything still in draft in a project
SELECT path, title FROM files
WHERE path LIKE '20_Projects/Pro/Agents IA/%'
  AND json_extract(frontmatter, '$.status') = 'draft';

-- unprocessed raw sources
SELECT path FROM files
WHERE path LIKE '%/00_Raw/%'
  AND json_extract(frontmatter, '$.status') = 'draft';

-- open tasks due within 7 days
SELECT file_path, text, due FROM tasks
WHERE completed = 0 AND due <= date('now', '+7 days') ORDER BY due;
```
Tables: `files(path, title, created, modified, tags, frontmatter)` and
`tasks(file_path, text, completed, due)`. `SELECT` only. `.trash/` and dotfiles
are not indexed.

---

## 6. REST API (automations, n8n)

Base `https://obsidian-api.<DOMAIN>`, `Authorization: Bearer <API_TOKEN>` on
everything except `GET /health`. Full reference: **`_system/API.md`** in the vault.

| Need | Endpoint |
|---|---|
| Filter by frontmatter | `GET /api/files?type=…&status=…&path=…&since=…` |
| Read / write / delete | `GET \| POST \| DELETE /api/file/{path}` |
| Frontmatter only | `PATCH /api/file/{path}` |
| Body only | `PATCH /api/file/{path}/body` |
| Surgical patch | `PATCH /api/file/{path}/patch` |
| Batch read / patch / move | `POST \| PATCH /api/files/batch`, `POST /api/files/move` |
| Folders | `POST \| DELETE /api/folders`, `POST /api/folders/move` |
| SQL | `POST /api/query` |
| Broken links | `GET /api/file/{path}/links`, `POST /api/links/check` |
| Index & watcher health | `GET /api/sync/status` |
| Webhooks | `/api/webhooks…` — **REST only**, MCP is read-only |

Webhooks fire on `add`/`change`/`unlink` of `.md` files, filterable by `folder`
(wildcards per segment) and by `frontmatter` / `frontmatter_not` — the latter
breaks write loops (e.g. skip changes whose `last_write_origin` is `todoist`).

---

## 7. Frontmatter

```yaml
---
title: "Titre lisible"          # display title
type: stakeholder               # governed type — see §3
zone: pro | perso | technique   # must match the file's location
project: "Agents IA"            # container, null outside a project
status: draft                   # cycle imposed by the type
created: '2026-09-02'
updated: '2026-09-02'           # agent MUST set this on every write via MCP
tags: [agent-rules, permissions]
agent: human | claude-code | claude-ai
summary: >-
  1–3 lines, plain text.
---
```

The exact field set is imposed by the type's instruction in
`_system/Instructions/`. **No instruction for a type → no creation without human
validation.** Details and per-type examples: `references/file-format.md`.

---

## 8. Reference files

| File | When |
|---|---|
| `references/vault-structure.md` | Full tree, per-folder role, project canon, migration state |
| `references/mcp-tools.md` | Complete MCP tool catalogue with signatures and gotchas |
| `references/pipeline.md` | Raw → Refined → Context: what happens at each stage |
| `references/file-format.md` | Frontmatter spec, types, status cycles, zones |
| `references/key-files.md` | What each governance file does and when to read it |
| `references/rest-api.md` | REST endpoints summary (full doc: `_system/API.md`) |

In the vault: `agent.md`, `_system/Gouvernance/*`, `_system/Instructions/_index.md`,
`_system/Instructions/raw-refined-context.md`, `20_Projects/_Template_projet.md`,
`_system/API.md`.

---

## 9. Reflexes

- **Project not named in the request?** Ask. Don't guess the container.
- **Can't find the context?** Say so, and propose fixing the index file rather
  than inventing a location.
- **Writing a wikilink?** Filename only, and check the broken-link warning.
- **Creating in `02_Context/`?** Stub every unknown entity it points at.
- **Touching `00_Raw/`?** Only frontmatter (`status`, `processed_at`) — never the content.
- **`60_Tools/` and `30_Knowledge/`** are outside the pipeline. `60_Tools/` is
  written directly; `30_Knowledge/` only receives validated promotions.
