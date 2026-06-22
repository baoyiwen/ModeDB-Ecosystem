import { RemoteModelDBClient, type WebSocketCtor } from './remote-client.js';
import {
  isWorkspaceOperation,
  type EngineApplyOutcome,
  type EngineOperation,
  type EngineOperationResult,
  type ManagementCatalogResponse,
} from '@mode-db/shared';

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

  /** Models + relations for **`database`** (HTTP catalog). */
  async getDatabaseCatalog(database: string): Promise<ManagementCatalogResponse> {
    return RemoteModelDBClient.getDatabaseCatalog({
      host: this.host,
      port: this.port,
      token: this.token,
      database,
    });
  }

  /** Create a new logical database directory + empty vault. */
  async createDatabase(name: string): Promise<void> {
    return RemoteModelDBClient.createDatabase({
      host: this.host,
      port: this.port,
      token: this.token,
      name,
    });
  }

  /** Delete logical DB files under workspace (destructive). */
  async deleteDatabase(name: string): Promise<void> {
    return RemoteModelDBClient.deleteDatabase({
      host: this.host,
      port: this.port,
      token: this.token,
      name,
    });
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

  /**
   * Protocol entry: run one {@link EngineOperation} (JSON), routing by scope:
   * - **workspace** ops (createDatabase / dropDatabase / listDatabases / catalog) hit the management surface;
   * - **database** ops are executed on the connected client for **`database`** (required for that scope).
   *
   * This is the JSON/Designer-friendly counterpart of the fluent methods, all of which remain available.
   */
  async apply(op: EngineOperation, database?: string): Promise<EngineOperationResult> {
    if (isWorkspaceOperation(op)) {
      switch (op.op) {
        case 'createDatabase':
          await this.createDatabase(op.name);
          return { kind: 'database', op: 'createDatabase', name: op.name, ok: true };
        case 'dropDatabase':
          await this.deleteDatabase(op.name);
          this.releaseClient(op.name);
          return { kind: 'database', op: 'dropDatabase', name: op.name, ok: true };
        case 'listDatabases': {
          const databases = await RemoteModelDBClient.listDatabases({
            host: this.host,
            port: this.port,
            token: this.token,
          });
          return { kind: 'databases', databases };
        }
        case 'catalog': {
          const catalog = await this.getDatabaseCatalog(op.database);
          return { kind: 'catalog', ...catalog };
        }
      }
    }
    if (!database) {
      throw new Error(
        `ModelDB.apply: database-scope operation "${op.op}" requires a target database name.`,
      );
    }
    const client = await this.use(database);
    return client.apply(op);
  }

  /**
   * Protocol entry: run an ordered batch of operations (mixed scopes allowed). Returns one
   * {@link EngineApplyOutcome} per attempted op; with **`failFast`** (default `true`) it stops after the
   * first failure. Provide **`database`** to target database-scope ops in the batch.
   */
  async applyAll(
    ops: readonly EngineOperation[],
    opts?: { readonly database?: string; readonly failFast?: boolean },
  ): Promise<EngineApplyOutcome[]> {
    const failFast = opts?.failFast ?? true;
    const out: EngineApplyOutcome[] = [];
    for (const op of ops) {
      try {
        const result = await this.apply(op, opts?.database);
        out.push({ ok: true, result });
      } catch (e) {
        out.push({ ok: false, error: e instanceof Error ? e.message : String(e) });
        if (failFast) {
          break;
        }
      }
    }
    return out;
  }

  /**
   * Close and drop cached wire client for **`database`** (e.g. after server-side delete, or to reset WS).
   */
  releaseClient(database: string): void {
    const name = database.trim();
    const c = this.clients.get(name);
    if (c) {
      c.close();
      this.clients.delete(name);
    }
  }
}
