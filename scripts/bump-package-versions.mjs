#!/usr/bin/env node
/**
 * Bump publishable packages under packages/* in the same order used by publish-workspaces.mjs.
 *
 * Examples:
 *   pnpm run version:packages
 *   pnpm run version:packages -- minor
 *   pnpm run version:packages -- --set 0.2.0
 *   pnpm run version:packages -- --packages @mode-db/data-kit,@mode-db/data-ui
 *   pnpm run version:packages:dry -- major
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ORDER = [
  '@mode-db/shared',
  '@mode-db/common',
  '@mode-db/data-kit',
  '@mode-db/data-ui',
  '@mode-db/sdk',
  '@mode-db/core',
  '@mode-db/server',
];

const PKG_DIR = {
  '@mode-db/shared': 'packages/shared',
  '@mode-db/common': 'packages/common',
  '@mode-db/data-kit': 'packages/data-kit',
  '@mode-db/data-ui': 'packages/data-ui',
  '@mode-db/sdk': 'packages/sdk',
  '@mode-db/core': 'packages/core',
  '@mode-db/server': 'packages/server',
};

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const dryRun = args.has('--dry-run');
const help = args.has('--help') || args.has('-h');

function printHelp() {
  console.log(`
Usage:
  pnpm run version:packages [patch|minor|major]
  pnpm run version:packages -- --set <version>
  pnpm run version:packages -- --packages <pkg1,pkg2>
  pnpm run version:packages:dry -- [patch|minor|major]

Defaults:
  bump type: patch
  packages: all publishable @mode-db packages

Examples:
  pnpm run version:packages
  pnpm run version:packages -- minor
  pnpm run version:packages -- --set 0.2.0 --packages @mode-db/data-kit,@mode-db/data-ui
`);
}

function valueAfterFlag(flag) {
  const idx = rawArgs.indexOf(flag);
  if (idx === -1) {
    return '';
  }
  return rawArgs[idx + 1] && !rawArgs[idx + 1].startsWith('-') ? rawArgs[idx + 1].trim() : '';
}

function valueFromEqFlag(prefix) {
  const found = rawArgs.find((a) => a.startsWith(`${prefix}=`));
  return found ? found.slice(prefix.length + 1).trim() : '';
}

function parseTargetPackages() {
  const raw = valueAfterFlag('--packages') || valueFromEqFlag('--packages');
  if (!raw) {
    return ORDER;
  }
  const names = raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !PKG_DIR[name]);
  if (unknown.length > 0) {
    throw new Error(`Unknown package(s): ${unknown.join(', ')}`);
  }
  return ORDER.filter((name) => names.includes(name));
}

function parseMode() {
  const exact = valueAfterFlag('--set') || valueFromEqFlag('--set');
  if (exact) {
    return { kind: 'set', version: exact };
  }
  const positional = rawArgs.find((a) => !a.startsWith('-'));
  if (!positional) {
    return { kind: 'bump', type: 'patch' };
  }
  if (positional === 'patch' || positional === 'minor' || positional === 'major') {
    return { kind: 'bump', type: positional };
  }
  return { kind: 'set', version: positional };
}

function parseSemver(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) {
    throw new Error(`Unsupported version "${version}". Expected x.y.z without prerelease.`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

function bumpVersion(version, type) {
  const v = parseSemver(version);
  if (type === 'major') {
    return `${v.major + 1}.0.0`;
  }
  if (type === 'minor') {
    return `${v.major}.${v.minor + 1}.0`;
  }
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

function assertVersion(version) {
  parseSemver(version);
  return version;
}

function packageJsonPath(name) {
  const dir = PKG_DIR[name];
  if (!dir) {
    throw new Error(`No package directory registered for ${name}.`);
  }
  return path.join(repoRoot, dir, 'package.json');
}

function readPackageJson(name) {
  const file = packageJsonPath(name);
  return {
    file,
    json: JSON.parse(readFileSync(file, 'utf8')),
  };
}

async function main() {
  if (help) {
    printHelp();
    return;
  }

  const mode = parseMode();
  const targets = parseTargetPackages();
  if (targets.length === 0) {
    throw new Error('No packages selected.');
  }

  console.log(
    dryRun
      ? '\n[mode-db version] DRY-RUN: no package.json files will be changed.\n'
      : '\n[mode-db version] Updating package versions.\n',
  );

  for (const name of targets) {
    const { file, json } = readPackageJson(name);
    const current = String(json.version ?? '');
    const next =
      mode.kind === 'set' ? assertVersion(mode.version) : bumpVersion(current, mode.type);
    console.log(`  ${name.padEnd(22)} ${current} -> ${next}`);
    if (!dryRun) {
      json.version = next;
      writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    }
  }

  console.log(
    dryRun
      ? '\n[mode-db version] Dry-run complete.\n'
      : '\n[mode-db version] package.json versions updated. Review the diff before publishing.\n',
  );
}

await main().catch((e) => {
  console.error(`[mode-db version] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
