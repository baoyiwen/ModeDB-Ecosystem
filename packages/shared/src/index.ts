/**
 * Shared surface for wire obfuscation, on-disk shadow line codec, and diagnostics.
 * Implementation is delegated to **`mode-db-engine`** so the engine stays the
 * single source of truth until a hard extraction is needed.
 */
export { DiagnosticCenter, ErrorCodes, ValidationReport } from 'mode-db-engine';
export type {
  Diagnostic,
  DiagnosticCode,
  Severity,
  ValidationReportJSON,
  ValidationReportSummary,
} from 'mode-db-engine';
export {
  encodeMldLine,
  parseMldLine,
  SHADOW_LINE_PREFIX,
  type ParsedMldLine,
} from 'mode-db-engine';
export { deriveWireSessionKey, encodeWirePayload, decodeWirePayload } from 'mode-db-engine';
export {
  TRANSPORT_OUTER_MAGIC,
  TRANSPORT_INNER_MAGIC,
  transportKeyXorMix,
  decodeInboundTransportBuffer,
  encodeOutboundTransportBuffer,
} from './binary-transport.js';
export type {
  WireClientMessage,
  WireHandshakeRequest,
  WireRpcEnvelope,
  WireExecuteBody,
  WireServerMessage,
  WireExecuteResultJson,
} from './wire-protocol-exports.js';
