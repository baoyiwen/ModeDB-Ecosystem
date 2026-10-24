import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { SecurityMaintenance } from '../../packages/server/src/security/security-maintenance.js';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import {
  resumeFactoryReset,
  restoreResetArchive,
  verifyResetArchive,
} from '../../packages/server/src/security/reset-recovery.js';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { acquireFileLeaseSync } from '@mode-db/common';
import { AtlasSingleVault } from '@mode-db/core';

const protector = {
  id: 'synthetic-test-only',
  ensureDirectory(path: string) {
    mkdirSync(path, { recursive: true });
  },
  protect(bytes: Uint8Array) {
    return Buffer.from(bytes).toString('base64');
  },
  unprotect(text: string) {
    return Buffer.from(text, 'base64');
  },
};
const child = (args: string[]) =>
  spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'test/fixtures/security-reset-child.ts', ...args],
    { cwd: resolve('.'), windowsHide: true, encoding: 'utf8', timeout: 30000 },
  );
function setup(real = false) {
  const root = mkdtempSync(join(tmpdir(), 'modedb-reset-recovery-'));
  const directory = join(root, 'security'),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'synthetic.txt'), 'synthetic private data');
  const protection = real ? new WindowsSecretProtector() : protector;
  const registry = SecurityRegistry.open(directory, { protector: protection });
  const keys = new LocalVaultKeyProvider(directory, protection);
  const principal = registry.createPrincipal('synthetic');
  const token = registry.createCredential(principal.id, 'must-not-revive', []).token;
  const oldKey = keys.resolveKey('business');
  const vault = new AtlasSingleVault();
  vault.set('value', 'synthetic encrypted recovery');
  vault.saveSync(join(workspace, 'atlas.mld'), oldKey);
  oldKey.key.fill(0);
  const instanceId = registry.status().instanceId;
  const maintenance = new SecurityMaintenance(registry, keys, directory, workspace, protection);
  assert.throws(() =>
    maintenance.factoryReset({ instanceId, target: workspace, yes: true }, (at) => {
      if (at === 'marked') throw new Error('synthetic interruption');
    }),
  );
  registry.close();
  const archive = join(
    root,
    'reset-backups',
    readdirSync(join(root, 'reset-backups')).find((name) => name.endsWith('.mdreset'))!,
  );
  return {
    root,
    directory,
    workspace,
    archive,
    instanceId,
    yes: true,
    token,
    protection,
    reference: oldKey.reference,
  };
}
it('authenticates a reset archive, recovers into a new tree with empty access, and resumes only the original deletion', () => {
  const f = setup();
  try {
    const marker = readFileSync(join(f.root, 'security-reset.pending'));
    const verified = verifyResetArchive(f, protector);
    assert.equal(verified.verified, true);
    assert.ok(verified.files > 2);
    const recovered = restoreResetArchive({ ...f, output: join(f.root, 'recovered') }, protector);
    assert.equal(
      readFileSync(join(recovered.workspace, 'synthetic.txt'), 'utf8'),
      'synthetic private data',
    );
    assert.deepEqual(readFileSync(join(f.root, 'security-reset.pending')), marker);
    const registry = SecurityRegistry.open(recovered.securityDirectory, { protector });
    try {
      assert.equal(registry.status().credentials, 0);
      assert.equal(registry.status().sessions, 0);
      assert.throws(() => registry.authenticate(f.token));
      const key = new LocalVaultKeyProvider(recovered.securityDirectory, protector).resolveKey(
        'business',
        f.reference,
      );
      assert.deepEqual(key.reference, f.reference);
      const vault = new AtlasSingleVault();
      assert.equal(vault.loadSync(join(recovered.workspace, 'atlas.mld'), key), true);
      assert.equal(vault.get('value'), 'synthetic encrypted recovery');
      key.key.fill(0);
    } finally {
      registry.close();
    }
    assert.throws(() =>
      restoreResetArchive({ ...f, output: join(f.root, 'recovered') }, protector),
    );
    const result = resumeFactoryReset(f, protector);
    assert.equal(result.reset, true);
    assert.equal(existsSync(f.directory), false);
    assert.equal(existsSync(f.workspace), false);
    assert.equal(existsSync(f.archive), true);
    assert.equal(existsSync(f.archive + '.receipt'), true);
    assert.equal(existsSync(join(f.root, 'security-reset.pending')), false);
    assert.equal(
      readFileSync(join(recovered.workspace, 'synthetic.txt'), 'utf8'),
      'synthetic private data',
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
it('refuses wrong confirmation, changed/unknown files, live locks and junctions without deleting the remaining target', () => {
  const f = setup();
  try {
    const data = join(f.workspace, 'synthetic.txt');
    for (const invalid of [
      { ...f, yes: false },
      { ...f, instanceId: 'other' },
      { ...f, workspace: f.root },
    ])
      assert.throws(() => resumeFactoryReset(invalid, protector));
    writeFileSync(data, 'changed');
    assert.throws(() => resumeFactoryReset(f, protector));
    assert.equal(readFileSync(data, 'utf8'), 'changed');
    writeFileSync(data, 'synthetic private data');
    const unknown = join(f.workspace, 'unknown');
    writeFileSync(unknown, 'outside archive');
    assert.throws(() => resumeFactoryReset(f, protector));
    rmSync(unknown);
    const release = acquireFileLeaseSync(join(f.directory, 'instance-owner'));
    try {
      assert.throws(() => resumeFactoryReset(f, protector));
    } finally {
      release();
    }
    symlinkSync(f.workspace, join(f.root, 'alias'), 'junction');
    assert.throws(() => resumeFactoryReset({ ...f, workspace: join(f.root, 'alias') }, protector));
    symlinkSync(join(f.root, 'missing-target'), join(f.root, 'dangling'), 'junction');
    assert.throws(() => restoreResetArchive({ ...f, output: join(f.root, 'dangling') }, protector));
    assert.throws(() => restoreResetArchive({ ...f, output: join(f.workspace, 'new') }, protector));
    assert.equal(readFileSync(data, 'utf8'), 'synthetic private data');
    assert.equal(existsSync(join(f.root, 'security-reset.pending')), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
it('excludes case-variant archived registry names and does not create a missing archive directory', () => {
  const f = setup();
  try {
    const outer = JSON.parse(readFileSync(f.archive, 'utf8'));
    const oldKey = protector.unprotect(outer.key),
      cipher = createDecipheriv('aes-256-gcm', oldKey, Buffer.from(outer.iv, 'base64'));
    cipher.setAAD(Buffer.from(`modeldb-reset-v1:${f.instanceId}`));
    cipher.setAuthTag(Buffer.from(outer.tag, 'base64'));
    const body = JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(outer.ciphertext, 'base64')),
        cipher.final(),
      ]).toString(),
    );
    oldKey.fill(0);
    for (const entry of body.content)
      if (entry.root === 'security' && entry.relative.startsWith('registry.'))
        entry.relative = entry.relative.toUpperCase();
    const key = randomBytes(32),
      iv = randomBytes(12),
      encrypted = createCipheriv('aes-256-gcm', key, iv);
    encrypted.setAAD(Buffer.from(`modeldb-reset-v1:${f.instanceId}`));
    const bytes = Buffer.concat([encrypted.update(JSON.stringify(body)), encrypted.final()]);
    writeFileSync(
      f.archive,
      JSON.stringify({
        ...outer,
        iv: iv.toString('base64'),
        key: protector.protect(key),
        tag: encrypted.getAuthTag().toString('base64'),
        ciphertext: bytes.toString('base64'),
      }),
    );
    key.fill(0);
    const restored = restoreResetArchive({ ...f, output: join(f.root, 'upper-case') }, protector);
    const registry = SecurityRegistry.open(restored.securityDirectory, { protector });
    try {
      assert.equal(registry.status().credentials, 0);
      assert.throws(() => registry.authenticate(f.token));
    } finally {
      registry.close();
    }
    const absent = join(
      f.root,
      'absent',
      'reset-backups',
      '00000000-0000-0000-0000-000000000000.mdreset',
    );
    assert.throws(() =>
      verifyResetArchive(
        { ...f, directory: join(f.root, 'absent', 'security'), archive: absent },
        protector,
      ),
    );
    assert.equal(existsSync(join(f.root, 'absent')), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
it('rejects tampering, authenticated unsafe archive paths and changed markers, retaining every source file', () => {
  const f = setup();
  try {
    const original = readFileSync(f.archive),
      outer = JSON.parse(original.toString());
    const cipher = createDecipheriv(
      'aes-256-gcm',
      protector.unprotect(outer.key),
      Buffer.from(outer.iv, 'base64'),
    );
    cipher.setAAD(Buffer.from(`modeldb-reset-v1:${f.instanceId}`));
    cipher.setAuthTag(Buffer.from(outer.tag, 'base64'));
    const body = JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(outer.ciphertext, 'base64')),
        cipher.final(),
      ]).toString(),
    );
    const invalidPaths = ['../outside', 'C:\\outside', 'file:stream', 'CON', 'a.'];
    for (const path of invalidPaths) {
      const bad = structuredClone(body);
      bad.content[0].relative = path;
      const key = randomBytes(32),
        iv = randomBytes(12),
        encrypted = createCipheriv('aes-256-gcm', key, iv);
      encrypted.setAAD(Buffer.from(`modeldb-reset-v1:${f.instanceId}`));
      const ciphertext = Buffer.concat([encrypted.update(JSON.stringify(bad)), encrypted.final()]);
      writeFileSync(
        f.archive,
        JSON.stringify({
          ...outer,
          iv: iv.toString('base64'),
          key: protector.protect(key),
          tag: encrypted.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        }),
      );
      key.fill(0);
      assert.throws(
        () => restoreResetArchive({ ...f, output: join(f.root, 'not-created') }, protector),
        path,
      );
      assert.equal(existsSync(join(f.root, 'not-created')), false);
    }
    const tampered = Buffer.from(original);
    tampered[tampered.length - 12] ^= 1;
    writeFileSync(f.archive, tampered);
    assert.throws(() => verifyResetArchive(f, protector));
    writeFileSync(f.archive, original);
    writeFileSync(
      join(f.root, 'security-reset.pending'),
      JSON.stringify({
        version: 1,
        instanceId: f.instanceId,
        workspace: f.workspace,
        backup: 'wrong',
      }),
    );
    assert.throws(() => resumeFactoryReset(f, protector));
    assert.equal(
      readFileSync(join(f.workspace, 'synthetic.txt'), 'utf8'),
      'synthetic private data',
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
for (const point of [
  'marker.staged',
  'marker.journaled',
  'marker.replaced',
  'marked',
  'deleted',
  'removed',
  'receipt.staged',
  'receipt.journaled',
  'receipt.replaced',
  'receipted',
])
  it(`resumes reset after a real process exit at ${point}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-reset-exit-'));
    try {
      const run = child(['reset', root, point]);
      assert.equal(run.status, 47, run.stderr);
      const raw = JSON.parse(
        readFileSync(
          join(
            root,
            'security-reset.pending' +
              (point === 'marker.staged' || point === 'marker.journaled' ? '.pending' : ''),
          ),
          'utf8',
        ),
      );
      const input = {
        directory: join(root, 'security'),
        workspace: join(root, 'workspace'),
        instanceId: raw.instanceId,
        archive: raw.backup,
        yes: true,
      };
      assert.throws(() => SecurityRegistry.open(input.directory, { protector }), {
        code: 'SECURITY_MAINTENANCE_FAILED',
      });
      resumeFactoryReset(input, protector);
      assert.equal(existsSync(input.directory), false);
      assert.equal(existsSync(input.workspace), false);
      assert.equal(existsSync(raw.backup), true);
      assert.equal(existsSync(raw.backup + '.receipt'), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
it('keeps an interrupted archive restore quarantined and refuses ordinary startup', () => {
  const f = setup();
  try {
    const output = join(f.root, 'interrupted');
    assert.throws(() =>
      restoreResetArchive({ ...f, output }, protector, () => {
        throw new Error('synthetic disk full');
      }),
    );
    assert.throws(() => SecurityRegistry.open(join(output, 'security'), { protector }), {
      code: 'SECURITY_MAINTENANCE_FAILED',
    });
    assert.equal(existsSync(f.archive), true);
    assert.throws(() => restoreResetArchive({ ...f, output }, protector));
    assert.equal(
      restoreResetArchive({ ...f, output: join(f.root, 'fresh-retry') }, protector).restored,
      true,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
for (const point of ['verified', 'deleted', 'removed', 'receipted'])
  it(`resumes again after the recovery process exits at ${point}`, () => {
    const f = setup();
    try {
      const input = {
        directory: f.directory,
        workspace: f.workspace,
        archive: f.archive,
        instanceId: f.instanceId,
        yes: true,
      };
      const run = child(['resume', f.root, JSON.stringify(input), point]);
      assert.equal(run.status, 48, run.stderr);
      assert.throws(() => SecurityRegistry.open(f.directory, { protector }), {
        code: 'SECURITY_MAINTENANCE_FAILED',
      });
      assert.equal(resumeFactoryReset(f, protector).reset, true);
      assert.equal(existsSync(f.workspace), false);
      assert.equal(existsSync(f.directory), false);
      assert.equal(existsSync(f.archive), true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
it(
  'verifies real Windows DPAPI and CLI archive recovery with no old credential resurrection',
  { skip: process.platform !== 'win32', timeout: 120000 },
  () => {
    const f = setup(true);
    try {
      const config = join(f.root, 'modeldb.config.json');
      writeFileSync(
        config,
        JSON.stringify({
          security: { version: 1 },
          workspace: f.workspace,
          logDir: join(f.root, 'logs'),
          host: '127.0.0.1',
          port: 0,
        }),
      );
      const cli = (action: string, ...extra: string[]) =>
        spawnSync(
          process.execPath,
          [
            'node_modules/tsx/dist/cli.mjs',
            'packages/server/src/cli.ts',
            'security',
            action,
            '-c',
            config,
            '--package',
            f.archive,
            '--instance',
            f.instanceId,
            '--target',
            f.workspace,
            ...extra,
          ],
          { cwd: resolve('.'), windowsHide: true, encoding: 'utf8', timeout: 60000 },
        );
      const verified = cli('factory-reset-verify');
      assert.equal(verified.status, 0, verified.stderr);
      assert.equal(JSON.parse(verified.stdout).verified, true);
      assert.equal(cli('factory-reset-resume').status, 1);
      const restored = cli(
        'factory-reset-restore',
        '--output',
        join(f.root, 'real-restored'),
        '--yes',
      );
      assert.equal(restored.status, 0, restored.stderr);
      const recovered = JSON.parse(restored.stdout);
      const registry = SecurityRegistry.open(recovered.securityDirectory);
      try {
        assert.equal(registry.status().credentials, 0);
        assert.throws(() => registry.authenticate(f.token));
        const key = new LocalVaultKeyProvider(recovered.securityDirectory).resolveKey(
          'business',
          f.reference,
        );
        const vault = new AtlasSingleVault();
        assert.equal(vault.loadSync(join(recovered.workspace, 'atlas.mld'), key), true);
        assert.equal(vault.get('value'), 'synthetic encrypted recovery');
        key.key.fill(0);
      } finally {
        registry.close();
      }
      const resumed = cli('factory-reset-resume', '--yes');
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).reset, true);
      assert.equal(existsSync(f.workspace), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
