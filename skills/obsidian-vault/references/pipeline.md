---
created: 2026-09-02
updated: 2026-09-02
---

# Reference — Raw → Refined → Context pipeline

Behaviour of a project container. Folder structure is in
`20_Projects/_Template_projet.md`; the authoritative behaviour spec is
`_system/Instructions/raw-refined-context.md`. This file summarises it — when
they diverge, the vault wins.

Instruction notes named below (`document`, `extraction`, `stakeholder`,
`organization`, `vendor`, `decision`, `synthesis`, `wiki-lint`) live in
`_system/Instructions/` and are the authority for their own type.

---

## 00_Raw/ — immutable sources

Content is **never rewritten**. Only two frontmatter fields may be set
(rule revised 2026-08-13):

```yaml
status: draft | validated    # draft = still being written (e.g. a CCTP in progress)
processed_at: YYYY-MM-DD     # set by the agent that ingested it; absent = not yet processed
```

| State | Meaning |
|---|---|
| `draft` | Not a stable source yet — **do not ingest** |
| `validated`, no `processed_at` | Stable, waiting — this is the daily queue |
| `validated` + `processed_at` | Already ingested — skip it |

Applies to `Documents/`, `Emails/`, `Transcripts/`. `processed_at` is set by the
agent that actually processed the source — never retroactively in bulk without
checking the downstream note exists.

**Typing (2026-08-15):** `type` carries the *input channel* — `document`,
`email`, `transcript` — never the business nature. A CCTP, a spec and a
benchmark report are all `document`; their nature lives in `doc_type`. Closed
list of `doc_type`, multi-part documents (`document` + `part`) and the
`origin` field (`interne`/`externe`) are defined in the `document` instruction.

## 01_Refined/ — summaries and extraction

### meeting-summary / podcast-summary
Readable narrative rendering, one per source `00_Raw` item. Not a separate
treatment — just the form extraction takes for sources that deserve a narrative.
An email or a deliverable doesn't need one.

### 0N_Extraction/ — one note = one fact

**Not one note per source.** A single meeting can yield several extraction
notes. Same principle as the vault's atomic notes: one note = one self-contained
idea, understandable without context.

Never embed JSON. Detected entities are **real wikilinks** — Obsidian indexes
them in the graph and backlinks, and they stay SQL-queryable via `query_vault`.

```yaml
type: extraction
source: "<wikilink to the Raw/Refined source, filename only>"
status: draft | validated
stakeholders: ["<wikilink>"]
topics: ["<wikilink>"]
organizations: []
vendors: []
decisions: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
```
Authoritative schema: the `extraction` instruction. (A real bug came from
treating a partial example as the schema: `organizations:` was missing from the
illustration before 2026-08-12, and notes filed organizations under `vendors:`
for lack of a visible field.)

**Title:** short and declarative, 3–6 words — "Julien co-développe ERV Modeling",
not "Extraction du 2026-06-03". The shared `source` field lets backlinks on the
Raw source recover everything extracted from it.

**Unknown entity → immediate stub, never a broken link.** As soon as an
extraction hits an entity absent from `02_Context/`, create a minimal sheet
there (`status: draft`, reduced frontmatter, `summary: "candidate — à valider"`).
Distinguish `organization` from `vendor` *before* creating the stub, per their
instructions — the confusion has happened in practice.

**Exception — `decision`:** too structuring to be stubbed by an extraction pass.
Leave `decisions: []`, describe the fact in the note body, and flag the decision
for manual creation per the `decision` instruction.

**Ambiguous entity (several existing candidates) → no stub.** Creating one
recreates the duplicate problem. Leave the note `draft` and state the ambiguity
explicitly in the body; a human decides.

**Validation, per fact — not per source:**
- `draft` on creation.
- The agent may set `validated` as soon as **every** entity mentioned *in that
  note* resolves to a `02_Context/` sheet — including a stub just created. The
  extraction's status (was the fact captured well) is independent of the
  entity's status (is the entity legitimate): a `validated` extraction may point
  at a `draft` entity.
- The agent **may not** self-validate when there is ambiguity.
- Consequence: within one meeting, some facts validate automatically while
  others wait — no cascade blocking.

## 02_Context/ — the referential

Single source of truth for the project taxonomy, in Obsidian frontmatter,
queried by n8n over SQL. Never duplicated elsewhere.

Eleven types: `stakeholder`, `organization`, `topic`, `decision`, `vendor`,
`project`, `use-case`, `process`, `insight`, `synthesis`, `knowledge-note`.
Canonical cycle `draft → active → archived`.

- `organization` (2026-08-09) — external entity (client, partner, competitor)
  that stakeholders attach to. Distinct from `vendor` (evaluated tool supplier)
  and `topic` (internal initiative). The link is carried by the **stakeholder**
  sheet (`organization:` field), never the reverse.
- `synthesis` (2026-08-09) — durable knowledge produced *during a conversation
  with the agent* (analysis, comparison, connection), not from a source
  extraction. Never created automatically: the agent proposes, the human
  validates. Can later be promoted to `knowledge-note`.
- `insight` replaces the legacy `01_pilotage/insights.md`: a validated insight
  is a versioned sheet, not a recomputed line.

**Sheets are filed by type subfolder** (2026-08-07, replaces the flat rule):
`00_Meta/` (the project sheet itself), then `01_Stakeholders/`, `02_Topics/`,
`03_Décisions/`, `04_Organizations/`… one numbered subfolder per type actually
used, continuing the numbering (`05_Vendors/`, etc.). No empty subfolder is
created. n8n queries match `LIKE '%/02_Context/%'`, so the extra level is safe.

### Semantic map — no static index.md

The "LLM Wiki" `index.md` role is filled by `query_vault`, on demand and always
current. A static index would duplicate information and break the rule against
hand-editing `_index.md`. Canonical query — run this **before** opening
individual sheets:

```sql
SELECT path,
       json_extract(frontmatter, '$.type')    AS type,
       json_extract(frontmatter, '$.summary') AS summary
FROM files
WHERE path LIKE '%/02_Context/%'
  AND json_extract(frontmatter, '$.status') != 'archived'
ORDER BY type, path
```

### log/ — append-only, monthly rotation

`02_Context/log/{YYYY-MM}.md`, one file per month per project. Not a
recomputable view: an event history no query can reconstruct.

*Why monthly:* inserting at the top requires `patch_file`, which needs an exact
`old_text`, hence a full `read_file` first. A single cumulative log would grow
unbounded and saturate the agent's context on every run. Monthly rotation keeps
that read flat.

**Who writes:** any agent that modifies `02_Context/` — the extraction pass at
the end of its verification, `wiki-lint` at the end of an audit, a validated
`synthesis` creation.

**Where:** at the top of the current month's file, right after the
`# Log — [Projet] — {YYYY-MM}` title (most recent first).
- File exists → `patch_file` (targeted insertion after the title).
- First entry of the month → `write_file` with title + entry, no read needed.

Entry shape (wikilinks to the actual notes in each list, not just counters):

```markdown
## YYYY-MM-DD — ingest
- sources: <wikilinks>
- extractions_created: <wikilinks>
- extractions_enriched: <wikilinks>
- context_created: <wikilinks>
- verification: mutualisation effectuée, aucun doublon détecté
```

Entry types: `ingest`, `lint`, `synthesis` — same bullet format, fields adapted
(`- issues_found:` / `- issues_fixed:` for lint). 3–6 lines, never free prose,
never rewritten retroactively.

No `context_updated` field: an extraction pass never modifies the *content* of
an existing `02_Context/` sheet — it resolves wikilinks or creates a stub.
Updating existing content is the job of wiki-lint, human validation, or
`synthesis`.

## Promotion to 30_Knowledge/

`30_Knowledge/` is a pure receptacle — no `00_Raw`, no work in progress.

- A `02_Context/` entity `status: active` and stable without contradiction
  (proposed threshold: ≥ 3 months, or several coherent updates) becomes a
  **candidate**.
- The agent **proposes**, never applies alone — human validation is systematic.
- Once validated, the entity is **distilled** (not copied) into
  `30_Knowledge/[thème]/`: reformulated as decontextualised knowledge
  (Zettelkasten), with a backlink to the origin container.

Thematic `knowledge-*` projects follow the standard template and live in
`20_Projects/[zone]/`, never in `30_Knowledge/`. Active work always stays in
`20_Projects/`; only mature distillate moves up.

## _index.md cockpit

Computed views only — nothing maintained by hand, and agents must not create or
edit it.

```yaml
title: "NOM_PROJET — Cockpit du Projet"
type: index
zone: pro
project: "NOM_PROJET"
status: active
tags: [index, cockpit]
```

Required sections: project state (status, start date, client, link to
`02_Context/`); Dataview + SQL queries (recent Raw, extractions awaiting
validation, active `02_Context/` entities); quick navigation.
