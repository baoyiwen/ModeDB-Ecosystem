import { resolve } from 'node:path';
import { DEFAULT_STORAGE_ROOT } from './default-storage-root.js';

/**
 * Programmatic STORAGE_ROOT override (takes precedence over `MODEL_DB_STORAGE_ROOT`).
 */
let storageRootOverride: string | undefined;

export interface ModelDBStorageRootConfig {
  storageRoot?: string;
}

/**
 * Configure STORAGE_ROOT for both authoring engines and {@link ModelDBClient.connect}.
 */
export function configureModelDBStorageRoot(config: ModelDBStorageRootConfig): void {
  if (config.storageRoot !== undefined) {
    storageRootOverride = resolve(config.storageRoot);
  }
}

/**
 * 1. {@link configureModelDBStorageRoot}
 * 2. `STORAGE_ROOT` (if set)
 * 3. `MODEL_DB_STORAGE_ROOT` (if set)
 * 4. {@link DEFAULT_STORAGE_ROOT}
 */
export function resolveModelDBStorageRoot(): string {
  if (storageRootOverride !== undefined) {
    return storageRootOverride;
  }
  const storageRootEnv = process.env.STORAGE_ROOT?.trim();
  if (storageRootEnv && storageRootEnv.length > 0) {
    return resolve(storageRootEnv);
  }
  const env = process.env.MODEL_DB_STORAGE_ROOT?.trim();
  if (env && env.length > 0) {
    return resolve(env);
  }
  return DEFAULT_STORAGE_ROOT;
}
