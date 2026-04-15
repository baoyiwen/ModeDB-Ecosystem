#!/usr/bin/env node
/**
 * 一键按依赖顺序将 @mode-db/* 发布到 npm（pnpm workspace）。
 *
 * 默认：全量 dry-run（不写 registry）。
 * 真发布：加 `--live`；跳过交互确认：再加 `--yes`。
 * 跳过构建：加 `--no-build`。
 *
 * 用法：
 *   pnpm run publish:npm                    # dry-run + 先 build
 *   pnpm run publish:npm -- --live        # 真发布（会提示输入 YES）
 *   pnpm run publish:npm:go               # 真发布 + 自动确认（CI / 无人值守）
 *   pnpm run publish:npm -- --live --yes --no-build
 *
 * 发布顺序：shared → common → sdk → core → server
 *
 * 前置：pnpm login（或 npm login）、各包 version 已 bump、作用域在 npm 已开放 public。
 * 若未提交 git 且 pnpm 拒绝发布，可临时：$env:PUBLISH_NO_GIT_CHECKS='1'（PowerShell）再执行。
 */
import { spawnSync } from 'node:child_process';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(fileURLToPath(new URL('..', import.meta.url)));

const args = new Set(process.argv.slice(2));
const live = args.has('--live');
const yes = args.has('--yes');
const noBuild = args.has('--no-build');

/** 与仓库依赖顺序一致：先 leaf 依赖，后 server */
const ORDER = [
  '@mode-db/shared',
  '@mode-db/common',
  '@mode-db/sdk',
  '@mode-db/core',
  '@mode-db/server',
];

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function publishArgs(pkg) {
  const out = ['--filter', pkg, 'publish', '--access', 'public'];
  if (!live) {
    out.push('--dry-run');
  }
  if (process.env.PUBLISH_NO_GIT_CHECKS === '1') {
    out.push('--no-git-checks');
  }
  return out;
}

async function main() {
  console.log(
    live
      ? '\n[mode-db publish] LIVE — 将写入 npm registry\n'
      : '\n[mode-db publish] DRY-RUN（加 --live 才会真发）\n',
  );

  if (live && !yes) {
    const rl = readline.createInterface({ input, output });
    const ans = await rl.question('确认发布到 npm？输入大写 YES 继续: ');
    rl.close();
    if (ans.trim() !== 'YES') {
      console.log('已取消。');
      process.exit(0);
    }
  }

  if (!noBuild) {
    console.log('\n--- pnpm run build ---\n');
    run('pnpm', ['run', 'build']);
  }

  for (const pkg of ORDER) {
    console.log(`\n--- pnpm publish ${pkg} ---\n`);
    run('pnpm', publishArgs(pkg));
  }

  console.log(
    live ? '\n[mode-db publish] 全部包已尝试发布。\n' : '\n[mode-db publish] dry-run 结束。\n',
  );
}

await main();
