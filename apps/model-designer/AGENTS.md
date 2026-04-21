# Model Designer — Agent / 开发约束

## 1. 技术栈与底层要求

- **核心渲染**：HTML5 Canvas（禁止用 DOM 模拟模型块）。
- **二进制**：禁止 `Buffer`；统一 `Uint8Array` / `DataView`（`encodeUtf8` / `decodeUtf8` / `dataViewOf` 见 `src/persistence/mldg-binary.ts`）。
- **模块化**：交互与业务逻辑放在 Manager；React 组件只做组合与绑定。

## 2. 持久化协议 (MLDG Schema) — Dual-Schema JSON

为满足「在其他引擎建立同等结构」且「保留画布信息」，内存与传输载荷采用 **Dual-Schema JSON**（`MldgDocument`）：

- **`engine_schema`（结构域）**：模型定义、Props、父子继承、关系。
- **`designer_layout`（表现域）**：`uuid`、`position(x,y)`、`color_theme`、`z_index`、折点、`viewport`、可选 **`layers`** / **`model_layers`**（与引擎 `sys_layers` / `layerHasModels` 等对齐，见 `designer-storage-init.ts`）。

**持久化决策（强制）**：

- **禁止** 使用 File System Access API、`<input type="file">`、或 **`localStorage` 持久化设计器图谱**；允许仅用 `localStorage` 缓存**连接参数（host/port/逻辑库名）**与 **UI 语言**（见 `src/config/connection-prefs.ts`、**`I18nManager`**）。
- 所有读写经 **`@mode-db/sdk`**：`RemoteModelDBClient` WebSocket 会话（`encodeWirePayload` 对称加密）及管理 API 校验工作区。
- **二进制流**：`DataManager` 在发送前将文档序列化为 **`Uint8Array`**（UTF-8 JSON），再经 **`bytesToBase64Url`** 嵌入写行字段，通过 **`insertMany`** 进入加密通道（见 `src/sync/mldg-wire-bytes.ts`、`src/sync/sdk-designer-sync.ts`）。
- **服务端前提**：连接成功后由 **`ensureDesignerCatalog`**（`src/bootstrap/designer-storage-init.ts`）注册 **`sys_model`、`sys_relation`、`sys_layers`、`sys_layer_type`、`sys_props`、`sys_data_asset_map`、`sys_designer_graph`** 等及关系；随后 **`seedDefaultWorkspaceRecords`**（`src/bootstrap/seed-workspace-rows.ts`）写入当前逻辑库对应的 **`sys_data_asset_map`** 行与默认 **`sys_layer_type`**（`group`/`page`）。需 **modeldb-server** 支持 `registerModel` / `registerRelation` RPC。快照行模型字段至少含 **`graph_b64`**（String）、**`updated_at`**（String）。

## 2.1 工作区绑定与事务性同步

- **逻辑库名**：构建默认值由 **`VITE_MODE_DB_WORKSPACE`** / **`fixed-database.ts`** 提供；连接门页提供**可编辑**逻辑库名，成功连接后写入 **`localStorage`**（`connection-prefs`），以便与服务器实际目录名对齐。
- **连接**：`openWorkspaceSession` 仅调用 **`RemoteModelDBClient.connectNetwork`**；**不**在连接阶段用管理 API 预校验「逻辑库是否在列表中」或「catalog 是否含快照模型」——由 WebSocket 握手与后续 push/pull 报错体现。
- **拉取**（`pullGraphFromEngine`）：失败时用 **`structuredClone` 快照** 恢复画布，保证不出现半拉取状态。
- **推送**（`pushGraphToEngine`）：`insertMany(..., { sync: true })` 单次 RPC 落盘；发送前 **`extractEngineModelRelationPayload`** 校验结构域。逻辑库内需已注册 **`sys_designer_graph`**（见 §2），否则写入失败。

## 3. 状态机 (Interaction States)

- 通过 **`StateManager`** 切换：`SELECT` | `ADD_NODE` | `LINKING` | `INHERITING`（文档中的 IDLE 与 SELECT 等价，实现为 `SELECT`）。
- 禁止在组件内写死交互分支；手势由 **`EventManager`** 判定后驱动业务。
- 快捷键约定：
  - **Click**：选中（延迟单击，避免与双击冲突）。
  - **Double Click（ADD_NODE）**：克隆指针下节点（若无则克隆当前选中项）。
  - **Long Press（SELECT / ADD_NODE）**：在节点上开始连线。
  - **Ctrl + 拖拽从节点出发**：继承模型（在空白处释放创建子模型）。
- **Esc**：退出 `LINKING` / `INHERITING`。

## 4. 数据结构

- **Prop** 为对象：`{ id, name, type, is_primary, encrypt_level, metadata }`。
- 模型与字段由 **`DataManager`** 持有；面板编辑通过 `updateModelName` / `updateProps` 等受控更新。

## 5. 国际化 (i18n)

- 文案在 `src/i18n/locales/<locale>/{ui,engine,errors}.json`。
- **`I18nManager`** 提供 `t('ui'|'engine'|'errors', key)`。

## 6. 组件与绘制

- Canvas 仅负责绘制；**原子函数**：`draw-node.ts`、`draw-edge.ts`、`draw-prop.ts`、`paint-scene.ts`。
- DOM：**PanelGroup**（Info / Relation / Props）与 **CanvasContainer** 分离。

## 7. 架构：核心管理器（中心化控制，去中心化渲染）

| Manager             | 职责                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| StateManager        | FSM：光标语义与 Canvas 交互态映射                                                                          |
| EventManager        | 全局键鼠、Canvas 原始事件；长按/双击判定并分发                                                             |
| ConfigManager       | 引擎连接参数、主题、Props 默认值、网格等                                                                   |
| DataManager         | 模型/关系/布局/图层归属内存；MLDG 序列化；SDK 同步                                                         |
| I18nManager         | 中/英/日等语言与 `t()`                                                                                     |
| LayerManager        | 激活图层；`toggleLayer` 驱动显隐（绘制与命中跳过隐藏节点及端点关系）                                       |
| GraphLinker         | 画布模型间连线，关系 kind 与引擎 `modelLinksOut` 一致                                                      |
| PropVaultController | `metadata.vault_ref`（`m_addr_*`）/ `encrypt_level` 的保险库字段 UI（与引擎 `InternalVault` 指针语义对齐） |

## 8. 引擎 Schema 补全建议（闭环拓扑与画布）

在开始大规模构造元数据前，建议与引擎/catalog 对齐以下约定（与仓库根 **`.cursorrules`**「Engine schema & model-designer」一致）：

- **`sys_relation` 端点映射**：除基数/语义字段外，为拓扑可遍历，显式维护 **`rel_relation_source`**（`sys_relation` → 源 **`sys_model`**）与 **`rel_relation_target`**（`sys_relation` → 目标 **`sys_model`**）。这样 **`sys_relation`** 行即带属性的连线实体。
- **`sys_props` 类型增强**：**`data_type`** 支持 **`MODEL_REF`**（或等价名）；「枚举即模型」时通过关系指向另一 **`sys_model`**，而非引擎内建枚举。
- **坐标与画布**：在 **`sys_model`** / **`sys_relation`** 上统一使用 **`canvas_meta`**（对象或 JSON 字符串）命名空间存放位置、折点、视口等，便于 Canvas 引擎与 SDK 同步。

## 9. 后续交互与实现规划（待办）

以下为产品/实现顺序建议，落地时与 **`DataManager`**、**`sdk-designer-sync`**、**`designer-storage-init`** 协同演进。

### 9.1 GraphSyncManager（脏图 → 批量写库）

- 用户拖动模型结束时（**`onDragEnd`**）**不**立即对每个像素写引擎；将变更记入**脏队列**（模型 id / 关系 id + 待写 **`canvas_meta`** 片段）。
- 工具栏或显式 **「保存」** 调用 **`GraphSyncManager.push()`**，经 **`session.batchUpdate()`**（或现有 **`pushGraphToEngine`** 路径）把 **`canvas_meta`** 与结构域增量一并提交。

### 9.2 增量加载（按页）

- 利用 **`sys_layers`** 与 N:N 关系，只加载**当前激活 Page** 可见的模型/边（示例思路：`session.query(sysModel).relatedTo(currentLayerId).run()` 或与现有 Layer 过滤 API 等价实现）。
- 大图谱时降低首屏与拖拽卡顿。

### 9.3 属性编辑器与引擎校验

- 用户修改 **`sys_props`** 的 **`data_type`** 时，自动校验该标识是否在 ModelDB 引擎允许的原生类型（及 **`MODEL_REF`**）集合内；非法则阻止提交并提示。

---

纯 JSON 解析：`src/persistence/mldg-json.ts`。SDK 同步：`src/sync/sdk-designer-sync.ts`、`src/engine/workspace-session.ts`。
