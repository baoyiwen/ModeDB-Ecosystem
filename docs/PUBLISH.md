# Publishing `@mode-db/*` packages

## Dependency order

Publish (or dry-run) in this order so dependents exist on the registry:

1. `@mode-db/shared`
2. `@mode-db/common`
3. `@mode-db/sdk` (depends only on shared)
4. `@mode-db/core` (**`packages/core`**; depends on common + shared)
5. `@mode-db/server` (depends on core + common + shared)

## Commands（一键脚本）

脚本：`scripts/publish-workspaces.mjs`（会先 **`pnpm run build`**，再按顺序 **`pnpm --filter <pkg> publish`**）。

| 命令                                              | 说明                                            |
| ------------------------------------------------- | ----------------------------------------------- |
| `pnpm run publish:npm`                            | 默认：**dry-run** + 全量构建，不写 registry     |
| `pnpm run publish:npm -- --live`                  | **真发布**；终端会要求输入大写 **`YES`** 才继续 |
| `pnpm run publish:npm:go`                         | **真发布**且自动确认（无人值守 / CI，慎用）     |
| `pnpm run publish:npm -- --live --yes --no-build` | 真发布、跳过确认、跳过构建                      |

兼容旧名：`publish:workspaces` / `publish:workspaces:live`（等价于带 `--yes` 的真发布）。

发布前请 **`npm login`**（pnpm 默认走 npm registry），并在各包 **`package.json`** 里 **bump `version`**。

未提交 git 时若 pnpm 拒绝发布，可临时设置环境变量 **`PUBLISH_NO_GIT_CHECKS=1`** 再执行（脚本会把 **`--no-git-checks`** 传给 pnpm）。

## Monorepo linking

Sibling packages use **`workspace:*`** in this repository; **`pnpm install`** at the repo root links them. **`pnpm publish`** rewrites **`workspace:*`** to concrete semver ranges in published tarballs.

## Build

From the repository root:

```bash
pnpm install
pnpm run build
```

Each publishable package emits only under its **`dist/`** via **`tsc`**：**`@mode-db/core`** 使用 **`packages/core/tsconfig.build.json`**；**`@mode-db/shared`** / **`@mode-db/sdk`** 使用各自的 **`tsconfig.build.json`**；**`@mode-db/common`** 与 **`@mode-db/server`** 使用包内 **`tsconfig.json`**。
