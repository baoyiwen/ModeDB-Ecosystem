/**
 * Shared single-file vault configuration for integration tests.
 * Call {@link useIntegrationVaultEnv} once per process before {@link ModelDBClient.connect}.
 */
import type { RelationIndexData } from '../common/types.js';
import { AtlasSingleVault } from '../authoring/atlas-single-vault.js';
import { PathResolver } from '../src/common/PathResolver.js';

export const INTEGRATION_VAULT_SECRET = 'mode-db-engine-integration-vault-secret-fixed-length!!';

export const integrationVaultAuthoringOptions = {
  singleFileVault: true as const,
  vaultSecret: INTEGRATION_VAULT_SECRET,
};

export function useIntegrationVaultEnv(): void {
  process.env.MODEL_DB_VAULT_SECRET = INTEGRATION_VAULT_SECRET;
}

export function atlasVaultPath(storageRoot: string, atlasName: string): string {
  return new PathResolver(storageRoot, atlasName).atlasSingleVaultPath();
}

/** Load relation index JSON from an on-disk vault (after flush). */
export function loadVaultRelationData(
  storageRoot: string,
  atlasName: string,
  relationBaseKey: string,
  secret: string,
): RelationIndexData {
  const paths = new PathResolver(storageRoot, atlasName);
  const vault = new AtlasSingleVault();
  const ok = vault.loadSync(paths.atlasSingleVaultPath(), secret);
  if (!ok) {
    throw new Error(`Failed to load vault for atlas "${atlasName}"`);
  }
  const raw = vault.get(AtlasSingleVault.relationKey(relationBaseKey));
  if (!raw) {
    return { fwd: {}, rev: {} };
  }
  return JSON.parse(raw) as RelationIndexData;
}

/** Read model JSONL blob for one model from vault (plaintext lines). */
export function loadVaultModelBlob(
  storageRoot: string,
  atlasName: string,
  modelName: string,
  secret: string,
): string {
  const paths = new PathResolver(storageRoot, atlasName);
  const vault = new AtlasSingleVault();
  const ok = vault.loadSync(paths.atlasSingleVaultPath(), secret);
  if (!ok) {
    throw new Error(`Failed to load vault for atlas "${atlasName}"`);
  }
  return vault.get(AtlasSingleVault.modelKey(modelName)) ?? '';
}

/** Parse embedded manifest JSON string from vault. */
export function loadVaultManifestJson(
  storageRoot: string,
  atlasName: string,
  secret: string,
): string {
  const paths = new PathResolver(storageRoot, atlasName);
  const vault = new AtlasSingleVault();
  const ok = vault.loadSync(paths.atlasSingleVaultPath(), secret);
  if (!ok) {
    throw new Error(`Failed to load vault for atlas "${atlasName}"`);
  }
  const raw = vault.get(AtlasSingleVault.manifestKey);
  if (!raw) {
    throw new Error('Vault has no __manifest__');
  }
  return raw;
}

/** Load → mutate → save relation index inside vault. */
export function mutateVaultRelationData(
  storageRoot: string,
  atlasName: string,
  relationBaseKey: string,
  secret: string,
  fn: (data: RelationIndexData) => void,
): void {
  const paths = new PathResolver(storageRoot, atlasName);
  const vault = new AtlasSingleVault();
  const ok = vault.loadSync(paths.atlasSingleVaultPath(), secret);
  if (!ok) {
    throw new Error(`Failed to load vault for atlas "${atlasName}"`);
  }
  const key = AtlasSingleVault.relationKey(relationBaseKey);
  const raw = vault.get(key) ?? '{"fwd":{},"rev":{}}';
  const data = JSON.parse(raw) as RelationIndexData;
  fn(data);
  vault.set(key, JSON.stringify(data));
  vault.saveSync(paths.atlasSingleVaultPath(), secret);
}
