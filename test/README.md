# Tests (`test/`)

## Commands

| Command                                    | Purpose                                                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`pnpm test`**                            | Runs **`test:unit`** then **`test:integration`**.                                                                                                                                                                                                      |
| **`pnpm run test:unit`**                   | Node test runner over **`test/unit/field-defs.test.ts`** (`@mode-db/common` helpers).                                                                                                                                                                  |
| **`pnpm run test:integration`**            | Builds packages, then integration scripts under **`test/integration/`** (e2e, query features, **`protocol-operations.ts`**, etc.).                                                                                                                     |
| **`pnpm run test:security:vault`**         | Builds M1 packages and runs Vault fault, real Windows DPAPI/ACL and directory/restart tests. Windows is required for OS protection acceptance; skips on other systems are not acceptance evidence.                                                     |
| **`pnpm run test:security:registry`**      | Builds M2 packages and verifies the transactional identity ledger, Windows-authenticated local pipe, CLI lifecycle, process recovery/concurrency, and the temporary network gate. Uses isolated directories and ports; never resets the live instance. |
| **`pnpm run test:security:authorization`** | Builds M3 packages and verifies scoped HTTP/WS, pinned releases, revocation, connection retries, isolated Windows management operations, and three-app in-memory credentials.                                                                          |
| **`pnpm run test:security:network`**       | Builds the security transport path and verifies HTTPS/WSS, certificate and redirect handling, IPv4/IPv6/CIDR source rules, Origin checks, one-time browser pairing, CSRF-protected short sessions, real Windows HTTPS registry HTTP, generated Postman requests, native curl and SDK invocation parity. |
| **`pnpm run test:security:browser`**       | After building SDK/server and all three frontends, launches isolated Windows/Chrome production-page acceptance for pairing, workspace entry, reload restoration, HttpOnly cookies and logout; also checks the published interface POST address, Bearer example and actual Postman template download. Set `MODELDB_TEST_BROWSER` for another Chromium executable. Missing prerequisites skip the test and do not count as acceptance. |

## Layout

`pnpm run test:security:recovery` builds the security packages and runs S6.1 recovery-package, JWE/WebCrypto interoperability, historical-key, process-interruption and isolated Windows CLI/DPAPI tests. It never uses the live service or repository configuration. Passing these tests does not constitute a second-machine recovery acceptance.

`scripts/security-recovery-drill.ts prepare|verify` provides a synthetic two-environment Windows acceptance drill. It transfers only an encrypted package, synthetic Vault and manifest, with the passphrase delivered separately. Same-machine/same-user verification fails, and editing the manifest cannot bypass the encrypted environment binding. See [SEC-M6 acceptance instructions](../docs/security-v1-deliveries/SEC-M6.md) for commands, ACL requirements and remaining evidence.

- **`integration/vault-env.ts`** — shared **network-only** `connectToken`, plus explicit `integrationVaultKeys(root)` backed by the Windows local provider. Tokens no longer derive Vault keys.
- **`vault-keys.ts`** — in-memory random key provider for isolated unit fixtures; never used by production.
- **`unit/security-vault-v2.test.ts`** / **`unit/security-windows-keys.test.ts`** — [SEC-M1 format and key contract](../docs/security-v1-vault-contract.md). Fault tests use temporary directories and subprocess exits; ENOSPC is simulated, not physical disk exhaustion.
- **`unit/security-registry.test.ts`** — [SEC-M2 identity and credential contract](../docs/security-v1-identity-contract.md). Uses real Windows DPAPI/ACL/pipe identity; controlled clock advancement verifies expiry/grace without wall-clock waits. A protection-write failure is injected to verify fail-closed audit persistence.
- **`unit/security-authorization.test.ts`**, **`unit/security-registry-http.test.ts`**, **`unit/browser-connection-credentials.test.ts`** — [SEC-M3 authorization/connection contract](../docs/security-v1-authorization-contract.md). Scoped RPC/HTTP/WS, pinned releases, batch revocation, publication rights, relations, audit failures, three-app credential storage; the HTTP management fixture uses real Windows DPAPI and restores only its own temporary database.
- **`unit/security-browser-session.test.ts`** — S4.2 session ledger contract: one-time pairing consumption, short session rotation, revocation and expiry. The browser HTTP flow is also covered by `security-authorization.test.ts`.
- **`unit/interface-call-docs.test.ts`** — S4.3 endpoint/typed-body/Postman/grant contract and Bash quoting; `security-authorization.test.ts` executes the generated Postman request over real HTTP, native curl and SDK short/stream. Does not require or claim a manual Postman desktop run. See [standard HTTP invocation](../docs/security-http-invocation.md).
- **`integration/e2e-engine-workflow.ts`** — full path: reset workspace → **AuthoringEngine** (create logical DB, inheritance, relation, MANUAL bind, seed) → **startModelDBWebSocketServer** → **`ModelDB` / SDK** (list DBs, query, **insertMany**, **alterModel** patch) → reopen engine (**updateRelationLogic**, **update**, **delete**) → stop server.
- **`integration/protocol-operations.ts`** — unified **`EngineOperation`** / **`apply`** protocol: DDL, DML, query JSON parity, **`clearModelData` / `clearAllData`**, workspace ops. See **`docs/engine-operation-protocol.md`**.

Wire protocol does **not** expose **`registerModel` / `registerRelation` / `bind`** to ad-hoc clients in all deployments; DDL for e2e is done in-process with **AuthoringEngine**, then the SDK exercises DML/meta RPCs. The **`apply(op)`** JSON entry covers the full op union when enabled. See **`packages/server/templates/modeldb/AGENTS.md`** (also installed to **`./modeldb/AGENTS.md`** on **`@mode-db/server`** install when missing).

## S6.3 model asset subset

`pnpm run test:security:asset` builds shared/common/core/server and runs `unit/security-asset.test.ts` plus `unit/security-designer-asset.test.ts`. The first covers frozen v1 model assets, independent WebCrypto JWS/JWE interoperability, publisher trust, hostile signed content and Windows offline transfer. The second covers explicit v2 Designer dependencies, pinned versions, contextual ID mapping, display hydration through the existing Designer reader, disabled imported interfaces, revision-bound previews and isolated process exits during task/business/Designer commits. All data and configuration are synthetic and temporary. This is process-interruption evidence, not hardware power-loss or browser UI acceptance. See the [user guide](../docs/security-v1/user-guide.md#71-designer-依赖包v2) and [SEC-M6 delivery record](../docs/security-v1-deliveries/SEC-M6.md).

## Web playground

React + Vite UI for ad-hoc queries: **`pnpm run dev:web`** (package **`apps/web`**). Configure host/port/token on the left; results on the right. Supports fluent query, **`apply(JSON)`** query demo, and **clear model / clear all data**. Optional WebGPU probe for environment sanity only.

## Model Designer

Canvas schema editor: **`pnpm run dev:model-designer`**. **Settings** panel: clear all library row data; model **Info** panel: clear selected model row data.
