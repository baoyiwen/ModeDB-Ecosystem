# SEC-M5 交付报告

- 交付日期：2026-10-21（Asia/Shanghai）
- 里程碑：SEC-M5 / 安全中心、日志与网络防护
- 修订：D06（2026-10-26；D01—D05 历史记录保留）
- 技术状态：D05 隔离验收后，SEC-M7 / D06 按反馈重开 S5.1；SEC-M7 / D10 修复并复验 M5-A1，SEC-M5 恢复完成；S5.2、S5.3 的历史验收保留
- 用户反馈：待反馈
- 代码/构建定位：当前工作区变更，未提交或发布，未切换真实 9091
- 最新任务：D06 / S5.1 语言入口与设计指引复验；以下保留 S5.1—S5.3 的历史交付记录

## 交付内容

- Model Designer 接入全屏安全中心工作区，包含概览、主体、凭证、会话、权限、网络策略和密钥引用页签。
- 安全中心只读取脱敏安全概览，不展示凭证秘密、令牌哈希或密钥材料；安全管理员会话与业务数据库授权隔离。
- 页面保留编辑器工作区上下文，提供无权限/连接失败状态、可信启动器提示和刷新入口。
- 新增 zh/en/ja 文案，覆盖安全中心页签、状态、权限和网络策略展示。
- `SecurityRegistry.auditPage()` 提供有界、按时间倒序的审计查询，支持时间、分类、动作、结果、主体、凭证、数据库、请求 ID 和客户端 IP 筛选，并返回分类/结果/IP 聚合统计。
- HTTP `GET /api/v1/security/admin/audit` 仅接受安全管理员浏览器会话，响应禁缓存，不返回令牌、哈希或请求体等秘密；HTTP、RPC、WebSocket、备份和数据库管理事件均保留可验证的来源 IP 归因。
- SDK 提供 `getSecurityAudit()`，Model Designer 安全中心新增审计页签、统计指标和上一页/下一页分页。
- SDK 根入口导出 `exportSecurityAudit()`；安全中心按当前筛选条件下载 JSONL，并提供导出失败和容量/保留健康提示。
- registry 启动和后续提交时清理超出配置保留期的事件，清理数量自身进入审计记录；审计容量 80%/95% 分别报告 warning/critical，达到硬上限时变更 fail-closed。
- Windows 本机安全 CLI 支持 `security audit` 和 `security audit-export`；导出采用新建文件、不覆盖、不更改父目录 ACL，且拒绝写入 registry 目录（包含通过目录 junction 的别名）。导出先生成事件快照，再追加导出留痕，避免自身递归进入文件。
- HTTP 审计查询严格校验已知参数、重复参数、分页整数和筛选枚举，避免用户请求范围因不规范参数被静默放宽。
- 管理面/数据面分别维护 IPv4/IPv6/CIDR 允许和拒绝规则；拒绝优先，开启但为空的允许名单拒绝访问。规则期限和临时封禁持久化，HTTP、WS 握手、已有连接及排队写操作共用边界检查，策略收紧后现有 WS 以 1008 关闭。
- 规则变更必须先预览当前连接命中结果，再用配置、操作者和 revision 绑定的预览 ID 应用；预览与应用后确认窗口均为 120 秒。CAS 防止覆盖并发修改；未确认变更超时、重启或时钟回退自动回滚，也可按 revision 主动回滚。OS 身份认证的 Named Pipe 保留网络锁定后的修复路径。
- 请求窗口按可信来源 IP/入口面和认证主体/入口面分别计数。默认 60 秒窗口，数据面每来源 1000 次、管理面 240 次、每主体每入口面 1000 次；认证失败 20 次仅观察，自动封禁默认关闭，启用后默认封禁 600 秒。限流和封禁返回 429 与 `Retry-After`；管理来源豁免不绕过手工拒绝规则或认证。
- 安全管理员浏览器 control 接口要求 Cookie、Origin、CSRF；普通业务会话和 Bearer 凭证不能执行。SDK、Model Designer 与 OS CLI 共用严格控制命令解析和服务端维护实现。审计/策略持久化失败保持最后有效策略并拒绝敏感操作；不可信代理头按实际 socket 归因。
- IMK 轮换先持久保存新旧主密钥及任务，再逐个重封装 DEK，启动时继续未完成任务；Vault 内容和 key reference 保持不变。浏览器执行轮换要求配对凭证创建距今不超过 5 分钟，会话刷新不延长授权新鲜度；CLI 要求 OS 身份和 `--yes`。
- 出厂清除仅提供离线 CLI：要求精确实例 ID、规范化后的完整 workspace 目标和 `--yes`，拒绝运行中的实例、根目录、重叠目标及目录联接。删除前创建目标之外的 AES-GCM + DPAPI 加密归档并实际解密验证，写入持久 tombstone，逐文件复核 hash；实例锁和密钥维护锁贯穿文件删除。完成后生成 receipt；中断保留归档并阻止实例启动。
- Model Designer 增加独立安全管理员入口、刷新恢复与退出，以及网络编辑、命中预览、倒计时确认、回滚、解封、维护状态和轮换确认界面，覆盖 zh/en/ja 和窄屏布局。

## 涉及文件与操作入口

- 服务端：`packages/server/src/security/security-protection.ts`、`security-control.ts`、`security-maintenance.ts`、`network-boundary.ts`、`network-policy.ts`、`local-vault-key-provider.ts`、`security-registry.ts`、`windows-secret-protector.ts`、`local-management-channel.ts`、`registry-entrypoints.ts`、`security-errors.ts`，以及 `packages/server/src/dual-track-app.ts`、`cli-security.ts`。
- 契约/SDK：`packages/shared/src/security-contracts.ts`、`packages/sdk/src/security-center.ts` 及根导出。
- 前端：`apps/model-designer/src/components/SecurityProtectionPanel.tsx`、`SecurityCenterWorkspace.tsx`、`App.tsx`、`WorkspaceGate.tsx`、`styles/designer-shell.css` 和 zh/en/ja 文案。
- 验证：`test/unit/security-protection.test.ts`、`security-windows-keys.test.ts`、`security-registry-http.test.ts`、`test/integration/security-browser-apps.test.ts`；根 `package.json` 增加 `test:security:protection`。
- 文档：本报告、`docs/security-v1-milestones.md`、`docs/security-v1-plan.md`、`docs/security-v1/AGENTS.md`。

以下是命令形状，配置参数必须显式指定；本次执行仅使用临时配置。规则 JSON 对应共享 `SecurityProtectionConfig`，含 `data`、`management`、`rate`，不能缺项或加入未知字段。

```text
modeldb-server security security-open --url <designer-url> -c <isolated-config>
modeldb-server security network-status -c <isolated-config>
modeldb-server security network-preview --rules-file <rules.json> -c <isolated-config>
modeldb-server security network-apply --rules-file <rules.json> --revision <n> --preview <preview-id> -c <isolated-config>
modeldb-server security network-confirm --id <pending-id> -c <isolated-config>
modeldb-server security network-rollback --revision <n> -c <isolated-config>
modeldb-server security network-unban --id <ban-id> -c <isolated-config>
modeldb-server security maintenance-status -c <isolated-config>
modeldb-server security master-rotate --yes -c <isolated-config>
modeldb-server security factory-reset --instance <instance-id> --target <exact-workspace> --yes -c <isolated-config>
```

## 验收结果

| 验收 ID | 结果 | 环境/命令或步骤                                                                                                                                                                 | 证据                                                                                                                                         |
| ------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| M5-A1   | 通过 | 三个生产前端在 Chrome 隔离环境完成配对、业务工作区、刷新恢复、HttpOnly 与退出；Designer 另验证独立安全入口、规则预览/应用/确认/回滚、IMK 轮换、390×844 无横向溢出及无未处理异常 | `test/integration/security-browser-apps.test.ts`；1/1 通过（约 164.8 秒）；Named Pipe 核对 UI 操作结果                                       |
| M5-A2   | 通过 | 审计日志检索、统计和筛选已实现；普通浏览器会话返回 403；安全管理员会话获版本化结果；重复和未知筛选参数返回 400                                                                  | `test/unit/security-registry.test.ts`、`test/unit/security-registry-http.test.ts`；12/12 通过                                                |
| M5-A3   | 通过 | 元数据脱敏、管理员受控查看/导出、保留清理、容量告警与满载 fail-closed 均已验证；CLI 导出拒绝 registry 目录与 junction 别名                                                      | registry 容量/保留/导出测试、HTTP 权限测试及 `resolveAuditExportPath` 回归测试；12/12 通过                                                   |
| M5-A4   | 通过 | 双入口面、deny 优先、enabled 空 allow、期限清理、重启不延长 ban、已有 WS 即时重检、来源/主体限流、失败观察与可选 ban/unban、伪造代理归因及审计失败拒绝                          | `security-protection.test.ts`、`security-network.test.ts`、`security-registry-http.test.ts`；包含真实隔离 HTTPS/WSS 与 DPAPI                 |
| M5-A5   | 通过 | 预览绑定/CAS/限时确认、超时/重启/时钟回退自动回滚、OS 管道修复管理面锁定、UI/CLI 共用控制；轮换中断恢复和 Vault 不变；清除精确目标、备份解密校验、确认/锁/ACL/junction/中断保护 | `security-protection.test.ts`、`security-windows-keys.test.ts`、`security-registry-http.test.ts`、浏览器测试；真实 DPAPI 离线 CLI reset 通过 |

### 实际验证与失败修复

1. 最终安全回归命令如下，71/71 通过，0 skip，约 82.3 秒。包含 S5.2 的审计查询/导出/保留/容量、既有 Vault/授权/网络/会话，以及本次防护维护与 Windows 实机测试。此前 S5.2 的 registry/HTTP 定向结果为 12/12，通过事实保留。

   ```powershell
   node node_modules/tsx/dist/cli.mjs --test test/unit/security-vault-v2.test.ts test/unit/security-windows-keys.test.ts test/unit/server-directory-layout.test.ts test/unit/security-registry.test.ts test/unit/security-authorization.test.ts test/unit/security-network.test.ts test/unit/security-browser-session.test.ts test/unit/browser-connection-credentials.test.ts test/unit/interface-call-docs.test.ts test/unit/security-protection.test.ts test/unit/security-registry-http.test.ts
   ```

2. `node node_modules/tsx/dist/cli.mjs --test test/integration/security-browser-apps.test.ts`：1/1 通过，0 skip，约 164.8 秒。三个前端使用生产构建、隔离 Chrome profile、临时配置和随机端口。管理员数据库列表为 200 空数组，具体业务库 catalog 为 403，管理员身份不隐含数据授权。
3. `node node_modules/tsx/dist/cli.mjs --test test/unit/security-protection.test.ts test/unit/security-windows-keys.test.ts`：19/19 通过，含真实 DPAPI 离线 reset CLI；最终 71 项回归已包含这 19 项。
4. shared/common/core/server/SDK 的直接 TypeScript 构建、Model Designer `tsc --noEmit` 及生产 Vite 构建通过；Designer 构建仍提示已有大 chunk。Designer 类型检查首次受现有 `exceljs`、`dayjs` workspace 依赖 junction 读权限限制，只读放行后通过，未改依赖。
5. server 安全目录、CLI、shared 契约和 SDK 安全接口的限定 ESLint 通过；相关源码/本次四份文档 Prettier、源码产物边界检查及 `git diff --check` 通过。`test/` 被仓库 Prettier 忽略，测试文件未计入格式通过范围。
6. 本机 `pnpm run check` 原始失败为 pnpm 11.25 SQLite store 的 `ERR_SQLITE_ERROR: unable to open database file`，故采用上述 Node 直接命令验证。直接运行根 TypeScript 检查仍有 DOM/`ImportMeta.env`、依赖 junction、旧 fixture 缺少 `securityAudit`/`modelId`、旧类型和未使用变量等错误；本次相关包与 Designer 定向检查通过。不能声称整仓 `check` 或整仓类型检查通过，整仓验收仍属 SEC-M7。

验收中发现的问题及处理：

- 浏览器前两轮分别暴露了错误的测试断言和配对导航竞争：列表按 grant 过滤，应断言空数组并补具体库 403；一次性配对 URL 刚 navigate 就 reload 会丢 code，改为从 `about:blank` 打开启动器 URL，进入成功后再刷新。修正后完整浏览器验收通过。
- 一轮扩展回归为 70/71：并发初始化期望 `SECURITY_INSTANCE_BUSY`，实际偶发 `SECURITY_STORE_INVALID`。Windows 文件 ACL 枚举可能与另一初始化进程替换 pending 文件竞争，已改为先验证目录 ACL、取实例锁，再枚举文件 ACL。并发定向 1/1、最终完整 71/71 通过；未放宽目录或文件权限校验。
- 清除实现复核时将实例锁/密钥维护锁的释放点延后到全部文件删除之后，并补删除期间两把锁仍存在的断言。限定 lint 发现的本机通道类型导入及括号问题已修正并复验。

## 限制、缺陷与风险

- 清除中断后 tombstone 阻止启动；本次未提供 reset 续跑或归档恢复工具。归档已验证可解密，但故障后的自动恢复/操作工具仍须后续实现和验收，不能手工删除标记后直接重启。
- reset 归档采用同机同账号 DPAPI，不是 SEC-M6 要求的独立灾备材料。清除上限为 10000 文件、128 MiB；超限拒绝，未提供流式大实例清除。
- IMK 轮换保留历史主密钥，不自动销毁，最多 1000 项；它只重封装 DEK，不等于 DEK 轮换或 Vault 数据重加密。历史依赖、安全销毁、独立恢复及异机演练仍属 SEC-M6。
- 请求窗口最多 10000 个内存键，满载拒绝新键；重启丢失窗口计数，持久 ban 保留原到期时间。多节点配额、连接数/执行时间/传输任务预算未在本阶段交付。
- 本阶段支持与实机验收平台为 Windows。整仓检查受上述环境及既有错误限制；没有据此宣称安全 V1 整体完成。

## 环境与数据影响

开始及结束均检查 `git status --short`，保留工作区已有改动。所有服务、密钥、轮换和清除测试均使用系统临时目录中的合成实例、显式临时配置及随机端口；未连接、重启或切换真实 9091，未读取或修改真实配置、凭据、密钥、Vault 或业务数据库。当前成果仅在工作区，未提交、推送、部署或发布。

## 后续任务

下一任务为 SEC-M6 / S6.1：独立恢复材料、历史密钥封装/依赖检查、DEK 轮换和异机恢复演练。累计完成 5/7 里程碑、15/20 开发任务。后续仍先阅读专项 AGENTS、唯一台账与本报告；接触真实实例须另有明确授权。

## 修订与反馈

- D01（2026-10-21）：建立安全中心阶段性实现和验证边界；不增加已完成里程碑或任务计数。
- D02（2026-10-21）：完成三前端 Chrome 隔离浏览器验收，记录 35 项安全隔离测试与 1 项浏览器集成测试通过；S5.1 由待验证更新为已通过，SEC-M5 仍因 S5.2/S5.3 未开始保持进行中。
- D03（2026-10-21）：完成 S5.2 审计查询、来源归因、聚合统计、管理员 HTTP 接口、SDK 和 Model Designer 分页展示；registry 定向测试 10/10 通过。S5.2 保持进行中，导出、轮转/保留、CLI 和健康告警列为剩余交付。
- D04（2026-10-21）：完成 S5.2 受控 JSONL 导出、导出留痕、保留清理、容量健康状态、OS 本机 CLI 与 Model Designer 筛选/下载；修正审计 query 的严格解析、SDK 根导出缺失、UI 共享筛选类型和 junction 路径绕过。registry/HTTP 定向测试 12/12、server/SDK/Model Designer 类型检查通过；Model Designer 检查需只读访问现有 workspace 依赖 junction 目标。相关格式与配置语法、`git diff --check` 通过；S5.2 标记完成，累计 14/20 开发任务，S5.3 未完成，SEC-M5 继续进行中。
- D05（2026-10-21）：完成 S5.3 双入口面网络维护、限流/临时封禁、预览/确认/回滚、本机修复、可恢复 IMK 轮换、受保护离线清除和 Designer/SDK/CLI 接入；修复并记录浏览器测试断言/导航竞争、并发初始化 ACL 竞争及删除锁范围。最终安全回归 71/71、三前端浏览器 1/1 通过；限定构建/类型/lint/格式检查通过，整仓检查限制及 reset 恢复工具缺口如实登记。M5-A1—M5-A5 通过，SEC-M5 完成，进度为 5/7、15/20；真实环境未触及，下一 SEC-M6 / S6.1。
- D06（2026-10-26）：SEC-M7 / D06 按部署反馈重开的 S5.1 / M5-A1 已在 [SEC-M7 / D10](SEC-M7.md#d10s51-语言入口与设计导航) 修复并复验。连接页/安全中心支持 zh/en/ja 语言切换，独立安全页提供单独授权的设计入口指引；规范服务地址，修复编辑器内安全页全高布局并保留返回上下文。21/21 相关单测、根/Designer 类型、隔离三前端构建、Chrome 1/1（0 skip）及实际视觉检查通过，普通会话管理 API 仍返回 403，管理员仍无隐含业务权限。简介/手册/实操指南与截图摘要同步；SEC-M5 恢复完成，累计 6/7、19/20，下一 S7.2 相关复验。D05 原证据保留，本轮不重跑其 71 项安全集；未触及真实环境，新增注册实现仍为 0/23。
