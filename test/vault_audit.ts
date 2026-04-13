/**
 * Single-file vault: authoring round-trip, cold {@link ModelDBClient.connect},
 * relation index inside vault, wrong-secret failure, corrupt-file E3002.
 *
 * Run: npx tsx test/vault_audit.ts
 *      npm run vault-audit
 */

import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import {
  configureModelDBStorageRoot,
  resolveModelDBStorageRoot,
} from '../common/storage-root-config.js';
import { AuthoringEngine } from '../src/authoring/AuthoringEngine.js';
import { ModelDBClient } from '../src/runtime/ModelDBClient.js';
import { PathResolver } from '../src/common/PathResolver.js';
import { AtlasManifestError } from '../common/errors.js';
import { DiagnosticCenter, ErrorCodes } from '../common/diagnostic.js';
import { AtlasSingleVault } from '../authoring/atlas-single-vault.js';
import {
  INTEGRATION_VAULT_SECRET,
  integrationVaultAuthoringOptions,
  useIntegrationVaultEnv,
} from './integration-vault.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS = 'vault_audit_rt';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function main(): Promise<void> {
  configureModelDBStorageRoot({ storageRoot: DATA_ROOT });
  useIntegrationVaultEnv();

  const root = resolveModelDBStorageRoot();
  const paths = new PathResolver(root, ATLAS);
  const atlasRoot = paths.atlasRoot();
  await rm(atlasRoot, { recursive: true, force: true });

  const engine = new AuthoringEngine({
    atlas: ATLAS,
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
  });

  engine.registerModel('Box', new Set(['tag']));
  engine.registerModel('Item', new Set(['name']));
  engine.quickLink('Box', 'Item', 'has', 'in_box');

  const box = await engine.insert('Box', { tag: 'main' });
  const item = await engine.insert('Item', { name: 'thing' });
  await engine.bind('has', 'MANUAL', { pairs: [[box._id, item._id]] });
  await engine.flushAll();

  const vaultPath = paths.atlasSingleVaultPath();
  assert(existsSync(vaultPath), 'atlas.mld exists');
  assert(!existsSync(paths.manifestFilePath()), 'no atlas-manifest.json');
  assert(!existsSync(paths.modelsDir()), 'no models/ directory');
  assert(!existsSync(paths.relationsDir()), 'no relations/ directory');

  const client = await ModelDBClient.connect(ATLAS);
  const rows = await client.model('Item').query().execute();
  assert(rows.length >= 1, 'runtime sees at least one Item row');
  const first = rows[0]!;
  assert(first.getData(false).name === 'thing', 'getData returns plaintext name');

  const related = await client.model('Box').query([box._id]).relate('has').execute();
  assert(related.length === 1, 'relate(has) returns one Item');
  assert(related[0]!.getData(false)._id === item._id, 'related entity is correct Item');

  const engine2 = new AuthoringEngine({
    atlas: ATLAS,
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
  });
  assert(engine2.registry.getModel('Box') !== undefined, 'reopen hydrates Box from manifest');
  assert(engine2.registry.getModel('Item') !== undefined, 'reopen hydrates Item from manifest');

  let wrongSecretThrew = false;
  try {
    void new AuthoringEngine({
      atlas: ATLAS,
      storageRoot: DATA_ROOT,
      singleFileVault: true,
      vaultSecret: 'definitely-not-the-integration-vault-secret-xx',
    });
  } catch (e) {
    wrongSecretThrew = e instanceof AtlasManifestError;
  }
  assert(wrongSecretThrew, 'wrong vault secret throws AtlasManifestError');

  const seen: string[] = [];
  const off = DiagnosticCenter.onDiagnostic((d) => {
    seen.push(d.code);
  });
  writeFileSync(vaultPath, Buffer.from('corrupt'));
  const v = new AtlasSingleVault();
  const loaded = v.loadSync(vaultPath, INTEGRATION_VAULT_SECRET);
  off();
  assert(!loaded, 'loadSync returns false on corrupt vault');
  assert(
    seen.includes(ErrorCodes.PHYSICAL_ADDRESS_CORRUPT),
    'E3002 PHYSICAL_ADDRESS_CORRUPT reported',
  );

  await rm(atlasRoot, { recursive: true, force: true });

  console.log(`\nvault_audit: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

void main();
