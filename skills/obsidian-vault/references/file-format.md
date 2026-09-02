---
created: 2026-03-29
updated: 2026-09-02
---

# Reference — Frontmatter, types and statuses

Authoritative in the vault: `_system/Gouvernance/referentiel-types-statuts.md`
(types and cycles) and the per-type instruction in `_system/Instructions/`
(exact field set). This file summarises both.

**No instruction exists for a type → do not create that type without human
validation.**

---

## Base frontmatter

```yaml
---
title: "Titre lisible"          # display title
type: stakeholder               # governed type (see below)
zone: pro | perso | technique   # must match the file's location
project: "Agents IA"            # container; null outside a project
status: draft                   # cycle imposed by the type
created: '2026-09-02'
updated: '2026-09-02'           # the agent sets this on EVERY MCP write
tags: [smartbuilding, engie]
agent: human | claude-code | claude-ai
summary: >-
  1–3 lines, plain text.
---
```

Type-specific fields are added on top — e.g. `doc_type` / `origin` / `part` on a
`document`, `source` / `stakeholders` / `topics` / `organizations` / `vendors` /
`decisions` on an `extraction`, `organization` on a `stakeholder`,
`related_project` on an archived `chantier`, `processed_at` on an ingested
`00_Raw` source.

### Field notes

| Field | Rule |
|---|---|
| `zone` | Drives permissions. Must be consistent with the path |
| `updated` | Agent-managed via MCP; the *Update Time on Edit* plugin only covers the Obsidian UI |
| `status` | Only values from the type's cycle. Downstream n8n/Dataview filter `status: active` |
| `agent` | Traceability of who wrote the note |
| wikilink fields | Filename only — never a full path, never a `.md` extension |

---

## Types and status cycles

| Type | Where | Cycle |
|---|---|---|
| `document` (+ `doc_type`) | `00_Raw/Documents/` | `draft → validated \| skipped` |
| `email` | `00_Raw/Emails/` | `draft → validated \| skipped` |
| `transcript` | `00_Raw/Transcripts/` | `draft → validated \| skipped` |
| `meeting-summary` | `01_Refined/01_Meetings/` | `draft → validated \| skipped` |
| `podcast-summary` | `01_Refined/02_Podcasts/` | `draft → validated` |
| `extraction` | `01_Refined/0N_Extraction/` | `draft → validated` |
| `stakeholder` | `02_Context/01_Stakeholders/` | `draft → active → archived` |
| `organization` | `02_Context/0N_Organizations/` | `draft → active → archived` |
| `topic` | `02_Context/02_Topics/` | `draft → active → archived` |
| `decision` | `02_Context/03_Décisions/` | `draft → active → archived` |
| `vendor` | `02_Context/0N_Vendors/` | `draft → active → archived` |
| `project` | `02_Context/00_Meta/` | `draft → active → archived` |
| `use-case`, `process`, `insight`, `synthesis`, `knowledge-note` | `02_Context/` | `draft → active → archived` |
| `chantier` | `15_Chantiers/` | `draft → active → archived` |
| `instruction` | `_system/Instructions/` | `draft → active` |
| `pattern` | `30_Knowledge/` | `draft → active` |
| `debug-log` | `30_Knowledge/ai-coding/` | `open → resolved` |
| `reflection` | anywhere | `open → resolved` |
| `session-log` | coding projects | `active → partial → completed` |
| `index` | project root | `active` only |
| `log` | `02_Context/log/` | `active` only |

Generic cycle is `draft → active → archived` unless listed otherwise.

### `skipped`

Applies to `document`, `email`, `transcript`, `meeting-summary`: an explicit
decision **not** to run a source through extraction (cost on a large backlog,
content already covered by existing `02_Context/` sheets).

Distinct from `validated` + `processed_at`, which records an extraction actually
performed. Never use `skipped` to mask an untreated backlog. A `skipped` source
can return to `validated` (without `processed_at`) if reintroduced later.

### Organization linking

| Field | Shape | Carried by |
|---|---|---|
| `organization` | single short-name wikilink | `stakeholder` |
| `organizations` | list of short-name wikilinks | `extraction`, `use-case` |

The target is always an `organization` note in the **current container's**
`02_Context/`. An entity present in several containers gets one sheet per
container, keeping the same filename across them.

### Out of scope

Project-local business types (real estate, finance, product…) are governed by
local convention, outside this status cycle.

---

## Zones

| Zone | Locations | Agent writes? |
|---|---|---|
| `pro` | `20_Projects/Pro/`, `10_Context/Pro/` | Yes, in the right project folder |
| `perso` | `20_Projects/Perso/`, `10_Context/Perso/`, `60_Tools/` | Propose first for `10_Context/Perso/`; **never open it in a pro session** |
| `technique` | `30_Knowledge/`, `40_Resources/`, `_system/` | Yes — except `30_Knowledge/` outside `permanent-notes/staging/`, and never `agent-rules.md` or an `_index.md` |

Never mix pro and perso in a single note.

---

## Titles

A title becomes a filename. Forbidden: `/ \ : * ? " < > |`. Rephrase rather than
drop information — `€/m²` → `€ par m²`, `avant/après` → `avant-après`.
(A real incident: `€/m²` created a `€/` folder containing `m².md`.)

Extraction titles are short and declarative, 3–6 words:
"Julien co-développe ERV Modeling", not "Extraction du 2026-06-03".

---

## Wikilinks

Default: a double-bracket link containing the **filename only** — no folder
path, no `.md`. Obsidian resolves by shortest path. Applies everywhere, and
**especially in frontmatter** (`source`, `stakeholders`, `topics`,
`decisions`…), where the temptation to paste a full path is strongest.

Duplicate basenames are reported as `ambiguous` by `read_file` / `write_file` /
`patch_file`. Fix the name itself when possible (rename, disambiguate).

**Only exception** — a structural collision, where the same naming convention is
reused across folders (e.g. dated `YYYY-MM-DD.md` notes as both daily notes and
project notes, where renaming would break the convention): use the full path
**followed by a pipe alias**, never a bare full path.
