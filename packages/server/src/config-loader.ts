import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export interface ModelDBServerFileConfig {
  readonly port?: number;
  readonly host?: string;
  readonly storageRoot?: string;
  /** Storage root, or a **`*.mld`** file path (parent dir becomes root, basename without extension → default atlas). */
  readonly dbPath?: string;
  /** Server / ops log directory (**`system.log`**, **`access.log`**). */
  readonly logDir?: string;
  /** When **`bufferThreshold`** staged rows exist for a model, flush that model to disk (authoring engines on server). */
  readonly bufferThreshold?: number;
  /** Reserved / telemetry only in this version (e.g. **`2GB`**). */
  readonly cacheSize?: string;
  /** When **`production`**, enables **`access.log`** HTTP / query / decode / write-gate lines. */
  readonly mode?: string;
  readonly connectToken?: string;
  readonly vaultSecret?: string;
  readonly vaultKey?: string;
  readonly dev?: boolean;
}

export interface ResolvedModelDBServerConfig {
  readonly port: number;
  readonly host: string;
  readonly storageRoot: string;
  /** When **`dbPath`** pointed at **`world.mld`**, suggested atlas name **`world`**. */
  readonly defaultAtlas?: string;
  /** Absolute directory for **`system.log`** / **`access.log`** when **`logDir`** is set in config. */
  readonly serverLogDirectory?: string;
  /** Passed to {@link AuthoringEngineOptions.bufferFlushRowThreshold} for server-side engines. */
  readonly bufferFlushRowThreshold?: number;
  readonly cacheSizeHint?: string;
  readonly mode?: string;
  readonly connectToken: string;
  readonly vaultSecret?: string;
  readonly dev: boolean;
  /** When true, **`access.log`** profiling is enabled (see **`loadModelDBServerConfig`**). */
  readonly accessLog?: boolean;
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

function boolEnv(name: string): boolean | undefined {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) {
    return undefined;
  }
  if (v === '1' || v === 'true' || v === 'yes') {
    return true;
  }
  if (v === '0' || v === 'false' || v === 'no') {
    return false;
  }
  return undefined;
}

function resolveStorageRootAndAtlas(
  raw: string | undefined,
  cwd: string,
): { readonly storageRoot: string; readonly defaultAtlas?: string } {
  if (!raw) {
    return { storageRoot: resolve(cwd, 'data') };
  }
  const abs = resolve(cwd, raw);
  const base = basename(abs);
  if (base.toLowerCase().endsWith('.mld')) {
    return { storageRoot: dirname(abs), defaultAtlas: base.replace(/\.mld$/i, '') };
  }
  return { storageRoot: abs };
}

export interface CliConfigOverrides {
  readonly port?: number;
  readonly host?: string;
  readonly storageRoot?: string;
  readonly dbPath?: string;
  readonly connectToken?: string;
  readonly vaultSecret?: string;
  readonly vaultKey?: string;
  readonly dev?: boolean;
  readonly bufferThreshold?: number;
}

/**
 * Priority: CLI > `modeldb.config.json` > environment variables > defaults
 * (port **9090**, host **127.0.0.1**, dev **false**).
 */
export async function loadModelDBServerConfig(
  configPath: string | undefined,
  cli: CliConfigOverrides,
): Promise<ResolvedModelDBServerConfig> {
  let file: ModelDBServerFileConfig = {};
  const path = configPath ? resolve(configPath) : resolve(process.cwd(), 'modeldb.config.json');
  if (existsSync(path)) {
    const raw = await readFile(path, 'utf-8');
    file = JSON.parse(raw) as ModelDBServerFileConfig;
  }

  const port = cli.port ?? file.port ?? numEnv('MODEL_DB_PORT') ?? 9090;

  const host = cli.host ?? file.host ?? strEnv('MODEL_DB_HOST') ?? '127.0.0.1';

  const storageRootRaw =
    cli.storageRoot ??
    cli.dbPath ??
    file.storageRoot ??
    file.dbPath ??
    strEnv('MODEL_DB_STORAGE_ROOT') ??
    strEnv('STORAGE_ROOT') ??
    'data';
  const { storageRoot, defaultAtlas } = resolveStorageRootAndAtlas(storageRootRaw, process.cwd());

  const connectTokenRaw =
    cli.connectToken ?? file.connectToken ?? strEnv('MODEL_DB_CONNECT_TOKEN') ?? '';
  const connectToken =
    typeof connectTokenRaw === 'string' ? connectTokenRaw.trim() : String(connectTokenRaw).trim();

  const vaultSecret =
    cli.vaultSecret ??
    cli.vaultKey ??
    file.vaultSecret ??
    file.vaultKey ??
    strEnv('MODEL_DB_VAULT_SECRET');

  const dev = cli.dev ?? boolEnv('MODEL_DB_DEV') ?? file.dev ?? false;

  const serverLogDirectory =
    file.logDir !== undefined && file.logDir.length > 0
      ? resolve(process.cwd(), file.logDir)
      : undefined;

  const bufferFlushRowThreshold =
    cli.bufferThreshold ?? file.bufferThreshold ?? numEnv('MODEL_DB_BUFFER_THRESHOLD');

  const mode = file.mode?.trim().toLowerCase();
  const accessLog = mode === 'production' || boolEnv('MODEL_DB_ACCESS_LOG') === true;

  if (!connectToken) {
    throw new Error(
      'ModelDB server: missing connectToken — set modeldb.config.json "connectToken", MODEL_DB_CONNECT_TOKEN, or --token.',
    );
  }

  return {
    port,
    host,
    storageRoot,
    defaultAtlas,
    serverLogDirectory,
    bufferFlushRowThreshold:
      bufferFlushRowThreshold !== undefined && bufferFlushRowThreshold > 0
        ? bufferFlushRowThreshold
        : undefined,
    cacheSizeHint: file.cacheSize,
    mode: file.mode,
    connectToken,
    vaultSecret,
    dev,
    ...(accessLog ? { accessLog: true as const } : {}),
  };
}
