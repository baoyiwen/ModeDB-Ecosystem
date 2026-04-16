import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 与 **`postuninstall`** 脚本、运维文档一致：用户级持久化目录（**不**放在数据盘内）。 */
export function getModelDbCliSettingsDir(): string {
  return join(homedir(), '.modeldb');
}

function persistedHomeFile(): string {
  return join(getModelDbCliSettingsDir(), 'home');
}

/**
 * 读取 **`modeldb-server set`** 写入的默认数据根（单行绝对路径）。
 * 若文件不存在或内容无效则返回 **`undefined`**。
 */
export function readPersistedModelDbHomePath(): string | undefined {
  const f = persistedHomeFile();
  if (!existsSync(f)) {
    return undefined;
  }
  try {
    const line = readFileSync(f, 'utf-8').split(/\r?\n/)[0]?.trim();
    return line && line.length > 0 ? line : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 将默认 **`MODELDB_HOME`** 写入 **`~/.modeldb/home`**（仍低于环境变量 **`MODELDB_HOME`** 优先级）。
 */
export function setPersistedModelDbHomePath(resolvedAbsoluteDir: string): void {
  const dir = getModelDbCliSettingsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(persistedHomeFile(), `${resolvedAbsoluteDir.replace(/[/\\]+$/, '')}\n`, 'utf-8');
}
