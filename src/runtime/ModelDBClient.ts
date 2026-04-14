import { existsSync } from 'node:fs';
import { DiskAdapter } from '../../common/disk-adapter.js';
import type { RuntimeContext } from './context.js';
import { ModelEntity } from './ModelEntity.js';
import { RuntimeRelation } from './RuntimeRelation.js';
import { assertFlatGraphSegment } from '../../common/atlas-segments.js';
import { PathResolver } from '../common/PathResolver.js';
import { parseAtlasManifestJson } from '../../common/atlas-manifest.js';
import { AtlasManifestError } from '../../common/errors.js';
import { resolveModelDBStorageRoot } from '../../common/storage-root-config.js';
import { ModelFileReader } from './ModelFileReader.js';
import { RelationIndexFileReader } from './RelationIndexFileReader.js';
import {
  fileLooksLikeAtlasSingleVault,
  AtlasSingleVault,
} from '../../authoring/atlas-single-vault.js';
import { VaultModelFileReader } from './vault-model-reader.js';
import { VaultRelationIndexReader } from './vault-relation-reader.js';

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Standalone client SDK: open an atlas by name and query `.mld` / `.rid` files read-only.
 *
 * Third-party entry point: {@link ModelDBClient.connect}. Does not import authoring storage or indexer.
 */
export class ModelDBClient {
  /**
   * @internal Constructed by {@link connect} or {@link fromContext} (same-process bridge).
   */
  constructor(private readonly ctx: RuntimeContext) {}

  /**
   * Primary API for external clients: load manifest + read-only readers for one atlas.
   */
  static async connect(atlasName: string): Promise<ModelDBClient> {
    assertFlatGraphSegment(atlasName, 'atlas name');
    const root = resolveModelDBStorageRoot();
    const paths = new PathResolver(root, atlasName);

    const vaultPath = paths.atlasSingleVaultPath();
    if (existsSync(vaultPath) && (await fileLooksLikeAtlasSingleVault(vaultPath))) {
      const secret =
        typeof process !== 'undefined' && process.env.MODEL_DB_VAULT_SECRET
          ? process.env.MODEL_DB_VAULT_SECRET
          : undefined;
      if (!secret || secret.length === 0) {
        throw new AtlasManifestError(
          `Atlas "${atlasName}" uses encrypted atlas.mld; set MODEL_DB_VAULT_SECRET in the environment to connect.`,
        );
      }
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

    let raw: string;
    try {
      raw = await DiskAdapter.read(paths.manifestFilePath(), 'utf-8');
    } catch (err) {
      if (isEnoent(err)) {
        throw new AtlasManifestError(
          `No atlas-manifest.json or encrypted atlas.mld for atlas "${atlasName}". Author the atlas and call flush (or writeAtlasManifest) first.`,
          { cause: err },
        );
      }
      throw err;
    }

    const registry = parseAtlasManifestJson(raw, atlasName);
    const dataReader = new ModelFileReader(paths);
    const indexReader = new RelationIndexFileReader(paths);

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
