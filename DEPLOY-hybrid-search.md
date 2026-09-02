# Deploying hybrid search — changes to make in the HPanel compose

This change adds BM25 + semantic search to the existing API and MCP server.
It adds **no new service, no new volume, and no Traefik change**. Everything
runs inside the existing `obsidian-api` container.

There is nothing to copy from this repo onto the server: `obsidian-api` already
clones the repo at boot. Only the `obsidian-api` service block in the compose
file visible in HPanel needs editing — two edits, both inside that block.

---

## Edit 1 — `command:` (required)

The container copies a fixed list of files out of the clone. Three new files
(`search-index.js`, `embeddings.js`, `rerank.js`) must be added to that list, and
one npm package to the install. **Without this edit the service will not start**:
`vault-indexer.js` now requires `search-index.js`.

**Find this line** in the `obsidian-api` service:

```
    command: bash -c "rm -rf /tmp/repo && mkdir -p /tmp/app && git clone https://github.com/seb7152/obsidian-headless-mcp.git /tmp/repo && cat /tmp/repo/obsidian-api.js > /tmp/app/server.js && cat /tmp/repo/vault-indexer.js > /tmp/app/vault-indexer.js && cat /tmp/repo/webhooks.js > /tmp/app/webhooks.js && npm install express cors js-yaml better-sqlite3 chokidar && node server.js"
```

**Replace it with:**

```
    command: bash -c "rm -rf /tmp/repo && mkdir -p /tmp/app && git clone https://github.com/seb7152/obsidian-headless-mcp.git /tmp/repo && for f in obsidian-api.js vault-indexer.js webhooks.js search-index.js embeddings.js rerank.js; do cat /tmp/repo/$$f > /tmp/app/$$f; done && mv /tmp/app/obsidian-api.js /tmp/app/server.js && npm install express cors js-yaml better-sqlite3 chokidar @huggingface/transformers && node server.js"
```

Two things that are easy to get wrong here:

- The `$$f` is doubled **on purpose**. Docker Compose interpolates `$f` as one of
  its own variables and would blank it out; `$$f` reaches bash as `$f`. This is
  the same escaping the `obsidian-headless` service already uses for
  `$$OBSIDIAN_EMAIL`.
- Keep it on **one line**. Folding it introduces YAML quoting problems.

## Edit 2 — `environment:` (required)

Add these entries to the existing `environment:` list of `obsidian-api`, right
after `CHOKIDAR_INTERVAL`. Keep the existing entries as they are.

```yaml
      # -- Hybrid search --
      - EMBED_PROVIDER=${EMBED_PROVIDER:-local}
      - EMBED_MODEL=${EMBED_MODEL:-Xenova/multilingual-e5-small}
      - TRANSFORMERS_CACHE=/data/models
      - EMBED_BATCH_SIZE=${EMBED_BATCH_SIZE:-8}
      - RERANK_PROVIDER=${RERANK_PROVIDER:-jina}
      - RERANK_MODEL=${RERANK_MODEL:-jina-reranker-v2-base-multilingual}
      - RERANK_EXCLUDE_PATHS=${RERANK_EXCLUDE_PATHS:-}
      - JINA_API_KEY=${JINA_API_KEY:-}
```

`TRANSFORMERS_CACHE=/data/models` points at the **existing** `sqlite-data`
volume, already mounted at `/data`. That is what keeps the ~120 MB of model
weights across restarts instead of re-downloading them every boot. Do not add a
new volume.

Every one of these has a default, so the stack starts even if `.env` is
untouched. Reranking stays off until a key is present *and* a caller asks for it.

## Edit 3 — `.env` (optional, only for reranking)

```
JINA_API_KEY=jina_...
RERANK_EXCLUDE_PATHS=10_Context/perso
```

Reranking sends the full text of the ~40 candidate passages to Jina on each
reranked query. `RERANK_EXCLUDE_PATHS` is a comma-separated list of vault folder
prefixes whose chunks are never included in that payload. Leave `JINA_API_KEY`
unset to keep the feature entirely off.

## What does *not* change

- `traefik`, `obsidian-headless`, `obsidian-mcp` service blocks: untouched.
- Volumes: untouched — no new volume.
- Ports and labels: untouched.
- `obsidian-mcp` pulls `obsidian_mcp.py` from GitHub at boot, so the updated MCP
  tool arrives on restart with no compose edit.

---

## Deploy

```bash
docker compose up -d --force-recreate obsidian-api obsidian-mcp
docker compose logs -f obsidian-api
```

First boot is slower than usual: `npm install` now pulls `onnxruntime-node`
(~100 MB), and the container then downloads the embedding model from
`huggingface.co` (~120 MB, once — it lands on the `/data` volume). The container
needs outbound HTTPS to `huggingface.co` for that first download.

Expected log sequence:

```
[indexer] Reconciling index with vault…
[search] chunking 1991 note(s) missing from the search index...
[search] chunked 1991 note(s), ~5000 chunks total
🚀 Obsidian API server running on port 3000
🔎 Search: 5000 chunks, 0 embedded (local/Xenova/multilingual-e5-small), rerank off
[embeddings] provider=local model=Xenova/multilingual-e5-small ready
[search] embedded 500 chunks (4500 pending)
...
[search] embedding index complete (5000 chunks)
```

The chunking pass is fast (seconds). The embedding backfill is the long part:
**10–20 minutes** for this vault on 2 vCPU, running in the background. The API
serves requests throughout — searches just answer with BM25 until it finishes.

## Verify

```bash
# 1. Index health
curl -s -H "Authorization: Bearer $API_TOKEN" \
  https://obsidian-api.$DOMAIN/api/search/status | jq '{chunks,embedded,pending,semantic_ready}'

# 2. Keyword ranking works immediately (before the backfill finishes)
curl -s -H "Authorization: Bearer $API_TOKEN" \
  "https://obsidian-api.$DOMAIN/api/search?q=budget&mode=bm25&limit=3" | jq '.results[].file'

# 3. Semantic — use wording that does NOT appear in the target note
curl -s -H "Authorization: Bearer $API_TOKEN" \
  "https://obsidian-api.$DOMAIN/api/search?q=changement+d%27hebergeur&mode=semantic&limit=3" | jq

# 4. Reranking, only if JINA_API_KEY is set
curl -s -H "Authorization: Bearer $API_TOKEN" \
  "https://obsidian-api.$DOMAIN/api/search?q=budget&rerank=true&limit=3" | jq '.rerank'
```

`semantic_ready: true` with `pending: 0` means the whole pipeline is live.
A non-empty `warnings` array on a search response tells you which half is
degraded and why — read it before concluding the search is broken.

## Resource impact

| | Before | After |
|---|---|---|
| `obsidian-api` RSS | ~150 MB | **~1.1 GB** once the model is loaded |
| `/data` volume | index only | +120 MB models, +~30 MB chunks & vectors |
| Query latency | grep over the whole vault | ~10–20 ms (~500 ms with rerank) |

On an 8 GB box that gigabyte is affordable but not free — check it after a day:

```bash
docker stats --no-stream obsidian-api
```

If it crowds the box, `EMBED_PROVIDER=jina` moves embedding to the API (RAM back
to ~150 MB, a few cents to index the vault, at the cost of sending note text to
Jina), and `EMBED_PROVIDER=none` disables the semantic half entirely while
keeping the ranked BM25 search.

## Rollback

Fastest, no compose edit: set `EMBED_PROVIDER=none` in `.env` and recreate.
Search falls back to ranked BM25 — still better than the previous `grep`, with
no model and no extra memory.

Full rollback: restore the original `command:` line, drop the added environment
entries, recreate. The `chunks` / `chunks_fts` tables stay behind in
`vault-index.db`; they are inert and can be dropped with
`sqlite3 /data/vault-index.db "DROP TABLE chunks_fts; DROP TABLE chunks;"`.
