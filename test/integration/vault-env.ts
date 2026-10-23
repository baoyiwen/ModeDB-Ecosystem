import { join } from 'node:path';
import { LocalVaultKeyProvider } from '@mode-db/server';

/** Shared network authentication token; never used for data encryption. */
export const INTEGRATION_CONNECT_TOKEN =
  'modedb-ecosystem-integration-connect-token-fixed-len!!';

export function useIntegrationVaultEnv(): void {
  process.env.MODEL_DB_CONNECT_TOKEN = INTEGRATION_CONNECT_TOKEN;
}

/** Real OS-protected keys shared with the server's config directory. */
export function integrationVaultKeys(root: string): LocalVaultKeyProvider {
  return new LocalVaultKeyProvider(join(root, 'security'));
}
