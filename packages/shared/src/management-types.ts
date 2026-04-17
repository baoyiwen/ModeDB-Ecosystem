/**
 * HTTP 管理 API（`/api/v1/management/*`）与 **`RemoteModelDBClient.listDatabases`** 共用类型。
 */

/** 工作区下单个逻辑库（**`<workspace>/<name>/atlas.mld`** 或 workspace-flat **`*.mld`**）的摘要。 */
export interface ManagementDatabaseInfo {
  readonly name: string;
  readonly status: 'active';
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
  readonly storageFormat: 'atlas.mld';
  readonly storageVersion: '2.0';
  readonly workspaceRoot: string;
  readonly databases: readonly ManagementDatabaseInfo[];
  readonly connectedClients: number;
}

export interface ManagementDatabasesResponse {
  readonly databases: readonly ManagementDatabaseInfo[];
}
