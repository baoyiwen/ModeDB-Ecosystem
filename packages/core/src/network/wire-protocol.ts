/**
 * Wire types for **@mode-db/core** consumers. The canonical schema lives in
 * **@mode-db/shared** so that SDK, server, and core always agree.
 */
export type {
  WireClientMessage,
  WireHandshakeRequest,
  WireRpcEnvelope,
  WireExecuteBody,
  WireServerMessage,
  WireHandshakeOk,
  WireRpcResponse,
  WireErrorMessage,
  WireRelationLogic,
  WireMatchPredicate,
  WireRowRef,
  WireBindStrategy,
  WireRelationStats,
} from '@mode-db/shared';
