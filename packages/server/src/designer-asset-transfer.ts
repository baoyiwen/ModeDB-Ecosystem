import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  acquireFileLeaseSync,
  assertFlatGraphSegment,
  fileDigest,
  readAtomicFileSync,
  stableStringify,
  writeAtomicFileSync,
  type AtomicCommitPoint,
  type VaultKeyProvider,
} from '@mode-db/common';
import {
  AtlasSingleVault,
  designerAssetRows,
  mapDesignerAsset,
  mergeDesignerAsset,
  readAtlasVaultKeyReferenceFromBytes,
} from '@mode-db/core';
import { assetTargetVault, previewAssetImport } from './asset-transfer.js';
import { readBackupBytes } from './backup-manager.js';
import { MAX_BACKUP_VAULT_BYTES } from './security/backup-package.js';
import { assertRecoveryPath } from './security/recovery-material.js';
import { SecurityError } from './security/security-errors.js';
import type { DesignerAssetContent } from './security/asset-package.js';
import type { SecurityRegistry } from './security/security-registry.js';

const MAX_TASK_BYTES = 224 * 1024 * 1024;
const TASK_DATABASE = '__asset_publication__';
const TASK_NAME = 'asset-publication.mld';
type Slot = {
  database: string;
  kind: 'nested' | 'flat';
  previous: string | null;
  before: string | null;
  next: string;
};
interface Task {
  version: 1;
  instanceId: string;
  root: string;
  packageDigest: string;
  localAssetInstanceId: string;
  business: Slot;
  designer: Slot;
}
export interface DesignerAssetImportInput {
  content: DesignerAssetContent;
  storageRoot: string;
  database: string;
  instanceId: string;
  designerWorkspace: string;
  securityDirectory: string;
  provider: VaultKeyProvider;
  registry: SecurityRegistry;
}
const fail = (): never => {
  throw new SecurityError('SECURITY_POLICY_CONFLICT');
};
const digest = (value: unknown) => fileDigest(Buffer.from(stableStringify(value)));
const activePath = (input: DesignerAssetImportInput) =>
  assertRecoveryPath(join(input.securityDirectory, TASK_NAME));
const targetPath = (input: DesignerAssetImportInput, slot: Pick<Slot, 'database' | 'kind'>) =>
  assertRecoveryPath(
    slot.kind === 'nested'
      ? join(input.storageRoot, slot.database, 'atlas.mld')
      : join(input.storageRoot, slot.database + '.mld'),
  );
function decodeVault(
  input: DesignerAssetImportInput,
  database: string,
  bytes: Buffer,
): AtlasSingleVault {
  const key = input.provider.resolveKey(database, readAtlasVaultKeyReferenceFromBytes(bytes));
  const vault = new AtlasSingleVault();
  try {
    vault.loadBytes(bytes, key);
  } finally {
    key.key.fill(0);
  }
  return vault;
}
function encodeVault(
  input: DesignerAssetImportInput,
  database: string,
  vault: AtlasSingleVault,
  previous?: Buffer,
): Buffer {
  const key = input.provider.resolveKey(
    database,
    previous ? readAtlasVaultKeyReferenceFromBytes(previous) : undefined,
  );
  try {
    return vault.exportBytes(key);
  } finally {
    key.key.fill(0);
  }
}
function authorize(input: DesignerAssetImportInput): string {
  input.registry.assertMaintenanceOwnership(input.securityDirectory);
  if (input.registry.status().instanceId !== input.instanceId) {
    fail();
  }
  assertFlatGraphSegment(input.database, 'database');
  assertFlatGraphSegment(input.designerWorkspace, 'workspace');
  if (
    input.database.toLowerCase() === input.designerWorkspace.toLowerCase() ||
    input.database.toLowerCase().startsWith('sys_') ||
    input.database.startsWith('__') ||
    input.designerWorkspace.startsWith('__')
  ) {
    fail();
  }
  return assetTargetVault(input.content, input.database, input.instanceId).localAssetInstanceId;
}
function historyPath(input: DesignerAssetImportInput, localId: string): string {
  return assertRecoveryPath(
    join(input.securityDirectory, 'asset-publication.' + localId + '.completed.mld'),
  );
}
function readTask(
  input: DesignerAssetImportInput,
  path: string,
  localId: string,
): { task: Task; bytes: Buffer } | undefined {
  const candidate = existsSync(path)
    ? path
    : existsSync(path + '.pending')
      ? path + '.pending'
      : undefined;
  if (!candidate) {
    if (['.commit', '.lock', '.reclaim'].some((suffix) => existsSync(path + suffix))) {
      fail();
    }
    return undefined;
  }
  const bytes = readBackupBytes(candidate, MAX_TASK_BYTES);
  if (
    existsSync(path) &&
    existsSync(path + '.pending') &&
    fileDigest(readBackupBytes(path + '.pending', MAX_TASK_BYTES)) !== fileDigest(bytes)
  ) {
    fail();
  }
  for (const suffix of ['.commit', '.lock', '.reclaim']) {
    if (existsSync(path + suffix)) {
      readBackupBytes(path + suffix, 1024);
    }
  }
  const vault = decodeVault(input, TASK_DATABASE, bytes);
  const task = JSON.parse(vault.get('task') ?? '{}') as Task;
  if (
    Object.keys(task).sort().join() !==
      'business,designer,instanceId,localAssetInstanceId,packageDigest,root,version' ||
    task.version !== 1 ||
    task.instanceId !== input.instanceId ||
    task.root !== resolve(input.storageRoot) ||
    task.packageDigest !== digest(input.content) ||
    task.localAssetInstanceId !== localId ||
    task.business.database !== input.database ||
    task.designer.database !== input.designerWorkspace
  ) {
    fail();
  }
  for (const slot of [task.business, task.designer]) {
    if (
      Object.keys(slot).sort().join() !== 'before,database,kind,next,previous' ||
      !['nested', 'flat'].includes(slot.kind) ||
      typeof slot.next !== 'string' ||
      (slot.previous !== null && !/^[a-f0-9]{64}$/.test(slot.previous))
    ) {
      fail();
    }
    const next = Buffer.from(slot.next, 'base64');
    if (next.length > MAX_BACKUP_VAULT_BYTES || next.toString('base64') !== slot.next) {
      fail();
    }
    decodeVault(input, slot.database, next);
    if (slot.before !== null) {
      const before = Buffer.from(slot.before, 'base64');
      if (
        fileDigest(before) !== slot.previous ||
        before.length > MAX_BACKUP_VAULT_BYTES ||
        before.toString('base64') !== slot.before
      ) {
        fail();
      }
      decodeVault(input, slot.database, before);
    } else if (slot.previous !== null) {
      fail();
    }
    if (
      slot === task.business &&
      (slot.kind !== 'nested' || slot.previous !== null || slot.before !== null)
    ) {
      fail();
    }
  }
  return { task, bytes };
}
function state(input: DesignerAssetImportInput, slot: Slot) {
  const path = targetPath(input, slot);
  for (const suffix of ['.commit', '.lock', '.reclaim']) {
    if (existsSync(path + suffix)) {
      readBackupBytes(path + suffix, 1024);
    }
  }
  const current = existsSync(path)
    ? fileDigest(readBackupBytes(path, MAX_BACKUP_VAULT_BYTES))
    : null;
  const next = fileDigest(Buffer.from(slot.next, 'base64'));
  if (current !== slot.previous && current !== next) {
    fail();
  }
  const other = targetPath(input, { ...slot, kind: slot.kind === 'nested' ? 'flat' : 'nested' });
  if (
    ['', '.pending', '.commit', '.lock', '.reclaim'].some((suffix) => existsSync(other + suffix))
  ) {
    fail();
  }
  if (slot.kind === 'nested' && slot.database === input.database) {
    const directory = assertRecoveryPath(join(input.storageRoot, slot.database));
    if (
      existsSync(directory) &&
      readdirSync(directory).some(
        (name) =>
          !['atlas.mld', 'atlas.mld.pending', 'atlas.mld.commit', 'atlas.mld.lock'].includes(name),
      )
    ) {
      fail();
    }
  }
  if (
    existsSync(path + '.pending') &&
    fileDigest(readBackupBytes(path + '.pending', MAX_BACKUP_VAULT_BYTES)) !== next
  ) {
    fail();
  }
  return { current, next };
}
/** Previews bind the complete package, both target revisions and the deterministic reference map. */
export function previewDesignerAssetImport(input: DesignerAssetImportInput) {
  const localId = authorize(input),
    path = activePath(input);
  const active = readTask(input, path, localId),
    history = active ? undefined : readTask(input, historyPath(input, localId), localId);
  const existing = active ?? history;
  const conflicts: string[] = [];
  let workspaceDigest: string | null = null,
    businessDigest: string | null = null;
  let workspaceKind: 'nested' | 'flat' = 'nested';
  if (existing) {
    businessDigest = state(input, existing.task.business).current;
    workspaceDigest = state(input, existing.task.designer).current;
    workspaceKind = existing.task.designer.kind;
    if (
      history &&
      (businessDigest !== fileDigest(Buffer.from(history.task.business.next, 'base64')) ||
        workspaceDigest !== fileDigest(Buffer.from(history.task.designer.next, 'base64')))
    ) {
      fail();
    }
  } else {
    const base = previewAssetImport(input);
    conflicts.push(...base.conflicts);
    // Without our cross-storage task/receipt no pre-existing business target is eligible.
    if (base.resume) {
      conflicts.push('untracked-business-target');
    }
    const nested = targetPath(input, { database: input.designerWorkspace, kind: 'nested' });
    const flat = targetPath(input, { database: input.designerWorkspace, kind: 'flat' });
    if (existsSync(nested) && existsSync(flat)) {
      conflicts.push('ambiguous-workspace');
    }
    if (existsSync(flat)) {
      workspaceKind = 'flat';
    }
    const workspacePath = workspaceKind === 'flat' ? flat : nested;
    for (const suffix of ['.pending', '.commit', '.lock', '.reclaim']) {
      if (existsSync(nested + suffix) || existsSync(flat + suffix)) {
        conflicts.push('workspace-maintenance');
      }
    }
    if (existsSync(workspacePath)) {
      const bytes = readBackupBytes(workspacePath, MAX_BACKUP_VAULT_BYTES);
      workspaceDigest = fileDigest(bytes);
      const vault = decodeVault(input, input.designerWorkspace, bytes);
      for (const model of [
        'sys_data_asset_map',
        'sys_model',
        'sys_props',
        'sys_relation',
        'sys_query_interface',
        'sys_operation_interface',
        'sys_binding_surface',
        'sys_designer_graph',
      ]) {
        if (
          designerAssetRows(vault, model).some(
            (row) =>
              row.library_code?.toString().toLowerCase() === input.database.toLowerCase() ||
              (model === 'sys_data_asset_map' &&
                row.code?.toString().toLowerCase() === input.database.toLowerCase()),
          )
        ) {
          conflicts.push('existing-designer-library');
        }
      }
      // Exercise merge and identity collision validation during preview, without provisioning a key.
      mergeDesignerAsset(
        vault,
        mappedDesigner(input, localId),
        input.designerWorkspace,
        input.content.graph,
      );
    } else {
      const directory = assertRecoveryPath(join(input.storageRoot, input.designerWorkspace));
      if (existsSync(directory) && readdirSync(directory).length) {
        conflicts.push('existing-workspace-directory');
      }
      mergeDesignerAsset(
        new AtlasSingleVault(),
        mappedDesigner(input, localId),
        input.designerWorkspace,
        input.content.graph,
      );
    }
  }
  const result = {
    format: 'modeldb.asset-preview.v2' as const,
    packageId: input.content.packageId,
    packageDigest: digest(input.content),
    assetId: input.content.assetId,
    assetVersion: input.content.assetVersion,
    publisherId: input.content.publisherId,
    targetDatabase: input.database,
    designerWorkspace: input.designerWorkspace,
    workspaceKind,
    localAssetInstanceId: localId,
    statistics: input.content.statistics,
    models: input.content.graph.models.map((m) => m.definition),
    relations: input.content.graph.relations.map((r) => r.definition),
    includeData: input.content.graph.includeData,
    designer: input.content.designer.rows.map(({ model, data }) => ({
      model,
      sourceId: data._id,
      targetId: mappedId(localId, model, data._id),
      interfaceId: data.interface_id ?? data.surface_id,
      name: data.display_name ?? data.name,
      versions: data.release_history_json
        ? (JSON.parse(String(data.release_history_json)) as { version: string }[]).map(
            (r) => r.version,
          )
        : [],
      currentVersion: data.release_json
        ? (JSON.parse(String(data.release_json)) as { version: string }).version
        : undefined,
    })),
    importedPermissions: 'disabled' as const,
    requiredAuthority: 'offline-os-owner' as const,
    workspaceDigest,
    businessDigest,
    resume: !!active,
    published: !!history,
    conflicts: [...new Set(conflicts)],
  };
  return { ...result, confirmationDigest: digest(result) };
}
function mappedId(localId: string, model: string, source: string): string {
  return 'asset_' + digest({ localId, model, source }).slice(0, 48);
}
function mappedDesigner(input: DesignerAssetImportInput, localId: string) {
  return mapDesignerAsset(
    input.content.designer,
    input.content.graph,
    input.database,
    (kind, source) => mappedId(localId, kind, source),
  );
}
/** Recover only this task's authenticated candidate, including a first-write staged-only exit. */
function publish(
  path: string,
  next: Buffer,
  previous: string | null,
  validate: (bytes: Buffer) => void,
  onPoint?: (point: AtomicCommitPoint) => void,
): void {
  const nextDigest = fileDigest(next);
  if (existsSync(path + '.pending') && !existsSync(path + '.commit') && !existsSync(path)) {
    if (
      previous !== null ||
      fileDigest(readBackupBytes(path + '.pending', MAX_TASK_BYTES)) !== nextDigest
    ) {
      fail();
    }
    // Claim/reclaim the dead writer through the common lease before reconstructing its intent.
    writeIntent(path, nextDigest);
  }
  const current = readAtomicFileSync(path, validate);
  if (current && fileDigest(current) === nextDigest) {
    return;
  }
  if ((current ? fileDigest(current) : null) !== previous) {
    fail();
  }
  writeAtomicFileSync(path, next, previous, validate, onPoint);
}
function writeIntent(path: string, next: string): void {
  // readAtomicFileSync owns its own lease; this short claim protects intent reconstruction.
  const release = acquireFileLeaseSync(path);
  try {
    const fd = openSync(path + '.commit', 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, previous: null, next }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    release();
  }
}

/** Offline two-file publication: a durable task blocks every normal registry listener until complete. */
export function importDesignerAsset(
  input: DesignerAssetImportInput & {
    confirmationDigest: string;
    onPoint?: (point: string) => void;
  },
) {
  const preview = previewDesignerAssetImport(input);
  if (preview.conflicts.length) {
    fail();
  }
  if (
    preview.confirmationDigest !== input.confirmationDigest ||
    !/^[a-f0-9]{64}$/.test(input.confirmationDigest)
  ) {
    throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
  }
  if (preview.published) {
    return {
      database: input.database,
      localAssetInstanceId: preview.localAssetInstanceId,
      packageId: input.content.packageId,
      resumed: true,
      published: true,
    };
  }
  const path = activePath(input),
    localId = preview.localAssetInstanceId;
  let stored = readTask(input, path, localId);
  if (!stored) {
    const workspacePath = targetPath(input, {
      database: input.designerWorkspace,
      kind: preview.workspaceKind,
    });
    const before = existsSync(workspacePath)
      ? readBackupBytes(workspacePath, MAX_BACKUP_VAULT_BYTES)
      : undefined;
    if ((before ? fileDigest(before) : null) !== preview.workspaceDigest) {
      fail();
    }
    const workspace = before
      ? decodeVault(input, input.designerWorkspace, before)
      : new AtlasSingleVault();
    const designer = mergeDesignerAsset(
      workspace,
      mappedDesigner(input, localId),
      input.designerWorkspace,
      input.content.graph,
    );
    const business = assetTargetVault(input.content, input.database, input.instanceId).vault;
    const businessBytes = encodeVault(input, input.database, business),
      designerBytes = encodeVault(input, input.designerWorkspace, designer, before);
    if (
      businessBytes.length > MAX_BACKUP_VAULT_BYTES ||
      designerBytes.length > MAX_BACKUP_VAULT_BYTES
    ) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    const task: Task = {
      version: 1,
      instanceId: input.instanceId,
      root: resolve(input.storageRoot),
      packageDigest: digest(input.content),
      localAssetInstanceId: localId,
      business: {
        database: input.database,
        kind: 'nested',
        previous: null,
        before: null,
        next: businessBytes.toString('base64'),
      },
      designer: {
        database: input.designerWorkspace,
        kind: preview.workspaceKind,
        previous: before ? fileDigest(before) : null,
        before: before?.toString('base64') ?? null,
        next: designerBytes.toString('base64'),
      },
    };
    const vault = new AtlasSingleVault();
    vault.set('task', JSON.stringify(task));
    const bytes = encodeVault(input, TASK_DATABASE, vault);
    if (bytes.length > MAX_TASK_BYTES) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    writeAtomicFileSync(
      path,
      bytes,
      null,
      (candidate) => {
        decodeVault(input, TASK_DATABASE, candidate);
      },
      (point) => input.onPoint?.('task.' + point),
    );
    stored = { task, bytes };
  } else {
    publish(path, stored.bytes, null, (candidate) => {
      decodeVault(input, TASK_DATABASE, candidate);
    });
  }
  input.onPoint?.('prepared');
  for (const [name, slot] of [
    ['business', stored.task.business],
    ['designer', stored.task.designer],
  ] as const) {
    state(input, slot);
    const target = targetPath(input, slot);
    mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
    publish(
      target,
      Buffer.from(slot.next, 'base64'),
      slot.previous,
      (candidate) => {
        decodeVault(input, slot.database, candidate);
      },
      (point) => input.onPoint?.(name + '.' + point),
    );
    input.onPoint?.(name + '.published');
  }
  const archive = historyPath(input, localId);
  mkdirSync(resolve(archive, '..'), { recursive: true, mode: 0o700 });
  if (existsSync(archive)) {
    fail();
  }
  renameSync(path, archive);
  input.onPoint?.('completed');
  return {
    database: input.database,
    localAssetInstanceId: localId,
    packageId: input.content.packageId,
    statistics: input.content.statistics,
    resumed: preview.resume,
    published: true,
  };
}
