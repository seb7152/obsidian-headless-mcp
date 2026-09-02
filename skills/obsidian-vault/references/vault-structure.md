---
created: 2026-09-02
updated: 2026-09-02
---

# Reference — Vault Structure

Verified against the live vault on **2026-09-02**. Authoritative source in the
vault: `_system/Gouvernance/vault-structure.md` (see the duplicate warning below).

---

## Root

| Item | Role |
|---|---|
| `agent.md` | AI-agent entry point: identity, routing, key files |
| `CLAUDE.md` | Mandatory reading order at Claude Code startup |
| `vault-structure.md` | ⚠️ Second, divergent copy of the Gouvernance file |
| `Suivi des drafts.base` | Obsidian *Bases* view — drafts to process |
| `Suivi des workflows.base` | Obsidian *Bases* view — workflows |
| `00_Inbox/` | Raw capture to triage |
| `10_Context/` | User context (pro / perso) |
| `15_Chantiers/` | Cross-cutting ideas not yet piloted projects |
| `20_Projects/` | All piloted work, pro and perso |
| `30_Knowledge/` | Long-term memory (distilled, promoted) |
| `40_Resources/` | External references |
| `50_Archives/` | Archived notes |
| `60_Tools/` | Direct-write sheets, outside the pipeline |
| `Excalidraw/` | Drawings |
| `_system/` | Governance and agent tooling |
| `.trash/` | Soft deletes — not indexed, purged after `TRASH_RETENTION_DAYS` (30) |

> ⚠️ **Two `vault-structure.md`.** The root copy (updated 2026-08-31) carries the
> migration state and the `60_Tools` detail; the `_system/Gouvernance/` copy
> (2026-08-06) is the one `CLAUDE.md` points at, and still mentions an
> `XP_Vault/` folder that no longer exists. `agent.md` links to the note name
> alone, which resolves ambiguously between the two. Neither copy lists `15_Chantiers/`
> or `Excalidraw/`. Flag this rather than silently picking one.

---

## 00_Inbox/

| Subfolder | Content |
|---|---|
| `Granola/` | Meeting notes imported from Granola |
| `Notes quotidiennes/` | Daily journal |

Loose dated notes also sit at the root of `00_Inbox/` (meeting captures awaiting
routing to a project). Writing here is the sanctioned fallback when the zone or
project is unclear.

## 10_Context/

| Path | Content |
|---|---|
| `Pro/profil-pro.md` | Professional context, clients, SIA methods |
| `Pro/sia-partners.md` | Employer context |
| `Pro/clients/` | Per-client context sheets |
| `Perso/profil-perso.md` | Personal context, family, finances |
| `Perso/Aspirations.md` | Goals and direction |
| `Perso/Mémoire agent/` | Agent long-term memory about the user |

**Zone rule:** never open `10_Context/Perso/` during a pro session.

## 15_Chantiers/

Flat folder of `type: chantier` notes — an idea, a want, a cross-cutting line of
thought (pro / perso / business) that could become a piloted project but isn't
one yet. Lives at the vault root, deliberately outside any `20_Projects/`
container. `active` = actively pursued; `archived` = dropped, or promoted to a
project (then `related_project` is filled). Routing rules: the
`daily-note-routing` instruction.

## 20_Projects/

```
20_Projects/
├── _Template_projet.md     ← canonical folder structure for any new project
├── Pro/                    ← client and internal projects
└── Perso/                  ← Coding projects/, Finance knowledge/, _index.md
```

`20_Projects/Perso/Coding projects/` holds: `Bring!`, `Finary-mcp`,
`obsidian-sync`, `RFP-analyzer`, `Sécurisation`, `Skills`, `startup-db`,
`Workload manager`.

### Canonical project layout (2026-08-05 refit — 3 folders)

```
NOM_PROJET/
├── 00_Raw/          ← immutable source of truth
│   ├── Transcripts/ (+ Granola/)   Emails/   Documents/   Notes/
├── 01_Refined/
│   ├── 01_Meetings/   02_Podcasts/ (if used)   0N_Extraction/
├── 02_Context/      ← distilled referential, single source of truth
│   ├── 00_Meta/  01_Stakeholders/  02_Topics/  03_Décisions/  04_Organizations/  …
│   └── log/         ← append-only, one file per month (YYYY-MM.md)
└── _index.md        ← cockpit, computed views only
```

Rules that matter:
- Numbered prefixes are **stable and load-bearing** — n8n targets `%/02_Context/%`.
- Subfolders are created only when a type is actually used; the `0N_Extraction/`
  number follows the last used Refined subfolder (`02_` without podcasts, `03_` with).
- Replaces the legacy 6-folder layout
  (`00_Raw/01_pilotage/02_Refinement/03_Décisions/04_Contexte/05_knowledge`).

Behaviour of each stage: `references/pipeline.md` and
`_system/Instructions/raw-refined-context.md`.

### Migration state — `20_Projects/Pro/` (verified 2026-09-02)

| Project | Folders present | Reading |
|---|---|---|
| `Agents IA` | `00_Raw 01_Refined 02_Context reflexions/` | New canon (pilot, 2026-08-06) |
| `ENGIE-Lease-Management` | `00_Raw 01_Refined 02_Context` | New canon |
| `ENGIE-Parking-Room-Booking` | — | New canon |
| `Praemia REIM - Application mobile` | `00_Raw 01_Refined 02_Context` | New canon |
| `MEN` | `00_Raw 01_pilotage 01_Refined 02_Context 02_Refinement 04_Contexte` | **Mid-migration**, both layouts coexist |
| `SANOFI - Smartbuilding` | `00_Raw 01_pilotage 01_Refined 02_Context 02_Contexte 03_knowledge` | **Mid-migration**, both layouts coexist |
| `The-Link` | `Contexte Décisions Livrables Planning Réflexions Réunions` | Historical layout, off-pipeline |
| `Business - Recherche` | `Artisans Freelance Garages` | Off-pipeline |
| `Business development` | `00_Raw value-proposal` + loose notes | Partially structured |
| `Interne` | `00_Raw` only | Off-pipeline |

> The vault's own docs still describe `MEN` and `SANOFI` as *not yet migrated*;
> on disk both now carry the new folders alongside the old ones. Check with
> `list_directory` before writing, and prefer the new canon for new content.

> **Open anomaly:** `20_Projects/Pro/00_Raw/Emails/` — a `00_Raw` directly under
> `Pro/`, outside any project. Don't write there; flag it.

Never migrate a project on your own initiative.

## 30_Knowledge/

Not a container: the vault's long-term memory, **fed only by validated promotion
from a project's `02_Context/`**. Never write work-in-progress here.

| Subfolder | Content |
|---|---|
| `ai/` | AI knowledge base |
| `ai-coding/` | Patterns, debug-logs |
| `Obsidian/` | Improving Obsidian itself |
| `real-estate/` | Real-estate domain knowledge |
| `permanent-notes/staging/` | The **only** agent-writable entry point for the Zettelkasten |

Active thematic capitalisation happens in `20_Projects/[zone]/knowledge-*/`
projects following the standard template — not here.

## 40_Resources/

`Frameworks/`, `ia-research/`, `skills/` (`sia-propale/`, `Sia-chiffrage.md`),
`Tools/`, `Web/`. Still being structured.

## 50_Archives/

Archived notes. Currently `Bébé/`.

## 60_Tools/

Personal tooling sheets, written and maintained **directly** — no Raw/Refined
pipeline: `Activities/`, `Checklists/`, `Gift-assistant/`. Consumed by the
`gift-brainstormer` and checklist skills.

## _system/

| Item | Content |
|---|---|
| `Gouvernance/agent-rules.md` | Permissions and prohibitions — agent read-only |
| `Gouvernance/vault-structure.md` | Tree reference |
| `Gouvernance/referentiel-types-statuts.md` | Every note type and its status cycle |
| `Instructions/_index.md` | Dataview entry point to all instructions |
| `Instructions/raw-refined-context.md` | Pipeline behaviour |
| `Instructions/…` | `Cadeaux/ Checklist/ Coding/ Context/ Finance/ Notes atomiques/ Podcast/ Pro/ Raw/ Refinement/` |
| `API.md` | REST + MCP reference |
| `Templates/`, `Classes/`, `copilot/`, `claude-plugins/`, `skills/` | Tooling |
| `Hygiène — drafts.base`, `Last-modified-items.base` | Obsidian Bases views |

`_system/skills/obsidian-vault/` holds the vault-side copy of this skill.
