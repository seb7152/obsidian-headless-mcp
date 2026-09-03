'use strict';

// Embedding providers for the semantic half of hybrid search.
//
// The default provider is `local`: a small multilingual sentence encoder run on
// CPU through transformers.js (ONNX). The vault is French/English, so a
// multilingual model matters more here than raw MTEB score — an English-only
// encoder silently degrades to keyword-quality results on French notes.
//
// Every provider returns L2-normalised Float32Array vectors, so cosine
// similarity is a plain dot product downstream.
//
// Providers are loaded lazily and failure is never fatal: if the model or the
// API key is missing, isReady() stays false and the caller falls back to BM25.

const PROVIDER = (process.env.EMBED_PROVIDER || 'local').toLowerCase();

const DEFAULT_MODELS = {
  local: 'Xenova/multilingual-e5-small',
  jina: 'jina-embeddings-v3',
  openai: 'text-embedding-3-small',
  voyage: 'voyage-3.5-lite'
};

const MODEL = process.env.EMBED_MODEL || DEFAULT_MODELS[PROVIDER] || DEFAULT_MODELS.local;
const BATCH_SIZE = Number(process.env.EMBED_BATCH_SIZE || (PROVIDER === 'local' ? 8 : 64));

// E5-family models are trained with asymmetric prefixes; using the wrong one
// (or none) measurably hurts retrieval. Other models take no prefix.
const isE5 = /e5/i.test(MODEL);
const QUERY_PREFIX = process.env.EMBED_QUERY_PREFIX ?? (isE5 ? 'query: ' : '');
const PASSAGE_PREFIX = process.env.EMBED_PASSAGE_PREFIX ?? (isE5 ? 'passage: ' : '');

const state = {
  provider: PROVIDER,
  model: MODEL,
  dim: null,
  ready: false,
  error: null
};

let initPromise = null;
let extractor = null; // local provider only

function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

async function initLocal() {
  // transformers.js is ESM-only; this file is CommonJS, hence the dynamic import.
  // It is an optional dependency: a missing package must degrade to BM25, not
  // crash the API server on boot.
  const { pipeline, env } = await import('@huggingface/transformers');
  if (process.env.TRANSFORMERS_CACHE) env.cacheDir = process.env.TRANSFORMERS_CACHE;
  extractor = await pipeline('feature-extraction', MODEL, {
    dtype: process.env.EMBED_DTYPE || 'q8',
    device: 'cpu'
  });
}

function apiKeyFor(provider) {
  switch (provider) {
    case 'jina': return process.env.JINA_API_KEY;
    case 'openai': return process.env.OPENAI_API_KEY;
    case 'voyage': return process.env.VOYAGE_API_KEY;
    default: return null;
  }
}

async function initRemote() {
  if (!apiKeyFor(PROVIDER)) {
    throw new Error(`EMBED_PROVIDER=${PROVIDER} requires the matching API key env var`);
  }
}

function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (PROVIDER === 'none') throw new Error('embeddings disabled (EMBED_PROVIDER=none)');
    if (PROVIDER === 'local') await initLocal();
    else if (DEFAULT_MODELS[PROVIDER]) await initRemote();
    else throw new Error(`unknown EMBED_PROVIDER: ${PROVIDER}`);
    state.ready = true;
    state.error = null;
    console.log(`[embeddings] provider=${PROVIDER} model=${MODEL} ready`);
  })().catch(err => {
    state.ready = false;
    state.error = err.message;
    console.error(`[embeddings] unavailable: ${err.message} — semantic search disabled, falling back to BM25`);
    // Don't cache the failure forever: a transient issue (e.g. the HuggingFace
    // download for EMBED_PROVIDER=local) should be retried on the next call —
    // by the next scheduled embed pass, or by POST /api/search/reindex —
    // rather than staying broken until the process restarts.
    initPromise = null;
    throw err;
  });
  return initPromise;
}

async function embedLocal(texts) {
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  const rows = out.tolist();
  return rows.map(r => l2normalize(Float32Array.from(r)));
}

async function postJson(url, apiKey, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${url} → HTTP ${res.status} ${text.slice(0, 200)}`);
    // Lets a caller (the embed worker) tell "try again shortly" (429/5xx) apart
    // from "this will never work" (401/400) without re-parsing the message.
    err.status = res.status;
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter)) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  return res.json();
}

async function embedRemote(texts, kind) {
  const apiKey = apiKeyFor(PROVIDER);
  let payload, url;
  if (PROVIDER === 'jina') {
    url = 'https://api.jina.ai/v1/embeddings';
    payload = {
      model: MODEL,
      task: kind === 'query' ? 'retrieval.query' : 'retrieval.passage',
      input: texts
    };
  } else if (PROVIDER === 'openai') {
    url = 'https://api.openai.com/v1/embeddings';
    payload = { model: MODEL, input: texts };
  } else {
    url = 'https://api.voyageai.com/v1/embeddings';
    payload = { model: MODEL, input: texts, input_type: kind === 'query' ? 'query' : 'document' };
  }
  const json = await postJson(url, apiKey, payload);
  // All three return { data: [{ index, embedding }] } but do not guarantee order.
  const rows = new Array(texts.length);
  for (const item of json.data) rows[item.index ?? json.data.indexOf(item)] = item.embedding;
  return rows.map(r => l2normalize(Float32Array.from(r)));
}

// Embeds `texts` and returns one normalised Float32Array per input, in order.
// `kind` is 'query' or 'passage' — it selects the asymmetric prefix / input type.
async function embed(texts, kind = 'passage') {
  if (!texts.length) return [];
  await init();
  const prefix = kind === 'query' ? QUERY_PREFIX : PASSAGE_PREFIX;
  const prefixed = prefix ? texts.map(t => prefix + t) : texts;

  const vectors = [];
  for (let i = 0; i < prefixed.length; i += BATCH_SIZE) {
    const batch = prefixed.slice(i, i + BATCH_SIZE);
    const got = PROVIDER === 'local' ? await embedLocal(batch) : await embedRemote(batch, kind);
    vectors.push(...got);
  }
  if (vectors.length && state.dim === null) state.dim = vectors[0].length;
  return vectors;
}

function isReady() {
  return state.ready;
}

function getStatus() {
  return { ...state, batch_size: BATCH_SIZE };
}

module.exports = { embed, init, isReady, getStatus, MODEL, PROVIDER, _internal: { l2normalize } };
