/**
 * **设计器专属逻辑库**（独立于用户业务库的元数据空间）：
 *
 * - 所有 `sys_*` 模型 / 关系（`ensureDesignerCatalog`）以及画布快照（`sys_designer_graph`）
 *   **只**注入此库；用户在 UI 上选择的「目标库」仅以 `sys_data_asset_map.code`（字符串）形式
 *   作为逻辑标签存在于此库内，不会污染用户的业务库。
 * - 构建时可由 `VITE_MODE_DB_WORKSPACE` 覆盖；缺省 `model_designer_workspace`。
 * - 运行时不可在 UI 中修改：连接门会自动检查此库存在与否，缺则 `createDatabase`。
 */
export const FIXED_MODEL_DESIGNER_DATABASE: string = (
  import.meta.env.VITE_MODE_DB_WORKSPACE ?? 'model_designer_workspace'
).trim();
