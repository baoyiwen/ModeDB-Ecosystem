/**
 * Shared single-file vault configuration for integration tests.
 * Call {@link useIntegrationVaultEnv} once per process before {@link ModelDBClient.connect}.
 */
import { AtlasSingleVault } from '../authoring/atlas-single-vault.js';
import {
  PathResolver,
  deriveAtlasVaultSecretFromConnectToken,
  type RelationIndexData,
} from '@mode-db/common';

/** Same string used as wire **`connectToken`** in integration scripts (derives the vault key). */
export const INTEGRATION_CONNECT_TOKEN = 'mode-db-engine-integration-connect-token-fixed-len!!';

/** Derived passphrase for low-level {@link AtlasSingleVault} helpers in tests. */
export const integrationVaultDerivedSecret =
  deriveAtlasVaultSecretFromConnectToken(INTEGRATION_CONNECT_TOKEN);

export const integrationVaultAuthoringOptions = {
  connectToken: INTEGRATION_CONNECT_TOKEN,
};

export function useIntegrationVaultEnv(): void {
  process.env.MODEL_DB_CONNECT_TOKEN = INTEGRATION_CONNECT_TOKEN;
}

export function atlasVaultPath(storageRoot: string, atlasName: string): string {
  return new PathResolver(storageRoot, atlasName).atlasSingleVaultPath();
}

/** Load relation index JSON from an on-disk vault (after flush). */
export function loadVaultRelationData(
  storageRoot: string,
  atlasName: string,
  relationBaseKey: string,
  secret: string = integrationVaultDerivedSecret,
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
  secret: string = integrationVaultDerivedSecret,
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
  secret: string = integrationVaultDerivedSecret,
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
  fn: (data: RelationIndexData) => void,
  secret: string = integrationVaultDerivedSecret,
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
