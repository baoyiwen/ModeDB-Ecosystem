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

发布前请 **`npm login`**（pnpm 默认走 npm registry）。

### 版本号（为什么「跑完了」但 npm 上没有新包？）

1. **默认命令是 dry-run**：`pnpm run publish:npm` **不会**向 registry 上传；只有加 **`--live`**（或 `publish:npm:go`）才会真发。
2. **真发时版本必须新**：npm 不允许覆盖已存在的 **`@scope/name@version`**。若 registry 上已有 `0.1.0`，你必须把对应包的 **`version`** 改成 **`0.1.1`** 等未占用版本再发。
3. **不必非用 `npm version patch`**：手动改各子包 **`package.json` 的 `version`** 也可以。单包示例（不写 git tag）：
   ```bash
   cd packages/shared
   npm version patch --no-git-tag-version
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

Each publishable package emits only under its **`dist/`** via **`tsc`**：**`@mode-db/core`** 使用 **`packages/core/tsconfig.build.json`**；**`@mode-db/shared`** / **`@mode-db/sdk`** 使用各自的 **`tsconfig.build.json`**；**`@mode-db/common`** 与 **`@mode-db/server`** 使用包内 **`tsconfig.json`**。
