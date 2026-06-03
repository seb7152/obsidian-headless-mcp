'use strict';

// Offline unit tests for webhooks.js. Run with: node --test
// No network is used: SSRF checks here exercise literal IPs and syntax only.

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

// Point config at a throwaway file BEFORE requiring the module (path is read at load).
const TMP_CONFIG = path.join(os.tmpdir(), `webhooks-test-${process.pid}.json`);
process.env.WEBHOOKS_CONFIG_PATH = TMP_CONFIG;
// Keep default strict SSRF (WEBHOOK_ALLOW_PRIVATE unset == false).

const webhooks = require('./webhooks');
const { compileMatcher, matchesFrontmatter, isPrivateIp, validateUrlSyntax } = webhooks._internal;

test.after(() => {
  try { fs.unlinkSync(TMP_CONFIG); } catch {}
});

// ---------------------------------------------------------------------------
// Folder glob matching
// ---------------------------------------------------------------------------

test('folder matcher: empty/null matches the whole vault', () => {
  const m = compileMatcher(null);
  assert.equal(m('anything/here.md'), true);
  assert.equal(m('root.md'), true);
});

test('folder matcher: plain folder matches everything beneath it', () => {
  const m = compileMatcher('20_Projects');
  assert.equal(m('20_Projects/a.md'), true);
  assert.equal(m('20_Projects/sub/deep/b.md'), true);
  assert.equal(m('10_Areas/a.md'), false);
});

test('folder matcher: wildcard segment (xxx/*/yyy) matches files within', () => {
  const m = compileMatcher('20_Projects/*/notes');
  assert.equal(m('20_Projects/alpha/notes/idea.md'), true);
  assert.equal(m('20_Projects/beta/notes/sub/idea.md'), true);
  assert.equal(m('20_Projects/alpha/tasks/idea.md'), false);
  // single * does not cross a slash
  assert.equal(m('20_Projects/alpha/extra/notes/idea.md'), false);
});

test('folder matcher: leading/trailing slashes and backslashes are normalized', () => {
  const m = compileMatcher('/Inbox/');
  assert.equal(m('Inbox/note.md'), true);
  assert.equal(m('Inbox\\sub\\note.md'), true);
});

// ---------------------------------------------------------------------------
// Frontmatter subset matching
// ---------------------------------------------------------------------------

test('frontmatter matcher: null filter matches anything', () => {
  assert.equal(matchesFrontmatter(null, { type: 'note' }), true);
});

test('frontmatter matcher: subset equality', () => {
  assert.equal(matchesFrontmatter({ type: 'action' }, { type: 'action', status: 'todo' }), true);
  assert.equal(matchesFrontmatter({ type: 'action' }, { type: 'note' }), false);
  assert.equal(matchesFrontmatter({ type: 'action' }, {}), false);
});

test('frontmatter matcher: array fields match if value is contained', () => {
  assert.equal(matchesFrontmatter({ tags: 'work' }, { tags: ['home', 'work'] }), true);
  assert.equal(matchesFrontmatter({ tags: 'gym' }, { tags: ['home', 'work'] }), false);
});

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

test('isPrivateIp: blocks loopback / private / link-local / metadata', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test('isPrivateIp: allows public addresses', () => {
  for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test('validateUrlSyntax: rejects non-http schemes, http, and localhost (strict mode)', () => {
  assert.throws(() => validateUrlSyntax('ftp://example.com'), webhooks.ValidationError);
  assert.throws(() => validateUrlSyntax('file:///etc/passwd'), webhooks.ValidationError);
  assert.throws(() => validateUrlSyntax('http://example.com/hook'), webhooks.ValidationError); // http blocked by default
  assert.throws(() => validateUrlSyntax('https://localhost/hook'), webhooks.ValidationError);
  assert.throws(() => validateUrlSyntax('not a url'), webhooks.ValidationError);
});

test('validateUrlSyntax: accepts public https', () => {
  assert.doesNotThrow(() => validateUrlSyntax('https://hooks.example.com/abc'));
});

test('assertUrlAllowed: rejects literal private IP, accepts literal public IP (no DNS)', async () => {
  await assert.rejects(() => webhooks.assertUrlAllowed('https://169.254.169.254/latest/meta-data'), webhooks.ValidationError);
  await assert.rejects(() => webhooks.assertUrlAllowed('https://10.0.0.5/hook'), webhooks.ValidationError);
  await assert.doesNotReject(() => webhooks.assertUrlAllowed('https://93.184.216.34/hook'));
});

// ---------------------------------------------------------------------------
// Config CRUD + atomic persistence
// ---------------------------------------------------------------------------

test('CRUD: create / get / update / remove round-trip with on-disk persistence', async () => {
  // literal public IP avoids any DNS lookup
  const created = await webhooks.create({ url: 'https://93.184.216.34/hook', folder: '20_Projects', frontmatter: { type: 'action' }, secret: 's3cr3t' });
  assert.match(created.id, /^wh_/);
  assert.equal(created.has_secret, true);
  assert.equal(created.secret, undefined, 'secret must never be returned');
  assert.deepEqual(created.events, ['add', 'change', 'unlink']);

  // persisted to disk
  const onDisk = JSON.parse(fs.readFileSync(TMP_CONFIG, 'utf-8'));
  assert.equal(onDisk.webhooks.length, 1);
  assert.equal(onDisk.webhooks[0].secret, 's3cr3t', 'secret is stored on disk');

  const fetched = webhooks.get(created.id);
  assert.equal(fetched.url, 'https://93.184.216.34/hook');

  const updated = await webhooks.update(created.id, { enabled: false, events: ['change'] });
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.events, ['change']);

  assert.equal(webhooks.remove(created.id), true);
  assert.equal(webhooks.get(created.id), null);
  assert.equal(webhooks.remove('nope'), false);
});

test('create: rejects missing url and private targets', async () => {
  await assert.rejects(() => webhooks.create({}), webhooks.ValidationError);
  await assert.rejects(() => webhooks.create({ url: 'https://127.0.0.1/x' }), webhooks.ValidationError);
});

test('loadConfig: corrupt JSON falls back to empty without throwing', () => {
  fs.writeFileSync(TMP_CONFIG, '{ this is not json');
  assert.doesNotThrow(() => webhooks.loadConfig());
  assert.deepEqual(webhooks.list(), []);
});
