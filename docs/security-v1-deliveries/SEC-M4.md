# SEC-M4 交付报告

- 交付日期：2026-10-21（工作区日期；D01—D03 为 2026-10-20）
- 里程碑：SEC-M4 / 安全连接与 Designer 会话
- 修订：D04
- 技术状态：完成；S4.1、S4.2、S4.3 全部通过阶段验收
- 用户反馈：待反馈
- 代码/构建定位：当前工作区变更，未提交或发布，未切换真实 9091
- 本次任务：S4.3 标准调用示例、发布授权信息与最终调用验收；保留 S4.1/S4.2 交付

## 交付内容

S4.1 保留 loopback、TLS/WSS、受信代理、IP/CIDR 来源名单、精确 Origin、查询参数凭据拒绝与 SDK 安全端点校验。

本次补齐 S4.2：

- 新增 Windows `security browser-open` 本机启动器。通过 OS 身份验证的命名管道签发配对码，明确授权当前逻辑库和设计器专属库；可显式声明待创建库名。不通过普通 loopback HTTP 授予管理员权限，不向浏览器交付长期服务凭证。
- `security session-pair --id … --origin …` 为已有受限凭据签发一次性邀请。码绑定精确前端 Origin，限时且只能消费一次；父凭据撤销、过期或访问重置后失效。
- 有效配对及会话可临时允许精确 Origin，IP、代理链和 TLS 规则继续执行。启动链接只用 fragment，前端读取后立即清除。
- 认证 Cookie 为 HttpOnly、SameSite=Strict，TLS/受信代理下带 Secure；名称按前端 Origin 与服务端地址隔离，避免不同工具互相覆盖。CSRF proof 由实际 session 派生，不能通过伪造另一枚 Cookie 绕过。
- 会话 30 分钟有效、最长 8 小时，并受父凭据期限约束。支持恢复、按需续期、活动页面续期、轮换、注销及撤销；会话信息返回实际 session 到期时间并禁止缓存。续期使旧 session 和旧 WS 失效。
- SDK 的数据 RPC、HTTP/WS、管理 JSON、二进制上传/下载均支持显式 `browserSession`。修复 `ModelDB.use()` 的并发缓存及失败重试分支；浏览器模式不降级到 legacy 协议。
- Model Designer、Data Studio、Web 默认使用浏览器会话；提供一次性码输入与高级服务凭据模式。刷新页面可恢复，断开连接会注销；长期 Token 不写入 Web Storage。Designer/Data Studio 文案同步 zh/en/ja，Web 同步现有 zh/en。
- Designer 初始化改为批量 DDL，合并旧库字段补丁，同一会话复用初始化结果。解决逐条注册和逐条审计导致首次连接明显变慢的问题；授权与逐请求持久化审计仍然保留。

操作与部署约束见[浏览器安全连接](../security-browser-sessions.md)。

D04 补齐 S4.3：

- 接口管理显示完整 `POST` 地址，按当前 registry/legacy 认证模式生成示例。新模式使用环境变量注入的 Bearer；旧示例只适用于显式使用旧凭据的连接。
- 可下载不含真实凭据的 Postman Collection v2.1 模板。示例来自发布契约，包含正确 JSON 类型、默认值、业务版本、分页和独立访问密钥占位符；SDK 示例复用相同请求体。
- 展示准确接口名和完整 release 摘要的最小 `callable.query` 授权 JSON。默认本机开发会话不因此扩大权限。
- 接口测试控制台接入本地化安全错误；直接 HTTP 入口与 RPC 一致记录应用声明的用户标识，不把声明当成授权。
- 修复 `publicBaseUrl` 已缓存时无法被新地址覆盖或清空的问题；修正 TLS 启动说明中的前端协议示例。
- 新增[标准 HTTP/Postman 调用说明](../security-http-invocation.md)，涵盖本机签发、Postman、PowerShell、SDK、错误码和版本含义。

## 验收结果

| 验收 ID | 结果              | 环境/命令或步骤                                                                                                                                       | 证据                                                                        |
| ------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| M4-A1   | 通过（S4.1 范围） | Windows 隔离 HTTPS/WSS、证书信任与名称错误、远程明文拒绝、redirect 拒绝                                                                               | `security-network.test.ts`、`security-registry-http.test.ts`                |
| M4-A2   | 通过（S4.1 范围） | IPv4/IPv6/CIDR、映射地址、deny 优先、空允许名单、过期规则、伪造代理与 Origin                                                                          | `security-network.test.ts`、`security-authorization.test.ts`                |
| M4-A3   | 通过（S4.2 范围） | 真实 Windows 管道发码，Chrome 依次打开三个生产页面、自动配对、选库进入工作区                                                                          | `test/integration/security-browser-apps.test.ts`                            |
| M4-A4   | 通过（S4.2 范围） | 实际 Cookie、刷新恢复、注销、错误 Origin、伪造 CSRF、HTTP/WS 撤销、8 小时上限；HTTPS 邀请/Secure Cookie                                               | 浏览器验收及 browser-session、authorization、registry-http 测试             |
| M4-A5   | 通过              | 生成的 Collection 请求经真实 HTTP 执行，原生 curl 和 SDK short/stream 结果一致；越权、到期、撤销、旧协议及版本错误明确；Chrome 检查完整地址和模板下载 | `interface-call-docs.test.ts`、`security-authorization.test.ts`、浏览器验收 |

验证命令与结果：

- `tsc -p packages/server/tsconfig.json`、`tsc -p packages/sdk/tsconfig.build.json`：通过。
- 三个前端 `tsc --noEmit -p …/tsconfig.json`：全部通过；此前 Designer 的依赖声明读取限制在本次环境中未复现。
- 三个前端 Vite production build：全部通过；Designer 仍有已有的大 chunk 提示。
- network、authorization、registry-http、browser-session、browser-connection-credentials、interface-call-docs 六个测试文件：D04 最终复验 27/27 通过。
- query-interface-errors、query-interface-publication、published-interface-runtime：D04 相关回归 21/21 通过，覆盖发布契约、参数、版本、投影、访问密钥与接口限流。D04 单元/HTTP 测试合计 48 项通过。
- `security-registry.test.ts`：7/7 通过，覆盖真实 Windows DPAPI/管道、重启、并发、撤销和审计持久化。
- `test/integration/security-browser-apps.test.ts`：D04 最终复验 1/1 通过，内部覆盖三个生产页面；真实 Chrome headless、Windows 管道、临时 registry、随机端口。额外验证接口管理展开、完整 POST 地址、Bearer 示例、实际下载并解析 Postman 文件。

D04 复验命令：

```powershell
.\node_modules\.bin\tsc.cmd -p packages/server/tsconfig.json
.\node_modules\.bin\tsc.cmd --noEmit -p apps/model-designer/tsconfig.json
.\node_modules\.bin\tsx.cmd --test test/unit/security-network.test.ts test/unit/security-authorization.test.ts test/unit/security-registry-http.test.ts test/unit/security-browser-session.test.ts test/unit/browser-connection-credentials.test.ts test/unit/interface-call-docs.test.ts
.\node_modules\.bin\tsx.cmd --test test/unit/query-interface-errors.test.ts test/unit/query-interface-publication.test.ts test/unit/published-interface-runtime.test.ts
.\node_modules\.bin\tsx.cmd --test test/integration/security-browser-apps.test.ts
# apps/model-designer 目录下
node node_modules/vite/bin/vite.js build
```

SDK、Data Studio、Web 在 D04 没有新增生产代码改动，沿用 D03 的类型/构建结果；三个页面仍在 D04 浏览器验收中复验。原生 curl 通过标准库子进程调用，凭据不进入报告。Postman 验证为生成结构与等价 HTTP 请求执行，未手工操作 Postman 桌面端。

## 限制与后续

- SEC-M4 已完成研发和隔离验收；下一里程碑为 SEC-M5：安全中心、可视化邀请管理、日志检索、轮转与网络防护维护。
- 本机启动器不启动前端开发服务；需要相同协议和主机名。远程浏览器采用 HTTPS 同站点部署，跨站第三方 Cookie 部署不支持。
- 本机发放的会话只覆盖明确列出的库；新增库名需要启动时声明，发布接口仍要求已有的独立 release 范围授权。
- 远程邀请的 HTTPS 交换在本机隔离 TLS 实例验证；未进行外部设备、真实公网反向代理和跨机器浏览器验收。
- 生产审计仍逐请求持久化；完整日志容量、轮转及性能调优分别在 SEC-M5/SEC-M7 验收，不由此次批量初始化优化替代。
- 未重启 9091、未改真实配置或凭据、未迁移旧 Vault；保留用户已有工作区修改。

## 环境与数据影响

测试仅创建临时目录、隔离 registry、合成 graph 与设计器库及专用 Chrome profile。测试结束清理测试进程和文件，不接触现有业务库。未提交、发布 npm 包或执行服务切换。

## 修订与反馈

- D01：S4.1 网络与传输交付。
- D02：S4.2 会话原型及基础测试；当时三个前端、完整 SDK 管理面及 CSRF 安全绑定尚未完成，不能据此宣称会话交付。
- D03：完成服务端 CSRF/Origin/期限/审计归属修正、Cookie 隔离、SDK 与三个前端、OS 启动器、HTTPS 邀请和真实浏览器回归。浏览器初验曾因测试仅改变 fragment 而未重载、重复创建测试库以及逐条初始化耗时失败；修正测试并批量初始化后复验通过。
- D04（2026-10-21）：完成标准 HTTP/Postman/SDK 示例、发布授权摘要、错误反馈、地址缓存修正及直接 HTTP 审计标识对齐；27 项相关测试和覆盖三个前端及模板实际下载的 Chrome 验收通过。SEC-M4 完成，真实 9091 仍未切换。
