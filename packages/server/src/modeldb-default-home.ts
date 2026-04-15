import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 用户数据根目录（配置、日志、缓存、默认 vault），可被环境变量 **`MODELDB_HOME`** 覆盖。
 *
 * - Windows: **`%LOCALAPPDATA%/modeldb`**
 * - macOS: **`~/Library/Application Support/modeldb`**
 * - 其他: **`$XDG_DATA_HOME/modeldb`** 或 **`~/.local/share/modeldb`**
 */
export function getModelDbHome(): string {
  const env = process.env.MODELDB_HOME?.trim();
  if (env) {
    return resolve(env);
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
 * 确保 **`MODELDB_HOME`** 下存在 **`logs`**、**`cache`**、**`vault`**；
 * 若 **`modeldb.config.json`** 尚不存在，则写入带随机 **`connectToken`** 的默认配置（绝对路径字段）。
 *
 * @returns 默认配置文件绝对路径
 */
export function ensureModelDbHomeLayout(): string {
  const home = getModelDbHome();
  mkdirSync(home, { recursive: true });
  for (const d of DEFAULT_SUBDIRS) {
    mkdirSync(join(home, d), { recursive: true });
  }
  const cfgPath = join(home, 'modeldb.config.json');
  if (!existsSync(cfgPath)) {
    const connectToken = randomBytes(32).toString('hex');
    const payload = {
      port: 9090,
      host: '127.0.0.1',
      logDir: join(home, 'logs'),
      workspace: join(home, 'vault'),
      bufferThreshold: 50_000,
      cacheSize: '2GB',
      mode: 'development',
      connectToken,
      dev: false,
    };
    writeFileSync(cfgPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  }
  return cfgPath;
}
