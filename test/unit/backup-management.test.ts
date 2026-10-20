import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createDatabaseBackup,
  importDatabaseBackup,
  listDatabaseBackups,
  normalizeBackupName,
  readDatabaseBackupFile,
  restoreDatabaseBackup,
} from '../../packages/server/src/backup-manager.js';
import {
  backupDisplayName,
  defaultBackupName,
  formatBackupTime,
  groupBackups,
} from '../../apps/model-designer/src/backup/backup-presentation.js';
import { ModelDB } from '../../packages/sdk/src/model-db.js';
import type { LibraryRegistryRecord } from '../../apps/model-designer/src/types/library-registry.js';

function withWorkspace(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'modedb-backup-test-'));
  try {
    mkdirSync(join(root, 'graph'), { recursive: true });
    writeFileSync(join(root, 'graph', 'atlas.mld'), 'test-only-vault');
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('named backup contract', () => {
  it('persists Unicode names through creation, listing, export, import and restore', () =>
    withWorkspace((root) => {
      const created = createDatabaseBackup(root, 'graph', 'manual', '  上线前备份  ');
      assert.equal(created.name, '上线前备份');
      assert.match(created.fileName, /^[A-Za-z0-9_.-]+\.modeldb-backup\.json$/);
      const exported = readDatabaseBackupFile(root, created.fileName);
      assert.equal(exported.info.name, created.name);
      assert.equal(JSON.parse(exported.content.toString()).name, created.name);
      const imported = importDatabaseBackup(root, created.fileName, exported.content);
      const importedAgain = importDatabaseBackup(root, created.fileName, exported.content);
      assert.notEqual(imported.fileName, created.fileName);
      assert.notEqual(importedAgain.fileName, imported.fileName);
      assert.equal(imported.name, created.name);
      assert.equal(listDatabaseBackups(root, 'graph').length, 3);
      assert.ok(listDatabaseBackups(root).every((item) => item.name === created.name));
      const restored = restoreDatabaseBackup(root, 'copy', imported.fileName);
      assert.equal(restored.name, created.name);
      assert.equal(readFileSync(join(root, 'copy', 'atlas.mld'), 'utf8'), 'test-only-vault');
    }));

  it('keeps legacy files readable and same-name backups distinct', () =>
    withWorkspace((root) => {
      const first = createDatabaseBackup(root, 'graph', 'manual');
      const second = createDatabaseBackup(root, 'graph', 'manual');
      assert.notEqual(first.fileName, second.fileName);
      assert.equal(first.name, undefined);
      assert.match(backupDisplayName(first), /^graph_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
      assert.equal(listDatabaseBackups(root).length, 2);
    }));

  it('validates names and rejects invalid imported metadata and paths', () =>
    withWorkspace((root) => {
      for (const value of ['', '  ', 'a\nb', 'a'.repeat(121), null, 42]) {
        assert.throws(() => normalizeBackupName(value));
      }
      assert.equal(normalizeBackupName(undefined), undefined);
      assert.equal(normalizeBackupName('备份 / 发布前'), '备份 / 发布前');
      const backup = createDatabaseBackup(root, 'graph');
      const payload = JSON.parse(readDatabaseBackupFile(root, backup.fileName).content.toString());
      assert.throws(() =>
        importDatabaseBackup(
          root,
          'bad.json',
          Buffer.from(JSON.stringify({ ...payload, name: 5 })),
        ),
      );
      payload.files[0].path = 'graph/../other/atlas.mld';
      assert.throws(() =>
        importDatabaseBackup(root, 'bad.json', Buffer.from(JSON.stringify(payload))),
      );
    }));

  it('passes an optional name through the public SDK without changing existing parameters', async () => {
    const original = globalThis.fetch;
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({ ok: true, backup: { name: '发布前', database: 'graph' } }),
        { status: 200 },
      );
    };
    try {
      const db = new ModelDB({ host: '127.0.0.1', port: 9091, token: 'fixture' });
      const result = await db.createBackup('graph', 'manual', '发布前');
      assert.equal(result.name, '发布前');
      assert.deepEqual(calls, [
        {
          url: 'http://127.0.0.1:9091/api/v1/management/databases/graph/backup',
          body: { reason: 'manual', name: '发布前' },
        },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('backup presentation', () => {
  it('uses local date components, including padded seconds', () => {
    const local = new Date(2026, 9, 16, 8, 4, 3);
    assert.equal(formatBackupTime(local), '2026-10-16 08:04:03');
    assert.equal(defaultBackupName('graph', local), 'graph_2026-10-16-08-04-03');
    assert.match(defaultBackupName('x'.repeat(120), local), /_2026-10-16-08-04-03$/);
    assert.ok(defaultBackupName('x'.repeat(120), local).length <= 120);
  });

  it('groups by payload database, localizes graph labels and keeps unregistered groups', () => {
    const backups = [
      {
        fileName: 'misleading-graph.json',
        database: 'graph_archive',
        createdAt: '2026-10-15T00:00:00Z',
        bytes: 1,
      },
      {
        fileName: 'other.json',
        name: '发布前',
        database: 'graph',
        createdAt: '2026-10-16T00:00:00Z',
        bytes: 1,
      },
      {
        fileName: 'deleted.json',
        database: 'deleted',
        createdAt: '2026-10-16T00:00:00Z',
        bytes: 1,
      },
    ];
    const registry: LibraryRegistryRecord[] = [
      {
        id: 'a',
        code: 'graph',
        name: { en: 'Network', zh: '路网', ja: '路線網' },
        description: {},
      },
      { id: 'b', code: 'empty', name: {}, description: {} },
    ];
    const groups = groupBackups(backups, registry, 'zh', 'graph');
    assert.equal(groups[0].label, '路网[graph]');
    assert.equal(groups[0].backups.length, 1);
    assert.equal(
      groups.find((group) => group.code === 'graph_archive')?.backups[0].fileName,
      'misleading-graph.json',
    );
    assert.equal(groups.find((group) => group.code === 'deleted')?.label, 'deleted');
    assert.equal(groups.find((group) => group.code === 'empty')?.backups.length, 0);
    assert.equal(groupBackups(backups, registry, 'ja', 'graph')[0].label, '路線網[graph]');
  });
});
