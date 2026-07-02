import { ModelDB, type ManagementCatalogResponse, type RemoteModelDBClient } from '@mode-db/sdk';
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
  });
  const library = session.library.trim();
  const client = await db.use(library);
  const catalog = await db.getDatabaseCatalog(library);
  return { client, library, catalog };
}
