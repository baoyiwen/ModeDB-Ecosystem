import { dirname, join } from 'node:path';
import type { VaultKeyProvider } from '@mode-db/common';
import type { ResolvedModelDBServerConfig } from '../config-loader.js';
import { LocalVaultKeyProvider } from './local-vault-key-provider.js';

/** Resolve keys beneath the instance/config home, never beneath a business Vault. */
export function serverVaultKeys(cfg: ResolvedModelDBServerConfig): VaultKeyProvider {
  return (
    cfg.vaultKeyProvider ?? new LocalVaultKeyProvider(join(dirname(cfg.configFilePath), 'security'))
  );
}
