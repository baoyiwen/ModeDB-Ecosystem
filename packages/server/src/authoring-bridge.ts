import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticCenter, ErrorCodes } from '@mode-db/common';
import { AuthoringEngine, fileLooksLikeAtlasSingleVault } from 'mode-db-engine';
import { atlasCatalogSignature } from './atlas-catalog-signature.js';

/**
 * Lazily constructs {@link AuthoringEngine} per logical database (**`<workspace>/<db>/atlas.mld`**)
 * for server-side writes. Cache is invalidated when vault mtimes change (see **`atlasCatalogSignature`**).
 */
export class AuthoringBridge {
  private readonly cache = new Map<
    string,
    { readonly sig: string; readonly promise: Promise<AuthoringEngine> }
  >();

  constructor(
    private readonly storageRoot: string,
    private readonly connectToken: string,
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
    const flushOpt =
      this.bufferFlushRowThreshold !== undefined
        ? { bufferFlushRowThreshold: this.bufferFlushRowThreshold }
        : {};
    const nestedVaultPath = join(this.storageRoot, atlas, 'atlas.mld');
    const ct = this.connectToken.trim();
    if (!ct) {
      throw new Error('AuthoringBridge: connectToken must be non-empty.');
    }

    if (existsSync(nestedVaultPath) && (await fileLooksLikeAtlasSingleVault(nestedVaultPath))) {
      return new AuthoringEngine({
        atlas,
        storageRoot: this.storageRoot,
        connectToken: ct,
        engineLogger: true,
        ...flushOpt,
      });
    }

    DiagnosticCenter.report(
      ErrorCodes.DATABASE_NOT_FOUND,
      { dbName: atlas, path: nestedVaultPath },
      'throw',
    );
    throw new Error('AuthoringBridge.createEngine: unreachable after DATABASE_NOT_FOUND');
  }
}
