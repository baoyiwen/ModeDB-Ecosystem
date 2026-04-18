import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticCenter, ErrorCodes, PathResolver } from '@mode-db/common';
import { AuthoringEngine, fileLooksLikeAtlasSingleVault } from '@mode-db/core';
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

  /** Drop cached engine for a logical DB (e.g. after **`rm` workspace directory**). */
  evict(atlas: string): void {
    this.cache.delete(atlas);
  }

  private async createEngine(atlas: string): Promise<AuthoringEngine> {
    const flushOpt =
      this.bufferFlushRowThreshold !== undefined
        ? { bufferFlushRowThreshold: this.bufferFlushRowThreshold }
        : {};
    const nestedDir = join(this.storageRoot, atlas);
    const nestedVaultPath = join(nestedDir, 'atlas.mld');
    const flatVaultPath = PathResolver.workspaceFlatVaultPath(this.storageRoot, atlas);
    const ct = this.connectToken.trim();
    if (!ct) {
      throw new Error('AuthoringBridge: connectToken must be non-empty.');
    }

    const baseEngineOpts = {
      atlas,
      storageRoot: this.storageRoot,
      connectToken: ct,
      engineLogger: true as const,
      ...flushOpt,
    };

    if (existsSync(nestedVaultPath)) {
      if (!(await fileLooksLikeAtlasSingleVault(nestedVaultPath))) {
        throw new Error(
          `AuthoringBridge: "${nestedVaultPath}" exists but is not a valid atlas single-file vault.`,
        );
      }
      return new AuthoringEngine(baseEngineOpts);
    }

    if (existsSync(flatVaultPath)) {
      if (!(await fileLooksLikeAtlasSingleVault(flatVaultPath))) {
        throw new Error(
          `AuthoringBridge: "${flatVaultPath}" exists but is not a valid atlas single-file vault.`,
        );
      }
      return new AuthoringEngine({
        ...baseEngineOpts,
        paths: new PathResolver(this.storageRoot, atlas, { workspaceFlatVault: true }),
      });
    }

    // Management API creates `<workspace>/<atlas>/` first; `atlas.mld` is created by {@link AuthoringEngine}.
    if (existsSync(nestedDir) && statSync(nestedDir).isDirectory()) {
      return new AuthoringEngine(baseEngineOpts);
    }

    DiagnosticCenter.report(
      ErrorCodes.DATABASE_NOT_FOUND,
      { dbName: atlas, path: flatVaultPath },
      'throw',
    );
    throw new Error('AuthoringBridge.createEngine: unreachable after DATABASE_NOT_FOUND');
  }
}
