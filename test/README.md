# Tests (`test/`)

## Commands

| Command | Purpose |
|--------|---------|
| **`pnpm test`** | Runs **`test:unit`** then **`test:integration`**. |
| **`pnpm run test:unit`** | Node test runner over **`test/unit/field-defs.test.ts`** (`@mode-db/common` helpers). |
| **`pnpm run test:integration`** | Builds packages, then **`test/integration/e2e-engine-workflow.ts`**. |

## Layout

- **`integration/vault-env.ts`** — shared **`connectToken`** string for scripts (matches vault derivation rules).
- **`integration/e2e-engine-workflow.ts`** — full path: reset workspace → **AuthoringEngine** (create logical DB, inheritance, relation, MANUAL bind, seed) → **startModelDBWebSocketServer** → **`ModelDB` / SDK** (list DBs, query, **insertMany**, **alterModel** patch) → reopen engine (**updateRelationLogic**, **update**, **delete**) → stop server.

Wire protocol does **not** expose **`registerModel` / `registerRelation` / `bind`**; DDL for this flow is done in-process with **AuthoringEngine**, then the SDK exercises DML/meta RPCs. See **`packages/server/templates/modeldb/AGENTS.md`** (also installed to **`./modeldb/AGENTS.md`** on **`@mode-db/server`** install when missing).

## Web playground

React + Vite UI for ad-hoc queries: **`pnpm run dev:web`** (package **`apps/web`**). Configure host/port/token on the left; results on the right. Optional WebGPU probe for environment sanity only.
