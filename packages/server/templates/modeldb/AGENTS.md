# ModeDB — AI assistant rules (workspace copy)

This file is installed under **`./modeldb/AGENTS.md`** when **`@mode-db/server`** runs **`postinstall`** (only if the file did not already exist). Edit locally as needed.

## What ModeDB is

- A **hyper-relational** engine: models and **bidirectional** relations live in a logical workspace; persistence uses a single-file vault **`atlas.mld`** per logical database.
- **Never** connect the SDK with raw filesystem **`dbPath`** from app code. Use the server origin, logical database name and a scoped registry credential. New configurations use `security: { "version": 1 }`; `connectToken` / `MODEL_DB_CONNECT_TOKEN` apply only to explicitly retained legacy configurations and never derive Vault encryption keys.

## Runtime layout

- **Server** (`modeldb-server`): serves HTTP + WebSocket; **`storageRoot` / `workspace`** in config is the directory whose **subdirectories** are logical DBs (`<workspace>/<dbName>/atlas.mld`).
- **SDK** (`@mode-db/sdk`): use **`ModelDB`** with **`host` / `port` / `token`**, then **`listDatabases()`** and **`use('logical-db-name')`** → **`RemoteModelDBClient`**.
- **Registry transport**: scoped HTTP JSON RPC `/api/v1/rpc` and WS `/api/v1/stream`; legacy `/v2` transports are disabled in registry mode. Remote registry access requires HTTPS/WSS. IP/Origin allowlists do not authenticate callers.
- **Browser apps**: owner-authorized one-time pairing and short HttpOnly sessions; never embed long-lived tokens in bundles, localStorage, sessionStorage or URLs. Open security management through the protected local owner CLI (`modeldb-server security help`).
- **Platform and isolation**: Windows DPAPI/current-account ownership is the verified security platform. Use an explicitly configured temporary instance, synthetic data and a free test port for validation. Never assume access to a real service, configuration, credentials or business Vault is authorized.

## Operations the wire exposes

- **Queries**: `model('Name').query()...execute()`.
- **Writes**: `insertMany`, and (on the server RPC layer) **`insert`** / **`update`** — check current SDK surface before assuming a helper exists.
- **Meta over wire**: **`alterModel`**, **`dropModel`**, **`dropRelation`**, **`registerModel`**, **`registerRelation`** ( **`alterModel`** requires the model to **already exist** in the registry; **`registerModel`/`registerRelation`** skip when already present).
- **JSON operations**: `apply` / `applyAll` expose supported `EngineOperation` entries, including relation binding, subject to server authorization. Do not assume a fluent helper exists or bypass service authorization with local engine access.

## Authoring (engine) vs remote (SDK)

- **DDL** (new model, relation graph, MANUAL/GLOBAL bind): use **`AuthoringEngine`** in Node or automation, or CLI **`modeldb-server create-db`**, then open with the SDK.
- **DML + query** against a running server: **`ModelDB`** / **`RemoteModelDBClient`**.
- **Non-destructive schema**: **`alterModel`** / **`alterModelPatch`** — do not remove fields or relax required flags in ways the engine rejects.

## Conventions

- Logical DB names and model/relation segments: **flat graph segments** (no `/`, no odd characters); follow existing **`assertFlatGraphSegment`** rules.
- Relations are **paired** forward/reverse labels; binding strategies include **GLOBAL**, **PROTOCOL**, **CONDITIONAL**, **MANUAL** (see core **`AuthoringEngine.bind`**).
- Credentials and keys are secrets: never log them, commit them, or include them in public client bundles. Credential rotation does not reencrypt Vaults. Security-admin authority does not imply business-data access.

## Tests in the ecosystem repo

- **`pnpm run test:security:regression`**: all unit suites with temporary fixtures, followed by six engine workflows with their relative data paths isolated under a fresh temporary cwd. Do not run live-check scripts as part of ordinary regression.
- **`pnpm run security:release:prepare`**: clean temporary package/frontend builds, archive manifest checks and local offline installation; does not publish or deploy. See `docs/security-v1/release-guide.md` in the ecosystem source for lifecycle/performance/browser verification and switch/rollback boundaries.

## Backup and recovery

- Server-side backups are management-plane operations, not normal database RPC.
- Backup files live under **`<workspace>/modeldb/backups/`**.
- Manual CLI:
  - **`modeldb-server backup <db-name>`**
  - **`modeldb-server backups [db-name]`**
  - **`modeldb-server restore <db-name> <backup-file> --yes`**
  - **`modeldb-server clear-data <db-name> --yes`**
  - **`modeldb-server force-reset <db-name> --yes`**
- `restore`, `clear-data`, and `force-reset` attempt safety backups first.
- Automatic backups are disabled unless **`modeldb.config.json`** sets **`autoBackup.enabled: true`**.
- In registry mode, pass an explicit `-c <isolated-config>` to offline backup/restore and destructive CLI commands, stop only that isolated instance first, and preserve the original material. Online management requires the corresponding database grants.
- Old Vault formats are explicitly rejected, not silently migrated or deleted. Ordinary database restore does not restore revoked credentials. Independent recovery creates an empty access ledger; pair and authorize again. Never remove a reset/publication marker or lock to force a partial operation online.

When suggesting code, prefer **ESM** (`import`/`export`), **TypeScript strict**, and match existing package boundaries (`@mode-db/core`, `@mode-db/common`, `@mode-db/shared`, `@mode-db/sdk`, `@mode-db/server`).
