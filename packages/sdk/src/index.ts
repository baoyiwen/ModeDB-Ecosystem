import { Buffer as BufferPolyfill } from 'buffer';

if (typeof globalThis !== 'undefined') {
  const g = globalThis as typeof globalThis & { Buffer?: typeof BufferPolyfill };
  if (!g.Buffer) {
    g.Buffer = BufferPolyfill;
  }
}

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
  ManagementDatabaseInfo,
  ManagementDatabasesResponse,
  ManagementStatusResponse,
} from '@mode-db/shared';
