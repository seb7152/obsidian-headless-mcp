'use strict';

// Optional cross-encoder reranking of hybrid-search candidates, via a cloud API.
//
// Reranking is deliberately NOT done locally: a 0.6B cross-encoder on this
// VPS's 2 vCPU costs minutes per query, while the same call to a hosted
// reranker costs a few hundred milliseconds and ~$0.0003 per search.
//
// It is off unless the caller explicitly asks for it AND an API key is set,
// because unlike embedding a query, reranking ships the FULL TEXT of every
// candidate chunk to a third party. RERANK_EXCLUDE_PATHS keeps sensitive
// folders out of that payload.

const PROVIDER = (process.env.RERANK_PROVIDER || 'jina').toLowerCase();

const DEFAULT_MODELS = {
  jina: 'jina-reranker-v2-base-multilingual',
  cohere: 'rerank-v3.5',
  voyage: 'rerank-2.5-lite'
};

const MODEL = process.env.RERANK_MODEL || DEFAULT_MODELS[PROVIDER] || DEFAULT_MODELS.jina;
const TIMEOUT_MS = Number(process.env.RERANK_TIMEOUT_MS || 8000);

// Comma-separated vault path prefixes whose chunks are never sent to the
// reranker (e.g. "10_Context/perso,50_Archives/prive").
const EXCLUDE_PATHS = (process.env.RERANK_EXCLUDE_PATHS || '')
  .split(',')
  .map(s => s.trim().replace(/^\/+|\/+$/g, ''))
  .filter(Boolean);

function apiKey() {
  switch (PROVIDER) {
    case 'jina': return process.env.JINA_API_KEY;
    case 'cohere': return process.env.COHERE_API_KEY;
    case 'voyage': return process.env.VOYAGE_API_KEY;
    default: return null;
  }
}

function isAvailable() {
  return Boolean(apiKey()) && Boolean(DEFAULT_MODELS[PROVIDER]);
}

function isExcluded(filePath) {
  return EXCLUDE_PATHS.some(p => filePath === p || filePath.startsWith(p + '/'));
}

function endpointFor(provider) {
  switch (provider) {
    case 'jina': return 'https://api.jina.ai/v1/rerank';
    case 'cohere': return 'https://api.cohere.com/v2/rerank';
    case 'voyage': return 'https://api.voyageai.com/v1/rerank';
    default: return null;
  }
}

// Normalises the three providers' response shapes to [{ index, score }].
function parseResults(provider, json) {
  const rows = json.results || json.data || [];
  return rows
    .map(r => ({
      index: r.index,
      score: r.relevance_score ?? r.relevanceScore ?? r.score ?? 0
    }))
    .filter(r => Number.isInteger(r.index));
}

// Reranks `candidates` ([{ filePath, text, ... }]) against `query`.
//
// Returns { ordered, reranked, skipped, error }:
//   ordered  — candidates, best first. Reranked candidates come first in the
//              reranker's order; candidates excluded from the payload keep
//              their incoming (RRF) order and are appended after.
//   reranked — how many candidates the reranker actually scored.
//   skipped  — how many were withheld by RERANK_EXCLUDE_PATHS.
// On any failure the incoming order is returned untouched with `error` set:
// a reranker outage must degrade to hybrid results, never to an empty page.
async function rerank(query, candidates, topN = candidates.length) {
  if (!isAvailable()) {
    return { ordered: candidates, reranked: 0, skipped: 0, error: 'reranker not configured' };
  }

  const sendable = [];
  const withheld = [];
  for (const c of candidates) {
    (isExcluded(c.filePath) ? withheld : sendable).push(c);
  }
  if (!sendable.length) {
    return { ordered: candidates, reranked: 0, skipped: withheld.length, error: null };
  }

  const body = {
    model: MODEL,
    query,
    documents: sendable.map(c => c.text),
    top_n: Math.min(topN, sendable.length)
  };

  try {
    const res = await fetch(endpointFor(PROVIDER), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const parsed = parseResults(PROVIDER, await res.json());
    if (!parsed.length) throw new Error('empty rerank response');

    const ordered = [];
    const seen = new Set();
    for (const r of parsed) {
      const c = sendable[r.index];
      if (!c || seen.has(r.index)) continue;
      seen.add(r.index);
      ordered.push({ ...c, rerankScore: r.score });
    }
    // Candidates the reranker dropped (top_n) keep their RRF order behind it.
    sendable.forEach((c, i) => { if (!seen.has(i)) ordered.push(c); });
    ordered.push(...withheld);

    return { ordered, reranked: seen.size, skipped: withheld.length, error: null };
  } catch (err) {
    console.error(`[rerank] ${PROVIDER} failed: ${err.message} — keeping hybrid order`);
    return { ordered: candidates, reranked: 0, skipped: withheld.length, error: err.message };
  }
}

function getStatus() {
  return {
    provider: PROVIDER,
    model: MODEL,
    available: isAvailable(),
    excluded_paths: EXCLUDE_PATHS
  };
}

module.exports = { rerank, isAvailable, getStatus, _internal: { isExcluded, parseResults } };
