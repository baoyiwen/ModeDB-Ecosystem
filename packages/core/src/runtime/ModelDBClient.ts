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
  deriveAtlasVaultSecretFromConnectToken,
} from '@mode-db/common';
import {
  fileLooksLikeAtlasSingleVault,
  AtlasSingleVault,
} from '../../authoring/atlas-single-vault.js';
import { VaultModelFileReader } from './vault-model-reader.js';
import { VaultRelationIndexReader } from './vault-relation-reader.js';

async function connectSingleFileVault(
  atlasName: string,
  paths: PathResolver,
  vaultPath: string,
): Promise<ModelDBClient> {
  const connectTok =
    typeof process !== 'undefined' && process.env.MODEL_DB_CONNECT_TOKEN
      ? process.env.MODEL_DB_CONNECT_TOKEN.trim()
      : '';
  if (!connectTok) {
    throw new AtlasManifestError(
      `Atlas "${atlasName}" uses encrypted atlas.mld; set MODEL_DB_CONNECT_TOKEN in the environment (same value as the server wire connect token).`,
    );
  }
  const secret = deriveAtlasVaultSecretFromConnectToken(connectTok);
  const vault = new AtlasSingleVault();
  const ok = vault.loadSync(vaultPath, secret);
  if (!ok) {
    throw new AtlasManifestError(
      `Cannot decrypt or parse vault "${vaultPath}" (wrong secret, truncated file, or corrupt payload). See diagnostics E3002.`,
    );
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
  static async connect(atlasName: string): Promise<ModelDBClient> {
    assertFlatGraphSegment(atlasName, 'atlas name');
    const root = resolveModelDBStorageRoot();
    const nestedPaths = new PathResolver(root, atlasName);
    const nestedVault = nestedPaths.atlasSingleVaultPath();
    if (existsSync(nestedVault) && (await fileLooksLikeAtlasSingleVault(nestedVault))) {
      return connectSingleFileVault(atlasName, nestedPaths, nestedVault);
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
