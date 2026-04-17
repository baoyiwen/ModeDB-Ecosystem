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
export type {
  ManagementDatabaseInfo,
  ManagementDatabasesResponse,
  ManagementStatusResponse,
} from '@mode-db/shared';
