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
 *   pnpm run publish:npm -- --branch develop              # 先检出该分支再 dry-run / 后续步骤
 *   pnpm run publish:npm -- --live --branch release/1.2 --yes
 *
 * 发布顺序：shared → common → data-kit → data-ui → sdk → core → server
 *
 * 前置：pnpm login（或 npm login）、各包 version 已 bump、作用域在 npm 已开放 public。
 * 若未提交 git 且 pnpm 拒绝发布，可临时：$env:PUBLISH_NO_GIT_CHECKS='1'（PowerShell）再执行。
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 本文件在 repo/scripts/：上一级才是 monorepo 根（勿再对 URL('..') 的结果做 dirname，否则会跑到 web_code/）
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const live = args.has('--live');
const yes = args.has('--yes');
const noBuild = args.has('--no-build');

function ask(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

/** `--branch foo` 或 `--branch=foo` */
function parseBranchArg(argv) {
  const idx = argv.indexOf('--branch');
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('-')) {
    return argv[idx + 1].trim();
  }
  const eq = argv.find((a) => a.startsWith('--branch='));
  if (eq) {
    return eq.slice('--branch='.length).trim();
  }
  return '';
}

/**
 * 检出到指定分支（先 fetch，再本地 checkout / 必要时跟踪 `origin/<branch>`）。
 */
function ensureGitBranch(branch) {
  const b = branch.trim();
  if (!b) {
    return;
  }
  console.log(`\n--- git: 检出分支 ${b} ---\n`);
  let r = spawnSync('git', ['fetch', 'origin', b], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) {
    console.error(`[mode-db publish] git fetch origin ${b} 失败。`);
    process.exit(r.status ?? 1);
  }
  r = spawnSync('git', ['checkout', b], { cwd: repoRoot, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    r = spawnSync('git', ['checkout', '-B', b, `origin/${b}`], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: true,
    });
  }
  if (r.status !== 0) {
    console.error(
      `[mode-db publish] 无法检出分支 ${b}。请确认远端存在 origin/${b}，或本地已有该分支。`,
    );
    process.exit(r.status ?? 1);
  }
  const head = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  console.log(`[mode-db publish] 当前分支: ${head.stdout?.trim() ?? '?'}\n`);
}

/** 与仓库依赖顺序一致：先 leaf 依赖，后依赖它们的包 */
const ORDER = [
  '@mode-db/shared',
  '@mode-db/common',
  '@mode-db/data-kit',
  '@mode-db/data-ui',
  '@mode-db/sdk',
  '@mode-db/core',
  '@mode-db/server',
];

/** 包名 → 包含其 package.json 的目录（相对 repo 根） */
const PKG_DIR = {
  '@mode-db/shared': 'packages/shared',
  '@mode-db/common': 'packages/common',
  '@mode-db/data-kit': 'packages/data-kit',
  '@mode-db/data-ui': 'packages/data-ui',
  '@mode-db/sdk': 'packages/sdk',
  '@mode-db/core': 'packages/core',
  '@mode-db/server': 'packages/server',
};

function readPkgVersion(name) {
  const dir = PKG_DIR[name];
  if (!dir) {
    return '?';
  }
  const j = JSON.parse(readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'));
  return String(j.version ?? '?');
}

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
  // 真发布必须指向 npmjs.org；全局 registry 若为 npmmirror 仅用于安装，不能用于 publish。
  if (live) {
    out.push('--registry', 'https://registry.npmjs.org');
  }
  if (!live) {
    out.push('--dry-run');
    // dry-run 仅打 tarball 预览，允许工作区未提交，避免误报 ERR_PNPM_GIT_UNCLEAN
    out.push('--no-git-checks');
  } else if (process.env.PUBLISH_NO_GIT_CHECKS === '1') {
    out.push('--no-git-checks');
  }
  return out;
}

async function main() {
  console.log(
    live
      ? '\n[mode-db publish] LIVE — 将写入 npm registry\n'
      : '\n[mode-db publish] DRY-RUN（不会上传；加 --live 才会真发）\n',
  );

  console.log(
    '当前各包 package.json 版本（必须与 npm 上「尚未占用」的版本一致，否则真发会失败）：\n',
  );
  for (const name of ORDER) {
    console.log(`  ${name.padEnd(22)} ${readPkgVersion(name)}`);
  }
  console.log('');

  let publishBranch = parseBranchArg(rawArgs);

  if (rawArgs.includes('--branch') && !publishBranch) {
    console.error('[mode-db publish] 请使用 --branch <名称> 或 --branch=名称');
    process.exit(1);
  }

  if (!publishBranch && live && !yes) {
    const rl = readline.createInterface({ input, output });
    publishBranch = (await ask(rl, '发布基于哪个 Git 分支？(回车=不切换，保持当前 HEAD): ')).trim();
    rl.close();
  }

  if (publishBranch) {
    ensureGitBranch(publishBranch);
  } else if (live && yes) {
    console.log(
      '[mode-db publish] 未指定 --branch：将使用当前 HEAD（CI 请传 --branch <name>）。\n',
    );
  }

  if (live && !yes) {
    const rl = readline.createInterface({ input, output });
    const ans = await ask(rl, '确认发布到 npm？输入大写 YES 继续: ');
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

  if (live) {
    console.log(
      '\n[mode-db publish] 全部包已尝试发布（若某版本已在 registry 上存在，该步会报错）。\n',
    );
  } else {
    console.log(`
================================================================
本次为 DRY-RUN：没有向 npm 上传任何包。
要真实发布请：
  1. 登录：npm login
  2. 在需要发布的子目录里提高 version（registry 上不能已有同名同版本）
     例：cd packages/shared && npm version patch --no-git-tag-version
     或对多个包重复；也可用你喜欢的工具统一改版本。
  3. 执行：pnpm run publish:npm -- --live
     或一键（跳过输入 YES）：pnpm run publish:npm:go
================================================================
`);
  }
}

await main();
