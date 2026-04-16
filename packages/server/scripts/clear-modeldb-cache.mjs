#!/usr/bin/env node
/**
 * Best-effort removal of **`<ModelDB home>/cache`** when **`@mode-db/server`** is uninstalled.
 * Home resolution matches **`getModelDbHome()`**（**`MODELDB_HOME`** → **`~/.modeldb/home`** → OS 默认）。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

function readPersistedHome() {
  const f = join(homedir(), '.modeldb', 'home');
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

function getModelDbHome() {
  const env = process.env.MODELDB_HOME?.trim();
  if (env) {
    return resolve(env);
  }
  const persisted = readPersistedHome();
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

const cacheDir = join(getModelDbHome(), 'cache');
if (existsSync(cacheDir)) {
  try {
    rmSync(cacheDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
