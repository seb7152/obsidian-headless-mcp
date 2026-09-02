---
created: 2026-09-02
updated: 2026-09-02
---

# Reference map — every reference file in the vault

Index only. **None of these files is summarised here** — open the file. Paths
verified 2026-09-02; when this map and the vault disagree, the vault wins.

---

## Governance — `_system/Gouvernance/`

The three referentials. Nothing else belongs in this folder.

| File | Answers | Agent access |
|---|---|---|
| `vault-structure.md` | The tree, the role of every folder, the canonical project layout (`00_Raw` / `01_Refined` / `02_Context`), per-project migration state, what `.trash/` is | Read |
| `agent-rules.md` | Permissions and prohibitions, the creation checklist, title and wikilink rules, zone separation | Read — **never modify** |
| `referentiel-types-statuts.md` | Every governed note type, its status cycle, its location, the `skipped` status, organization linking | Read |

> `vault-structure.md` moved here from the vault root on 2026-09-02; the root
> copy is gone. `agent.md` and `CLAUDE.md` both point here, and the wikilink
> `[[vault-structure]]` now resolves unambiguously.

## Entry points — vault root

| File | Answers |
|---|---|
| `agent.md` | Identity, session routing, key-file table, quick-start order |
| `CLAUDE.md` | The mandatory reading order at Claude Code startup |

## Instructions — `_system/Instructions/`

One file per note type or method. **The instruction is authoritative for the
format and field set of its type**; the referential only says the type exists
and what its statuses are.

| File / folder | Covers |
|---|---|
| `_index.md` | Dataview entry point to all instructions |
| `raw-refined-context.md` | Pipeline behaviour: `00_Raw` statuses and `processed_at`, extraction rules (one note = one fact), stub creation, the ambiguity rule, `02_Context/` subfolders, the `log/` journal, promotion to `30_Knowledge/`, the `_index.md` cockpit |
| `Raw/` | `document` (+ `doc_type`, `part`, `origin`), `transcript`, `email-inbox-archiving` |
| `Refinement/` | `extraction`, `meeting-summary`, `daily-note-routing`, `daily-refinement`, `weekly-refinement`, `weekly-summary`, `weekly-synthesis-by-theme`, `weekly-synthesis-evolution` |
| `Context/` | `stakeholder`, `organization`, `topic`, `decision`, `decision-capitalisation`, `vendor`, `project`, `use-case`, `process`, `insight`, `synthesis`, `knowledge-note`, `context`, `reflection`, `cockpit`, `wiki-lint` |
| `Notes atomiques/` | `permanent-note`, `atomic-note-formatting`, `Atomic-note-deconstruction`, `MOC-model-detection`, `quickstart-zettelkasten`, `gemini-permanent-note-extraction` |
| `Coding/` | `session-log`, `coding-session-log`, `debug-log`, `pattern` |
| `Pro/` | `email-writing`, `email-minutes` |
| `Cadeaux/`, `Checklist/`, `Finance/`, `Podcast/` | Domain-specific methods |

Re-derive the live list rather than trusting this table:

```sql
SELECT path, json_extract(frontmatter,'$.summary') AS summary
FROM files
WHERE path LIKE '_system/Instructions/%'
  AND json_extract(frontmatter,'$.type') = 'instruction'
ORDER BY path;
```

## Templates & tooling — `_system/`

| Path | Content |
|---|---|
| `API.md` | REST + MCP reference for the vault server |
| `Templates/` | Obsidian templates (including `Daily Note.md`) |
| `skills/obsidian-vault/` | Vault-side copy of this skill |
| `Classes/`, `copilot/`, `claude-plugins/` | Tooling |
| `Hygiène — drafts.base`, `Last-modified-items.base` | Obsidian *Bases* views |

## Projects — `20_Projects/`

| Path | Content |
|---|---|
| `_Template_projet.md` | Folder structure of any new project — structure only; behaviour is in `raw-refined-context.md` |
| `<Zone>/<Projet>/02_Context/` | That project's referential — the domain answer to most project questions |
| `<Zone>/<Projet>/02_Context/log/YYYY-MM.md` | What agents did to that referential this month |
| `<Zone>/<Projet>/_index.md` | Cockpit — read or `run_index`, never hand-edit |

## User context — `10_Context/`

| Path | Content | Caution |
|---|---|---|
| `Pro/profil-pro.md` | Professional context, clients, SIA methods | — |
| `Pro/sia-partners.md` | Employer context | — |
| `Pro/clients/` | Per-client sheets | — |
| `Perso/profil-perso.md` | Personal context | **Never open in a pro session** |
| `Perso/Aspirations.md` | Goals and direction | Same |
| `Perso/Mémoire agent/` | Agent memory about the user | Propose before writing |

## Root-level Bases

`Suivi des drafts.base` (everything still in `draft`) and
`Suivi des workflows.base`. Obsidian-native views — for programmatic access use
`query_vault` instead.

---

## Skill-side files (not in the vault)

| File | Content |
|---|---|
| `references/mcp-tools.md` | Complete MCP tool catalogue, signatures, index schema, gotchas |
| `references/rest-api.md` | REST endpoint summary and error codes |
| `references/reference-map.md` | This file |
