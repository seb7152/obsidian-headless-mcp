'use strict';

// Offline unit + integration tests for search-index.js and rerank.js.
// Run with: node --test
// No network is used: embeddings are disabled, so the semantic path is exercised
// only through its fallback behaviour.

const test = require('node:test');
const assert = require('node:assert');

// Must be set BEFORE requiring the modules: both read their config at load.
process.env.EMBED_PROVIDER = 'none';
delete process.env.JINA_API_KEY;
// The real default (60s) would make the reschedule-after-giving-up test slow;
// this only shortens the *delay*, not the retry-attempt bound being tested.
process.env.EMBED_RETRY_MAX_MS = '30';

const Database = require('better-sqlite3');
const searchIndex = require('./search-index');
const reranker = require('./rerank');
const embeddingsModule = require('./embeddings');

const { chunkMarkdown, splitSections, buildFtsQuery, fuseRRF, pickMatches, hashOf } = searchIndex._internal;

// ---------------------------------------------------------------------------
// Section splitting
// ---------------------------------------------------------------------------

test('splitSections: builds a breadcrumb heading path', () => {
  const sections = splitSections('# Projet\n\nIntro\n\n## Budget\n\nChiffres\n\n### Détail\n\nLignes');
  assert.deepEqual(sections.map(s => s.heading), ['Projet', 'Projet > Budget', 'Projet > Budget > Détail']);
});

test('splitSections: a sibling heading pops the deeper level off the path', () => {
  const sections = splitSections('# A\n\nx\n\n## B\n\ny\n\n## C\n\nz');
  assert.deepEqual(sections.map(s => s.heading), ['A', 'A > B', 'A > C']);
});

test('splitSections: "#" inside a fenced block is not a heading', () => {
  const sections = splitSections('# Real\n\nbefore\n\n```bash\n# not a heading\necho hi\n```\n\nafter');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, 'Real');
  assert.match(sections[0].lines.join('\n'), /# not a heading/);
});

test('splitSections: content before the first heading is kept', () => {
  const sections = splitSections('orphan paragraph\n\n# Later\n\nbody');
  assert.equal(sections[0].heading, '');
  assert.match(sections[0].lines.join('\n'), /orphan paragraph/);
});

test('splitSections: empty sections are dropped', () => {
  const sections = splitSections('# A\n\n## B\n\n## C\n\ncontent');
  assert.deepEqual(sections.map(s => s.heading), ['A > C']);
});

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

test('chunkMarkdown: empty body yields no chunks', () => {
  assert.deepEqual(chunkMarkdown(''), []);
  assert.deepEqual(chunkMarkdown('   \n\n  '), []);
});

test('chunkMarkdown: small consecutive sections are merged into one chunk', () => {
  const body = '# A\n\nun\n\n## B\n\ndeux\n\n## C\n\ntrois';
  const chunks = chunkMarkdown(body, { maxChars: 2000, minChars: 100, overlapChars: 0 });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /un/);
  assert.match(chunks[0].text, /trois/);
});

test('chunkMarkdown: no chunk exceeds maxChars', () => {
  const para = 'phrase de test. '.repeat(40);            // ~640 chars
  const body = `# Long\n\n${Array(12).fill(para).join('\n\n')}`;
  const chunks = chunkMarkdown(body, { maxChars: 1000, minChars: 100, overlapChars: 100 });
  assert.ok(chunks.length > 1, 'expected the section to be split');
  for (const c of chunks) assert.ok(c.text.length <= 1000, `chunk of ${c.text.length} chars exceeds budget`);
});

test('chunkMarkdown: a single paragraph larger than maxChars is hard-split', () => {
  const body = '# Wall\n\n' + 'x'.repeat(5000);
  const chunks = chunkMarkdown(body, { maxChars: 800, minChars: 100, overlapChars: 0 });
  assert.ok(chunks.length >= 6);
  for (const c of chunks) assert.ok(c.text.length <= 800);
});

test('chunkMarkdown: overlap carries context across a split boundary', () => {
  const paras = Array.from({ length: 8 }, (_, i) => `paragraphe numero ${i} ` + 'mot '.repeat(60));
  const chunks = chunkMarkdown('# S\n\n' + paras.join('\n\n'), { maxChars: 700, minChars: 50, overlapChars: 200 });
  assert.ok(chunks.length > 1);
  const joined = chunks.map(c => c.text).join('\n');
  // Every paragraph must survive somewhere in the chunk set.
  for (let i = 0; i < paras.length; i++) assert.match(joined, new RegExp(`paragraphe numero ${i}`));
});

test('chunkMarkdown: chunks carry their section heading and line range', () => {
  const chunks = chunkMarkdown('# Titre\n\nligne une\nligne deux');
  assert.equal(chunks[0].heading, 'Titre');
  assert.ok(chunks[0].startLine >= 1);
  assert.ok(chunks[0].endLine >= chunks[0].startLine);
});

test('hashOf: stable for identical input, different when the heading changes', () => {
  assert.equal(hashOf('t', 'h', 'body'), hashOf('t', 'h', 'body'));
  assert.notEqual(hashOf('t', 'h', 'body'), hashOf('t', 'h2', 'body'));
});

// ---------------------------------------------------------------------------
// FTS query building
// ---------------------------------------------------------------------------

test('buildFtsQuery: quotes tokens so FTS5 syntax in the query is inert', () => {
  const q = buildFtsQuery('budget AND "nokia" OR (x)');
  assert.ok(!/\(x\)/.test(q.replace(/\("[^"]+" OR "[^"]+"\*\)/g, '')), 'raw parentheses leaked through');
  assert.match(q, /"budget"/);
  assert.match(q, /"nokia"/);
});

test('buildFtsQuery: long tokens get a prefix variant, short ones do not', () => {
  assert.match(buildFtsQuery('reunion'), /\("reunion" OR "reunion"\*\)/);
  assert.equal(buildFtsQuery('cle'), '"cle"');
});

test('buildFtsQuery: returns null when nothing is searchable', () => {
  assert.equal(buildFtsQuery('   '), null);
  assert.equal(buildFtsQuery('!!! ?'), null);
});

test('buildFtsQuery: single-character tokens are dropped', () => {
  assert.equal(buildFtsQuery('a budget'), '("budget" OR "budget"*)');
});

// ---------------------------------------------------------------------------
// Rank fusion
// ---------------------------------------------------------------------------

test('fuseRRF: a document ranked by both retrievers beats one ranked by either', () => {
  const bm25 = { results: [{ id: 1, rank: 1, bm25: 9 }, { id: 2, rank: 2, bm25: 8 }] };
  const vec = { results: [{ id: 3, rank: 1, cosine: 0.9 }, { id: 1, rank: 2, cosine: 0.8 }] };
  const fused = fuseRRF([bm25, vec], 60);
  assert.equal(fused[0].id, 1);
  assert.ok(fused[0].score > fused[1].score);
});

test('fuseRRF: keeps both retrievers scores and ranks on the fused entry', () => {
  const fused = fuseRRF([
    { results: [{ id: 5, rank: 3, bm25: 4 }] },
    { results: [{ id: 5, rank: 7, cosine: 0.5 }] }
  ], 60);
  assert.equal(fused[0].bm25Rank, 3);
  assert.equal(fused[0].vectorRank, 7);
  assert.equal(fused[0].cosine, 0.5);
});

test('fuseRRF: weights shift the ordering', () => {
  const lists = [
    { results: [{ id: 1, rank: 1, bm25: 1 }], weight: 1 },
    { results: [{ id: 2, rank: 1, cosine: 1 }], weight: 3 }
  ];
  assert.equal(fuseRRF(lists, 60)[0].id, 2);
});

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

test('pickMatches: prefers lines containing a query term, ignoring accents', () => {
  const content = 'ligne sans rapport\nle budget previsionnel est valide\nautre ligne';
  assert.deepEqual(pickMatches(content, 'budget prévisionnel', 1), ['le budget previsionnel est valide']);
});

test('pickMatches: falls back to the opening lines for a purely semantic hit', () => {
  const matches = pickMatches('premiere ligne\ndeuxieme ligne', 'concept totalement absent', 2);
  assert.deepEqual(matches, ['premiere ligne', 'deuxieme ligne']);
});

test('pickMatches: truncates very long lines', () => {
  const [line] = pickMatches('budget ' + 'x'.repeat(500), 'budget', 1);
  assert.ok(line.length <= 301);
  assert.ok(line.endsWith('…'));
});

// ---------------------------------------------------------------------------
// Embeddings init retry (no network: EMBED_PROVIDER=none always rejects)
// ---------------------------------------------------------------------------

test('embeddings: a failed init() is not cached forever - the next call retries', async () => {
  const p1 = embeddingsModule.init();
  await assert.rejects(p1);
  const p2 = embeddingsModule.init();
  // Before the fix, init() cached the rejected promise and every later caller
  // (including POST /api/search/reindex) got the exact same stale failure
  // back forever, even after whatever was wrong got fixed.
  assert.notStrictEqual(p1, p2, 'second init() call returned the same cached rejection instead of retrying');
  await assert.rejects(p2);
});

// ---------------------------------------------------------------------------
// Reranker guards (no network: no API key is configured)
// ---------------------------------------------------------------------------

test('rerank: unavailable without an API key, and returns the input order', async () => {
  assert.equal(reranker.isAvailable(), false);
  const candidates = [{ filePath: 'a.md', text: 'x' }, { filePath: 'b.md', text: 'y' }];
  const res = await reranker.rerank('q', candidates);
  assert.deepEqual(res.ordered, candidates);
  assert.equal(res.reranked, 0);
  assert.ok(res.error);
});

test('rerank: parseResults normalises the providers response shapes', () => {
  const { parseResults } = reranker._internal;
  assert.deepEqual(parseResults('jina', { results: [{ index: 2, relevance_score: 0.7 }] }),
    [{ index: 2, score: 0.7 }]);
  assert.deepEqual(parseResults('cohere', { results: [{ index: 0, relevance_score: 0.9 }] }),
    [{ index: 0, score: 0.9 }]);
  assert.deepEqual(parseResults('x', { results: [{ relevance_score: 0.5 }] }), []);
});

// ---------------------------------------------------------------------------
// Integration: real SQLite, real FTS5, embeddings disabled
// ---------------------------------------------------------------------------

function buildTestIndex() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE files (
      path TEXT PRIMARY KEY, title TEXT, created TEXT, modified TEXT,
      tags TEXT NOT NULL DEFAULT '[]', frontmatter TEXT NOT NULL DEFAULT '{}'
    );
  `);
  searchIndex.init(db);

  const addFile = db.prepare(`INSERT INTO files (path, title, created, modified) VALUES (?, ?, ?, ?)`);
  const notes = [
    ['20_Projects/nokia.md', 'Commande Nokia', '2026-06-24',
      '# Commande\n\nSécurisation de la commande Nokia et du calendrier de livraison.\n\n## Budget\n\nLe budget prévisionnel est validé par le comité.'],
    ['20_Projects/reunions.md', 'Réunions hebdo', '2026-05-02',
      '# Réunions\n\nCompte rendu des réunions hebdomadaires avec les équipes.'],
    ['30_Knowledge/sqlite.md', 'Notes SQLite', '2024-01-15',
      '# SQLite\n\nFTS5 fournit un classement BM25 natif, sans dépendance externe.']
  ];
  for (const [p, t, d, body] of notes) {
    addFile.run(p, t, d, d);
    searchIndex.indexChunks(p, t, body);
  }
  return db;
}

test('integration: BM25 ranks the relevant note first', async () => {
  buildTestIndex();
  const out = await searchIndex.search('commande Nokia', { mode: 'bm25' });
  assert.equal(out.mode, 'bm25');
  assert.equal(out.results[0].file, '20_Projects/nokia.md');
  assert.ok(out.results[0].matches.length > 0);
});

test('integration: accent-insensitive and plural-tolerant matching', async () => {
  buildTestIndex();
  const out = await searchIndex.search('reunion', { mode: 'bm25' });
  assert.equal(out.results[0].file, '20_Projects/reunions.md');
});

// Both messages search() can emit here end the same way regardless of whether
// embeddings.init() has already run elsewhere in this process (it shares one
// module-level state with every other test in this file, including the
// init()-retry test above) — assert on that common tail rather than on which
// of the two variants fired, which is exercised precisely by the two tests
// further down ("not ready yet" vs a named config error).
const SEMANTIC_UNAVAILABLE_RE = /answered with BM25 only/;

test('integration: mode=hybrid degrades to bm25 with a warning when embeddings are off', async () => {
  buildTestIndex();
  const out = await searchIndex.search('budget', { mode: 'hybrid' });
  assert.equal(out.mode, 'bm25');
  assert.ok(out.warnings.some(w => SEMANTIC_UNAVAILABLE_RE.test(w)), JSON.stringify(out.warnings));
});

test('integration: mode=auto (the default) also warns when semantic is not ready', async () => {
  // 'auto' silently falling back used to skip the warning entirely — a caller
  // that never named a mode still deserves to know it got keyword-only
  // results, not just quietly worse recall.
  buildTestIndex();
  const out = await searchIndex.search('budget', {});
  assert.equal(out.mode, 'bm25');
  assert.ok(out.warnings.some(w => SEMANTIC_UNAVAILABLE_RE.test(w)), JSON.stringify(out.warnings));
});

test('integration: an explicit bm25/grep-style request is not nagged about semantic', async () => {
  buildTestIndex();
  const out = await searchIndex.search('budget', { mode: 'bm25' });
  assert.deepEqual(out.warnings, []);
});

test('integration: a real embeddings config error is named in the warning, not just "not ready"', async () => {
  buildTestIndex();
  await embeddingsModule.init().catch(() => {}); // EMBED_PROVIDER=none -> populates state.error
  const out = await searchIndex.search('budget', {});
  assert.ok(
    out.warnings.some(w => w.includes('semantic search unavailable') && w.includes('EMBED_PROVIDER=none')),
    JSON.stringify(out.warnings)
  );
});

test('integration: date and path filters restrict the result set', async () => {
  buildTestIndex();
  const recent = await searchIndex.search('budget commande réunions SQLite', { mode: 'bm25', since: '2026-01-01' });
  assert.ok(recent.results.every(r => r.date >= '2026-01-01'), JSON.stringify(recent.results));

  const scoped = await searchIndex.search('budget commande réunions SQLite', { mode: 'bm25', pathPrefix: '30_Knowledge' });
  assert.deepEqual(scoped.results.map(r => r.file), ['30_Knowledge/sqlite.md']);
});

test('integration: results collapse to one row per note', async () => {
  const db = buildTestIndex();
  db.prepare(`INSERT INTO files (path, title, created, modified) VALUES (?, ?, ?, ?)`)
    .run('20_Projects/gros.md', 'Gros dossier', '2026-02-02', '2026-02-02');
  const body = Array.from({ length: 10 }, (_, i) => `## Section ${i}\n\nbudget ` + 'texte '.repeat(200)).join('\n\n');
  searchIndex.indexChunks('20_Projects/gros.md', 'Gros dossier', body);

  const out = await searchIndex.search('budget', { mode: 'bm25' });
  const files = out.results.map(r => r.file);
  assert.equal(new Set(files).size, files.length, 'a note appeared more than once');
  const gros = out.results.find(r => r.file === '20_Projects/gros.md');
  assert.ok(gros.chunks.length > 1, 'expected several matching chunks on the same note');
});

test('integration: re-indexing a note replaces its chunks and FTS rows', async () => {
  const db = buildTestIndex();
  searchIndex.indexChunks('20_Projects/nokia.md', 'Commande Nokia', '# Commande\n\nContenu entièrement remplacé.');

  const before = await searchIndex.search('calendrier livraison', { mode: 'bm25' });
  assert.ok(!before.results.some(r => r.file === '20_Projects/nokia.md'), 'stale FTS row still matches');

  const chunkCount = db.prepare(`SELECT COUNT(*) c FROM chunks WHERE file_path = ?`).get('20_Projects/nokia.md').c;
  const ftsCount = db.prepare(`SELECT COUNT(*) c FROM chunks_fts`).get().c;
  const totalChunks = db.prepare(`SELECT COUNT(*) c FROM chunks`).get().c;
  assert.equal(chunkCount, 1);
  assert.equal(ftsCount, totalChunks, 'FTS index drifted from the chunks table');
});

test('integration: removing a note clears its chunks and FTS rows', async () => {
  const db = buildTestIndex();
  searchIndex.removeChunks('20_Projects/reunions.md');
  db.prepare('DELETE FROM files WHERE path = ?').run('20_Projects/reunions.md');

  const out = await searchIndex.search('reunion', { mode: 'bm25' });
  assert.ok(!out.results.some(r => r.file === '20_Projects/reunions.md'));
  assert.equal(
    db.prepare(`SELECT COUNT(*) c FROM chunks_fts`).get().c,
    db.prepare(`SELECT COUNT(*) c FROM chunks`).get().c
  );
});

test('integration: a body-less note is still indexed under its title', async () => {
  const db = buildTestIndex();
  db.prepare(`INSERT INTO files (path, title, created, modified) VALUES (?, ?, ?, ?)`)
    .run('00_Inbox/vide.md', 'Chantier Hostinger', '2026-03-03', '2026-03-03');
  searchIndex.indexChunks('00_Inbox/vide.md', 'Chantier Hostinger', '');

  const out = await searchIndex.search('Hostinger', { mode: 'bm25' });
  assert.equal(out.results[0].file, '00_Inbox/vide.md');
});

test('integration: getStatus reports chunk and embedding counts', () => {
  buildTestIndex();
  const status = searchIndex.getStatus();
  assert.ok(status.chunks > 0);
  assert.equal(status.embedded, 0);
  assert.equal(status.semantic_ready, false);
  assert.equal(status.pending, status.chunks);
});

test('embed worker: retries a rate-limited (429) batch instead of abandoning the backfill', async () => {
  // Reproduces what actually happened against Jina's free tier in production:
  // a batch came back 429, and the worker used to give up on the whole run
  // rather than back off and retry — stalling the backfill until someone
  // manually restarted the service or hit /api/search/reindex.
  buildTestIndex();

  const origInit = embeddingsModule.init;
  const origEmbed = embeddingsModule.embed;
  let calls = 0;
  embeddingsModule.init = async () => {};
  embeddingsModule.embed = async (texts) => {
    calls++;
    if (calls < 3) {
      const err = new Error('rate limited');
      err.status = 429;
      err.retryAfterMs = 1; // keep the test fast regardless of the real default backoff
      throw err;
    }
    return texts.map(() => new Float32Array(4).fill(0.1));
  };

  try {
    await searchIndex.runEmbedWorker();
  } finally {
    embeddingsModule.init = origInit;
    embeddingsModule.embed = origEmbed;
  }

  assert.ok(calls >= 3, `expected the worker to retry past the two 429s, got ${calls} call(s)`);
  const status = searchIndex.getStatus();
  assert.equal(status.embedded, status.chunks, 'all chunks should be embedded once the retries succeed');
});

test('embed worker: a non-retryable error (e.g. a bad key) gives up immediately', async () => {
  buildTestIndex();

  const origInit = embeddingsModule.init;
  const origEmbed = embeddingsModule.embed;
  let calls = 0;
  embeddingsModule.init = async () => {};
  embeddingsModule.embed = async () => {
    calls++;
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  };

  try {
    await searchIndex.runEmbedWorker();
  } finally {
    embeddingsModule.init = origInit;
    embeddingsModule.embed = origEmbed;
  }

  assert.equal(calls, 1, 'a 401 should not be retried at all');
  assert.equal(searchIndex.getStatus().embedded, 0);
});

test('embed worker: a batch that stays rate-limited past all retries reschedules itself', async () => {
  // What actually happened in production: one batch outlasted every retry
  // attempt's backoff, runEmbedWorker() returned, and — before this fix —
  // nothing ever called it again. The whole backfill stalled until someone
  // noticed and hit /api/search/reindex or restarted the container by hand.
  buildTestIndex();
  // buildTestIndex() already self-scheduled a (real, 5s-delayed) embed pass;
  // clear it so the reschedule this test is actually checking for is the one
  // runEmbedWorker() itself arms after giving up, not a coincidental one left
  // over from setup.
  searchIndex._internal._clearEmbedTimerForTests();

  const origInit = embeddingsModule.init;
  const origEmbed = embeddingsModule.embed;
  let calls = 0;
  embeddingsModule.init = async () => {};
  embeddingsModule.embed = async () => {
    calls++;
    const err = new Error('still rate limited');
    err.status = 429;
    err.retryAfterMs = 1; // keep both the in-batch retries and the reschedule fast
    throw err;
  };

  try {
    await searchIndex.runEmbedWorker(); // exhausts its retries, then reschedules via scheduleEmbedding()
    const callsAfterFirstPass = calls;

    // The reschedule fires after EMBED_RETRY_MAX_MS (overridden to 30ms for
    // this file) — wait past it and confirm the worker actually ran again on
    // its own, without anything explicitly calling it a second time.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(calls > callsAfterFirstPass, 'expected a rescheduled pass to call embed() again on its own');
  } finally {
    embeddingsModule.init = origInit;
    embeddingsModule.embed = origEmbed;
  }
});
