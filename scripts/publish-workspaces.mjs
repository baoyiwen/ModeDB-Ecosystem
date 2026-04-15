#!/usr/bin/env node
/**
 * Publish order for @mode-db/* workspace packages (dependency order).
 *
 * Usage:
 *   node scripts/publish-workspaces.mjs           # dry-run (default)
 *   node scripts/publish-workspaces.mjs --live  # real publish (requires npm login + OTP if 2FA)
 *
 * Order: shared → common → sdk → @mode-db/core (repo root) → server
 * (common before core; sdk only needs shared; server needs core + common + shared.)
 *
 * Uses **pnpm** (`pnpm publish --filter <name>`). Install dependencies with **`pnpm install`** at the repo root.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(fileURLToPath(new URL('..', import.meta.url)));
const dryRun = !process.argv.includes('--live');

const ORDER = [
  '@mode-db/shared',
  '@mode-db/common',
  '@mode-db/sdk',
  '@mode-db/core',
  '@mode-db/server',
];

function runPublishFromRoot(workspaceName, extraArgs) {
  const args = ['publish', '--filter', workspaceName, ...extraArgs];
  const r = spawnSync('pnpm', args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

console.log(
  dryRun
    ? '\n[publish-workspaces] DRY RUN (pass --live for real publish)\n'
    : '\n[publish-workspaces] LIVE publish — ensure versions are bumped and you are logged in.\n',
);

const extra = dryRun ? ['--dry-run', '--access', 'public'] : ['--access', 'public'];

for (const name of ORDER) {
  console.log(`\n--- ${name} ---\n`);
  runPublishFromRoot(name, extra);
}

console.log('\n[publish-workspaces] Done.\n');
