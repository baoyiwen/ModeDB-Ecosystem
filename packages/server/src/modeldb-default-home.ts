import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { readPersistedModelDbHomePath } from './modeldb-persisted-home.js';

/**
 * 用户数据根目录（配置、日志、缓存、默认 vault），优先级：
 *
 * 1. 环境变量 **`MODELDB_HOME`**
 * 2. **`modeldb-server set`** 写入的 **`~/.modeldb/home`**（单行绝对路径）
 * 3. OS 默认：**`%LOCALAPPDATA%/modeldb`** / **`~/Library/...`** / **`~/.local/share/modeldb`**
 */
export function getModelDbHome(): string {
  const env = process.env.MODELDB_HOME?.trim();
  if (env) {
    return resolve(env);
  }
  const persisted = readPersistedModelDbHomePath();
  if (persisted) {
    return resolve(persisted);
  }
  const sys = platform();
  if (sys === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim();
    return resolve(
      local && local.length > 0 ? local : join(homedir(), 'AppData', 'Local'),
      'modeldb',
    );
  }
  if (sys === 'darwin') {
    return resolve(join(homedir(), 'Library', 'Application Support'), 'modeldb');
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return resolve(xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share'), 'modeldb');
}

export function getDefaultModelDbConfigPath(): string {
  return join(getModelDbHome(), 'modeldb.config.json');
}

const DEFAULT_SUBDIRS = ['logs', 'cache', 'vault'] as const;

/**
 * 在 **`home`** 下创建 **`logs/`**、**`cache/`**、**`vault/`**；若不存在 **`modeldb.config.json`** 则写入默认内容
 *（**`logDir`/`workspace` 为相对路径** **`logs`** / **`vault`**，相对本文件所在目录解析）。
 *
 * @returns **`modeldb.config.json`** 绝对路径
 */
export function ensureModelDbLayoutAtRoot(home: string): string {
  const root = resolve(home);
  mkdirSync(root, { recursive: true });
  for (const d of DEFAULT_SUBDIRS) {
    mkdirSync(join(root, d), { recursive: true });
  }
  const cfgPath = join(root, 'modeldb.config.json');
  if (!existsSync(cfgPath)) {
    const connectToken = randomBytes(32).toString('hex');
    const payload = {
      port: 9090,
      host: '127.0.0.1',
      advertisedHost: '',
      publicBaseUrl: '',
      logDir: 'logs',
      workspace: 'vault',
      bufferThreshold: 50_000,
      cacheSize: '2GB',
      mode: 'development',
      designerWorkspace: 'model_designer_workspace',
      connectToken,
      autoBackup: {
        enabled: false,
        intervalMinutes: 60,
        runOnStart: false,
        reason: 'auto',
      },
      dev: false,
    };
    writeFileSync(cfgPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  }
  return cfgPath;
}

/**
 * @deprecated 使用 **`ensureModelDbLayoutAtRoot(getModelDbHome())`**。
 */
export function ensureModelDbHomeLayout(): string {
  return ensureModelDbLayoutAtRoot(getModelDbHome());
}

/**
 * 将 **`-c`** 解析为本次会话的**数据根目录**（其下为 **`modeldb.config.json`**、**`logs/`**、**`cache/`**、**`vault/`**），
 * 或兼容旧用法：指向已存在的 **`.json`** 文件时，会话根为其父目录。
 *
 * - **`undefined`**：默认主目录（**`MODELDB_HOME` / set / OS 默认**）并确保布局。
 * - **目录**：确保布局后返回 **`&lt;dir&gt;/modeldb.config.json`**。
 * - **已存在的 `.json` 文件**：确保**父目录**布局后返回该文件路径。
 * - **不存在的路径**：若以 **`.json`** 结尾且文件名为 **`modeldb.config.json`**，则创建父目录并生成默认配置；其它 **`.json`** 仅创建父目录与子目录，**不**自动创建该 json（供测试/手写路径）。
 */
export function resolveModelDbConfigPathFromCli(cliPath: string | undefined): string {
  if (cliPath === undefined || cliPath.trim() === '') {
    return ensureModelDbLayoutAtRoot(getModelDbHome());
  }
  const resolved = resolve(cliPath.trim());
  if (existsSync(resolved)) {
    const st = statSync(resolved);
    if (st.isFile()) {
      const root = dirname(resolved);
      ensureModelDbLayoutAtRoot(root);
      return resolved;
    }
    if (st.isDirectory()) {
      ensureModelDbLayoutAtRoot(resolved);
      return join(resolved, 'modeldb.config.json');
    }
  }
  if (resolved.toLowerCase().endsWith('.json')) {
    const root = dirname(resolved);
    const base = basename(resolved).toLowerCase();
    mkdirSync(root, { recursive: true });
    if (base === 'modeldb.config.json') {
      return ensureModelDbLayoutAtRoot(root);
    }
    for (const d of DEFAULT_SUBDIRS) {
      mkdirSync(join(root, d), { recursive: true });
    }
    return resolved;
  }
  mkdirSync(resolved, { recursive: true });
  return ensureModelDbLayoutAtRoot(resolved);
}
