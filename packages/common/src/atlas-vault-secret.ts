import { createHmac } from 'node:crypto';

/** Stable pepper; changing it invalidates all existing on-disk vaults. */
const ATLAS_VAULT_KEY_PEPPER = 'mode-db-engine:atlas-single-vault-key:v1';

/**
 * Derives the AES/scrypt passphrase for the single-file atlas vault from the wire **`connectToken`**.
 * Same **`connectToken`** must be used for {@link AuthoringEngine} and {@link ModelDBClient.connect}.
 */
export function deriveAtlasVaultSecretFromConnectToken(connectToken: string): string {
  const t = typeof connectToken === 'string' ? connectToken.trim() : String(connectToken).trim();
  if (!t) {
    throw new Error('deriveAtlasVaultSecretFromConnectToken: connectToken must be non-empty.');
  }
  return createHmac('sha256', ATLAS_VAULT_KEY_PEPPER).update(t, 'utf8').digest('base64url');
}
