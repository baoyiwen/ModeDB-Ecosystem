import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AuthoringEngine, fileLooksLikeAtlasSingleVault } from 'mode-db-engine';
import { atlasCatalogSignature } from './atlas-catalog-signature.js';

/**
 * Lazily constructs {@link AuthoringEngine} per atlas (Vault vs split-file) for server-side writes.
 * Cache is invalidated when **`atlas-manifest.json`** / **`atlas.mld`** mtimes change.
 */
export class AuthoringBridge {
  private readonly cache = new Map<
    string,
    { readonly sig: string; readonly promise: Promise<AuthoringEngine> }
  >();

  constructor(
    private readonly storageRoot: string,
    private readonly vaultSecret: string | undefined,
    private readonly bufferFlushRowThreshold?: number,
  ) {}

  getEngine(atlas: string): Promise<AuthoringEngine> {
    const sig = atlasCatalogSignature(this.storageRoot, atlas);
    const hit = this.cache.get(atlas);
    if (hit && hit.sig === sig) {
      return hit.promise;
    }
    const p = this.createEngine(atlas);
    this.cache.set(atlas, { sig, promise: p });
    return p;
  }

  private async createEngine(atlas: string): Promise<AuthoringEngine> {
    const vaultPath = join(this.storageRoot, atlas, 'atlas.mld');
    const flushOpt =
      this.bufferFlushRowThreshold !== undefined
        ? { bufferFlushRowThreshold: this.bufferFlushRowThreshold }
        : {};
    if (existsSync(vaultPath) && (await fileLooksLikeAtlasSingleVault(vaultPath))) {
      const vs = this.vaultSecret ?? process.env.MODEL_DB_VAULT_SECRET;
      if (!vs || vs.length === 0) {
        throw new Error(
          `Atlas "${atlas}" uses single-file vault but no vault secret (MODEL_DB_VAULT_SECRET / config).`,
        );
      }
      return new AuthoringEngine({
        atlas,
        storageRoot: this.storageRoot,
        singleFileVault: true,
        vaultSecret: vs,
        engineLogger: true,
        ...flushOpt,
      });
    }
    return new AuthoringEngine({
      atlas,
      storageRoot: this.storageRoot,
      engineLogger: true,
      ...flushOpt,
    });
  }
}
