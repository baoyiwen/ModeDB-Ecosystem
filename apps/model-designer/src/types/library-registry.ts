/** `sys_data_asset_map` 行在设计器内的逻辑库登记。 */
export interface LibraryRegistryRecord {
  readonly id: string;
  readonly code: string;
  name: Record<string, string>;
  description: Record<string, string>;
}

export interface LibraryRegistryDraft {
  code: string;
  name: Record<string, string>;
  description: Record<string, string>;
}
