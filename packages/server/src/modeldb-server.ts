import type { FastifyInstance } from 'fastify';
import type { ResolvedModelDBServerConfig } from './config-loader.js';
import { buildDualTrackFastify, getServerListeningPort } from './dual-track-app.js';

/** @deprecated Use {@link getServerListeningPort} from the same package. */
export function getWebSocketServerListeningPort(app: FastifyInstance): number {
  return getServerListeningPort(app);
}

/**
 * Starts **Fastify** with **HTTP** (`/v2/action`, `/v2/bulk`, `/health`) and **WebSocket**
 * (`/` and `/v2/stream`) on the same port.
 */
export async function startModelDBWebSocketServer(
  cfg: ResolvedModelDBServerConfig,
): Promise<FastifyInstance> {
  return buildDualTrackFastify(cfg);
}

export { getServerListeningPort } from './dual-track-app.js';
