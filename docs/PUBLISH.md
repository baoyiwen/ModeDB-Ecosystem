# Publishing `@mode-db/*` packages

## Dependency order

Publish (or dry-run) in this order so dependents exist on the registry:

1. `@mode-db/shared`
2. `@mode-db/common`
3. `@mode-db/data-kit` (depends on common + shared)
4. `@mode-db/data-ui` (depends on data-kit; peer depends on React)
5. `@mode-db/sdk` (depends only on shared)
6. `@mode-db/core` (**`packages/core`**; depends on common + shared)
7. `@mode-db/server` (depends on core + common + shared)

## Commands（一键脚本）

脚本：`scripts/publish-workspaces.mjs`（会先 **`pnpm run build`**，再按顺序 **`pnpm --filter <pkg> publish`**；当前包含 **shared / common / data-kit / data-ui / sdk / core / server**）。

| 命令                                              | 说明                                            |
| ------------------------------------------------- | ----------------------------------------------- |
| `pnpm run publish:npm`                            | 默认：**dry-run** + 全量构建，不写 registry     |
| `pnpm run publish:npm -- --live`                  | **真发布**；终端会要求输入大写 **`YES`** 才继续 |
| `pnpm run publish:npm:go`                         | **真发布**且自动确认（无人值守 / CI，慎用）     |
| `pnpm run publish:npm -- --live --yes --no-build` | 真发布、跳过确认、跳过构建                      |

**Git 分支**：加 **`--branch <name>`** 或 **`--branch=name`** 会在构建/发布前执行 **`git fetch origin <name>`** 并检出该分支（必要时从 **`origin/<name>`** 创建本地跟踪分支）。交互式 **`--live`**（未加 **`--yes`**）且未在命令行写 **`--branch`** 时，会提示输入分支名；直接回车表示不切换，沿用当前 **`HEAD`**。无人值守真发（**`--yes`**）若需固定分支，务必显式传 **`--branch`**。

兼容旧名：`publish:workspaces` / `publish:workspaces:live`（等价于带 `--yes` 的真发布）。

发布前请 **`npm login --registry=https://registry.npmjs.org`**（或 **`pnpm login --registry=https://registry.npmjs.org`**）。验证：**`npm whoami --registry=https://registry.npmjs.org`**。

**国内镜像（npmmirror）**：若全局 **`registry=https://registry.npmmirror.com`**（仅加速安装），**不要**对它 `npm login` 来发布。本仓库 **`scripts/publish-workspaces.mjs`** 在 **`--live`** 时会显式 **`--registry=https://registry.npmjs.org`**；根目录 **`.npmrc`** 也设置了 **`publish-registry`** / **`@mode-db:registry`**。你已在 npmjs 登录即可真发。

### 版本号（为什么「跑完了」但 npm 上没有新包？）

1. **默认命令是 dry-run**：`pnpm run publish:npm` **不会**向 registry 上传；只有加 **`--live`**（或 `publish:npm:go`）才会真发。
2. **真发时版本必须新**：npm 不允许覆盖已存在的 **`@scope/name@version`**。若 registry 上已有 `0.1.0`，你必须把对应包的 **`version`** 改成 **`0.1.1`** 等未占用版本再发。
3. **推荐用一键版本脚本**：`scripts/bump-package-versions.mjs` 会按发布队列更新 `packages/*` 下可发布包的 `package.json` 版本。
   ```bash
   pnpm run version:packages:dry              # 预览：默认 patch
   pnpm run version:packages                  # 实际 patch
   pnpm run version:packages -- minor         # 实际 minor
   pnpm run version:packages -- --set 0.2.0   # 设置为精确版本
   pnpm run version:packages -- --packages @mode-db/data-kit,@mode-db/data-ui
   ```
4. **仍可手动改版本**：手动改各子包 **`package.json` 的 `version`** 也可以。单包示例（不写 git tag）：
   ```bash
   cd packages/shared
   pnpm version patch --no-git-tag-version
   cd ../..
   ```
   对每个要发的包重复，或只 bump 你实际改过的包。

未提交 git 时若 pnpm 拒绝 **真发**，可临时设置 **`PUBLISH_NO_GIT_CHECKS=1`**（脚本在 **live** 模式下会传给 pnpm **`--no-git-checks`**）。dry-run 脚本里已默认带 **`--no-git-checks`** 以便本地试跑。

## Monorepo linking

Sibling packages use **`workspace:*`** in this repository; **`pnpm install`** at the repo root links them. **`pnpm publish`** rewrites **`workspace:*`** to concrete semver ranges in published tarballs.

## Build

From the repository root:

```bash
pnpm install
pnpm run build
```

Each publishable package emits **`dist/`** via **`tsc`**：**`@mode-db/core`** 使用 **`packages/core/tsconfig.build.json`**；**`@mode-db/shared`** / **`@mode-db/sdk`** / **`@mode-db/data-kit`** / **`@mode-db/data-ui`** 使用各自的 **`tsconfig.build.json`**；**`@mode-db/common`** 与 **`@mode-db/server`** 使用包内 **`tsconfig.json`**。其中 **`@mode-db/data-ui`** 构建后会额外执行 **`scripts/copy-css.mjs`** 复制组件 CSS。部分包的 **`package.json` → `files`** 另含 **`src/`**（供 **`exports.types` → `./src/index.ts`** 的 TypeScript 解析）；registry 消费者仍以 **`dist/`** 为运行时代码入口。
