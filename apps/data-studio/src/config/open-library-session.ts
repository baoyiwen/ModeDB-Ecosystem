import { ModelDB, RemoteModelDBClient, type ManagementCatalogResponse } from '@mode-db/sdk';
import type { RestorableSession } from '../config/connection-prefs.js';

export interface OpenLibraryResult {
  readonly client: RemoteModelDBClient;
  readonly library: string;
  readonly catalog: ManagementCatalogResponse;
}

/** Opens a logical library over the network (shared by connect panel and session restore). */
export async function openLibrarySession(session: RestorableSession): Promise<OpenLibraryResult> {
  const db = new ModelDB({
    host: session.host.trim(),
    port: session.port,
    token: session.token.trim(),
    browserSession: session.browserSession,
  });
  const library = session.library.trim();
  const client = await db.use(library);
  const [catalog, databases] = await Promise.all([
    db.getDatabaseCatalog(library),
    RemoteModelDBClient.listDatabases({
      host: session.host.trim(),
      port: session.port,
      token: session.token.trim(),
      browserSession: session.browserSession,
    }),
  ]);
  const databaseInfo = databases.find((info) => info.name === library);
  return {
    client,
    library,
    catalog: {
      ...catalog,
      displayName: catalog.displayName ?? databaseInfo?.displayName,
    },
  };
}
