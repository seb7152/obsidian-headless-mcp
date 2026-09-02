'use strict';

// Hybrid search over the vault: BM25 (SQLite FTS5) + semantic (vector) search,
// fused with Reciprocal Rank Fusion, with optional cloud reranking.
//
// Why this shape:
//   - Chunks, not files. A 3000-word meeting note has one topic per section;
//     embedding it whole averages those topics into mush, and BM25 over whole
//     notes ranks long notes above precise ones.
//   - FTS5 gives real BM25 ranking with zero extra dependencies (SQLite ships
//     with it) — the previous `grep -r` had no ranking at all and rescanned the
//     whole vault on every query.
//   - Brute-force cosine, no ANN index. At vault scale (~2k notes -> ~6k chunks
//     -> ~9 MB of float32) a full scan is a handful of milliseconds. An ANN
//     index would add a native dependency for no measurable gain; revisit past
//     ~100k chunks.
//   - RRF rather than a weighted score sum: BM25 scores and cosine similarities
//     live on different scales, and RRF needs no per-corpus calibration.
//
// The DB handle is injected by vault-indexer.js (init) so this module does not
// open a second connection and there is no require cycle.

const crypto = require('crypto');
const embeddings = require('./embeddings');
const reranker = require('./rerank');

const MAX_CHARS = Number(process.env.SEARCH_CHUNK_MAX_CHARS || 2200);   // ~550 tokens
const MIN_CHARS = Number(process.env.SEARCH_CHUNK_MIN_CHARS || 200);
const OVERLAP_CHARS = Number(process.env.SEARCH_CHUNK_OVERLAP_CHARS || 300);
const EMBED_WORKER_BATCH = Number(process.env.EMBED_WORKER_BATCH || 32);
const RRF_K = Number(process.env.SEARCH_RRF_K || 60);
// A rate-limited embedding API (a real-world default: Jina's free tier is
// 100k tokens/min, and a handful of large chunk batches fired back-to-back
// blows through that) is a transient condition, not a reason to abandon the
// whole backfill until someone notices and pokes /api/search/reindex.
const EMBED_RETRY_MAX_ATTEMPTS = Number(process.env.EMBED_RETRY_MAX_ATTEMPTS || 5);
const EMBED_RETRY_BASE_MS = Number(process.env.EMBED_RETRY_BASE_MS || 5000);
const EMBED_RETRY_MAX_MS = Number(process.env.EMBED_RETRY_MAX_MS || 60000);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let db = null;
let stmt = null;
let embedTimer = null;
let embedRunning = false;
let vectorCache = null;   // { ids: Int32Array, mat: Float32Array, dim }
let cacheVersion = 0;     // bumped on every embedding write; invalidates vectorCache
let cachedAtVersion = -1;
const embedState = { pending: null, done: 0, failed: 0, last_error: null, running: false };

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path   TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      title       TEXT,
      heading     TEXT,
      start_line  INTEGER,
      end_line    INTEGER,
      content     TEXT NOT NULL,
      hash        TEXT NOT NULL,
      embedding   BLOB,
      embed_model TEXT,
      embed_dim   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
  `);
  // remove_diacritics 2 is what makes "reunion" match "réunion". FTS5 has no
  // French stemmer, so search() also issues prefix variants to cover plurals.
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content, heading, title,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}

function prepare(database) {
  return {
    insertChunk: database.prepare(`
      INSERT INTO chunks (file_path, chunk_index, title, heading, start_line, end_line, content, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertFts: database.prepare(`
      INSERT INTO chunks_fts (rowid, content, heading, title) VALUES (?, ?, ?, ?)
    `),
    chunkIdsForFile: database.prepare(`SELECT id FROM chunks WHERE file_path = ?`),
    deleteFts: database.prepare(`DELETE FROM chunks_fts WHERE rowid = ?`),
    deleteChunks: database.prepare(`DELETE FROM chunks WHERE file_path = ?`),
    // Reuse an identical chunk's vector (unchanged section, moved or renamed
    // note) instead of paying to embed it again.
    reuseByHash: database.prepare(`
      UPDATE chunks SET
        embedding   = (SELECT c2.embedding FROM chunks c2
                        WHERE c2.hash = chunks.hash AND c2.embedding IS NOT NULL
                          AND c2.embed_model = ? LIMIT 1),
        embed_dim   = (SELECT c3.embed_dim FROM chunks c3
                        WHERE c3.hash = chunks.hash AND c3.embedding IS NOT NULL
                          AND c3.embed_model = ? LIMIT 1),
        embed_model = ?
      WHERE embedding IS NULL
        AND EXISTS (SELECT 1 FROM chunks c4
                     WHERE c4.hash = chunks.hash AND c4.embedding IS NOT NULL
                       AND c4.embed_model = ?)
    `),
    pendingBatch: database.prepare(`
      SELECT id, title, heading, content FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT ?
    `),
    countPending: database.prepare(`SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NULL`),
    countChunks: database.prepare(`SELECT COUNT(*) AS c FROM chunks`),
    countEmbedded: database.prepare(`SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NOT NULL`),
    setEmbedding: database.prepare(`UPDATE chunks SET embedding = ?, embed_model = ?, embed_dim = ? WHERE id = ?`),
    allVectors: database.prepare(`SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND embed_dim = ?`),
    hydrate: database.prepare(`
      SELECT c.id, c.file_path, c.title, c.heading, c.start_line, c.end_line, c.content,
             f.created, f.modified
        FROM chunks c JOIN files f ON f.path = c.file_path
       WHERE c.id = ?
    `),
    filesWithoutChunks: database.prepare(`
      SELECT f.path FROM files f
        LEFT JOIN chunks c ON c.file_path = f.path
       WHERE c.id IS NULL
    `),
    allFileDates: database.prepare(`SELECT path, created FROM files`)
  };
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;

// Splits markdown into heading-delimited sections, ignoring headings inside
// fenced code blocks (a `# comment` line in a shell block is not a section).
function splitSections(body) {
  const lines = (body || '').split('\n');
  const sections = [];
  const stack = [];
  let current = { heading: '', lines: [], startLine: 1 };
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;

    const m = inFence ? null : line.match(HEADING_RE);
    if (m) {
      if (current.lines.some(l => l.trim())) sections.push({ ...current, endLine: i });
      const level = m[1].length;
      stack.length = Math.min(stack.length, level - 1);
      stack[level - 1] = m[2].trim();
      current = { heading: stack.filter(Boolean).join(' > '), lines: [], startLine: i + 2 };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some(l => l.trim())) sections.push({ ...current, endLine: lines.length });
  return sections;
}

// Splits one oversized section into pieces at paragraph boundaries, carrying an
// overlap tail so a passage straddling a boundary stays retrievable from both.
function splitLongSection(section, opts) {
  const { maxChars, overlapChars } = opts;
  const paragraphs = section.lines.join('\n').split(/\n{2,}/).filter(p => p.trim());
  const pieces = [];
  let buf = '';

  const flush = () => {
    if (!buf.trim()) return;
    pieces.push(buf.trim());
    buf = overlapChars > 0 ? buf.slice(-overlapChars) : '';
  };

  for (const para of paragraphs) {
    if (buf && buf.length + para.length + 2 > maxChars) flush();
    // A single paragraph over the budget (a wall of text, a wide table) is
    // hard-split rather than emitted as one oversized chunk.
    if (para.length > maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars) {
        const piece = para.slice(i, i + maxChars).trim();
        if (piece) pieces.push(piece);
      }
      buf = '';
      continue;
    }
    buf += (buf ? '\n\n' : '') + para;
  }
  if (buf.trim()) pieces.push(buf.trim());
  return pieces;
}

// Turns a note body into retrieval chunks. Small consecutive sections are
// merged (meeting notes are full of two-line headings); large ones are split.
function chunkMarkdown(body, options = {}) {
  const opts = {
    maxChars: options.maxChars ?? MAX_CHARS,
    minChars: options.minChars ?? MIN_CHARS,
    overlapChars: options.overlapChars ?? OVERLAP_CHARS
  };
  const sections = splitSections(body);
  const chunks = [];

  let buf = null; // { heading, text, startLine, endLine }
  const flush = () => {
    if (buf && buf.text.trim()) chunks.push({ ...buf, text: buf.text.trim() });
    buf = null;
  };

  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    if (!text) continue;

    if (text.length > opts.maxChars) {
      flush();
      for (const piece of splitLongSection(section, opts)) {
        chunks.push({
          heading: section.heading,
          text: piece,
          startLine: section.startLine,
          endLine: section.endLine
        });
      }
      continue;
    }

    if (buf && buf.text.length + text.length + 2 > opts.maxChars) flush();
    if (!buf) {
      buf = { heading: section.heading, text, startLine: section.startLine, endLine: section.endLine };
    } else {
      buf.text += '\n\n' + text;
      buf.endLine = section.endLine;
    }
    if (buf.text.length >= opts.maxChars - opts.minChars) flush();
  }
  flush();
  return chunks;
}

function hashOf(title, heading, text) {
  return crypto.createHash('sha1').update(`${title} ${heading} ${text}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

function removeChunks(relPath) {
  if (!db) return;
  for (const row of stmt.chunkIdsForFile.all(relPath)) stmt.deleteFts.run(row.id);
  stmt.deleteChunks.run(relPath);
}

// Re-chunks one note. Called inside the indexer's per-file transaction, so it
// must stay synchronous — embedding happens later, in the background worker.
function indexChunks(relPath, title, body) {
  if (!db) return 0;
  removeChunks(relPath);

  let chunks = chunkMarkdown(body);
  // A note with no body (title-only, or frontmatter-only) still deserves to be
  // findable, and giving every file at least one chunk keeps reconcileChunks()
  // from rescanning it on every boot.
  if (!chunks.length) chunks = [{ heading: '', text: title || relPath, startLine: 1, endLine: 1 }];

  chunks.forEach((chunk, i) => {
    const hash = hashOf(title || '', chunk.heading, chunk.text);
    const info = stmt.insertChunk.run(
      relPath, i, title || '', chunk.heading, chunk.startLine, chunk.endLine, chunk.text, hash
    );
    stmt.insertFts.run(info.lastInsertRowid, chunk.text, chunk.heading, title || '');
  });
  scheduleEmbedding();
  return chunks.length;
}

// ---------------------------------------------------------------------------
// Background embedding worker
// ---------------------------------------------------------------------------

function scheduleEmbedding(delayMs = 5000) {
  if (embedTimer || embedRunning) return;
  embedTimer = setTimeout(() => {
    embedTimer = null;
    runEmbedWorker().catch(err => console.error(`[search] embed worker: ${err.message}`));
  }, delayMs);
  embedTimer.unref?.();
}

async function runEmbedWorker() {
  if (!db || embedRunning) return;
  const providerUp = await embeddings.init().then(() => true).catch(() => false);
  if (!providerUp) return;

  embedRunning = true;
  embedState.running = true;
  const model = embeddings.MODEL;
  try {
    // Free win before spending anything: copy vectors across identical chunks.
    stmt.reuseByHash.run(model, model, model, model);
    cacheVersion++;

    for (;;) {
      const batch = stmt.pendingBatch.all(EMBED_WORKER_BATCH);
      if (!batch.length) break;

      const texts = batch.map(c => [c.title, c.heading, c.content].filter(Boolean).join('\n'));
      let vectors = null;
      for (let attempt = 1; attempt <= EMBED_RETRY_MAX_ATTEMPTS; attempt++) {
        try {
          vectors = await embeddings.embed(texts, 'passage');
          break;
        } catch (err) {
          const retryable = err.status === 429 || (err.status >= 500 && err.status < 600);
          if (!retryable || attempt === EMBED_RETRY_MAX_ATTEMPTS) {
            embedState.failed += batch.length;
            embedState.last_error = err.message;
            console.error(`[search] embedding batch failed${retryable ? ' (out of retries)' : ''}: ${err.message}`);
            break;
          }
          const delayMs = Math.min(err.retryAfterMs || EMBED_RETRY_BASE_MS * attempt, EMBED_RETRY_MAX_MS);
          console.error(`[search] embedding batch rate-limited, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${EMBED_RETRY_MAX_ATTEMPTS}): ${err.message}`);
          await sleep(delayMs);
        }
      }
      if (!vectors) break; // gave up on this batch; the next schedule (or a manual reindex) resumes here

      const write = db.transaction(() => {
        vectors.forEach((vec, i) => {
          const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
          stmt.setEmbedding.run(blob, model, vec.length, batch[i].id);
        });
      });
      write();
      cacheVersion++;
      embedState.done += batch.length;
      if (embedState.done % 500 < EMBED_WORKER_BATCH) {
        console.log(`[search] embedded ${embedState.done} chunks (${stmt.countPending.get().c} pending)`);
      }
    }

    const pending = stmt.countPending.get().c;
    embedState.pending = pending;
    if (pending === 0) console.log(`[search] embedding index complete (${stmt.countEmbedded.get().c} chunks)`);
  } finally {
    embedRunning = false;
    embedState.running = false;
  }
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

// FTS5 treats ", *, :, -, AND/OR/NOT as syntax. Rather than escape a raw user
// string, extract word tokens and rebuild a safe MATCH expression. Tokens of 4+
// chars also get a prefix variant, which is what stands in for the French
// stemmer FTS5 does not have ("réunion" finds "réunions").
function buildFtsQuery(query) {
  const tokens = (String(query).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter(t => t.length > 1);
  if (!tokens.length) return null;
  return tokens.map(t => (t.length >= 4 ? `("${t}" OR "${t}"*)` : `"${t}"`)).join(' OR ');
}

function searchBm25(query, limit) {
  const match = buildFtsQuery(query);
  if (!match) return [];
  try {
    // bm25() is negative-is-better in FTS5; column weights favour a hit in the
    // note title or section heading over one in the body.
    const rows = db.prepare(`
      SELECT rowid AS id, bm25(chunks_fts, 1.0, 2.0, 3.0) AS score
        FROM chunks_fts WHERE chunks_fts MATCH ?
       ORDER BY score LIMIT ?
    `).all(match, limit);
    return rows.map((r, i) => ({ id: r.id, rank: i + 1, bm25: -r.score }));
  } catch (err) {
    console.error(`[search] FTS query failed: ${err.message}`);
    return [];
  }
}

function loadVectorCache(dim) {
  if (vectorCache && vectorCache.dim === dim && cachedAtVersion === cacheVersion) return vectorCache;
  const rows = stmt.allVectors.all(dim);
  const ids = new Int32Array(rows.length);
  const mat = new Float32Array(rows.length * dim);
  rows.forEach((row, i) => {
    ids[i] = row.id;
    // Buffers from SQLite are not guaranteed to be 4-byte aligned, so copy
    // through a byte view rather than constructing a Float32Array over them.
    const bytes = new Uint8Array(mat.buffer, i * dim * 4, dim * 4);
    bytes.set(new Uint8Array(row.embedding.buffer, row.embedding.byteOffset, dim * 4));
  });
  vectorCache = { ids, mat, dim };
  cachedAtVersion = cacheVersion;
  return vectorCache;
}

// Full scan over the in-memory matrix. Vectors are L2-normalised at embed time,
// so cosine similarity is a dot product.
function searchVector(queryVec, limit) {
  const dim = queryVec.length;
  const cache = loadVectorCache(dim);
  if (!cache.ids.length) return [];

  const scored = new Array(cache.ids.length);
  for (let i = 0; i < cache.ids.length; i++) {
    let dot = 0;
    const base = i * dim;
    for (let d = 0; d < dim; d++) dot += cache.mat[base + d] * queryVec[d];
    scored[i] = { id: cache.ids[i], cosine: dot };
  }
  scored.sort((a, b) => b.cosine - a.cosine);
  return scored.slice(0, limit).map((s, i) => ({ id: s.id, rank: i + 1, cosine: s.cosine }));
}

// Reciprocal Rank Fusion: score = sum(weight / (k + rank)). Rank-based, so the
// wildly different scales of BM25 and cosine never need normalising.
function fuseRRF(lists, k = RRF_K) {
  const acc = new Map();
  for (const { results, weight = 1 } of lists) {
    for (const r of results) {
      const entry = acc.get(r.id) ||
        { id: r.id, score: 0, bm25: null, cosine: null, bm25Rank: null, vectorRank: null };
      entry.score += weight / (k + r.rank);
      if (r.bm25 !== undefined) { entry.bm25 = r.bm25; entry.bm25Rank = r.rank; }
      if (r.cosine !== undefined) { entry.cosine = r.cosine; entry.vectorRank = r.rank; }
      acc.set(r.id, entry);
    }
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

function normalizeForMatch(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Snippet lines for a result: lines carrying a query term, else the opening
// lines of the chunk so a purely semantic hit still shows something useful.
function pickMatches(content, query, max = 3) {
  const terms = (normalizeForMatch(String(query)).match(/[\p{L}\p{N}_]+/gu) || []).filter(t => t.length > 2);
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const hits = terms.length
    ? lines.filter(l => { const n = normalizeForMatch(l); return terms.some(t => n.includes(t)); })
    : [];
  const picked = hits.length ? hits : lines;
  return picked.slice(0, max).map(l => (l.length > 300 ? l.slice(0, 300) + '…' : l));
}

function fileDate(filePath, created) {
  if (created) return created;
  const m = filePath.split('/').pop().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Pre-computes the set of notes passing the date / path filters. Cheap at vault
// scale and it keeps the filter out of both the FTS and the vector hot loops.
function buildAllowedPaths({ since, before, pathPrefix }) {
  if (!since && !before && !pathPrefix) return null;
  const prefix = pathPrefix ? pathPrefix.replace(/\/+$/, '') : null;
  const allowed = new Set();
  for (const row of stmt.allFileDates.all()) {
    if (prefix && row.path !== prefix && !row.path.startsWith(prefix + '/')) continue;
    const d = fileDate(row.path, row.created);
    if (d && since && d < since) continue;
    if (d && before && d > before) continue;
    allowed.add(row.path);
  }
  return allowed;
}

// Runs the hybrid pipeline and returns file-level results, best first.
//
// mode: 'auto' (hybrid when embeddings are ready, BM25 otherwise) | 'hybrid'
//       | 'semantic' | 'bm25'
async function search(query, options = {}) {
  if (!db) throw new Error('search index not initialised');
  const {
    limit = 20,
    since = null,
    before = null,
    pathPrefix = null,
    rerank = false,
    candidateLimit = Number(process.env.SEARCH_CANDIDATE_LIMIT || 40)
  } = options;

  const semanticReady = embeddings.isReady() && stmt.countEmbedded.get().c > 0;
  const requestedMode = options.mode || 'auto';
  // 'auto' implicitly wants semantic too — a caller who never asked for a mode
  // still deserves to know their results are keyword-only right now, rather
  // than silently getting worse recall with no signal.
  const wantsSemantic = requestedMode === 'auto' || requestedMode === 'hybrid' || requestedMode === 'semantic';
  let mode = requestedMode;
  const warnings = [];

  if (mode === 'auto') mode = semanticReady ? 'hybrid' : 'bm25';
  if ((mode === 'hybrid' || mode === 'semantic') && !semanticReady) mode = 'bm25';

  if (wantsSemantic && !semanticReady) {
    // A populated embeddings error (e.g. a missing EMBED_PROVIDER API key) is a
    // standing misconfiguration, not a transient state — call it out by name
    // so whoever/whatever is calling this (an LLM via MCP included) can act on
    // it instead of just seeing quietly worse results.
    const embedError = embeddings.getStatus().error;
    warnings.push(
      embedError
        ? `semantic search unavailable (${embedError}) — answered with BM25 only`
        : 'semantic index not ready yet — answered with BM25 only'
    );
  }

  const pool = Math.max(candidateLimit, limit) * 2;
  const lists = [];

  if (mode === 'bm25' || mode === 'hybrid') {
    lists.push({ results: searchBm25(query, pool), weight: 1 });
  }
  if (mode === 'semantic' || mode === 'hybrid') {
    try {
      const [queryVec] = await embeddings.embed([query], 'query');
      lists.push({ results: searchVector(queryVec, pool), weight: 1 });
    } catch (err) {
      warnings.push(`semantic search failed: ${err.message}`);
      if (mode === 'semantic') lists.push({ results: searchBm25(query, pool), weight: 1 });
    }
  }

  const fused = lists.length === 1
    ? lists[0].results.map(r => ({
        id: r.id,
        score: 1 / (RRF_K + r.rank),
        bm25: r.bm25 ?? null,
        cosine: r.cosine ?? null,
        bm25Rank: r.bm25 !== undefined ? r.rank : null,
        vectorRank: r.cosine !== undefined ? r.rank : null
      }))
    : fuseRRF(lists);

  const allowed = buildAllowedPaths({ since, before, pathPrefix });
  let candidates = [];
  for (const entry of fused) {
    const row = stmt.hydrate.get(entry.id);
    if (!row) continue;
    if (allowed && !allowed.has(row.file_path)) continue;
    candidates.push({
      ...entry,
      filePath: row.file_path,
      title: row.title,
      heading: row.heading,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.content,
      created: row.created,
      modified: row.modified
    });
    if (candidates.length >= candidateLimit) break;
  }

  let rerankInfo = null;
  if (rerank && candidates.length) {
    const res = await reranker.rerank(query, candidates, candidates.length);
    candidates = res.ordered;
    const status = reranker.getStatus();
    rerankInfo = {
      provider: status.provider,
      model: status.model,
      reranked: res.reranked,
      skipped: res.skipped,
      error: res.error
    };
    if (res.error) warnings.push(`rerank: ${res.error}`);
  }

  // Collapse to one row per note, keeping its best chunk's position.
  const byFile = new Map();
  candidates.forEach((c, position) => {
    const existing = byFile.get(c.filePath);
    const chunkRef = { heading: c.heading || null, start_line: c.startLine, end_line: c.endLine };
    if (existing) {
      existing.chunks.push(chunkRef);
      return;
    }
    byFile.set(c.filePath, {
      file: c.filePath,
      title: c.title || c.filePath.split('/').pop().replace(/\.md$/, ''),
      score: Math.round((c.rerankScore ?? c.score) * 10000) / 10000,
      date: fileDate(c.filePath, c.created),
      heading: c.heading || null,
      matches: pickMatches(c.text, query),
      position,
      chunks: [chunkRef]
    });
  });

  const results = [...byFile.values()]
    .sort((a, b) => a.position - b.position)
    .slice(0, limit)
    .map(({ position, ...rest }) => rest);

  return { query, mode, results, count: results.length, rerank: rerankInfo, warnings };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function init(database) {
  db = database;
  createSchema(db);
  stmt = prepare(db);
}

// Chunks any indexed note that has no chunks yet — the migration path for an
// existing vault-index.db, and the safety net if a chunking pass was cut short.
function reconcileChunks(readNote) {
  if (!db) return 0;
  const missing = stmt.filesWithoutChunks.all();
  if (!missing.length) return 0;
  console.log(`[search] chunking ${missing.length} note(s) missing from the search index...`);
  let done = 0;
  for (const row of missing) {
    const note = readNote(row.path);
    if (!note) continue;
    try {
      indexChunks(row.path, note.title, note.body);
      done++;
    } catch (err) {
      console.error(`[search] failed to chunk ${row.path}: ${err.message}`);
    }
  }
  console.log(`[search] chunked ${done} note(s), ${stmt.countChunks.get().c} chunks total`);
  return done;
}

function getStatus() {
  if (!db) return { ready: false };
  const chunks = stmt.countChunks.get().c;
  const embedded = stmt.countEmbedded.get().c;
  return {
    chunks,
    embedded,
    pending: chunks - embedded,
    semantic_ready: embeddings.isReady() && embedded > 0,
    embeddings: embeddings.getStatus(),
    embed_worker: { ...embedState, pending: chunks - embedded },
    rerank: reranker.getStatus(),
    chunking: { max_chars: MAX_CHARS, min_chars: MIN_CHARS, overlap_chars: OVERLAP_CHARS }
  };
}

module.exports = {
  init,
  indexChunks,
  removeChunks,
  reconcileChunks,
  search,
  getStatus,
  scheduleEmbedding,
  runEmbedWorker,
  _internal: { chunkMarkdown, splitSections, buildFtsQuery, fuseRRF, pickMatches, hashOf, normalizeForMatch }
};
