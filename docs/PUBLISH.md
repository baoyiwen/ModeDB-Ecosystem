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

If your toolchain supports it, you may switch internal deps to `workspace:*`; this repo uses semver ranges for broader `npm` compatibility.

## Build

From the repository root:

```bash
npm run build
```

Each publishable package emits only under its `dist/` directory via `tsc` (`@mode-db/shared` and `@mode-db/sdk` use `tsconfig.build.json`).
