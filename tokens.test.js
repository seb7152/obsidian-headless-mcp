'use strict';

// Offline unit tests for tokens.js. Run with: node --test

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

// Point config at a throwaway file BEFORE requiring the module (path is read at load).
const TMP_CONFIG = path.join(os.tmpdir(), `tokens-test-${process.pid}.json`);
process.env.TOKENS_CONFIG_PATH = TMP_CONFIG;
process.env.API_TOKEN = 'env-root-token';

const tokens = require('./tokens');

test.after(() => {
  try { fs.unlinkSync(TMP_CONFIG); } catch {}
});

function tomorrow() {
  return new Date(Date.now() + 86400000).toISOString().slice(0, 10);
}
function yesterday() {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Path prefix matching
// ---------------------------------------------------------------------------

test('isUnder matches the prefix itself and anything below it', () => {
  assert.equal(tokens.isUnder('20_Projects/Pro', '20_Projects/Pro'), true);
  assert.equal(tokens.isUnder('20_Projects/Pro/MEN/note.md', '20_Projects/Pro'), true);
  assert.equal(tokens.isUnder('20_Projects', '20_Projects/Pro'), false);
});

test('isUnder does not match a sibling sharing a name prefix', () => {
  // The bug this guards: "10_Context/Perso" must not cover "10_Context/Perso2".
  assert.equal(tokens.isUnder('10_Context/Perso2/x.md', '10_Context/Perso'), false);
  assert.equal(tokens.isUnder('10_Context/Personal.md', '10_Context/Perso'), false);
});

test('isUnder normalises leading, trailing and duplicate slashes', () => {
  assert.equal(tokens.isUnder('/20_Projects/Pro/a.md', '20_Projects/Pro/'), true);
  assert.equal(tokens.isUnder('20_Projects//Pro/a.md', '20_Projects/Pro'), true);
  assert.equal(tokens.isUnder('./20_Projects/Pro/./a.md', '20_Projects/Pro'), true);
});

test('an empty prefix covers the whole vault', () => {
  assert.equal(tokens.isUnder('anything/at/all.md', ''), true);
});

// ---------------------------------------------------------------------------
// Path traversal
//
// The authorization check runs on the path as sent; the filesystem sees it only
// after path.join() has collapsed the dot segments. Anything that reads
// differently in those two places is a way through allow and deny alike, and
// the per-route vault-root guard does not catch it — the target stays inside
// the vault, just not where the token may go.
// ---------------------------------------------------------------------------

test('".." segments are resolved before the prefix is compared', () => {
  // Reads /vault/10_Context/Perso/x.md while starting with the allowed prefix.
  assert.equal(
    tokens.isUnder('20_Projects/Pro/../../10_Context/Perso/x.md', '20_Projects/Pro'),
    false
  );
  // And a legitimate ".." that stays inside the prefix still matches.
  assert.equal(tokens.isUnder('20_Projects/Pro/MEN/../a.md', '20_Projects/Pro'), true);
});

test('a path climbing out of the vault matches nothing', () => {
  assert.equal(tokens.normalizeRel('../../etc/passwd'), null);
  assert.equal(tokens.isUnder('../../etc/passwd', ''), false);
});

test('a backslash never stands in for a separator', () => {
  // The vault is POSIX: "\\" is an ordinary filename character, so a path
  // carrying one is refused rather than read as a folder boundary.
  assert.equal(tokens.normalizeRel('20_Projects\\Pro\\a.md'), null);
  assert.equal(tokens.isUnder('20_Projects\\Pro\\a.md', '20_Projects/Pro'), false);
});

test('traversal is refused by both authorization helpers, allow and deny alike', () => {
  const allow = { scopes: ['read'], path_allow: ['20_Projects/Pro'], path_deny: [] };
  const deny = { scopes: ['read'], path_allow: [], path_deny: ['10_Context/Perso'] };

  const escape = '20_Projects/Pro/../../10_Context/Perso/x.md';
  assert.equal(tokens.canAccessFile(allow, escape), false);
  assert.equal(tokens.canAccessPath(allow, escape), false);

  // Walking into a denied folder from elsewhere must not slip past the deny.
  const through = '20_Projects/../10_Context/Perso/x.md';
  assert.equal(tokens.canAccessFile(deny, through), false);
  assert.equal(tokens.canAccessPath(deny, through), false);

  // A token with no restrictions at all is unaffected by any of this.
  const root = { scopes: ['read'], path_allow: [], path_deny: [] };
  assert.equal(tokens.canAccessFile(root, '20_Projects/Pro/a.md'), true);
});

test('a prefix that cannot be canonicalised is refused at creation', () => {
  // Dropping it silently would mint a token wider than the one asked for.
  assert.throws(
    () => tokens.create({ name: 'bad allow', path_allow: ['../outside'] }),
    /not a vault-relative prefix/
  );
  assert.throws(
    () => tokens.create({ name: 'bad deny', path_deny: ['10_Context\\Perso'] }),
    /not a vault-relative prefix/
  );
  assert.throws(
    () => tokens.create({ name: 'empty', path_allow: ['/'] }),
    /not a vault-relative prefix/
  );
});

test('creation canonicalises the prefixes it stores', () => {
  const created = tokens.create({
    name: 'normalised',
    path_allow: ['/20_Projects/Pro/'],
    path_deny: ['./20_Projects/Pro/Interne']
  });
  assert.deepEqual(created.path_allow, ['20_Projects/Pro']);
  assert.deepEqual(created.path_deny, ['20_Projects/Pro/Interne']);
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test('a token with no restrictions reaches everything', () => {
  const auth = { scopes: ['read'], path_allow: [], path_deny: [] };
  assert.equal(tokens.isPathRestricted(auth), false);
  assert.equal(tokens.canAccessFile(auth, '10_Context/Perso/profil-perso.md'), true);
});

test('allow list confines file access to its prefixes', () => {
  const auth = { scopes: ['read'], path_allow: ['20_Projects/Pro'], path_deny: [] };
  assert.equal(tokens.canAccessFile(auth, '20_Projects/Pro/MEN/_index.md'), true);
  assert.equal(tokens.canAccessFile(auth, '20_Projects/Perso/x.md'), false);
  assert.equal(tokens.canAccessFile(auth, '10_Context/Perso/profil-perso.md'), false);
});

test('deny wins over allow', () => {
  const auth = {
    scopes: ['read'],
    path_allow: ['10_Context'],
    path_deny: ['10_Context/Perso']
  };
  assert.equal(tokens.canAccessFile(auth, '10_Context/Pro/profil-pro.md'), true);
  assert.equal(tokens.canAccessFile(auth, '10_Context/Perso/profil-perso.md'), false);
});

test('deny alone restricts without an allow list', () => {
  const auth = { scopes: ['read'], path_allow: [], path_deny: ['10_Context/Perso'] };
  assert.equal(tokens.isPathRestricted(auth), true);
  assert.equal(tokens.canAccessFile(auth, '20_Projects/Pro/a.md'), true);
  assert.equal(tokens.canAccessFile(auth, '10_Context/Perso/a.md'), false);
});

test('canAccessPath lets an ancestor directory stay browsable, canAccessFile does not', () => {
  const auth = { scopes: ['read'], path_allow: ['20_Projects/Pro'], path_deny: [] };
  // Browsing down to the allowed prefix must work…
  assert.equal(tokens.canAccessPath(auth, '20_Projects'), true);
  // …but the ancestor is not itself readable as a file.
  assert.equal(tokens.canAccessFile(auth, '20_Projects/_Template_projet.md'), false);
});

test('a denied ancestor is not browsable either', () => {
  const auth = { scopes: ['read'], path_allow: [], path_deny: ['10_Context/Perso'] };
  assert.equal(tokens.canAccessPath(auth, '10_Context/Perso'), false);
  assert.equal(tokens.canAccessPath(auth, '10_Context'), true);
});

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

test('write implies read, admin implies both', () => {
  assert.equal(tokens.hasScope({ scopes: ['write'] }, 'read'), true);
  assert.equal(tokens.hasScope({ scopes: ['read'] }, 'write'), false);
  assert.equal(tokens.hasScope({ scopes: ['admin'] }, 'read'), true);
  assert.equal(tokens.hasScope({ scopes: ['admin'] }, 'write'), true);
  assert.equal(tokens.hasScope({ scopes: ['write'] }, 'admin'), false);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('create returns the plaintext once and stores only its hash', () => {
  const created = tokens.create({ name: 'test', scopes: ['read'] });
  assert.match(created.token, /^obsv_[A-Za-z0-9_-]{43}$/);

  const stored = JSON.parse(fs.readFileSync(TMP_CONFIG, 'utf-8'));
  const record = stored.tokens.find(t => t.id === created.id);
  assert.ok(record.hash);
  assert.equal(record.token, undefined);
  assert.ok(!JSON.stringify(stored).includes(created.token));

  // And the listing never exposes it either.
  assert.equal(tokens.get(created.id).token, undefined);
});

test('a created token authenticates, carrying its scopes and paths', () => {
  const created = tokens.create({
    name: 'work laptop',
    scopes: ['read'],
    path_allow: ['20_Projects/Pro'],
    path_deny: ['20_Projects/Pro/Interne']
  });

  const auth = tokens.authenticate(created.token, '10.0.0.1');
  assert.ok(auth);
  assert.equal(auth.id, created.id);
  assert.deepEqual(auth.scopes, ['read']);
  assert.equal(tokens.canAccessFile(auth, '20_Projects/Pro/MEN/a.md'), true);
  assert.equal(tokens.canAccessFile(auth, '20_Projects/Pro/Interne/a.md'), false);
});

test('revocation takes effect immediately and keeps the audit trail', () => {
  const created = tokens.create({ name: 'to revoke', scopes: ['read'] });
  assert.ok(tokens.authenticate(created.token, '10.0.0.1'));

  const revoked = tokens.revoke(created.id);
  assert.ok(revoked.revoked_at);
  assert.equal(tokens.authenticate(created.token, '10.0.0.1'), null);

  // The record survives so last_used stays inspectable.
  assert.ok(tokens.get(created.id).last_used_at);
});

test('an expired token stops authenticating', () => {
  const created = tokens.create({ name: 'expiring', scopes: ['read'], expires_at: tomorrow() });
  assert.ok(tokens.authenticate(created.token, '10.0.0.1'));

  // Age it out on disk, then reload through a fresh require of the module.
  const stored = JSON.parse(fs.readFileSync(TMP_CONFIG, 'utf-8'));
  stored.tokens.find(t => t.id === created.id).expires_at = yesterday();
  fs.writeFileSync(TMP_CONFIG, JSON.stringify(stored));
  delete require.cache[require.resolve('./tokens')];
  const reloaded = require('./tokens');

  assert.equal(reloaded.authenticate(created.token, '10.0.0.1'), null);
});

test('the env API_TOKEN authenticates as unrestricted admin', () => {
  const auth = tokens.authenticate('env-root-token', '10.0.0.1');
  assert.ok(auth);
  assert.equal(auth.root, true);
  assert.equal(tokens.hasScope(auth, 'admin'), true);
  assert.equal(tokens.isPathRestricted(auth), false);
});

test('an unknown or empty token is rejected', () => {
  assert.equal(tokens.authenticate('obsv_nope', '10.0.0.1'), null);
  assert.equal(tokens.authenticate('', '10.0.0.1'), null);
  assert.equal(tokens.authenticate(undefined, '10.0.0.1'), null);
});

test('create rejects an unknown scope, a bad date, and a past expiry', () => {
  assert.throws(() => tokens.create({ name: 'x', scopes: ['superuser'] }), /unknown scope/);
  assert.throws(() => tokens.create({ name: 'x', expires_at: '01/01/2027' }), /YYYY-MM-DD/);
  assert.throws(() => tokens.create({ name: 'x', expires_at: yesterday() }), /in the past/);
  assert.throws(() => tokens.create({ scopes: ['read'] }), /"name" is required/);
});

test('scopes default to read when omitted', () => {
  const created = tokens.create({ name: 'defaults' });
  assert.deepEqual(created.scopes, ['read']);
});
