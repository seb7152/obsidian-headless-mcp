'use strict';

const Database = require('better-sqlite3');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const webhooks = require('./webhooks');

const VAULT_PATH = process.env.VAULT_PATH || '/vault';
const SQLITE_PATH = process.env.SQLITE_PATH || '/data/vault-index.db';

// -- DB init --
const db = new Database(SQLITE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    path        TEXT PRIMARY KEY,
    title       TEXT,
    created     TEXT,
    modified    TEXT,
    tags        TEXT NOT NULL DEFAULT '[]',
    frontmatter TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path   TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    completed   INTEGER NOT NULL DEFAULT 0,
    due         TEXT
  );
`);

// -- Helpers --

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: content };
  try {
    return { frontmatter: yaml.load(m[1]) || {}, body: m[2] };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

function extractTags(frontmatter, body) {
  const tags = new Set();
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) fmTags.forEach(t => tags.add(String(t)));
  else if (typeof fmTags === 'string' && fmTags) tags.add(fmTags);
  const re = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_\-/]*)/g;
  let match;
  while ((match = re.exec(body)) !== null) tags.add(match[1]);
  return [...tags];
}

function extractTasks(body) {
  return body.split('\n').reduce((acc, line) => {
    const m = line.match(/^\s*- \[([ xX])\] (.+)$/);
    if (!m) return acc;
    const text = m[2].trim();
    const dueM = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/) || text.match(/\bdue::\s*(\d{4}-\d{2}-\d{2})/);
    acc.push({ text, completed: m[1].toLowerCase() === 'x' ? 1 : 0, due: dueM ? dueM[1] : null });
    return acc;
  }, []);
}

function normalizeDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  try {
    const d = new Date(s);
    if (!isNaN(d)) return d.toISOString().split('T')[0];
  } catch {}
  return null;
}

function walkMd(dir, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMd(full, results);
    else if (entry.name.endsWith('.md')) results.push(full);
  }
  return results;
}

// -- Prepared statements --
const stmtUpsertFile = db.prepare(`
  INSERT OR REPLACE INTO files (path, title, created, modified, tags, frontmatter)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtDeleteTasks = db.prepare(`DELETE FROM tasks WHERE file_path = ?`);
const stmtInsertTask  = db.prepare(`INSERT INTO tasks (file_path, text, completed, due) VALUES (?, ?, ?, ?)`);
const stmtDeleteFile  = db.prepare(`DELETE FROM files WHERE path = ?`);

const doIndex = db.transaction((rel, fm, tags, tasks, title, created, modified) => {
  stmtUpsertFile.run(rel, title, created, modified, JSON.stringify(tags), JSON.stringify(fm));
  stmtDeleteTasks.run(rel);
  for (const t of tasks) stmtInsertTask.run(rel, t.text, t.completed, t.due);
});

// -- Public API --

// Returns { rel, frontmatter, body } so callers (e.g. the watcher) can reuse
// the already-parsed file instead of reading it again. Returns null on failure.
function indexFile(filePath) {
  try {
    const rel = path.relative(VAULT_PATH, filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter: fm, body } = parseFrontmatter(content);
    const stat = fs.statSync(filePath);
    doIndex(
      rel,
      fm,
      extractTags(fm, body),
      extractTasks(body),
      fm.title || path.basename(rel, '.md'),
      normalizeDate(fm.created),
      normalizeDate(fm.modified) || normalizeDate(stat.mtime)
    );
    return { rel, frontmatter: fm, body };
  } catch (err) {
    console.error(`[indexer] Failed to index ${filePath}: ${err.message}`);
    return null;
  }
}

const stmtGetFrontmatter = db.prepare(`SELECT frontmatter FROM files WHERE path = ?`);

function removeFile(filePath) {
  stmtDeleteFile.run(path.relative(VAULT_PATH, filePath));
}

// Last-known frontmatter from the index (the file is already gone on unlink).
function lastKnownFrontmatter(rel) {
  try {
    const row = stmtGetFrontmatter.get(rel);
    return row ? JSON.parse(row.frontmatter) : {};
  } catch {
    return {};
  }
}

function fullReindex() {
  console.log('[indexer] Full reindex starting…');
  const files = walkMd(VAULT_PATH);
  db.transaction(() => files.forEach(indexFile))();
  console.log(`[indexer] Indexed ${files.length} files`);
}

function startWatcher() {
  chokidar
    .watch(path.join(VAULT_PATH, '**/*.md'), {
      ignored: /[\/\\]\./,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    })
    .on('add', (fp) => {
      const r = indexFile(fp);
      if (r) webhooks.dispatch('add', { relPath: r.rel, frontmatter: r.frontmatter, body: r.body });
    })
    .on('change', (fp) => {
      const r = indexFile(fp);
      if (r) webhooks.dispatch('change', { relPath: r.rel, frontmatter: r.frontmatter, body: r.body });
    })
    .on('unlink', (fp) => {
      const rel = path.relative(VAULT_PATH, fp);
      const frontmatter = lastKnownFrontmatter(rel); // read before deleting from index
      removeFile(fp);
      webhooks.dispatch('unlink', { relPath: rel, frontmatter });
    });
  console.log('[indexer] Watching for changes…');
}

// Bootstrap: full reindex only if DB is empty
if (db.prepare('SELECT COUNT(*) as c FROM files').get().c === 0) {
  fullReindex();
}
startWatcher();

module.exports = { db, indexFile, removeFile };
