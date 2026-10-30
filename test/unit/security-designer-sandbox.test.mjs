import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { loadSandboxCandidate, serveSandboxDesigner } from '../../scripts/security-designer-sandbox.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function candidate() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Release-'));
  const bytes = Buffer.from('synthetic candidate');
  const packages = ['common', 'core', 'data-kit', 'data-ui', 'sdk', 'server', 'shared'].map(name => {
    const installed = join(root, 'consumer/node_modules/@mode-db', name);
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'index.js'), bytes);
    writeFileSync(join(root, name + '.tgz'), bytes);
    return { name: '@mode-db/' + name, archive: name + '.tgz', sha256: sha(bytes), files: [{ path: 'index.js', sha256: sha(bytes) }] };
  });
  const appRoot = join(root, 'apps/model-designer');
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, 'index.html'), bytes);
  const manifest = join(root, 'release-candidate.json');
  writeFileSync(manifest, JSON.stringify({ format: 'modeldb.security-release-candidate.v1', packages, apps: [{ name: 'model-designer', files: [{ path: 'index.html', sha256: sha(bytes) }] }] }));
  return { root, manifest };
}

it('requires a temporary candidate and refuses modified installed package bytes', () => {
  const item = candidate();
  assert.equal(loadSandboxCandidate(item.manifest).pages.size, 1);
  writeFileSync(join(item.root, 'consumer/node_modules/@mode-db/server/index.js'), 'modified');
  assert.throws(() => loadSandboxCandidate(item.manifest));
});

it('refuses manifest traversal before opening any outside file', () => {
  const item = candidate();
  const manifest = { format: 'modeldb.security-release-candidate.v1', packages: ['common', 'core', 'data-kit', 'data-ui', 'sdk', 'server', 'shared'].map(name => ({ name: '@mode-db/' + name, archive: '../outside', sha256: '' })) };
  writeFileSync(item.manifest, JSON.stringify(manifest));
  assert.throws(() => loadSandboxCandidate(item.manifest), /SANDBOX_CANDIDATE_PATH_REJECTED/);
});

it('serves only verified in-memory pages on loopback and rejects configuration requests', async () => {
  const page = Buffer.from('<!doctype html><title>Synthetic</title>');
  const served = await serveSandboxDesigner(new Map([['/index.html', page]]));
  try {
    assert.ok(served.origin.startsWith('http://127.0.0.1:'));
    assert.equal(await (await fetch(served.origin)).text(), page.toString());
    assert.equal((await fetch(served.origin + '/modeldb.config.json')).status, 404);
    assert.equal((await fetch(served.origin + '/security/instance.key')).status, 404);
    assert.equal((await fetch(served.origin, { method: 'POST', body: 'synthetic' })).status, 405);
    assert.equal((await fetch(served.origin, { method: 'HEAD' })).headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await new Promise(done => served.server.close(done));
  }
});
