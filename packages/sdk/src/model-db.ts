import { RemoteModelDBClient, type WebSocketCtor } from './remote-client.js';

/**
 * Primary SDK entry: host/port/token only (no raw URL). Use {@link ModelDB.use} for per-database
 * clients; concurrent calls for the same database share one in-flight connection (async guard).
 */
export interface ModelDBConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly mode?: 'short' | 'stream';
  readonly webSocketCtor?: WebSocketCtor;
}

export class ModelDB {
  private readonly host: string;
  private readonly port: number;
  private readonly token: string;
  private readonly mode?: 'short' | 'stream';
  private readonly webSocketCtor?: WebSocketCtor;

  private readonly clients = new Map<string, RemoteModelDBClient>();
  private readonly pending = new Map<string, Promise<RemoteModelDBClient>>();

  constructor(config: ModelDBConfig) {
    this.host = config.host;
    this.port = config.port;
    this.token = config.token;
    this.mode = config.mode;
    this.webSocketCtor = config.webSocketCtor;
  }

  /**
   * Lists logical database names under the server workspace (**`GET /api/v1/management/databases`**).
   */
  async listDatabases(): Promise<string[]> {
    const infos = await RemoteModelDBClient.listDatabases({
      host: this.host,
      port: this.port,
      token: this.token,
    });
    return infos.map((d) => d.name);
  }

  /**
   * Returns a {@link RemoteModelDBClient} for the given logical database name. Multiple calls for
   * the same name while a connection is in progress await the same promise.
   */
  async use(database: string): Promise<RemoteModelDBClient> {
    const name = database.trim();
    if (!name) {
      throw new Error('ModelDB.use: database name is required.');
    }
    const cached = this.clients.get(name);
    if (cached) {
      return cached;
    }
    let inflight = this.pending.get(name);
    if (!inflight) {
      inflight = RemoteModelDBClient.connectNetwork({
        host: this.host,
        port: this.port,
        token: this.token,
        database: name,
        mode: this.mode,
        webSocketCtor: this.webSocketCtor,
      }).then((c) => {
        this.clients.set(name, c);
        this.pending.delete(name);
        return c;
      });
      this.pending.set(name, inflight);
    }
    return inflight;
  }
}
