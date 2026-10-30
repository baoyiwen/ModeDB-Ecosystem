import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { assertNoSecurityMaterial } from '../../scripts/assert-no-security-material.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Git-Guard-'));
  execFileSync('git', ['init', '-q', root], { windowsHide: true });
  writeFileSync(join(root, '.gitignore'), '/security/\n');
  mkdirSync(join(root, 'security'));
  writeFileSync(join(root, 'security', 'synthetic.key'), 'synthetic-not-a-secret');
  return root;
}

it('accepts an ignored synthetic runtime file without reading or tracking it', () => {
  const root = fixture();
  assert.deepEqual(assertNoSecurityMaterial(root), { ok: true, trackedRuntimeEntries: 0, materialRead: false });
});

it('rejects force-added runtime material despite a Git ignore rule', () => {
  const root = fixture();
  execFileSync('git', ['add', '-f', '--', 'security/synthetic.key'], { cwd: root, windowsHide: true });
  assert.throws(() => assertNoSecurityMaterial(root), /SECURITY_RUNTIME_MATERIAL_TRACKED: 1/);
});

it('accepts an index-only removal while preserving the synthetic working file', () => {
  const root = fixture();
  execFileSync('git', ['add', '-f', '--', 'security/synthetic.key'], { cwd: root, windowsHide: true });
  execFileSync('git', ['update-index', '--force-remove', '-z', '--stdin'], { cwd: root, windowsHide: true, input: 'security/synthetic.key\0' });
  assert.equal(assertNoSecurityMaterial(root).ok, true);
  assert.equal(readFileSync(join(root, 'security', 'synthetic.key'), 'utf8'), 'synthetic-not-a-secret');
});

it('fails closed when the Git index is unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Git-Guard-'));
  assert.throws(() => assertNoSecurityMaterial(root), /SECURITY_GIT_INDEX_UNAVAILABLE/);
});

it('rejects case variants in the Git index on every host filesystem', () => {
  const root = fixture();
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'synthetic-not-a-secret', encoding: 'utf8', windowsHide: true }).trim();
  execFileSync('git', ['update-index', '--add', '--cacheinfo', '100644,' + blob + ',SeCuRiTy/synthetic.key'], { cwd: root, windowsHide: true });
  assert.throws(() => assertNoSecurityMaterial(root), /SECURITY_RUNTIME_MATERIAL_TRACKED: 1/);
});
