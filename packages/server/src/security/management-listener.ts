import Fastify, { type FastifyInstance } from 'fastify';
import { installRegistryEntrypoints } from './registry-entrypoints.js';
import { SecurityNetworkPolicy } from './network-policy.js';
import { installSecurityNetworkBoundary } from './network-boundary.js';
import {
  installHostedAssets,
  installHostedBoundary,
  hostedAssetPaths,
  type HostedAssets,
} from './browser-hosting.js';

type RegistryInput = Parameters<typeof installRegistryEntrypoints>[0];
/** Separate listener; no proxy trust, CORS or data route reachability. Binding errors propagate. */
export async function startHostedManagement(input: {
  port: number;
  assets: HostedAssets;
  entrypoints: Omit<RegistryInput, 'app' | 'network' | 'listenerRole' | 'publicAssetPaths'>;
}): Promise<{ app: FastifyInstance; origin: string }> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  // This listener has no WebSocket endpoint. Explicitly finish upgraded sockets too.
  app.server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () =>
      socket.destroy(),
    );
  });
  const origin = () => {
    const address = app.server.address();
    if (!address || typeof address !== 'object') {
      throw Error('SECURITY_LOCAL_CHANNEL_UNAVAILABLE');
    }
    return `http://127.0.0.1:${address.port}`;
  };
  const network = new SecurityNetworkPolicy(
    {},
    { host: '127.0.0.1', port: input.port, directory: '.' },
  );
  network.setPairedOriginVerifier((value) => value === origin());
  try {
    installHostedBoundary(app, {
      role: 'management',
      origin,
      assets: hostedAssetPaths(input.assets, '/security/'),
      protection: input.entrypoints.securityControl?.protection,
    });
    installSecurityNetworkBoundary(app, network);
    const paths = installHostedAssets(app, input.assets, '/security/');
    installRegistryEntrypoints({
      ...input.entrypoints,
      app,
      network,
      listenerRole: 'management',
      publicAssetPaths: paths,
    });
    await app.listen({ host: '127.0.0.1', port: input.port });
    return { app, origin: origin() };
  } catch (error) {
    await app.close();
    throw error;
  }
}
