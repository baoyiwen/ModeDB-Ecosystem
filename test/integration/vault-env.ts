/**
 * Shared **`connectToken`** for integration tests (derives the atlas vault key via the same rules as production).
 */
export const INTEGRATION_CONNECT_TOKEN =
  'modedb-ecosystem-integration-connect-token-fixed-len!!';

export function useIntegrationVaultEnv(): void {
  process.env.MODEL_DB_CONNECT_TOKEN = INTEGRATION_CONNECT_TOKEN;
}
