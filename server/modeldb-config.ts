import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export interface ModelDBServerFileConfig {
  readonly port?: number;
  readonly storageRoot?: string;
  /** Shared secret for client handshake (not sent on the wire inside ciphertext). */
  readonly connectToken?: string;
  /** Passed to `process.env.MODEL_DB_VAULT_SECRET` when opening vault atlases. */
  readonly vaultSecret?: string;
}

export interface ResolvedModelDBServerConfig {
  readonly port: number;
  readonly storageRoot: string;
  readonly connectToken: string;
  readonly vaultSecret?: string;
}

function numEnv(name: string): number | undefined {
  const v = process.env[name]?.trim();
  if (!v) {
    return undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function strEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : undefined;
}

/**
 * Load `modeldb.config.json` if present; CLI and env override file values.
 */
export async function loadModelDBServerConfig(
  configPath: string | undefined,
  cli: { port?: number; storageRoot?: string; connectToken?: string },
): Promise<ResolvedModelDBServerConfig> {
  let file: ModelDBServerFileConfig = {};
  const path = configPath ? resolve(configPath) : resolve(process.cwd(), 'modeldb.config.json');
  if (existsSync(path)) {
    const raw = await readFile(path, 'utf-8');
    file = JSON.parse(raw) as ModelDBServerFileConfig;
  }

  const port = cli.port ?? numEnv('MODEL_DB_PORT') ?? file.port ?? 8787;

  const storageRootRaw =
    cli.storageRoot ??
    strEnv('MODEL_DB_STORAGE_ROOT') ??
    strEnv('STORAGE_ROOT') ??
    file.storageRoot ??
    'data';
  const storageRoot = resolve(process.cwd(), storageRootRaw);

  const connectToken =
    cli.connectToken ?? strEnv('MODEL_DB_CONNECT_TOKEN') ?? file.connectToken ?? '';

  const vaultSecret = strEnv('MODEL_DB_VAULT_SECRET') ?? file.vaultSecret;

  if (!connectToken) {
    throw new Error(
      'ModelDB server: missing connectToken — set modeldb.config.json "connectToken", MODEL_DB_CONNECT_TOKEN, or --token.',
    );
  }

  return { port, storageRoot, connectToken, vaultSecret };
}
