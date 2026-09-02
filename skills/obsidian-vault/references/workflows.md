---
created: 2026-09-02
updated: 2026-09-02
---

# Reference — Workflows

Replaces the old `workflow-professional.md` / `workflow-personal.md` /
`permanent-notes-workflow.md` / `context-building.md`, which described a folder
layout the vault no longer uses.

---

## A. Answering a question about a project

1. `get_projects()` (Pro) or `list_directory("20_Projects/Perso")`.
2. `list_directory("20_Projects/<Zone>/<Projet>")` — **check which canon** the
   project follows (new 3-folder, mid-migration, or historical layout).
3. Map the referential before opening anything:
   ```sql
   SELECT path, json_extract(frontmatter,'$.type') AS type,
          json_extract(frontmatter,'$.summary') AS summary
   FROM files
   WHERE path LIKE '20_Projects/<Zone>/<Projet>/02_Context/%'
     AND json_extract(frontmatter,'$.status') != 'archived'
   ORDER BY type, path
   ```
4. `read_file` only the sheets that matter.
5. Still missing context? Say so and propose fixing the index file — don't
   invent a location.

If the request doesn't name a project, **ask** before guessing the container.

## B. Capturing something new

```
Is the zone/project obvious?
├── No  → 00_Inbox/ (sanctioned fallback), triage later
└── Yes → is it a piloted project?
          ├── Yes → 20_Projects/<Zone>/<Projet>/ per the pipeline
          └── No  → an idea, not yet a project?     → 15_Chantiers/ (type: chantier)
                    a personal tool sheet?          → 60_Tools/
                    user context?                   → 10_Context/<Zone>/
```

Dictated daily notes are not triaged by hand: the `daily-note-routing`
instruction fans each fragment out to an existing chantier, a project's
`00_Raw/Notes/`, or a new chantier stub — see `references/vault-structure.md`.

Before creating anything: search for an existing note (`search_vault` fuzzy +
`query_vault`), pick a governed type, open its instruction in
`_system/Instructions/`, and fill the frontmatter it prescribes.

## C. Ingesting a source into a project

Detail in `references/pipeline.md`. Short version:

1. Source lands in `00_Raw/<Transcripts|Emails|Documents|Notes>/` — content is
   never rewritten afterwards.
2. Queue = `status: validated` **without** `processed_at`.
3. Produce, in `01_Refined/`: a narrative summary when the source deserves one
   (meeting, podcast), plus **one extraction note per fact** in `0N_Extraction/`.
4. Each unknown entity → immediate `status: draft` stub in `02_Context/`
   (except `decision`, flagged for manual creation). Ambiguous entity → no stub,
   extraction stays `draft`, ambiguity stated in the body.
5. Set `processed_at` on the source once the downstream note actually exists.
6. Append an `ingest` entry at the top of `02_Context/log/YYYY-MM.md`.

## D. Promoting knowledge to `30_Knowledge/`

Never write work in progress there. A `02_Context/` entity that has been
`active` and uncontested long enough (≥ ~3 months, or several coherent updates)
becomes a candidate. **The agent proposes; the human validates.** Once approved,
the entity is *distilled* — reformulated as decontextualised knowledge — into
`30_Knowledge/[thème]/`, with a backlink to the origin container.

`30_Knowledge/permanent-notes/staging/` is the only place an agent may create
Zettelkasten notes directly. Promotion out of staging is a human action.

Thematic capitalisation work belongs to `20_Projects/[zone]/knowledge-*/`
projects following the standard template — never directly in `30_Knowledge/`.

## E. Personal zone

`10_Context/Perso/` is **off limits during a pro session**. Outside one, propose
before writing: the agent may suggest enriching `profil-perso.md`,
`Aspirations.md` or `Mémoire agent/`, but the human validates.

`60_Tools/` (Gift-assistant, Checklists, Activities) is written directly — no
pipeline, no promotion. It is the working surface of the dedicated skills
(`gift-brainstormer`, checklist generation).

## F. Maintenance passes

| Pass | What it does | Trace |
|---|---|---|
| `ingest` | Extraction from `00_Raw` → `01_Refined` → stubs in `02_Context` | `log/YYYY-MM.md` entry `ingest` |
| `lint` (`wiki-lint`) | Mechanical fixes on `02_Context/`, broken-link audit | `log` entry `lint` with `issues_found` / `issues_fixed` |
| `synthesis` | Durable knowledge produced during a conversation, validated by the human | `log` entry `synthesis` |

Only lint, human validation or `synthesis` may change the *content* of an
existing `02_Context/` sheet — an extraction pass never does.
