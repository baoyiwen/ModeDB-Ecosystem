# Model Designer — Agent / 开发约束

## 1. 技术栈与底层要求

- **核心渲染**：HTML5 Canvas（禁止用 DOM 模拟模型块）。
- **二进制**：禁止 `Buffer`；统一 `Uint8Array` / `DataView`（`encodeUtf8` / `decodeUtf8` / `dataViewOf` 见 `src/persistence/mldg-binary.ts`）。
- **模块化**：交互与业务逻辑放在 Manager；React 组件只做组合与绑定。

## 2. 持久化协议 (MLDG Schema) — Dual-Schema JSON

为满足「在其他引擎建立同等结构」且「保留画布信息」，内存与传输载荷采用 **Dual-Schema JSON**（`MldgDocument`）：

- **`engine_schema`（结构域）**：模型定义、Props、父子继承、关系。
- **`designer_layout`（表现域）**：`uuid`、`position(x,y)`、`color_theme`、`z_index`、折点、`viewport`、可选 **`layers`** / **`model_layers`**（与引擎 `sys_layer` / `layerHasNodes` 对齐）。

**持久化决策（强制）**：

- **禁止** 使用 File System Access API、`<input type="file">`、**`localStorage`** 等本地持久化。
- 所有读写经 **`@mode-db/sdk`**：`RemoteModelDBClient` WebSocket 会话（`encodeWirePayload` 对称加密）及管理 API 校验工作区。
- **二进制流**：`DataManager` 在发送前将文档序列化为 **`Uint8Array`**（UTF-8 JSON），再经 **`bytesToBase64Url`** 嵌入写行字段，通过 **`insertMany`** 进入加密通道（见 `src/sync/mldg-wire-bytes.ts`、`src/sync/sdk-designer-sync.ts`）。
- **服务端前提**：连接成功后由 **`ensureDesignerCatalog`**（`src/bootstrap/designer-storage-init.ts`）经线协议幂等注册 **`sys_designer_graph`** 等专题模型与关系；需 **modeldb-server** 支持 `registerModel` / `registerRelation` RPC（见 `@mode-db/shared` 线协议）。快照行模型字段至少含 **`graph_b64`**（String）、**`updated_at`**（String）。

## 2.1 工作区绑定与事务性同步

- **逻辑库名**：由构建环境变量 **`VITE_MODE_DB_WORKSPACE`** 决定（见 `src/config/fixed-database.ts`），默认 **`model_designer`**；验证页不提供修改入口。
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
| GraphLinker         | Node↔Node 拖拽连线，关系 kind 与引擎 `nodeLinksOut` 一致                                                   |
| PropVaultController | `metadata.vault_ref`（`m_addr_*`）/ `encrypt_level` 的保险库字段 UI（与引擎 `InternalVault` 指针语义对齐） |

---

纯 JSON 解析：`src/persistence/mldg-json.ts`。SDK 同步：`src/sync/sdk-designer-sync.ts`、`src/engine/workspace-session.ts`。
