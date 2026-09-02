---
created: 2026-09-02
updated: 2026-09-02
---

# Reference — Vault Structure

Verified against the live vault on **2026-09-02**. Authoritative source in the
vault: **`vault-structure.md` at the vault root** (see the duplicate warning below).

---

## Root

| Item | Role |
|---|---|
| `agent.md` | AI-agent entry point: identity, routing, key files |
| `CLAUDE.md` | Mandatory reading order at Claude Code startup |
| `vault-structure.md` | **The authoritative structure reference** (see warning below) |
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

> ⚠️ **Two `vault-structure.md`.** The **root copy is authoritative** — confirmed
> by Sébastien on 2026-09-02, and updated the same day to document
> `15_Chantiers/`. The `_system/Gouvernance/` copy (2026-08-06) is stale: it
> still mentions an `XP_Vault/` folder that no longer exists, and lists neither
> `15_Chantiers/` nor `Excalidraw/`. `CLAUDE.md` points at that stale copy and
> `agent.md` links the bare note name, which resolves ambiguously between the
> two — read the root copy, and flag the `CLAUDE.md` pointer if it is still
> unfixed. `Excalidraw/` remains undocumented in both.

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

Added 2026-09-01. Flat folder of `type: chantier` notes — an idea, a want, a
cross-cutting subject (pro / perso / business) attached to no piloted project,
or still at the thinking stage. Deliberately outside any `20_Projects/`
container, and outside the Raw/Refined/Context pipeline.

**How it is fed:** chantiers are routed out of the **dictated daily notes**
(`00_Inbox/Notes quotidiennes/YYYY-MM-DD.md`) by the `daily-note-routing`
instruction. That agent splits the day's note into fragments and resolves each
against the existing referential:

| Fragment resolves to | Action |
|---|---|
| An existing chantier (matched on `aliases`) | Append a line to its `## Journal` via `patch_file` |
| An existing piloted project | Drop the fragment verbatim into that project's `00_Raw/Notes/YYYY-MM-DD.md` (one file per project per day) |
| A genuinely new idea | Create a `status: draft` chantier stub |
| Several candidates (ambiguous) | Create nothing — flag it in the trace on the source note |
| Noise (practical info, secrets, asides) | Ignore, no trace |

The routing agent never extracts (no facts, decisions or `02_Context/` writes —
that is the 22:00 Daily Refinement's job), never creates a project, and never
rewrites the dictated text: it only appends a `## Traitement — HH:MM` trace at
the bottom and sets `processed_at` in the frontmatter.

Stub frontmatter: `type: chantier`, `zone: pro|perso|business`, `status: draft`,
`aliases`, `related_project`, `summary` (a real one-line description, never
"candidate — à valider").

**Exit:** `archived` means dropped, or promoted to a piloted project — in which
case `related_project` links the container that was created.

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

> **Known workflow error — not a pattern:** `20_Projects/Pro/00_Raw/Emails/`, a
> `00_Raw` directly under `Pro/`, outside any project. Sébastien confirmed on
> 2026-09-02 that a faulty workflow created it and that it will be corrected.
> Never write there, and never imitate it.

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
