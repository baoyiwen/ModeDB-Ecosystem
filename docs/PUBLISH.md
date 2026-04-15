# Publishing `@mode-db/*` packages

## Dependency order

Publish (or dry-run) in this order so dependents exist on the registry:

1. `@mode-db/shared`
2. `@mode-db/common`
3. `@mode-db/sdk` (depends only on shared)
4. `@mode-db/engine` (repo root; depends on common + shared)
5. `@mode-db/server` (depends on engine + common + shared)

## Commands

- Dry-run (default): `npm run publish:workspaces`
- Real publish: `npm run publish:workspaces:live`

Log in with `npm login` and bump versions in each `package.json` before a live publish.

## Monorepo linking

Workspace packages link to each other using **semver ranges** aligned with local `version` fields (e.g. `^0.1.0`, `^1.0.0`). `npm install` at the repo root wires them together without pulling unpublished copies from the registry.

Internal packages use **semver ranges** (`^0.1.0`, `^1.0.0`) aligned with each `version` field so `npm install` at the repo root links workspaces on a wide range of npm versions. Some registries / npm ≥ 9 also accept **`workspace:*`** in published tarballs (rewritten at pack time); if your CI uses a fully workspace-aware npm, you may migrate sibling deps to `workspace:*`—this checkout keeps `^` for compatibility with environments that return `EUNSUPPORTEDPROTOCOL` for `workspace:*`.

## Build

From the repository root:

```bash
npm run build
```

Each publishable package emits only under its `dist/` directory via `tsc` (`@mode-db/shared` and `@mode-db/sdk` use `tsconfig.build.json`).
