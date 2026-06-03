'use strict';

// Webhook configuration + matching + delivery for vault file changes.
//
// This module is required BY vault-indexer.js (the chokidar watcher calls
// dispatch()). It must therefore NOT require('./vault-indexer') to avoid a
// require cycle. It is also required by obsidian-api.js to expose CRUD endpoints.
//
// Concurrency note: all config mutations below are fully synchronous. Node's
// JS execution is single-threaded, so a read-modify-write that contains no
// `await` cannot interleave with another request — this is what serializes
// concurrent POST/PATCH/DELETE without an explicit lock. The on-disk write is
// atomic (temp file + rename).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');

const CONFIG_PATH = process.env.WEBHOOKS_CONFIG_PATH || '/data/webhooks.json';
const ALLOW_PRIVATE = String(process.env.WEBHOOK_ALLOW_PRIVATE || '').toLowerCase() === 'true';

// Delivery tuning (overridable via env, sensible defaults).
const DELIVERY_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 10000);
const MAX_RETRIES = Number(process.env.WEBHOOK_MAX_RETRIES || 3);
const MAX_CONCURRENCY = Number(process.env.WEBHOOK_CONCURRENCY || 5);

const VALID_EVENTS = ['add', 'change', 'unlink'];

class ValidationError extends Error {}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

let config = { version: 1, webhooks: [] };

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.webhooks)) {
      config = { version: parsed.version || 1, webhooks: parsed.webhooks };
    } else {
      config = { version: 1, webhooks: [] };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[webhooks] Could not load config (${CONFIG_PATH}): ${err.message}. Starting with an empty config.`);
    }
    config = { version: 1, webhooks: [] };
  }
  return config;
}

function persist() {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.webhooks.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, CONFIG_PATH); // atomic replace
}

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

// True when `ip` (a literal v4/v6 address) is in a range we must never let a
// webhook reach unless WEBHOOK_ALLOW_PRIVATE is set.
function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0) return true;                                  // 0.0.0.0/8 "this network"
    if (p[0] === 10) return true;                                 // private
    if (p[0] === 127) return true;                                // loopback
    if (p[0] === 169 && p[1] === 254) return true;                // link-local + cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;    // private
    if (p[0] === 192 && p[1] === 168) return true;                // private
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;   // CGNAT 100.64/10
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;           // loopback / unspecified
    if (lower.startsWith('fe80')) return true;                   // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // IPv4-mapped
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

// Syntactic checks only (no DNS). Throws ValidationError on rejection.
function validateUrlSyntax(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new ValidationError('Invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new ValidationError('URL scheme must be http or https');
  }
  if (u.protocol === 'http:' && !ALLOW_PRIVATE) {
    throw new ValidationError('Plain http:// is not allowed (set WEBHOOK_ALLOW_PRIVATE=true to permit http/private targets)');
  }
  const host = u.hostname.toLowerCase();
  if (!ALLOW_PRIVATE && (host === 'localhost' || host.endsWith('.localhost'))) {
    throw new ValidationError('Target host is not allowed');
  }
  return u;
}

// Resolves the hostname and rejects private targets. Run at create/patch time
// AND again right before each delivery to limit DNS-rebinding. Throws ValidationError.
async function assertResolvedAllowed(u) {
  if (ALLOW_PRIVATE) return;
  const host = u.hostname;
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new ValidationError('Target IP is not allowed');
    return;
  }
  let addrs;
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new ValidationError(`Could not resolve host: ${host}`);
  }
  if (!addrs.length) throw new ValidationError(`Host did not resolve: ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new ValidationError('Target host resolves to a private/internal address');
  }
}

async function assertUrlAllowed(rawUrl) {
  const u = validateUrlSyntax(rawUrl);
  await assertResolvedAllowed(u);
  return u;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// Minimal, dependency-free glob -> RegExp supporting ** (any depth, incl. '/'),
// * (within a path segment) and ? (single non-slash char).
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // swallow the slash after ** so "a/**/b" matches "a/b"
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

// `folder` is treated as a directory specifier: it matches every file beneath
// it. Wildcards are allowed in segments (e.g. "20_Projects/*/notes"). Empty /
// null matches the whole vault.
function compileMatcher(folder) {
  if (!folder || !String(folder).trim()) return () => true;
  let pattern = String(folder).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!pattern) return () => true;
  if (!pattern.includes('**')) pattern = `${pattern}/**`;
  const re = globToRegExp(pattern);
  return (rel) => re.test(String(rel).replace(/\\/g, '/'));
}

function valueMatches(actual, expected) {
  if (Array.isArray(actual)) return actual.some(a => String(a) === String(expected));
  return String(actual) === String(expected);
}

// Subset match: every key in `filter` must be present and equal in `fm`.
function matchesFrontmatter(filter, fm) {
  if (!filter || typeof filter !== 'object') return true;
  fm = fm || {};
  for (const [k, v] of Object.entries(filter)) {
    if (!valueMatches(fm[k], v)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function publicView(wh) {
  const { secret, ...rest } = wh;
  return { ...rest, has_secret: !!secret };
}

function list() {
  return config.webhooks.map(publicView);
}

function get(id) {
  const wh = config.webhooks.find(w => w.id === id);
  return wh ? publicView(wh) : null;
}

function getRaw(id) {
  return config.webhooks.find(w => w.id === id) || null;
}

// Build (and validate) a stored webhook record from user input. When `existing`
// is provided this is a PATCH: only supplied fields are changed.
async function normalizeInput(input, existing) {
  input = input || {};
  const out = existing
    ? { ...existing }
    : { id: `wh_${crypto.randomUUID()}`, enabled: true, created: new Date().toISOString() };

  if (input.url !== undefined || !existing) {
    const url = input.url !== undefined ? input.url : existing && existing.url;
    if (!url || typeof url !== 'string') throw new ValidationError('"url" is required');
    await assertUrlAllowed(url);
    out.url = url;
  }

  if (input.name !== undefined) {
    if (input.name == null) delete out.name;
    else out.name = String(input.name);
  }

  if (input.enabled !== undefined) out.enabled = !!input.enabled;

  if (input.folder !== undefined) {
    if (input.folder !== null && typeof input.folder !== 'string') {
      throw new ValidationError('"folder" must be a string or null');
    }
    out.folder = input.folder || null;
  } else if (!existing) {
    out.folder = null;
  }

  if (input.frontmatter !== undefined) {
    if (input.frontmatter !== null && (typeof input.frontmatter !== 'object' || Array.isArray(input.frontmatter))) {
      throw new ValidationError('"frontmatter" must be an object or null');
    }
    out.frontmatter = input.frontmatter || null;
  } else if (!existing) {
    out.frontmatter = null;
  }

  if (input.events !== undefined) {
    if (!Array.isArray(input.events) || !input.events.every(e => VALID_EVENTS.includes(e))) {
      throw new ValidationError(`"events" must be an array, subset of: ${VALID_EVENTS.join(', ')}`);
    }
    out.events = input.events.length ? [...new Set(input.events)] : [...VALID_EVENTS];
  } else if (!existing) {
    out.events = [...VALID_EVENTS];
  }

  if (input.secret !== undefined) {
    if (input.secret) out.secret = String(input.secret);
    else delete out.secret;
  }

  if (input.include_body !== undefined) out.include_body = !!input.include_body;
  else if (!existing) out.include_body = false;

  out.updated = new Date().toISOString();
  return out;
}

async function create(input) {
  const wh = await normalizeInput(input, null);
  config.webhooks.push(wh);
  persist();
  return publicView(wh);
}

async function update(id, patch) {
  const idx = config.webhooks.findIndex(w => w.id === id);
  if (idx === -1) return null;
  const merged = await normalizeInput(patch, config.webhooks[idx]);
  config.webhooks[idx] = merged;
  persist();
  return publicView(merged);
}

function remove(id) {
  const idx = config.webhooks.findIndex(w => w.id === id);
  if (idx === -1) return false;
  config.webhooks.splice(idx, 1);
  persist();
  return true;
}

// ---------------------------------------------------------------------------
// Delivery (bounded-concurrency queue + retry)
// ---------------------------------------------------------------------------

let active = 0;
const queue = [];

function enqueue(job) {
  queue.push(job);
  pump();
}

function pump() {
  while (active < MAX_CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    Promise.resolve()
      .then(job)
      .catch(() => {})
      .finally(() => { active--; pump(); });
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return 'invalid-url';
  }
}

async function deliver(wh, payload) {
  const bodyStr = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'obsidian-headless-webhook/1',
    'X-Obsidian-Event': payload.event
  };
  if (wh.secret) {
    const sig = crypto.createHmac('sha256', wh.secret).update(bodyStr).digest('hex');
    headers['X-Obsidian-Signature'] = `sha256=${sig}`;
  }

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await assertUrlAllowed(wh.url); // re-check at request time (anti DNS-rebinding)
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(wh.url, {
          method: 'POST',
          headers,
          body: bodyStr,
          signal: ctrl.signal,
          redirect: 'error' // never follow redirects (would bypass the SSRF check)
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) return { ok: true, status: res.status, attempts: attempt };
      lastErr = new Error(`HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) {
        console.error(`[webhooks] ${wh.id} -> ${safeHost(wh.url)} failed: HTTP ${res.status} (no retry)`);
        return { ok: false, status: res.status, attempts: attempt };
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < MAX_RETRIES) await sleep(1000 * 2 ** (attempt - 1));
  }
  console.error(`[webhooks] ${wh.id} -> ${safeHost(wh.url)} failed after ${MAX_RETRIES} attempts: ${lastErr && lastErr.message}`);
  return { ok: false, error: lastErr ? lastErr.message : 'delivery failed', attempts: MAX_RETRIES };
}

// Called by the watcher. Non-blocking: enqueues matching deliveries and returns.
function dispatch(event, { relPath, frontmatter, body } = {}) {
  if (event !== 'test' && !VALID_EVENTS.includes(event)) return;
  const rel = String(relPath || '').replace(/\\/g, '/');
  for (const wh of config.webhooks) {
    if (wh.enabled === false) continue;
    if (!(wh.events || VALID_EVENTS).includes(event)) continue;
    if (!compileMatcher(wh.folder)(rel)) continue;
    if (!matchesFrontmatter(wh.frontmatter, frontmatter)) continue;

    const payload = {
      event,
      path: rel,
      frontmatter: frontmatter || {},
      timestamp: new Date().toISOString(),
      webhook_id: wh.id
    };
    if (wh.include_body && body !== undefined) payload.body = body;
    enqueue(() => deliver(wh, payload));
  }
}

// Awaited test delivery used by POST /api/webhooks/:id/test. Returns null if
// the webhook does not exist, otherwise the delivery result.
async function testDeliver(id) {
  const wh = getRaw(id);
  if (!wh) return null;
  return deliver(wh, {
    event: 'test',
    path: '(test)',
    frontmatter: {},
    timestamp: new Date().toISOString(),
    webhook_id: wh.id
  });
}

loadConfig();

module.exports = {
  loadConfig,
  list,
  get,
  getRaw,
  create,
  update,
  remove,
  dispatch,
  testDeliver,
  assertUrlAllowed,
  ValidationError,
  // exposed for unit tests
  _internal: { compileMatcher, matchesFrontmatter, isPrivateIp, validateUrlSyntax, globToRegExp }
};
