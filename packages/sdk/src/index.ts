export {
  connectRemote,
  ModelDBClient,
  RemoteModelDBClient,
  RemoteRuntimeModel,
  RemoteQueryChain,
  RemoteHydratedEntity,
  toWsStreamUrl,
  toHttpOrigin,
  type ConnectRemoteOptions,
  type WebSocketCtor,
} from './remote-client.js';
export { ModelDB, type ModelDBConfig } from './model-db.js';
export type {
  ManagementCatalogModelInfo,
  ManagementCatalogRelationInfo,
  ManagementCatalogResponse,
  ManagementDatabaseInfo,
  ManagementDatabasesResponse,
  ManagementStatusResponse,
} from '@mode-db/shared';

/** Alias for binary payloads: **Uint8Array** everywhere (no Node `Buffer`). */
export type WireBinaryBytes = Uint8Array;
