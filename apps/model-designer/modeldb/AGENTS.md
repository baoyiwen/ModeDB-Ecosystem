# ModeDB — AI assistant rules (workspace copy)

This file is installed under **`./modeldb/AGENTS.md`** when **`@mode-db/server`** runs **`postinstall`** (only if the file did not already exist). Edit locally as needed.

## What ModeDB is

- A **hyper-relational** engine: models and **bidirectional** relations live in a logical workspace; persistence uses a single-file vault **`atlas.mld`** per logical database.
- **Never** connect the SDK with raw filesystem **`dbPath`** from app code. Use **logical database name** + **`connectToken`** (same string as server **`connectToken`** / **`MODEL_DB_CONNECT_TOKEN`**).

## Runtime layout

- **Server** (`modeldb-server`): serves HTTP + WebSocket; **`storageRoot` / `workspace`** in config is the directory whose **subdirectories** are logical DBs (`<workspace>/<dbName>/atlas.mld`).
- **SDK** (`@mode-db/sdk`): use **`ModelDB`** with **`host` / `port` / `token`**, then **`listDatabases()`** and **`use('logical-db-name')`** → **`RemoteModelDBClient`**.

## Operations the wire exposes

- **Queries**: `model('Name').query()...execute()`.
- **Writes**: `insertMany`, and (on the server RPC layer) **`insert`** / **`update`** — check current SDK surface before assuming a helper exists.
- **Meta over wire**: **`alterModel`**, **`dropModel`**, **`dropRelation`**, **`registerModel`**, **`registerRelation`** ( **`alterModel`** requires the model to **already exist** in the registry; **`registerModel`/`registerRelation`** skip when already present).
- **Not on the wire**: **`bind`**, and ad-hoc registry usage outside these RPCs (AuthoringEngine tooling / CLI).

## Authoring (engine) vs remote (SDK)

- **DDL** (new model, relation graph, MANUAL/GLOBAL bind): use **`AuthoringEngine`** in Node or automation, or CLI **`modeldb-server create-db`**, then open with the SDK.
- **DML + query** against a running server: **`ModelDB`** / **`RemoteModelDBClient`**.
- **Non-destructive schema**: **`alterModel`** / **`alterModelPatch`** — do not remove fields or relax required flags in ways the engine rejects.

## Conventions

- Logical DB names and model/relation segments: **flat graph segments** (no `/`, no odd characters); follow existing **`assertFlatGraphSegment`** rules.
- Relations are **paired** forward/reverse labels; binding strategies include **GLOBAL**, **PROTOCOL**, **CONDITIONAL**, **MANUAL** (see core **`AuthoringEngine.bind`**).
- Tokens: treat **`connectToken`** as a **secret**; never log it in client bundles or public repos.

## Tests in the ecosystem repo

- **`pnpm run test:integration`**: end-to-end **`test/integration/e2e-engine-workflow.ts`** (AuthoringEngine DDL → server → SDK → local update/delete).
- **`pnpm run test:unit`**: pure **`@mode-db/common`** helpers under **`test/unit/`**.

When suggesting code, prefer **ESM** (`import`/`export`), **TypeScript strict**, and match existing package boundaries (`@mode-db/core`, `@mode-db/common`, `@mode-db/shared`, `@mode-db/sdk`, `@mode-db/server`).
