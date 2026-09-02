---
created: 2026-03-29
updated: 2026-09-02
---

# Reference — Key vault files

What each governance file does, and when to open it.

> The old skill pointed at `_system/agent_rules.md`, `_system/MEMORY.md` and
> `_system/openapi.yaml`. **None of these exist any more.** Governance moved to
> `_system/Gouvernance/`, and there is no MEMORY.md — user context lives in
> `10_Context/`, domain context in each project's `02_Context/`.

---

## Read at startup (order imposed by `CLAUDE.md`)

| File | Why |
|---|---|
| `agent.md` | Entry point: identity, quick-start routing, key-file table |
| `vault-structure.md` (vault root) | Full tree and role of every folder — **the authoritative copy** |
| `_system/Gouvernance/agent-rules.md` | Permissions, prohibitions, creation checklist. **Never modify** |
| `_system/Gouvernance/referentiel-types-statuts.md` | Every note type, its status cycle, its location |

> ⚠️ There are two `vault-structure.md`. The **root** copy is authoritative
> (confirmed by Sébastien, 2026-09-02); the `_system/Gouvernance/` copy is
> stale. `CLAUDE.md` names the stale one and `agent.md` links the bare note
> name, which resolves ambiguously — read the root copy, and flag the pointer.

## Read on demand

| File | When |
|---|---|
| `_system/Instructions/_index.md` | Any writing or methodology task — Dataview entry point to all instructions |
| `_system/Instructions/raw-refined-context.md` | Anything touching a project's pipeline (extraction, validation, promotion) |
| `20_Projects/_Template_projet.md` | Creating a project, or checking which canon one follows |
| `_system/Instructions/<type>.md` | Before creating a note of that type — the instruction defines the exact field set |
| `_system/API.md` | REST / MCP endpoint detail |
| `<projet>/02_Context/` | Project domain context — query it before opening sheets one by one |
| `<projet>/_index.md` | Project cockpit — read or `run_index`, never hand-edit |
| `<projet>/02_Context/log/YYYY-MM.md` | What agents did to this project's referential this month |

## User context

| File | Content | Caution |
|---|---|---|
| `10_Context/Pro/profil-pro.md` | Professional context, clients, SIA methods | — |
| `10_Context/Pro/sia-partners.md` | Employer context | — |
| `10_Context/Pro/clients/` | Per-client sheets | — |
| `10_Context/Perso/profil-perso.md` | Personal context, family, finances | **Never open in a pro session** |
| `10_Context/Perso/Aspirations.md` | Goals and direction | Same |
| `10_Context/Perso/Mémoire agent/` | Agent memory about the user | Propose before writing |

## Obsidian Bases views (`.base`)

| File | Use |
|---|---|
| `Suivi des drafts.base` (root) | Everything still in `draft` |
| `Suivi des workflows.base` (root) | Workflow tracking |
| `_system/Hygiène — drafts.base` | Draft hygiene |
| `_system/Last-modified-items.base` | Recently touched notes |

These are Obsidian-native views. Query the same data with `query_vault` when you
need it programmatically.

## Where the skill itself lives

- `_system/skills/obsidian-vault/` — vault-side copy of this skill
- `40_Resources/skills/` — other skill material (`sia-propale/`, `Sia-chiffrage.md`)
- `_system/claude-plugins/okf-marketplace/` — plugin marketplace config
