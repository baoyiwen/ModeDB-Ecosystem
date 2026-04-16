#!/usr/bin/env node
/**
 * **`@mode-db/sdk`** must stay a thin remote client: wire + query façade only.
 * Fails if `packages/sdk/src` **imports** server, core, or HTTP frameworks.
 * (JSDoc `{@link AuthoringEngine}` references are allowed.)
 */
import { readFileSync, readdirSync } from 'node:fs';
import path, { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkSrc = join(repoRoot, 'packages', 'sdk', 'src');

const IMPORT_LINE = /^\s*(?:import|export)\s+[^;]*\s+from\s+['"]([^'"]+)['"]/;

const BANNED_SPECIFIERS = [
  '@mode-db/server',
  '@mode-db/core',
  'fastify',
  '@fastify/websocket',
  'ws/server',
];

/** @param {string} dir */
function* walkTs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkTs(p);
    } else if (ent.isFile() && extname(ent.name) === '.ts') {
      yield p;
    }
  }
}

let failed = false;
for (const file of walkTs(sdkSrc)) {
  const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(IMPORT_LINE);
    if (!m) {
      continue;
    }
    const spec = m[1];
    for (const ban of BANNED_SPECIFIERS) {
      if (spec === ban || spec.startsWith(`${ban}/`)) {
        console.error(
          `assert-sdk-client-only: forbidden import "${spec}" in ${path.relative(repoRoot, file)}:${i + 1}`,
        );
        failed = true;
      }
    }
  }
}

if (failed) {
  process.exit(1);
}
