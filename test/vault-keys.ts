import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { VaultSecurityError, type VaultKeyMaterial, type VaultKeyProvider } from '@mode-db/common';

const providers = new Map<string, VaultKeyProvider>();

/** In-memory test-only key store. Production never imports this fixture. */
export function fixtureVaultKeys(root: string): VaultKeyProvider {
  const path = resolve(root);
  const hit = providers.get(path);
  if (hit) return hit;
  const instanceId = randomUUID();
  const keys = new Map<string, VaultKeyMaterial>();
  const provider: VaultKeyProvider = {
    resolveKey(_atlas, existing) {
      if (existing) {
        const stored = keys.get(existing.keyId);
        if (!stored || JSON.stringify(stored.reference) !== JSON.stringify(existing))
          throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
        return stored;
      }
      const material = {
        reference: { instanceId, databaseId: randomUUID(), keyId: randomUUID(), keyVersion: 1 },
        key: randomBytes(32),
      };
      keys.set(material.reference.keyId, material);
      return material;
    },
  };
  providers.set(path, provider);
  return provider;
}
