import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import {
  AtlasSingleVault,
  AuthoringEngine,
  readAtlasVaultKeyReference,
  ModelDBClient,
} from '@mode-db/core';
import {
  configureModelDBStorageRoot,
  PathResolver,
  VaultSecurityError,
  type VaultKeyMaterial,
} from '@mode-db/common';
import { fixtureVaultKeys } from '../vault-keys.js';

function material(): VaultKeyMaterial {
  return {
    reference: {
      instanceId: randomUUID(),
      databaseId: randomUUID(),
      keyId: randomUUID(),
      keyVersion: 1,
    },
    key: randomBytes(32),
  };
}

it('opens persisted engine/runtime data independently of all network tokens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-independent-key-'));
  const keyProvider = fixtureVaultKeys(root);
  const originalToken = process.env.MODEL_DB_CONNECT_TOKEN;
  try {
    process.env.MODEL_DB_CONNECT_TOKEN = 'first-network-token';
    const engine = new AuthoringEngine({ atlas: 'graph', storageRoot: root, keyProvider });
    engine.registerModel('Item', { name: 'String' });
    await engine.insert('Item', { name: 'preserved' }, { sync: true });
    await engine.flushAll();
    const path = join(root, 'graph', 'atlas.mld');
    const before = readFileSync(path);
    process.env.MODEL_DB_CONNECT_TOKEN = 'different-network-token';
    const reopened = new AuthoringEngine({ atlas: 'graph', storageRoot: root, keyProvider });
    assert.equal((await reopened.storage.getAll('Item'))[0]?.name, 'preserved');
    assert.deepEqual(readFileSync(path), before);
    configureModelDBStorageRoot({ storageRoot: root });
    delete process.env.MODEL_DB_CONNECT_TOKEN;
    const runtime = await ModelDBClient.connect('graph', { keyProvider });
    assert.equal(
      (await runtime.getRuntimeContext().dataReader.getAll('Item'))[0]?.name,
      'preserved',
    );
    assert.equal(readFileSync(path).includes(Buffer.from('preserved')), false);
    assert.equal(readAtlasVaultKeyReference(path)?.keyVersion, 1);
  } finally {
    if (originalToken === undefined) delete process.env.MODEL_DB_CONNECT_TOKEN;
    else process.env.MODEL_DB_CONNECT_TOKEN = originalToken;
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects wrong key, identity tampering, legacy and truncation without touching files', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-vault-tamper-'));
  try {
    const path = join(root, 'atlas.mld');
    const key = material();
    const vault = new AtlasSingleVault();
    vault.set('value', 'private');
    vault.saveSync(path, key);
    const good = readFileSync(path);
    assert.throws(() => new AtlasSingleVault().loadSync(path, { ...key, key: randomBytes(32) }), {
      code: 'VAULT_AUTHENTICATION_FAILED',
    });
    assert.deepEqual(readFileSync(path), good);
    assert.throws(
      () =>
        new AtlasSingleVault().loadSync(path, {
          ...key,
          reference: { ...key.reference, databaseId: randomUUID() },
        }),
      { code: 'VAULT_KEY_MISMATCH' },
    );
    const headerSize = good.readUInt32BE(8);
    const changedReference = { ...key.reference, databaseId: randomUUID() };
    const changedHeader = Buffer.from(
      JSON.stringify({ version: 2, algorithm: 'A256GCM', reference: changedReference }),
    );
    assert.equal(changedHeader.length, headerSize);
    const headerTampered = Buffer.from(good);
    changedHeader.copy(headerTampered, 12);
    writeFileSync(path, headerTampered);
    assert.throws(
      () => new AtlasSingleVault().loadSync(path, { ...key, reference: changedReference }),
      { code: 'VAULT_AUTHENTICATION_FAILED' },
    );
    const tagTampered = Buffer.from(good);
    tagTampered[12 + headerSize + 12] ^= 1;
    writeFileSync(path, tagTampered);
    assert.throws(() => new AtlasSingleVault().loadSync(path, key), {
      code: 'VAULT_AUTHENTICATION_FAILED',
    });
    const modified = Buffer.from(good);
    modified[modified.length - 1] ^= 1;
    writeFileSync(path, modified);
    assert.throws(() => vault.loadSync(path, key), { code: 'VAULT_AUTHENTICATION_FAILED' });
    assert.equal(vault.get('value'), 'private');
    assert.deepEqual(readFileSync(path), modified);
    writeFileSync(path, Buffer.from('MDB4SVLTlegacy-data'));
    assert.throws(() => readAtlasVaultKeyReference(path), { code: 'VAULT_LEGACY_FORMAT' });
    assert.equal(readFileSync(path).toString(), 'MDB4SVLTlegacy-data');
    writeFileSync(path, good.subarray(0, 10));
    assert.throws(() => new AtlasSingleVault().loadSync(path, key), {
      code: 'VAULT_FORMAT_INVALID',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects legacy files before provisioning any new key', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-vault-legacy-'));
  try {
    const path = join(root, 'legacy.mld');
    writeFileSync(path, Buffer.from('MDB4SVLTretained'));
    let requested = false;
    assert.throws(
      () =>
        new AuthoringEngine({
          atlas: 'legacy',
          paths: new PathResolver(root, 'legacy', { workspaceFlatVault: true }),
          keyProvider: {
            resolveKey() {
              requested = true;
              return material();
            },
          },
        }),
      { code: 'VAULT_LEGACY_FORMAT' },
    );
    assert.equal(requested, false);
    assert.equal(readFileSync(path).toString(), 'MDB4SVLTretained');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects a stale writer and requires reopening after a failed commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-vault-stale-'));
  try {
    const path = join(root, 'atlas.mld');
    const key = material();
    const first = new AtlasSingleVault();
    first.set('value', 'old');
    first.saveSync(path, key);
    const stale = new AtlasSingleVault();
    stale.loadSync(path, key);
    first.set('value', 'new');
    first.saveSync(path, key);
    stale.set('value', 'stale');
    assert.throws(() => stale.saveSync(path, key), { code: 'VAULT_COMMIT_CONFLICT' });
    assert.throws(() => stale.saveSync(path, key), { code: 'VAULT_COMMIT_INCOMPLETE' });
    const loaded = new AtlasSingleVault();
    loaded.loadSync(path, key);
    assert.equal(loaded.get('value'), 'new');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const point of ['staged', 'journaled', 'replaced'] as const) {
  it(`recovers after a separate writer exits at ${point}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-vault-crash-'));
    try {
      const path = join(root, 'atlas.mld');
      const key: VaultKeyMaterial = {
        reference: {
          instanceId: 'fixture',
          databaseId: 'fixture-db',
          keyId: 'fixture-key',
          keyVersion: 1,
        },
        key: Buffer.alloc(32, 7),
      };
      const original = new AtlasSingleVault();
      original.set('value', 'before');
      original.saveSync(path, key);
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `
        import { AtlasSingleVault } from '@mode-db/core';
        const key = { reference: { instanceId: 'fixture', databaseId: 'fixture-db', keyId: 'fixture-key', keyVersion: 1 }, key: Buffer.alloc(32, 7) };
        const v = new AtlasSingleVault(); v.loadSync(process.env.VAULT_TEST_PATH, key);
        v.set('value', 'after');
        v.saveSync(process.env.VAULT_TEST_PATH, key, (p) => { if (p === process.env.VAULT_TEST_POINT) process.exit(73); });
      `,
        ],
        {
          env: { ...process.env, VAULT_TEST_PATH: path, VAULT_TEST_POINT: point },
          encoding: 'utf8',
          timeout: 20000,
          windowsHide: true,
        },
      );
      assert.equal(child.error, undefined);
      assert.equal(child.status, 73, child.stderr);
      const recovered = new AtlasSingleVault();
      assert.equal(recovered.loadSync(path, key), true);
      assert.equal(recovered.get('value'), point === 'staged' ? 'before' : 'after');
      assert.equal(existsSync(`${path}.commit`), false);
      assert.equal(existsSync(`${path}.pending`), false);
      recovered.set('value', 'next');
      recovered.saveSync(path, key);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

it('preserves old data on simulated ENOSPC and retains a tampered recovery stage for diagnosis', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-vault-space-'));
  try {
    const path = join(root, 'atlas.mld');
    const key = material();
    const vault = new AtlasSingleVault();
    vault.set('x', 'old');
    vault.saveSync(path, key);
    const original = readFileSync(path);
    vault.set('x', 'new');
    assert.throws(
      () =>
        vault.saveSync(path, key, (point) => {
          if (point === 'staged') {
            writeFileSync(`${path}.pending`, Buffer.from('partial'));
            throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
          }
        }),
      { code: 'VAULT_WRITE_FAILED' },
    );
    assert.deepEqual(readFileSync(path), original);
    const recovered = new AtlasSingleVault();
    recovered.loadSync(path, key);
    assert.equal(recovered.get('x'), 'old');
    recovered.set('x', 'new');
    assert.throws(
      () =>
        recovered.saveSync(path, key, (point) => {
          if (point === 'journaled') throw new Error('interrupted');
        }),
      VaultSecurityError,
    );
    writeFileSync(`${path}.pending`, Buffer.from('tampered'));
    assert.throws(() => new AtlasSingleVault().loadSync(path, key), {
      code: 'VAULT_COMMIT_INCOMPLETE',
    });
    assert.deepEqual(readFileSync(path), original);
    assert.equal(existsSync(`${path}.pending`), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('recovers journaled first creation and refuses incomplete first creation without provisioning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-vault-create-'));
  try {
    const key = material();
    const paths = new PathResolver(root, 'newgraph');
    const path = paths.atlasSingleVaultPath();
    const vault = new AtlasSingleVault();
    vault.set('x', 'first');
    assert.throws(
      () =>
        vault.saveSync(path, key, (point) => {
          if (point === 'journaled') throw new Error('interrupted');
        }),
      { code: 'VAULT_WRITE_FAILED' },
    );
    assert.equal(existsSync(path), false);
    assert.deepEqual(readAtlasVaultKeyReference(path), key.reference);
    const recovered = new AtlasSingleVault();
    assert.equal(recovered.loadSync(path, key), true);
    assert.equal(recovered.get('x'), 'first');

    const partialPath = new PathResolver(root, 'partial').atlasSingleVaultPath();
    const partial = new AtlasSingleVault();
    assert.throws(
      () =>
        partial.saveSync(partialPath, key, (point) => {
          if (point === 'staged') throw new Error('interrupted');
        }),
      { code: 'VAULT_WRITE_FAILED' },
    );
    assert.throws(() => new AtlasSingleVault().loadSync(partialPath, key), {
      code: 'VAULT_COMMIT_INCOMPLETE',
    });
    assert.equal(existsSync(partialPath), false);
    assert.equal(existsSync(`${partialPath}.pending`), true);

    const lockedPath = new PathResolver(root, 'locked').atlasSingleVaultPath();
    new PathResolver(root, 'locked').ensureAtlasVaultLayoutSync();
    writeFileSync(`${lockedPath}.reclaim`, 'interrupted reclamation');
    let provisioned = false;
    assert.throws(
      () =>
        new AuthoringEngine({
          atlas: 'locked',
          storageRoot: root,
          keyProvider: {
            resolveKey() {
              provisioned = true;
              return key;
            },
          },
        }),
      { code: 'VAULT_COMMIT_INCOMPLETE' },
    );
    assert.equal(provisioned, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('runtime opens flat Vaults and reports corruption instead of creating empty data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-runtime-flat-'));
  const keyProvider = fixtureVaultKeys(root);
  try {
    const paths = new PathResolver(root, 'flat', { workspaceFlatVault: true });
    const engine = new AuthoringEngine({ atlas: 'flat', paths, keyProvider });
    engine.registerModel('Item', { title: 'String' });
    await engine.insert('Item', { title: 'flat-data' }, { sync: true });
    await engine.close();
    configureModelDBStorageRoot({ storageRoot: root });
    const runtime = await ModelDBClient.connect('flat', { keyProvider });
    assert.equal(
      (await runtime.getRuntimeContext().dataReader.getAll('Item'))[0]?.title,
      'flat-data',
    );
    const path = paths.atlasSingleVaultPath();
    writeFileSync(path, Buffer.from('corrupt'));
    await assert.rejects(ModelDBClient.connect('flat', { keyProvider }), {
      code: 'VAULT_FORMAT_INVALID',
    });
    assert.equal(readFileSync(path).toString(), 'corrupt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
