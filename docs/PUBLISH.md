# Publishing `@mode-db/*` packages

## Dependency order

Publish (or dry-run) in this order so dependents exist on the registry:

1. `@mode-db/shared`
2. `@mode-db/common`
3. `@mode-db/sdk` (depends only on shared)
4. `@mode-db/core` (repo root; depends on common + shared)
5. `@mode-db/server` (depends on core + common + shared)

## Commands

- Dry-run (default): `pnpm run publish:workspaces`
- Real publish: `pnpm run publish:workspaces:live`

Log in with **`npm login`** (pnpm uses the npm registry by default) and bump versions in each **`package.json`** before a live publish.

## Monorepo linking

Sibling packages use **`workspace:*`** in this repository; **`pnpm install`** at the repo root links them. **`pnpm publish`** rewrites **`workspace:*`** to concrete semver ranges in published tarballs.

## Build

From the repository root:

```bash
pnpm install
pnpm run build
```

Each publishable package emits only under its `dist/` directory via `tsc` (`@mode-db/shared` and `@mode-db/sdk` use `tsconfig.build.json`).
