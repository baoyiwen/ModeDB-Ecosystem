/**
 * HTTP 管理 API（`/api/v1/management/*`）与 **`RemoteModelDBClient.listDatabases`** 共用类型。
 */

/** 工作区下单个逻辑库（**`<workspace>/<name>/atlas.mld`** 或 workspace-flat **`*.mld`**）的摘要。 */
export interface ManagementDatabaseInfo {
  readonly name: string;
  readonly status: 'active';
  /** Optional database display names keyed by locale (`en` / `zh` / `ja`). */
  readonly displayName?: Readonly<Record<string, string>>;
  /** **`atlas.mld`**（或 flat **`.mld`**）的 mtime ISO-8601 */
  readonly createTime?: string;
  /** 单文件 Vault 字节数（近似「占用」） */
  readonly bytesUsed?: number;
}

export interface ManagementStatusResponse {
  readonly engine: 'ModelDB';
  readonly state: 'RUNNING';
  readonly uptimeSeconds: number;
  readonly listen: { readonly host: string; readonly port: number };
  /** Resolved HTTP(S) base URL for generated API links, if available. */
  readonly publicBaseUrl?: string;
  readonly storageFormat: 'atlas.mld';
  readonly storageVersion: '2.0';
  readonly workspaceRoot: string;
  readonly databases: readonly ManagementDatabaseInfo[];
  readonly connectedClients: number;
}

export interface ManagementDatabasesResponse {
  readonly databases: readonly ManagementDatabaseInfo[];
}

export interface ManagementBackupInfo {
  readonly fileName: string;
  /** User-facing name; absent on legacy backup files. */
  readonly name?: string;
  readonly database: string;
  readonly createdAt: string;
  readonly bytes: number;
  readonly path?: string;
}

export interface ManagementBackupsResponse {
  readonly backups: readonly ManagementBackupInfo[];
}

export interface ManagementBackupCreateResponse {
  readonly ok: true;
  readonly backup: ManagementBackupInfo;
}

export interface ManagementBackupImportResponse {
  readonly ok: true;
  readonly backup: ManagementBackupInfo;
}

export interface ManagementBackupRestoreResponse {
  readonly ok: true;
  readonly restored: ManagementBackupInfo;
  readonly safetyBackup?: ManagementBackupInfo;
}

export interface ManagementClearDatabaseResponse {
  readonly ok: true;
  readonly database: string;
  readonly mode: 'clearAllData' | 'forceReset';
  readonly deletedCount?: number;
  readonly perModel?: Readonly<Record<string, number>>;
  readonly safetyBackup?: ManagementBackupInfo;
}

/** Per-model row in **`GET /api/v1/management/databases/:name/catalog`**. */
export interface ManagementCatalogModelInfo {
  readonly name: string;
  readonly parentId: string | null;
  /** Optional model display names keyed by locale (`en` / `zh` / `ja`). */
  readonly displayName?: Readonly<Record<string, string>>;
  readonly fields: readonly string[];
  /** Optional prop display names keyed by field name, then locale (`en` / `zh` / `ja`). */
  readonly fieldLabels?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Engine DataType per prop field (`String`, `Int`, …) from model registry. */
  readonly fieldTypes?: Readonly<Record<string, string>>;
}

export interface ManagementCatalogRelationInfo {
  readonly forward: string;
  readonly reverse: string;
  readonly source: string;
  readonly target: string;
  readonly selfLoopPolicy?: 'deny' | 'allow';
}

export interface ManagementCatalogResponse {
  readonly database: string;
  /** Optional database display names keyed by locale (`en` / `zh` / `ja`). */
  readonly displayName?: Readonly<Record<string, string>>;
  readonly models: readonly ManagementCatalogModelInfo[];
  readonly relations: readonly ManagementCatalogRelationInfo[];
}
