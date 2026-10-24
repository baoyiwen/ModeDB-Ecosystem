# SEC-M3 交付报告

- 交付日期：2026-10-20（工作区日期）
- 里程碑：SEC-M3 / 全入口统一授权
- 修订：D01
- 技术状态：完成
- 用户反馈：待反馈
- 代码/构建定位：HEAD `07e5393` 基础上的本地工作区变更，未提交/发布；含 M1/M2 既有改造
- 本次任务：S3.1—S3.3；按用户要求同步 model-designer、data-studio、web

## 交付内容

registry 模式接入限权 Bearer JSON RPC、新 WS 和标准 HTTP 查询接口；旧全局 Token handler 在新模式下不可达。SDK 发现协议并验证凭据后才暴露会话，保留结果 revive，已有 WS 及时失效、排队写入重新授权，失败连接清理后可重新尝试。

发布接口按完整 release 的 canonical SHA-256 固定权限范围，保留既有投影、accessKey、限流和运行时审计。Binding Surface 的子查询/写接口分别检查；发布者修改 sys 发布记录时还须有目标业务库授权。通用读写采用整库权限，DDL、导入、备份、库管理分别授权，精确字段访问使用发布接口。

建库、备份、清空、同库恢复和删库通过统一授权与写队列；破坏性操作先创建安全备份，恢复/删除时 evict 引擎缓存。备份下载不隐式授权其他库，也不返回物理路径。外部备份上传、force-reset、实例安全管理保持默认拒绝，后续里程碑接续对应安全工作流。

三个前端停止保存长期 Token，清理旧存储键、移除 Token 构建变量入口，增加本地化错误和内存凭据说明；刷新后重新输入。data-studio/web 的启动、构建补齐 shared → SDK 顺序。Web 断开时关闭已打开的客户端。

授权矩阵、凭据示例、标准调用和开发连接说明见[统一授权与客户端连接契约](../security-v1-authorization-contract.md)。

## 验收结果

| 验收 ID | 结果 | 可复现证据                                                                                                                                                            |
| ------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M3-A1   | 通过 | registry-entrypoints 默认拒绝；旧 HTTP/WS 426，匿名 401；limited 凭据访问管理状态/reset/sys/其他库拒绝；真实 registry HTTP 管理闭环                                   |
| M3-A2   | 通过 | 限定查询仅返回 label，隐藏值不返回；禁止原始查询/跨库/sys；完整 release 内容扩大且原 signature 不变仍拒绝；发布者缺少目标业务库权限时不更新记录                       |
| M3-A3   | 通过 | bind/rebind/unbind/delete 读凭据拒绝、整库写凭据通过；导入另需权限；备份创建/下载权限分离；batch 项后撤销返回 partial 与后续逐项失败；请求原子回滚 batch 在写入前拒绝 |
| M3-A4   | 通过 | SDK short/stream 验证与结果 revive、并发调用排队、HTTP 立即撤销、已有 WS 失败、已排队写入无副作用；已提交单项保留结果，不中断落盘                                     |
| M3-A5   | 通过 | 同一限权凭据可直接 HTTP 调用，无 SDK 也遵守投影；伪造角色/租户头不扩大权限；应用声明用户仅进入标记审计，不记录业务值或 Token                                          |

额外故障验证：执行前审计拒写阻止业务变更；业务已提交而结果审计拒写返回 `SECURITY_OUTCOME_UNCONFIRMED` 并保留 started 意图，不能当成“未执行”盲目重试。

## 验证命令与结果

环境：Windows、PowerShell、Node v24.15.0。使用已有本地工具，无新增运行时依赖。

- `tsc -p packages/shared/tsconfig.build.json`、common/tsconfig.json、core/tsconfig.build.json、server/tsconfig.json、sdk/tsconfig.build.json：5 包构建通过。
- 三个 apps 的 `tsc --noEmit -p tsconfig.json`：均通过。
- 三个 apps 的 `node node_modules/vite/bin/vite.js build`：均通过；Designer 保留大 chunk 提示。
- `tsx --test test/unit/security-authorization.test.ts test/unit/security-registry-http.test.ts test/unit/browser-connection-credentials.test.ts`：12/12 通过，其中 HTTP 管理闭环使用真实 Windows DPAPI/ACL 与临时服务，前端存储使用标准 Storage 行为测试替身；HTTP/WS 各自验证同一 SDK 实例短暂连接失败后重试，以及并发连接共享。
- M1/M2/目录回归 `security-registry`、`security-windows-keys`、`security-vault-v2`、`server-directory-layout`：23/23 通过。
- 发布 Query/Operation/Binding Surface 运行时、pivot-interface-http、data-transfer-http、backup-management-http：21/21 通过。
- 发布/编译、绑定、错误契约、排序/HAVING/cursor 等 10 个相关测试文件：66/66 通过。
- 修改的 server/shared/SDK 生产代码 ESLint 与相关文件 Prettier：通过。根 ESLint 配置忽略 apps/test，不将其忽略结果写成前端 lint 通过。
- 根 `tsc --noEmit -p tsconfig.json` 仍有原有 28 项诊断（Vite ImportMeta、旧测试类型/只读赋值/未用项等），未宣称全仓检查通过；本次新增测试未引入新的类型诊断。

修复中记录：最初的测试 fixture 使用了不受支持的空条件，已改成合法条件；data-studio/web 首次构建发现旧 SDK dist，正确构建依赖后通过，已补 predev/prebuild 防止重复。早期命令误用 SDK 的 noEmit 配置作构建，最终使用 build 配置重新生成并验证。没有把失败尝试当作通过。

## 限制与后续阶段

- 本阶段通用 RPC 采用整库权限，单模型/任意字段过滤与行级策略未实现；接口调用者通过固定发布契约获得最小字段范围。
- 当前 batch 不支持跨项回滚；请求此语义时在执行前拒绝，不能声称提供数据库事务。
- M4 尚未完成：TLS/WSS 部署配置、来源名单、Origin/CSRF、本机/远程可信配对、短期 Cookie/续期。三个前端的内存凭据连接不能当成最终浏览器会话交付。
- M5 尚未完成：当前早期审计每次整体加密台账，默认 10000 事件到限拒绝；IP 统计、未认证流量日志、检索、保留/轮转和管理 UI 后续实现。
- M6 尚未完成：当前同机备份仍依赖本实例密钥，不是异机恢复材料或新资产交付包；外部上传默认拒绝。
- 本次没有完整浏览器点选/视觉验收，没有跨机器 TLS 或异机恢复测试，不用构建/单元结果代替这些后续验收。

## 环境与数据影响

全部服务实验使用临时目录、随机 loopback 端口；测试建库/删除只针对测试自身创建的目录。没有重启现有 9091 服务，没有改动现有配置/凭据，没有删除或迁移真实数据库。工作区原有 `vault/model_designer_workspace/atlas.mld` 修改保留。

旧 `MDB4SVLT` Vault 仍会返回 `VAULT_LEGACY_FORMAT`。M3 完成不代表旧库自动可用；此前 Designer 的旧格式故障不会仅靠继续接入认证解决。

## 后续任务

SEC-M4 / S4.1 安全传输与来源策略 → S4.2 配对和浏览器会话 → S4.3 标准客户端与完整地址验收。保持三个前端使用同一 SDK/会话契约。
