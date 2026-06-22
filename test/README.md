# Tests (`test/`)

## Commands

| Command | Purpose |
|--------|---------|
| **`pnpm test`** | Runs **`test:unit`** then **`test:integration`**. |
| **`pnpm run test:unit`** | Node test runner over **`test/unit/field-defs.test.ts`** (`@mode-db/common` helpers). |
| **`pnpm run test:integration`** | Builds packages, then integration scripts under **`test/integration/`** (e2e, query features, **`protocol-operations.ts`**, etc.). |

## Layout

- **`integration/vault-env.ts`** — shared **`connectToken`** string for scripts (matches vault derivation rules).
- **`integration/e2e-engine-workflow.ts`** — full path: reset workspace → **AuthoringEngine** (create logical DB, inheritance, relation, MANUAL bind, seed) → **startModelDBWebSocketServer** → **`ModelDB` / SDK** (list DBs, query, **insertMany**, **alterModel** patch) → reopen engine (**updateRelationLogic**, **update**, **delete**) → stop server.
- **`integration/protocol-operations.ts`** — unified **`EngineOperation`** / **`apply`** protocol: DDL, DML, query JSON parity, **`clearModelData` / `clearAllData`**, workspace ops. See **`docs/engine-operation-protocol.md`**.

Wire protocol does **not** expose **`registerModel` / `registerRelation` / `bind`** to ad-hoc clients in all deployments; DDL for e2e is done in-process with **AuthoringEngine**, then the SDK exercises DML/meta RPCs. The **`apply(op)`** JSON entry covers the full op union when enabled. See **`packages/server/templates/modeldb/AGENTS.md`** (also installed to **`./modeldb/AGENTS.md`** on **`@mode-db/server`** install when missing).

## Web playground

React + Vite UI for ad-hoc queries: **`pnpm run dev:web`** (package **`apps/web`**). Configure host/port/token on the left; results on the right. Supports fluent query, **`apply(JSON)`** query demo, and **clear model / clear all data**. Optional WebGPU probe for environment sanity only.

## Model Designer

Canvas schema editor: **`pnpm run dev:model-designer`**. **Settings** panel: clear all library row data; model **Info** panel: clear selected model row data.
