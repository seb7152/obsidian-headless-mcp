// API token store: multiple named, scoped, revocable tokens.
//
// Replaces the single shared API_TOKEN as the only credential. That token still
// works and keeps full admin access (the MCP server and existing automations
// depend on it), but every additional caller can now get its own token, with
// its own scopes, path restrictions and expiry — revocable one at a time.
//
// Only the SHA-256 of each token is persisted, so a leak of the config file
// yields nothing usable. Storage mirrors webhooks.js: a JSON file under /data
// (outside the synced vault), written atomically (temp file + rename).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = process.env.TOKENS_CONFIG_PATH || '/data/tokens.json';

const TOKEN_PREFIX = 'obsv_';
const SCOPES = ['read', 'write', 'admin'];

// ---------------------------------------------------------------- persistence

let config = { tokens: [] };

function load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    config = { tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [] };
  } catch {
    config = { tokens: [] }; // missing or unreadable → start empty
  }
}

function save() {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, CONFIG_PATH); // atomic replace
}

load();

// --------------------------------------------------------------------- helpers

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

// Constant-time string compare. Hashes are fixed-length hex, so length never
// differs in practice, but guard anyway rather than let timingSafeEqual throw.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Normalise a vault-relative path for prefix comparison:
// backslashes → "/", no leading "./" or "/", no trailing "/".
function normalizeRel(p) {
  return String(p == null ? '' : p)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

// True when `rel` is `prefix` itself or lives underneath it. Compared segment
// by segment so that "10_Context/Perso" never matches "10_Context/Perso2".
function isUnder(rel, prefix) {
  const r = normalizeRel(rel);
  const p = normalizeRel(prefix);
  if (p === '') return true; // empty prefix = whole vault
  return r === p || r.startsWith(p + '/');
}

// --------------------------------------------------------------------- records

// The env token: full access, never persisted, cannot be revoked through the
// API. Rotating it means changing the environment and restarting.
function rootAuth() {
  return {
    id: 'root',
    name: 'API_TOKEN (environment)',
    scopes: ['read', 'write', 'admin'],
    path_allow: [],
    path_deny: [],
    root: true
  };
}

function publicView(t) {
  return {
    id: t.id,
    name: t.name,
    scopes: t.scopes,
    path_allow: t.path_allow,
    path_deny: t.path_deny,
    expires_at: t.expires_at || null,
    created_at: t.created_at,
    last_used_at: t.last_used_at || null,
    last_used_ip: t.last_used_ip || null,
    revoked_at: t.revoked_at || null,
    expired: isExpired(t)
  };
}

function isExpired(t) {
  return Boolean(t.expires_at) && t.expires_at < today();
}

// ------------------------------------------------------------------- lifecycle

function create({ name, scopes, path_allow, path_deny, expires_at }) {
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('"name" is required'), { status: 400 });
  }

  const wanted = Array.isArray(scopes) && scopes.length ? scopes : ['read'];
  for (const s of wanted) {
    if (!SCOPES.includes(s)) {
      throw Object.assign(new Error(`unknown scope "${s}" (allowed: ${SCOPES.join(', ')})`), { status: 400 });
    }
  }

  for (const [field, val] of [['path_allow', path_allow], ['path_deny', path_deny]]) {
    if (val !== undefined && !Array.isArray(val)) {
      throw Object.assign(new Error(`"${field}" must be an array of vault-relative prefixes`), { status: 400 });
    }
  }

  if (expires_at !== undefined && expires_at !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires_at)) {
      throw Object.assign(new Error('"expires_at" must be YYYY-MM-DD'), { status: 400 });
    }
    if (expires_at < today()) {
      throw Object.assign(new Error('"expires_at" is in the past'), { status: 400 });
    }
  }

  const secret = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const record = {
    id: 'tok_' + crypto.randomBytes(6).toString('hex'),
    name,
    hash: sha256(secret),
    scopes: wanted,
    path_allow: (path_allow || []).map(normalizeRel).filter(Boolean),
    path_deny: (path_deny || []).map(normalizeRel).filter(Boolean),
    expires_at: expires_at || null,
    created_at: today(),
    last_used_at: null,
    last_used_ip: null,
    revoked_at: null
  };

  config.tokens.push(record);
  save();

  // The plaintext is returned here and never again — it is not stored.
  return { token: secret, ...publicView(record) };
}

function list() {
  return config.tokens.map(publicView);
}

function get(id) {
  const t = config.tokens.find(t => t.id === id);
  return t ? publicView(t) : null;
}

// Revoking keeps the record so the audit trail (created, last used) survives.
function revoke(id) {
  const t = config.tokens.find(t => t.id === id);
  if (!t) return null;
  if (!t.revoked_at) {
    t.revoked_at = new Date().toISOString();
    save();
  }
  return publicView(t);
}

// --------------------------------------------------------------------- lookup

// Resolve a presented bearer token to its auth record, or null.
// Records the use (date + IP) so a leaked token shows up in the listing.
function authenticate(presented, ip) {
  if (!presented) return null;

  const envToken = process.env.API_TOKEN || 'change-me-in-production';
  if (safeEqual(presented, envToken)) return rootAuth();

  const hash = sha256(presented);
  const match = config.tokens.find(t => safeEqual(t.hash, hash));
  if (!match) return null;
  if (match.revoked_at) return null;
  if (isExpired(match)) return null;

  const stamp = new Date().toISOString();
  // Persist at most once a minute per token: this runs on every request.
  if (!match.last_used_at || stamp.slice(0, 16) !== match.last_used_at.slice(0, 16)) {
    match.last_used_at = stamp;
    match.last_used_ip = ip || null;
    save();
  }

  return {
    id: match.id,
    name: match.name,
    scopes: match.scopes,
    path_allow: match.path_allow,
    path_deny: match.path_deny,
    root: false
  };
}

// ------------------------------------------------------------------ authorization

function hasScope(auth, scope) {
  if (!auth) return false;
  if (auth.scopes.includes('admin')) return true; // admin implies read + write
  if (scope === 'read') return auth.scopes.includes('read') || auth.scopes.includes('write');
  return auth.scopes.includes(scope);
}

// A token is "path-restricted" when it carries any allow or deny prefix.
function isPathRestricted(auth) {
  if (!auth) return true;
  return (auth.path_allow && auth.path_allow.length > 0) ||
         (auth.path_deny && auth.path_deny.length > 0);
}

// Deny wins over allow. An empty allow list means "the whole vault".
function canAccessPath(auth, relPath) {
  if (!auth) return false;
  const rel = normalizeRel(relPath);

  for (const denied of auth.path_deny || []) {
    if (isUnder(rel, denied)) return false;
  }

  const allow = auth.path_allow || [];
  if (allow.length === 0) return true;

  // A directory listing of an ancestor of an allowed prefix is permitted, so
  // that a token scoped to "20_Projects/Pro" can still browse from the root
  // down to it. Individual entries are filtered separately.
  return allow.some(a => isUnder(rel, a) || isUnder(a, rel));
}

// Stricter variant for reads and writes of an actual file: the path must sit
// inside an allowed prefix, not merely be one of its ancestors.
function canAccessFile(auth, relPath) {
  if (!auth) return false;
  const rel = normalizeRel(relPath);

  for (const denied of auth.path_deny || []) {
    if (isUnder(rel, denied)) return false;
  }

  const allow = auth.path_allow || [];
  if (allow.length === 0) return true;
  return allow.some(a => isUnder(rel, a));
}

module.exports = {
  create,
  list,
  get,
  revoke,
  authenticate,
  hasScope,
  isPathRestricted,
  canAccessPath,
  canAccessFile,
  normalizeRel,
  isUnder,
  SCOPES,
  CONFIG_PATH
};
