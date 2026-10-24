# SEC-M3：统一授权与客户端连接契约

对应 [SEC-M3 / S3.1—S3.3](security-v1-milestones.md)。本文件替代 M2 文档中的阶段性 503 门禁说明；不代表已切换现有进程或迁移旧 Vault。

## 连接与认证

新配置 `"security": { "version": 1 }` 使用 registry 模式。`GET /health` 返回非秘密能力声明：

```json
{ "ok": true, "v": 2, "security": { "mode": "registry", "protocol": 1 } }
```

HTTP 使用 `Authorization: Bearer <API credential>`，API 凭据形如 `mdbt_v1_...`，从 OS 身份保护的本机 CLI 创建并一次性交付。不会根据客户端 IP 为 localhost、User-Agent、角色/租户头或“来自 SDK”的声明直接放行。

| 入口                                                          | registry 模式行为                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /health`                                                 | 公开健康与协议版本，不验证凭据                                                    |
| `GET /api/v1/security/context?database=<name>`                | 验证凭据有效性及目标库存在授权；不打开业务 Vault                                  |
| `POST /api/v1/rpc`                                            | JSON V1，统一身份与操作授权                                                       |
| `WS /api/v1/stream`                                           | 首条消息认证，每条操作重新验证；撤销通知关闭连接                                  |
| `POST /api/v1/databases/<db>/query-interfaces/<callable>`     | 同一授权与已发布接口运行时；支持 Postman 等标准客户端                             |
| `GET /api/v1/management/databases`                            | 只返回凭据明确授权的库，不读取其他库的 Designer 元数据                            |
| `GET /api/v1/management/databases/<db>/catalog`               | 整库读取权限；系统库另需 schema 权限，保留 i18n 标签和类型                        |
| `GET /api/v1/management/backups?database=<db>`                | 明确库名及 `backup.manage`                                                        |
| `POST /api/v1/management/databases/<db>/backup`               | `backup.manage`，经过该库写队列，先 flush，再快照                                 |
| `GET /api/v1/management/backups/<file>/download`              | 校验实际备份所属库，同时要求 `backup.manage`、`transfer.export`；不返回物理路径   |
| 建库、删库、清空、同库备份恢复                                | 独立 `database.manage` 与下表权限，写队列内执行；破坏性操作先备份，失败不静默跳过 |
| 旧 `/v2/action`、`/v2/bulk`、`/v2/stream`、根 WS              | HTTP 426 `SECURITY_PROTOCOL_UNSUPPORTED`，不进入旧 Token handler                  |
| 状态详情、安全 reset、force-reset、外部备份上传及未列出的入口 | 默认拒绝；本机维护仍走受保护管道，外部加密备份接收在 M6 实现                      |

不含 `security` 的已有配置仍为显式 legacy 模式。新 SDK 允许旧 Token 连接旧服务，但不会把 `mdbt_v1_...` 发送到旧传输；未知安全模式明确失败。TLS、代理、来源名单、Origin/CSRF、浏览器配对和 Cookie 在 M4 实现，本阶段验证使用隔离 loopback 实例。

## 授权矩阵与范围

每条 grant 必须明确写一个逻辑库。`resource: "*"` 只代表该库中的资源，不是全实例管理员。不存在角色头直接映射权限的逻辑。

| 能力                                           | 要求                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 通用查询、关系预览/统计                        | 目标库 `model.read`，`resource: "*"`                                                                                       |
| 通用行写入、bind/unbind/rebind、间接写入与删除 | 同库 `model.read` + `model.write`，均为 `*`                                                                                |
| DDL                                            | 同库 `model.read` + `model.write` + `schema.manage`                                                                        |
| insertMany、导入查找绑定                       | 同库读写 + `transfer.import`                                                                                               |
| Designer 专属库、含 `sys_*` 模型的库           | 上述要求之外增加同库 `schema.manage`                                                                                       |
| Query / Operation / Binding Surface 调用       | 同库、准确接口名/Surface ID、对应 `callable.query` / `callable.operation` / `callable.binding`，以及匹配的 `releaseDigest` |
| 修改接口发布元数据                             | Designer 库读写及 schema；还需目标业务库 `schema.manage` + `model.read`，写接口和 Surface 另需 `model.write`               |
| 建库                                           | 准确新库名 `database.manage` + `schema.manage` + `model.read` + `model.write`                                              |
| 删库/清空/同库恢复                             | 上述管理权限 + `backup.manage`；恢复只能选择同库备份                                                                       |

通用 RPC 暂采用整库能力，避免遍历、嵌套结果、关系和级联造成漏检。只有具体模型或字段资源名的 grant 不会获准调用通用查询；没有实现自动字段过滤或行级隔离。精确字段授权通过已发布接口投影提供。原始查询结果可被客户端保存，本阶段不能阻止已获数据的客户端自行导出；`transfer.export` 独立控制整库备份下载。

Model Designer 同时使用业务库和 `model_designer_workspace`，需要对两个库分别授权。数据工作台及 Web 可仅授权目标业务库。创建业务库或自动创建缺失的 Designer 库还需要准确库名的 `database.manage`，不会自动扩展到其他名称。

本机开发时，为 Model Designer 准备的授权文件可以写成下面这样（`business` 替换为实际业务库唯一名）。这是完整开发权限，不应交付给仅调用接口的应用：

```json
[
  {
    "database": "model_designer_workspace",
    "resource": "*",
    "actions": [
      "database.manage",
      "schema.manage",
      "model.read",
      "model.write",
      "transfer.import",
      "backup.manage",
      "transfer.export"
    ]
  },
  {
    "database": "business",
    "resource": "*",
    "actions": [
      "database.manage",
      "schema.manage",
      "model.read",
      "model.write",
      "transfer.import",
      "backup.manage",
      "transfer.export"
    ]
  }
]
```

将该 JSON 保存为授权文件，再使用 M2 的 `security principal-create --name <名称>` 和 `security token-create --principal <ID> --name <名称> --grants-file <授权文件> --output <受保护的新文件>` 创建凭据。凭据只交付一次，列表不可取回。通用开发权限不自动等同于发布接口调用权限；如需在预览器中调用某个发布接口，应额外添加其准确名称与摘要的 callable grant。后续安全中心会提供可视化授权流程。

## 发布与批量执行

`securityReleaseDigest(completeRelease)` 从 shared/SDK 导出。它对完整存储 release 的 JSON 按对象键排序后计算 SHA-256，数组保持顺序；包含投影、执行模板、条件、发布策略和依赖版本。不要仅散列 `signature` 字段。

为发布接口创建的 grant 示例：

```json
[
  {
    "database": "business",
    "resource": "ListItems",
    "actions": ["callable.query"],
    "releaseDigest": "<审核完整 release 后计算的 64 位小写十六进制摘要>"
  }
]
```

摘要不符时返回 403 `SECURITY_RELEASE_SCOPE_CHANGED`。更新范围后应审核并创建新 grant/凭据，随后撤销旧凭据。没有摘要的旧 callable grant 不放行；通配资源也不能替代准确接口名。Binding Surface 和所引用的查询、写接口分别授权和固定摘要，Surface 权限不隐式扩大子接口权限。写后刷新失败仍遵守原有 `refreshFailed` 结果契约。

写请求等待队列后重新验证凭据。已进入执行的单项写操作按引擎一致性规则完成；不在中途强制终止文件提交。发布 batch 在每个实际执行项前重新验证，继续模式逐项返回权限错误，停止模式给出跳过数量。当前引擎公开模板仅支持非回滚 batch；请求回滚的 batch 在模板校验时拒绝，不宣称提供跨项原子事务。通用 batchUpdate/batchDelete 使用整库权限，在任何项目写入前统一授权；执行中的授权不被拆成半提交。

## SDK 与三个前端

SDK 的 public API 保持 `ModelDB({ host, port, token })` / `connectNetwork` / `connect({ url, dbName, token, mode })`。SDK 先发现协议，再完成凭据验证才暴露会话；registry 使用 JSON HTTP 或新 WS，保留结果 revive。单个 WS 内按顺序发送，避免消息重入；关闭时未完成请求立即失败，不自动重发写请求。

Model Designer、data-studio、web 同步使用这一 SDK。三者移除旧浏览器 Token 存储并清理历史键，服务凭据仅放内存；不再读取 `VITE_*TOKEN` 构建变量。M4 已补齐短期 HttpOnly Cookie/可信配对，浏览器会话可刷新恢复；高级服务凭据模式刷新后仍需重新输入。主机、端口、逻辑库等非秘密偏好继续保存。Designer/data-studio 增加 zh/en/ja 错误提示，Web 按其现有 en/zh-CN 语言集合同步。见[浏览器安全连接](security-browser-sessions.md)。

data-studio/web 的启动和构建会先构建 shared、SDK，避免类型源码已更新而浏览器仍加载旧 dist 导出。Model Designer 的开发配置直接引用源码。

## 应用后端接入与诊断

应用先在自己的后端完成用户鉴权，再使用仅有指定接口权限的服务凭据调用 ModelDB。用户浏览器不需要获得应用服务凭据。`X-ModelDB-User-Subject` 可附带限定长度/字符的用户标识，仅对已验证应用主体记录为 `userSubjectTrust: "application-asserted"`；不会加入授权条件。角色、租户、代理 IP 等普通头不会增加权限。没有实现 OAuth Token Exchange 或外部用户身份联合。

标准 HTTP 请求示例（凭据由调用端安全注入，不写入源码）：

完整的地址、Postman 模板、限权凭据准备及错误处理见[发布查询接口的标准调用](security-http-invocation.md)。

```http
POST /api/v1/databases/business/query-interfaces/ListItems
Authorization: Bearer <应用的限权凭据>
Content-Type: application/json
X-ModelDB-User-Subject: user-123

{ "version": "1.0.0", "parameters": {} }
```

通用 RPC 的请求为 `{ "version": 1, "database": "business", "operation": { ... } }`，响应为 `{ "version": 1, "result": { ... }, "requestId": "..." }`。WS 首条消息为 `{ "type": "security.hello", "version": 1, "database": "business", "token": "..." }`；后续为 `{ "type": "security.rpc", "version": 1, "id": "...", "operation": { ... } }`。凭据不放 URL。

认证错误 401，授权/发布摘要错误 403，版本错误 426；SDK 抛出 `ConnectionSecurityError`，含稳定 code、status 和可用的 requestId。业务参数和物理路径不进入安全错误。`VAULT_LEGACY_FORMAT` 独立提示旧数据格式，不能用更换 Token 修复。

执行先持久化最小审计意图，再执行并记录结果。安全审计写入失败不静默放行。业务提交与安全台账不是同一个跨文件事务；业务已成功而结果审计失败时返回 `SECURITY_OUTCOME_UNCONFIRMED`，保留未完成意图，客户端先核对结果，不能盲目重试。批量部分成功仍以响应的逐项结果为准。

当前数据审计保存在 DPAPI 保护台账内，每次写入整体加密，默认容量 10000，到限拒绝；不是生产高吞吐审计方案。M5 接续独立日志、来源 IP、未认证统计、轮转、保留和查询 UI。当前不以这些早期事件宣称已完成完整数据安全日志系统。

## 验证

`pnpm run test:security:authorization` 运行 scoped RPC/HTTP/WS、撤销、发布、批量、关系、备份、Windows DPAPI 管理闭环和三前端内存凭据回归。使用临时目录和随机端口，不删除真实业务库、不轮换现有凭据、不重启当前服务。完整证据见 [SEC-M3 交付报告](security-v1-deliveries/SEC-M3.md)。
