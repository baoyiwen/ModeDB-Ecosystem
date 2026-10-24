import { existsSync } from 'node:fs';
import type { RuntimeContext } from './context.js';
import { ModelEntity } from './ModelEntity.js';
import { RuntimeRelation } from './RuntimeRelation.js';
import {
  assertFlatGraphSegment,
  PathResolver,
  parseAtlasManifestJson,
  AtlasManifestError,
  resolveModelDBStorageRoot,
  DiagnosticCenter,
  ErrorCodes,
  VaultSecurityError,
  type VaultKeyProvider,
} from '@mode-db/common';
import {
  AtlasSingleVault,
  readAtlasVaultKeyReference,
} from '../../authoring/atlas-single-vault.js';
import { VaultModelFileReader } from './vault-model-reader.js';
import { VaultRelationIndexReader } from './vault-relation-reader.js';

async function connectSingleFileVault(
  atlasName: string,
  paths: PathResolver,
  vaultPath: string,
  keyProvider: VaultKeyProvider,
): Promise<ModelDBClient> {
  if (!keyProvider) {
    throw new VaultSecurityError('VAULT_KEY_REQUIRED');
  }
  const reference = readAtlasVaultKeyReference(vaultPath);
  if (!reference) {
    throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
  }
  const key = keyProvider.resolveKey(atlasName, reference);
  const vault = new AtlasSingleVault();
  const ok = vault.loadSync(vaultPath, key);
  if (!ok) {
    throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
  }
  const manifestRaw = vault.get(AtlasSingleVault.manifestKey);
  if (!manifestRaw) {
    throw new AtlasManifestError(
      `Vault for atlas "${atlasName}" has no embedded manifest key "${AtlasSingleVault.manifestKey}".`,
    );
  }
  const registry = parseAtlasManifestJson(manifestRaw, atlasName);
  const dataReader = new VaultModelFileReader(paths, vault);
  const indexReader = new VaultRelationIndexReader(vault);
  for (const m of registry.getModelDefinitions()) {
    dataReader.registerSchema({ name: m.name, fields: m.fields, fieldTypes: m.fieldTypes });
  }
  const ctx: RuntimeContext = {
    atlas: atlasName,
    dataReader,
    indexReader,
    registry,
  };
  return new ModelDBClient(ctx);
}

/**
 * Standalone client SDK: open a logical database by name (single-file vault only).
 *
 * Third-party entry point: {@link ModelDBClient.connect}. Does not import authoring storage or indexer.
 */
export class ModelDBClient {
  /**
   * @internal Constructed by {@link connect} or {@link fromContext} (same-process bridge).
   */
  constructor(private readonly ctx: RuntimeContext) {}

  /**
   * Primary API for external clients: load encrypted **`*.mld`** (workspace-flat **`${root}/${name}.mld`** or nested **`${root}/${name}/atlas.mld`**).
   */
  static async connect(
    atlasName: string,
    options: { keyProvider: VaultKeyProvider },
  ): Promise<ModelDBClient> {
    assertFlatGraphSegment(atlasName, 'atlas name');
    if (!options?.keyProvider) {
      throw new VaultSecurityError('VAULT_KEY_REQUIRED');
    }
    const root = resolveModelDBStorageRoot();
    const nestedPaths = new PathResolver(root, atlasName);
    const nestedVault = nestedPaths.atlasSingleVaultPath();
    const present = (path: string): boolean =>
      ['', '.pending', '.commit', '.lock', '.reclaim'].some((suffix) => existsSync(path + suffix));
    if (present(nestedVault)) {
      return connectSingleFileVault(atlasName, nestedPaths, nestedVault, options.keyProvider);
    }
    const flatPaths = new PathResolver(root, atlasName, { workspaceFlatVault: true });
    const flatVault = flatPaths.atlasSingleVaultPath();
    if (present(flatVault)) {
      return connectSingleFileVault(atlasName, flatPaths, flatVault, options.keyProvider);
    }

    DiagnosticCenter.report(
      ErrorCodes.DATABASE_NOT_FOUND,
      { dbName: atlasName, path: nestedVault },
      'throw',
    );
    throw new Error('ModelDBClient.connect: unreachable after DATABASE_NOT_FOUND');
  }

  /**
   * Same-process bridge when an {@link AuthoringEngine} already holds storage/indexer.
   * Prefer {@link connect} for isolated client delivery.
   */
  static fromContext(ctx: RuntimeContext): ModelDBClient {
    return new ModelDBClient(ctx);
  }

  get atlas(): string {
    return this.ctx.atlas;
  }

  /** Read-side context (registry + readers); used by the WebSocket server and integrations. */
  getRuntimeContext(): RuntimeContext {
    return this.ctx;
  }

  model(name: string): ModelEntity {
    const def = this.ctx.registry.getModel(name);
    if (!def) {
      throw new Error(`Model "${name}" is not registered.`);
    }
    return new ModelEntity(name, this.ctx.registry, this.ctx.dataReader, this.ctx.indexReader);
  }

  relation(label: string): RuntimeRelation {
    const def = this.ctx.registry.findRelationByLabel(label);
    if (!def) {
      throw new Error(`Relation "${label}" is not registered (checked both forward and reverse).`);
    }
    return new RuntimeRelation(def);
  }
}
