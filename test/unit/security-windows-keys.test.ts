import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { AuthoringEngine } from '@mode-db/core';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';

const windows = { skip: process.platform !== 'win32' };

it('offline factory-reset CLI verifies DPAPI backup, refuses a live instance and preserves configuration', windows, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-reset-cli-'));
  let registry: SecurityRegistry | undefined;
  try {
    const config = ensureModelDbLayoutAtRoot(root);
    const beforeConfig = readFileSync(config);
    const directory = join(root, 'security');
    const workspace = join(root, 'vault');
    registry = SecurityRegistry.open(directory);
    const instanceId = registry.status().instanceId;
    const key = new LocalVaultKeyProvider(directory).resolveKey('synthetic');
    key.key.fill(0);
    const payload = Buffer.from('isolated reset CLI payload');
    writeFileSync(join(workspace, 'synthetic.bin'), payload);
    const cli = (confirmation: string) => spawnSync(process.execPath, [
      fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../../packages/server/src/cli.ts', import.meta.url)),
      'security', 'factory-reset', '-c', config, '--instance', confirmation, '--target', workspace, '--yes',
    ], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
    const busy = cli(instanceId);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /SECURITY_INSTANCE_BUSY/);
    assert.deepEqual(readFileSync(join(workspace, 'synthetic.bin')), payload);
    registry.close();
    const wrong = cli('wrong-instance');
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /SECURITY_CONFIRMATION_REQUIRED/);
    const reset = cli(instanceId);
    assert.equal(reset.status, 0, reset.stderr);
    const result = JSON.parse(reset.stdout) as { reset: boolean; backup: string };
    assert.equal(result.reset, true);
    assert.equal(existsSync(workspace), false);
    assert.equal(existsSync(directory), false);
    assert.deepEqual(readFileSync(config), beforeConfig);
    const raw = readFileSync(result.backup);
    assert.equal(raw.includes(payload), false);
    const archive = JSON.parse(raw.toString());
    const protector = new WindowsSecretProtector();
    protector.ensureDirectory(join(root, 'reset-backups'));
    const backupKey = protector.unprotect(archive.key, `modeldb-reset-v1:${instanceId}`);
    try {
      const decipher = createDecipheriv('aes-256-gcm', backupKey, Buffer.from(archive.iv, 'base64'));
      decipher.setAAD(Buffer.from(`modeldb-reset-v1:${instanceId}`));
      decipher.setAuthTag(Buffer.from(archive.tag, 'base64'));
      const restored = JSON.parse(Buffer.concat([decipher.update(Buffer.from(archive.ciphertext, 'base64')), decipher.final()]).toString());
      const file = restored.content.find((entry: { root: string; relative: string }) => entry.root === 'workspace' && entry.relative === 'synthetic.bin');
      assert.deepEqual(Buffer.from(file.data, 'base64'), payload);
      assert.equal(file.hash, createHash('sha256').update(payload).digest('hex'));
    } finally { backupKey.fill(0); }
    assert.equal(existsSync(`${result.backup}.receipt`), true);
    assert.equal(existsSync(join(root, 'security-reset.pending')), false);
  } finally {
    registry?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('DPAPI protects independent per-database keys and survives a fresh provider', windows, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-dpapi-'));
  try {
    const dir = join(root, 'security');
    const provider = new LocalVaultKeyProvider(dir);
    const first = provider.resolveKey('one');
    const second = provider.resolveKey('two');
    assert.notDeepEqual(first.key, second.key);
    assert.notEqual(first.reference.databaseId, second.reference.databaseId);
    const reopened = new LocalVaultKeyProvider(dir).resolveKey('one', first.reference);
    assert.deepEqual(reopened.key, first.key);
    for (const file of readdirSync(dir)) {
      assert.equal(readFileSync(join(dir, file)).includes(Buffer.from(first.key)), false);
      assert.equal(
        readFileSync(join(dir, file)).includes(Buffer.from(first.key).toString('base64')),
        false,
      );
    }
    const protector = new WindowsSecretProtector();
    const sealed = protector.protect(Buffer.alloc(32, 42), 'correct-purpose');
    assert.throws(() => protector.unprotect(sealed, 'wrong-purpose'), {
      code: 'VAULT_PROTECTION_UNAVAILABLE',
    });
    const denied = spawnSync(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
      $ErrorActionPreference = 'Stop'
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AnonymousProbe {
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool ImpersonateAnonymousToken(IntPtr thread);
  [DllImport("advapi32.dll")] public static extern bool RevertToSelf();
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentThread();
}
'@
      if (-not [AnonymousProbe]::ImpersonateAnonymousToken([AnonymousProbe]::GetCurrentThread())) { exit 91 }
      $denied = $false
      try { [IO.File]::ReadAllBytes($env:VAULT_ACL_PROBE) | Out-Null }
      catch [UnauthorizedAccessException] { $denied = $true }
      finally { [AnonymousProbe]::RevertToSelf() | Out-Null }
      if ($denied) { exit 0 } else { exit 92 }
    `,
      ],
      {
        env: { ...process.env, VAULT_ACL_PROBE: join(dir, 'instance.key') },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    assert.equal(denied.status, 0, `Anonymous OS-token access check failed: ${denied.status}`);
    const broad = spawnSync(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
      $ErrorActionPreference = 'Stop'
      $acl = [IO.File]::GetAccessControl($env:VAULT_ACL_PROBE)
      $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', 'Allow'))
      [IO.File]::SetAccessControl($env:VAULT_ACL_PROBE, $acl)
    `,
      ],
      {
        env: { ...process.env, VAULT_ACL_PROBE: join(dir, 'instance.key') },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    assert.equal(broad.status, 0);
    assert.throws(() => new LocalVaultKeyProvider(dir).resolveKey('one', first.reference), {
      code: 'VAULT_PROTECTION_UNAVAILABLE',
    });
    const restoreAcl = spawnSync(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
      $ErrorActionPreference = 'Stop'
      $acl = [IO.File]::GetAccessControl($env:VAULT_ACL_PROBE)
      $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
      $acl.PurgeAccessRules($everyone)
      [IO.File]::SetAccessControl($env:VAULT_ACL_PROBE, $acl)
    `,
      ],
      {
        env: { ...process.env, VAULT_ACL_PROBE: join(dir, 'instance.key') },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    assert.equal(restoreAcl.status, 0);
    const keyPath = join(dir, `${first.reference.keyId}.dek`);
    const envelope = readFileSync(keyPath);
    unlinkSync(keyPath);
    assert.throws(() => new LocalVaultKeyProvider(dir).resolveKey('one', first.reference), {
      code: 'VAULT_KEY_UNAVAILABLE',
    });
    assert.equal(existsSync(keyPath), false);
    writeFileSync(keyPath, envelope);
    const masterPath = join(dir, 'instance.key');
    const original = readFileSync(masterPath);
    writeFileSync(masterPath, Buffer.from('corrupt'));
    assert.throws(() => new LocalVaultKeyProvider(dir).resolveKey('one', first.reference), {
      code: 'VAULT_KEY_UNAVAILABLE',
    });
    assert.equal(readFileSync(masterPath).toString(), 'corrupt');
    writeFileSync(masterPath, original);
    assert.deepEqual(
      new LocalVaultKeyProvider(dir).resolveKey('one', first.reference).key,
      first.key,
    );
    unlinkSync(masterPath);
    assert.throws(() => new LocalVaultKeyProvider(dir).resolveKey('one'), {
      code: 'VAULT_KEY_UNAVAILABLE',
    });
    assert.equal(existsSync(masterPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('reopens the same server database with a different network credential', windows, async () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-key-server-'));
  try {
    const engine = new AuthoringEngine({
      atlas: 'graph',
      storageRoot: root,
      keyProvider: new LocalVaultKeyProvider(join(root, 'security')),
    });
    engine.registerModel('Item', { name: 'String' });
    await engine.insert('Item', { name: 'same-data' }, { sync: true });
    await engine.close();
    const path = join(root, 'graph', 'atlas.mld');
    const before = readFileSync(path);
    for (const connectToken of ['network-one', 'network-two']) {
      const app = await buildDualTrackFastify({
        securityAudit: { retentionDays: 365, maxEvents: 10000 },
        storageRoot: root,
        port: 0,
        host: '127.0.0.1',
        designerWorkspace: 'designer',
        connectToken,
        dev: false,
        configFilePath: join(root, 'modeldb.config.json'),
      });
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/management/databases/graph/catalog',
          headers: { authorization: `Bearer ${connectToken}` },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.ok(JSON.stringify(response.json()).includes('Item'));
      } finally {
        await app.close();
      }
      assert.deepEqual(readFileSync(path), before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
