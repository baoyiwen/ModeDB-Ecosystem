#!/usr/bin/env node
/**
 * Fail if JavaScript / declaration / source-map emit appears under source trees.
 * Build output must live only under each package's `dist/`.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const coreRoot = join(repoRoot, 'packages', 'core');

const DEV_ROOTS = [
  join(coreRoot, 'src'),
  join(coreRoot, 'authoring'),
  join(coreRoot, 'common'),
  join(coreRoot, 'facade'),
  join(coreRoot, 'templates'),
];

function isArtifactFile(name) {
  return (
    name.endsWith('.js.map') ||
    name.endsWith('.d.ts.map') ||
    name.endsWith('.d.ts') ||
    (name.endsWith('.js') && !name.endsWith('.json')) // allow rare config.js if added later — none today
  );
}

/** @param {string} dir */
function* walkFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.git') {
        continue;
      }
      yield* walkFiles(p);
    } else if (ent.isFile() && isArtifactFile(ent.name)) {
      yield p;
    }
  }
}

function collectPackageSrcDirs() {
  const packagesDir = join(repoRoot, 'packages');
  if (!existsSync(packagesDir)) {
    return [];
  }
  const out = [];
  for (const ent of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === 'core') {
      continue;
    }
    const src = join(packagesDir, ent.name, 'src');
    if (existsSync(src) && statSync(src).isDirectory()) {
      out.push(src);
    }
  }
  return out;
}

const roots = [...DEV_ROOTS, ...collectPackageSrcDirs()].filter(
  (p) => existsSync(p) && statSync(p).isDirectory(),
);

const violations = [];
for (const name of ['index.js', 'index.js.map', 'index.d.ts', 'index.d.ts.map']) {
  const p = join(repoRoot, name);
  if (existsSync(p) && statSync(p).isFile()) {
    violations.push(relative(repoRoot, p));
  }
}
for (const root of roots) {
  for (const file of walkFiles(root)) {
    violations.push(relative(repoRoot, file));
  }
}

if (violations.length > 0) {
  console.error(
    '\n[assert-no-build-artifacts-in-src] Build artifacts must not live next to sources.\n' +
      'Remove these files (use `pnpm run build:*` so output goes to `dist/` only), then commit:\n',
  );
  for (const v of violations.sort()) {
    console.error(`  - ${v}`);
  }
  console.error(
    '\nTip: use `pnpm run build:core` (packages/core `tsconfig.build.json`) for the engine library build.\n',
  );
  process.exit(1);
}
