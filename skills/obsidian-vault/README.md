---
created: 2026-03-29
updated: 2026-09-02
---

# Obsidian Vault Skill

Router for **myVault** — Sébastien's Obsidian vault, served headless via the
`obsidian` MCP server and a REST API (`seb7152/obsidian-headless-mcp`).

## Design rule

**The skill routes; the vault rules.** Governance — structure, note types,
statuses, permissions, per-type formats — lives in the vault and is not
duplicated here. Restating it would create a second source of truth that drifts
the moment the vault is edited. The skill answers "which file tells me this?"
and documents the MCP / REST tooling, which the vault does not cover.

## Layout

```
obsidian-vault/
├── SKILL.md                        # start here — startup order, reference map, MCP tools
├── QUICK-REFERENCE.md              # one-screen lookup: question → file, tool → use
├── README.md                       # this file
└── references/
    ├── reference-map.md            # full index of every reference file in the vault
    ├── mcp-tools.md                # complete MCP tool catalogue, index schema, gotchas
    └── rest-api.md                 # REST endpoints (full doc: _system/API.md)
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

## History

**2026-09-02 — turned into a router.** The skill had grown into a mirror of the
vault's governance: full note-type tables, status cycles, the pipeline spec, the
permission list. All of that was removed. `references/vault-structure.md`,
`pipeline.md`, `file-format.md`, `key-files.md` and `workflows.md` were replaced
by a single `reference-map.md` that indexes the vault's own files. In the same
pass, `vault-structure.md` moved from the vault root into
`_system/Gouvernance/`, and `agent.md` was updated to name that path.

**2026-09-02 — earlier that day, rewritten against the live vault.** The
previous version described a vault that no longer exists: `_system/agent_rules.md`
and `_system/MEMORY.md` (gone — governance moved to `_system/Gouvernance/`),
`10_context/perso` (now `10_Context/Perso/`), `20_Projects/` without the
`Pro/`/`Perso/` split, projects laid out as `Réunions/` + `Decisions/` +
`Coding-Notes/` instead of the Raw/Refined/Context canon, and an `obsidian` CLI
that is not part of this deployment. The MCP catalogue was completed at the same
time (folders, surgical patch, SQL index, `run_index`, task extraction, comment
threads, read-only webhooks).

A copy of this skill lives in the vault at `_system/skills/obsidian-vault/`.
