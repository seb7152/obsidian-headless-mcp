---
created: 2026-03-29
updated: 2026-09-02
---

# Obsidian Vault Skill

Working guide for **myVault** — Sébastien's Obsidian vault, served headless via
the `obsidian` MCP server and a REST API (`seb7152/obsidian-headless-mcp`).

## Layout

```
obsidian-vault/
├── SKILL.md                        # start here
├── QUICK-REFERENCE.md              # cheat sheet
├── README.md                       # this file
└── references/
    ├── vault-structure.md          # full tree, project canon, migration state
    ├── pipeline.md                 # 00_Raw → 01_Refined → 02_Context behaviour
    ├── mcp-tools.md                # complete MCP tool catalogue
    ├── file-format.md              # frontmatter, note types, status cycles, zones
    ├── key-files.md                # which governance file to read, and when
    ├── rest-api.md                 # REST endpoints (full doc: _system/API.md)
    └── workflows.md                # common task recipes
```

## Startup

1. `SKILL.md` (this skill)
2. `agent.md` — vault root
3. `_system/Gouvernance/vault-structure.md`
4. `_system/Gouvernance/agent-rules.md`
5. `_system/Gouvernance/referentiel-types-statuts.md`

Then `_system/Instructions/_index.md` for a writing task, and
`_system/Instructions/raw-refined-context.md` before touching a project.

## Access

| Surface | Use for |
|---|---|
| `obsidian` MCP server | Agent sessions — primary path |
| REST API (`obsidian-api.<DOMAIN>`) | n8n, scripts, webhooks |

Both are documented in `_system/API.md` inside the vault.

## Refresh — 2026-09-02

The previous version of this skill described a vault that no longer exists. What
changed:

- `_system/agent_rules.md` and `_system/MEMORY.md` → **gone**. Governance moved
  to `_system/Gouvernance/` (`agent-rules.md`, `vault-structure.md`,
  `referentiel-types-statuts.md`); there is no MEMORY.md.
- `10_context/perso` → `10_Context/Perso/` (`profil-perso.md`, `Aspirations.md`,
  `Mémoire agent/`).
- `20_Projects/` is now split `Pro/` vs `Perso/`; projects follow the
  Raw/Refined/Context canon instead of `Réunions/`, `Decisions/`, `Coding-Notes/`.
- New top-level folders documented: `15_Chantiers/`, `60_Tools/`, `50_Archives/`,
  `Excalidraw/`, `.trash/`.
- MCP catalogue completed: folders, surgical patch, SQL index, `run_index`,
  task extraction, comment threads, webhooks (read-only).
- The `obsidian` CLI section was removed — that CLI is not part of this
  deployment. `references/cli-operations.md`, `context-building.md`,
  `permanent-notes-workflow.md`, `workflow-professional.md` and
  `workflow-personal.md` were replaced by the files listed above.

A copy of this skill lives in the vault at `_system/skills/obsidian-vault/`.
