import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticCenter, ErrorCodes, PathResolver, type VaultKeyProvider } from '@mode-db/common';
import { AuthoringEngine } from '@mode-db/core';

/**
 * Lazily constructs {@link AuthoringEngine} per logical database (**`<workspace>/<db>/atlas.mld`**)
 * for server-side writes. An engine stays cached for the lifetime of the server
 * and is rebuilt only after an explicit {@link evict}.
 *
 * The server is the owner of the vault while it is running. Recreating the
 * engine whenever `atlas.mld` changes is unsafe: every successful mutation
 * changes the file mtime, so the next queued request can try to open the file
 * while the previous engine is still flushing it. Besides producing intermittent
 * Windows `open(...atlas.mld)` errors, that can discard the in-memory registry.
 */
export class AuthoringBridge {
  private readonly cache = new Map<string, { readonly promise: Promise<AuthoringEngine> }>();

  constructor(
    private readonly storageRoot: string,
    private readonly keyProvider: VaultKeyProvider,
    private readonly bufferFlushRowThreshold?: number,
  ) {}

  getEngine(atlas: string): Promise<AuthoringEngine> {
    const hit = this.cache.get(atlas);
    if (hit) {
      return hit.promise;
    }
    const p = this.createEngine(atlas);
    // Store the in-flight promise immediately so concurrent callers share the
    // same initialization and never open the vault more than once.
    this.cache.set(atlas, { promise: p });
    p.catch(() => {
      // A failed initialization must remain retryable after the underlying
      // cause is fixed (for example, after a transient file access failure).
      const current = this.cache.get(atlas);
      if (current?.promise === p) {
        this.cache.delete(atlas);
      }
    });
    return p;
  }

  /** Drop cached engine for a logical DB (e.g. after **`rm` workspace directory**). */
  evict(atlas: string): void {
    const cached = this.cache.get(atlas);
    this.cache.delete(atlas);
    void cached?.promise
      .then((engine) => engine.dispose())
      .catch(() => {
        /* initialization already failed */
      });
  }

  /** Flush and release all active engines on server shutdown. */
  async close(): Promise<void> {
    const engines = [...this.cache.values()];
    this.cache.clear();
    await Promise.all(
      engines.map(async ({ promise }) => {
        await (await promise).close();
      }),
    );
  }

  private async createEngine(atlas: string): Promise<AuthoringEngine> {
    const flushOpt =
      this.bufferFlushRowThreshold !== undefined
        ? { bufferFlushRowThreshold: this.bufferFlushRowThreshold }
        : {};
    const nestedDir = join(this.storageRoot, atlas);
    const nestedVaultPath = join(nestedDir, 'atlas.mld');
    const flatVaultPath = PathResolver.workspaceFlatVaultPath(this.storageRoot, atlas);
    const baseEngineOpts = {
      atlas,
      storageRoot: this.storageRoot,
      keyProvider: this.keyProvider,
      // Server startup owns the process-wide logger. Opening a library must
      // not redirect it into the vault or reset its access-log configuration.
      engineLogger: false as const,
      ...flushOpt,
    };

    const present = (path: string): boolean =>
      ['', '.pending', '.commit', '.lock', '.reclaim'].some((suffix) => existsSync(path + suffix));
    if (present(nestedVaultPath)) {
      return new AuthoringEngine(baseEngineOpts);
    }

    if (present(flatVaultPath)) {
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
