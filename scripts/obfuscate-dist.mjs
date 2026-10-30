#!/usr/bin/env node
/**
 * Post-process compiled `.js` under each package `dist/` after `tsc`: compress +
 * mangle (Terser). 每个 ESM 模块独立分配局部名称；共享变量缓存会误改其他
 * 模块的同名全局引用（例如 Buffer）。公共导出与属性名称保留。
 *
 * 关于「方法名 / 属性名」：工作区包之间通过 `import` 与 `.method()` 字面量耦合；
 * 若对 `dist` 做属性级混淆（rename object keys / class methods），其它包里仍写着
 * 原方法名的调用会运行失败。要在**单文件**里把方法名也抹掉，需要先把依赖打成一个
 * bundle 再混淆（例如对独立可执行入口用 esbuild/rollup 单文件后再上强混淆）。
 *
 * Skips when `DIST_OBFUSCATE=0`（可读 dist，便于调试）。
 * 单包 `pnpm --filter ... build` 后可：`pnpm run obfuscate:dist`
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minifyModule } from './minify-module.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Do not obfuscate `sdk`: browsers / Vite apps import `@mode-db/sdk` and call public API by name
// (e.g. `new ModelDB(...).createDatabase()`). Per-file mangle renames class methods and breaks that.
const PACKAGES = ['shared', 'common', 'core', 'server'];

/** @param {string} dir */
function* walkJsFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkJsFiles(p);
    } else if (ent.isFile() && ent.name.endsWith('.js')) {
      yield p;
    }
  }
}

/**
 * @param {string} absPath
 */
async function obfuscateOne(absPath) {
  let src = await readFile(absPath, 'utf8');
  let shebang = '';
  if (src.startsWith('#!')) {
    const nl = src.indexOf('\n');
    shebang = nl === -1 ? src : src.slice(0, nl + 1);
    src = nl === -1 ? '' : src.slice(nl + 1);
  }

  let out = await minifyModule(src);
  if (shebang && !out.startsWith('#!')) {
    out = shebang + out;
  }
  await writeFile(absPath, out, 'utf8');
}

/** @param {string} distDir */
async function obfuscatePackageDist(distDir, label) {
  const files = [...walkJsFiles(distDir)].sort();
  if (files.length === 0) {
    return 0;
  }
  for (const absPath of files) {
    await obfuscateOne(absPath);
  }
  console.log(`  ${label}: ${files.length} file(s)`);
  return files.length;
}

async function main() {
  if (process.env.DIST_OBFUSCATE === '0') {
    console.log('[obfuscate-dist] DIST_OBFUSCATE=0 — skip.\n');
    return;
  }

  let total = 0;
  const todo = [];
  for (const pkg of PACKAGES) {
    const dist = join(repoRoot, 'packages', pkg, 'dist');
    if (!existsSync(dist) || !statSync(dist).isDirectory()) {
      continue;
    }
    todo.push({ dist, pkg });
  }

  if (todo.length === 0) {
    console.warn('[obfuscate-dist] No packages/*/dist found; run tsc builds first.\n');
    return;
  }

  console.log('[obfuscate-dist] Terser (independent module scopes, keep_fnames off):\n');
  for (const { dist, pkg } of todo) {
    total += await obfuscatePackageDist(dist, `@mode-db/${pkg}`);
  }

  console.log(`\n[obfuscate-dist] Done. ${total} file(s) total.\n`);
}

await main();
