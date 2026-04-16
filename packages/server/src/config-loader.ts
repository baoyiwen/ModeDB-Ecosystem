import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { resolveModelDbConfigPathFromCli } from './modeldb-default-home.js';

export interface ModelDBServerFileConfig {
  readonly port?: number;
  readonly host?: string;
  /**
   * **首选**：逻辑库工作区根目录；每个逻辑库为 **`<workspace>/<dbName>/`**（内含 **`atlas.mld`** 等）。
   * 与 **`storageRoot`**、**`dbPath`**（目录或 **`.mld` 文件**）互为别名，按合并顺序取第一个非空。
   */
  readonly workspace?: string;
  readonly storageRoot?: string;
  /** @deprecated Prefer **`workspace`**. 目录或 **`*.mld`** 文件路径（父目录为根、basename 无扩展名为默认逻辑库名）。 */
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
  readonly dev?: boolean;
}

export interface ResolvedModelDBServerConfig {
  readonly port: number;
  readonly host: string;
  /**
   * 逻辑库工作区根；客户端 **`dbName` / `atlas`** 对应 **`<storageRoot>/<name>/`**。
   */
  readonly storageRoot: string;
  /** Same as **`storageRoot`** when loaded from file; optional when callers pass **`storageRoot`** only. */
  readonly workspace?: string;
  /** When legacy **`dbPath`** pointed at **`world.mld`**, suggested default logical name **`world`**. */
  readonly defaultAtlas?: string;
  /** Absolute directory for **`system.log`** / **`access.log`** when **`logDir`** is set in config. */
  readonly serverLogDirectory?: string;
  /** Passed to {@link AuthoringEngineOptions.bufferFlushRowThreshold} for server-side engines. */
  readonly bufferFlushRowThreshold?: number;
  readonly cacheSizeHint?: string;
  readonly mode?: string;
  readonly connectToken: string;
  readonly dev: boolean;
  /** When true, **`access.log`** profiling is enabled (see **`loadModelDBServerConfig`**). */
  readonly accessLog?: boolean;
  /** Absolute path of the loaded **`modeldb.config.json`** (implicit default or **`-c`**). */
  readonly configFilePath: string;
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

/**
 * **`-c`**：会话**数据根目录**（内含 **`modeldb.config.json`**、**`logs/`**、**`cache/`**、**`vault/`**），
 * 或指向已存在的配置文件路径（兼容旧 CLI）；详见 **`resolveModelDbConfigPathFromCli`**。
 */
function resolveConfigFilePath(cliConfigPath: string | undefined): string {
  return resolveModelDbConfigPathFromCli(cliConfigPath);
}

function resolveStorageRootAndAtlas(
  raw: string | undefined,
  pathBase: string,
): { readonly storageRoot: string; readonly defaultAtlas?: string } {
  if (!raw) {
    return { storageRoot: resolve(pathBase, 'vault') };
  }
  const abs = resolve(pathBase, raw);
  const base = basename(abs);
  if (base.toLowerCase().endsWith('.mld')) {
    return { storageRoot: dirname(abs), defaultAtlas: base.replace(/\.mld$/i, '') };
  }
  return { storageRoot: abs };
}

export interface CliConfigOverrides {
  readonly port?: number;
  readonly host?: string;
  readonly connectToken?: string;
  readonly dev?: boolean;
  readonly bufferThreshold?: number;
}

/**
 * Per-key merge order: CLI overrides（**`port`/`host`/`connectToken`/`dev`/`bufferThreshold`**）→ **`modeldb.config.json`**
 * → 环境变量 → 默认值（如 port **9090**，host **127.0.0.1**，dev **false**）。**`workspace`/`logDir`** 等路径**仅**来自 JSON（及 **`-c`** 会话根），不由 CLI 覆盖。
 *
 * **`connectToken`**：同一顺序 **CLI → 文件 → `MODEL_DB_CONNECT_TOKEN`**；仅当左侧为 **`null`/`undefined`**
 * 时才继续（空字符串的 CLI 入参在 **`cli.ts`** 中已归一为 **`undefined`**，避免误覆盖文件中的令牌）。
 * 逻辑库根等路径**仅**来自 **`modeldb.config.json`**（及 **`-c`** 会话根下的相对 **`vault`/`logs`** 约定），**`modeldb-server` CLI 不提供 `--workspace`**。
 *
 * 当 **`configPath === undefined`**（未传 **`-c`**）时：配置文件**仅**来自默认主目录下的
 * **`modeldb.config.json`**；**`workspace`/`storageRoot`/`dbPath`** **不**再读取
 * **`MODEL_DB_WORKSPACE` / `MODEL_DB_STORAGE_ROOT` / `STORAGE_ROOT`**，以免与默认主目录配置「串线」。
 * 端口等仍可由 **`MODEL_DB_PORT`** 等覆盖（便于容器编排）。
 */
export async function loadModelDBServerConfig(
  configPath: string | undefined,
  cli: CliConfigOverrides,
): Promise<ResolvedModelDBServerConfig> {
  const implicitDefaultHome = configPath === undefined;

  let file: ModelDBServerFileConfig = {};
  const path = resolveConfigFilePath(configPath);
  const pathBase = dirname(path);
  const fileExists = existsSync(path);
  if (fileExists) {
    const raw = await readFile(path, 'utf-8');
    file = JSON.parse(raw) as ModelDBServerFileConfig;
  }

  const port = cli.port ?? file.port ?? numEnv('MODEL_DB_PORT') ?? 9090;

  const host = cli.host ?? file.host ?? strEnv('MODEL_DB_HOST') ?? '127.0.0.1';

  const storageEnvBranch = implicitDefaultHome
    ? undefined
    : (strEnv('MODEL_DB_WORKSPACE') ?? strEnv('MODEL_DB_STORAGE_ROOT') ?? strEnv('STORAGE_ROOT'));

  const storageRootRaw =
    file.workspace ?? file.storageRoot ?? file.dbPath ?? storageEnvBranch ?? 'vault';
  const { storageRoot, defaultAtlas } = resolveStorageRootAndAtlas(storageRootRaw, pathBase);

  const envTokenPresent = strEnv('MODEL_DB_CONNECT_TOKEN') !== undefined;
  const cliTokenEffective =
    cli.connectToken !== undefined && String(cli.connectToken).trim() !== ''
      ? String(cli.connectToken).trim()
      : undefined;

  const connectTokenRaw =
    cliTokenEffective ?? file.connectToken ?? strEnv('MODEL_DB_CONNECT_TOKEN') ?? '';
  const connectToken =
    typeof connectTokenRaw === 'string' ? connectTokenRaw.trim() : String(connectTokenRaw).trim();

  const dev = cli.dev ?? boolEnv('MODEL_DB_DEV') ?? file.dev ?? false;

  const serverLogDirectory =
    file.logDir !== undefined && file.logDir.length > 0
      ? resolve(pathBase, file.logDir)
      : undefined;

  const bufferFlushRowThreshold =
    cli.bufferThreshold ?? file.bufferThreshold ?? numEnv('MODEL_DB_BUFFER_THRESHOLD');

  const mode = file.mode?.trim().toLowerCase();
  const accessLog = mode === 'production' || boolEnv('MODEL_DB_ACCESS_LOG') === true;

  if (!connectToken) {
    throw new Error(
      'ModelDB server: missing connectToken. ' +
        `config file: ${path} (exists=${fileExists}). ` +
        `MODEL_DB_CONNECT_TOKEN: ${envTokenPresent ? 'set' : 'not set'}. ` +
        'Merge order: CLI --token → file "connectToken" → MODEL_DB_CONNECT_TOKEN.',
    );
  }

  return {
    port,
    host,
    storageRoot,
    workspace: storageRoot,
    defaultAtlas,
    serverLogDirectory,
    bufferFlushRowThreshold:
      bufferFlushRowThreshold !== undefined && bufferFlushRowThreshold > 0
        ? bufferFlushRowThreshold
        : undefined,
    cacheSizeHint: file.cacheSize,
    mode: file.mode,
    connectToken,
    dev,
    configFilePath: path,
    ...(accessLog ? { accessLog: true as const } : {}),
  };
}
