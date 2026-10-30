# 设备注册可信部署契约 V1

状态：DR-P1.1—P1.6 已交付部署/公共协议、持久台账、默认关闭的注册 HTTP 和本机审批 CLI。本文约束后续部署边界；批准仅登记主体、公钥与准确授权，DR-P2.2 / D19 已实现默认关闭的公钥登录与 SDK；正式页面和生产切换尚未交付，详见[登录契约](device-registration-protocol-contract.md#13-dr-p22-公钥登录与短期会话契约)。

## 1. 适用范围

设备注册只接受一个经过管理员确认的 HTTPS 部署描述。这份部署契约用于冻结目标实例、浏览器安全上下文和注册协议参数。DR-P1.2 的[公共协议契约](device-registration-protocol-contract.md)已冻结公开下载响应的版本、到期与容量字段，当前 JSON 不是安装配置或已发布的下载 API。它不是凭据、证书私钥、口令、会话、数据库授权或数据解密材料。

下载描述不创建主体、不列出业务库、不授予管理权限。后续注册仍必须由服务端发放一次性挑战，并由本机受保护的审批流程激活。

## 2. 冻结的描述字段

示例见 [`device-registration.deployment.v1.json`](examples/device-registration.deployment.v1.json)。实现和测试使用 `modeldb.device-registration-deployment.v1`。

| 字段                           | 约束                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format` / `descriptorVersion` | 固定为 `modeldb.device-registration-deployment.v1` / `1`。未知版本拒绝，不猜测兼容。                                                                    |
| `instanceId`                   | 服务端生成的随机 UUID v4；只用于实例绑定和审计关联，不能从主机名、MAC、CPU 序列或路径派生。                                                             |
| `serverOrigin`                 | 唯一规范 Origin，必须是 `https://`、小写 DNS 主机名、无用户信息、路径、查询、片段；纯 IP、`localhost`、通配符、尾点和动态 Host 拒绝。默认同源页面/API。 |
| `rpId`                         | 固定小写 DNS 名称，必须与 `serverOrigin` 的主机名完全相等。首版不接受运行时 Host、转发头或 Origin 推导 RP ID。                                          |
| `registration`                 | `mode` 为 `planned`、`enabled` 或 `disabled`；`publicDownload` 必须为 `true`。当前样例为 `planned`，因此不会开启运行时注册。                            |
| `tls`                          | `minVersion` 固定为 `TLS1.2`。`public-ca` 使用受信公共 CA；`owner-pinned` 必须登记 64 位小写 SHA-256 SPKI 指纹。描述不携带私钥或 CA 密钥。              |
| `binding`                      | `strategy` 固定 `instance-id-exact`，`requireExactInstanceId=true`，`allowHostDerivedIdentity=false`。挑战、批准、公钥凭证和会话都核对同一实例 ID。     |
| `supportMatrix`                | 浏览器必须运行在 secure context 且 `userVerification=required`；Node 支持矩阵只说明服务端运行时，不代表浏览器认证器能力。                               |
| `performanceBaseline`          | 固定隔离合成 A/B 方法、场景、样本数、p95 门槛和排除项。用户输入 PIN/生物识别时间单独计量，不能混入服务端延迟。                                          |

禁止加入 `token`、`secret`、`privateKey`、`passphrase`、`grant`、`database`、`command`、私有路径或任何未定义字段。校验器按未知字段拒绝，避免未来把自授权限或脚本带入公开描述。

## 3. Origin、RP ID 和证书规则

首版部署名称必须先确定 DNS，再签发覆盖该名称的 HTTPS 证书。`modeldb-a.example.test` 是隔离文档示例，不是可连接的真实地址。纯 IP、临时网卡名称和动态 DNS 名称不能暗中启用注册；需要改名时生成新描述并重新审批，不能把旧 RP ID 自动迁移。

`serverOrigin` 由部署所有者登记，首版只允许该精确 Origin；额外 Origin 需要另行变更契约和兼容验收。禁止 `*`、主机名模糊匹配和仅凭 `Origin` 赋权。端口属于 Origin，非默认端口必须明确登记；RP ID 不含端口。Origin 校验与来源 IP 白名单、身份认证分开；`localhost` 或 `127.0.0.1` 只可用于当前已有的本机管理/开发流程，不能作为设备注册的生产 RP。

两种 TLS 模式均必须通过正常证书链、SAN 主机名和有效期校验。`owner-pinned` 在此基础上增加所有者带外核对的 SPKI 指纹；私有 CA 必须先通过独立、受控流程获得浏览器信任。浏览器 JavaScript 不能自行钉住证书、替代证书链或消除安全警告。公开描述不能让浏览器自动信任未知 CA，不能关闭证书校验，不能执行描述中的命令。证书续期如果改变固定指纹，必须走维护审批并生成新描述；公共 CA 模式仍须验证证书主机名、有效期和链。

## 4. 实例绑定和兼容边界

客户端提交描述中的 `instanceId`，服务端从受保护注册台账读取当前实例 ID，二者必须逐字匹配。挑战、注册申请、公钥凭证、批准记录和会话父级都记录实例 ID；错实例即使 RP ID 和签名正确也拒绝。实例恢复创建新访问台账时生成新的描述和新的注册关系，不能恢复旧会话或把旧描述当作批准证明。

结构校验不建立信任。`assertDeploymentBinding` 还须对照独立受信的部署基线，逐项比较实例、Origin 与 RP ID；同时替换 Origin/RP ID 或只改 Origin 端口也拒绝，不能把申请人提供的描述当作受信基线。

公开描述可被复制、缓存或转发，复制本身不能冒充设备。设备名称、来源 IP、浏览器 User-Agent、`X-Forwarded-For` 和声明的用户标识只用于显示/审计，不能替代公钥持有证明或本机审批。

当前兼容期保留 API Token 和一次性浏览器配对；DR-P1.2 规定台账/迁移约束，DR-P1.3 已实现默认关闭的新台账，DR-P2 才将注册身份接入会话父级。不能把 WebAuthn 私钥转换为长期 Bearer Token，也不因设备注册改变现有数据库 DEK、Vault 或备份格式。

## 5. 支持矩阵

这是开发目标矩阵，不是已完成的浏览器兼容验收：

| 端          | 最低目标            | 必须条件                                                               |
| ----------- | ------------------- | ---------------------------------------------------------------------- |
| Chrome      | 120+                | HTTPS secure context、WebAuthn Level 2、用户验证 required              |
| Edge        | 120+                | HTTPS secure context、WebAuthn Level 2、用户验证 required              |
| Firefox     | 122+                | HTTPS secure context、WebAuthn Level 2、用户验证 required              |
| Safari      | 17+                 | HTTPS secure context、WebAuthn Level 2、用户验证 required              |
| Server Node | 22+；目标矩阵 22/24 | 服务端 TLS、挑战随机源、加密库和依赖支持；不代表 Node 扮演浏览器认证器 |

Node 20 不列入新增注册的目标矩阵；DR-P1.2 依赖选择可以收紧此矩阵，不能未经验证扩大支持。本轮实际验证为 Node 24，22 的运行时兼容仍待后续验证。浏览器版本表示协议最低目标，实际部署还需安装该浏览器的安全更新。

实际支持必须按浏览器、操作系统、认证器和代理组合做隔离集成测试。无法满足 secure context、用户验证或准确 Origin/RP ID 时明确拒绝，不降级到纯 IP、HTTP 或无验证模式。

## 6. 性能基线方法

DR-P1.1 冻结了测量方法和提前登记门槛的目标，当时没有实际登记数值；实际门槛须由 DR-P4.5 的探索报告生成，并在独立确认前锁定。使用全新合成实例、相同随机数据和随机回环端口；按 AB-BA 顺序交替基线组与注册组，停止其他验收进程后测量。Node 性能驱动与浏览器/实际认证器验收分别执行，具体环境随报告记录。

固定场景及样本：注册开始 30、注册证明验证 30、登录 60、撤销 30、登录后 1000 行查询 60；每个场景报告 p50、p95、失败率、CPU/内存峰值和排队时间。服务端签名/台账落盘、TLS、网络往返分别标记。PIN、生物识别和安全密钥触摸时间单列，不计入服务端 p95。

DR-P4.5 / SEC-M7-D33 已完成独立性能确认，实际门槛见[登记原件](../security-v1-deliveries/evidence/SEC-M7-D33/registration.json)，结果见[确认报告](../security-v1-deliveries/evidence/SEC-M7-D33/confirmation/performance.json)。示例 JSON 给出供基线测量评估的初值：注册开始 500ms、注册验证 1500ms、登录 1000ms、撤销 1000ms、登录后查询 1500ms。在独立验收前，必须根据保留的基线报告单独登记最终门槛和容量，不能把示例值描述成已通过的门槛；门槛一旦登记，超限必须保留原始报告并失败；不能删慢样本、增加门槛或省略审计来取得通过。此方法不承诺生产 SLA、高并发、远程 TLS 容量或硬件断电能力。

DR-P4.5 将服务端测量具体化为[独立性能手册](performance-guide.md)的 Node HTTPS 驱动/服务双进程 AB-BA：保留上述五个场景及样本，增加续期、批量保存、静态服务和撤销后拒绝；每块独立实例、固定合成数据和预热。服务端计时单列 TLS、真实库验证、证明队列与保护器墙钟时间；客户端与传输余量不冒充纯网络 RTT。测量只统计服务端 Node CPU 与 RSS 高水位，不包含 DPAPI 子进程 CPU/RSS；不宣称整机资源容量。性能驱动不启动浏览器或用户确认，浏览器 profile/版本与实际 Hello 验收仍单独进行，不能把软件签名说成浏览器或硬件体验性能。

DR-P1.1 当时只冻结方法和示例，未实际登记最终数值；DR-P4.5 的探索报告和确认前 `registration.json` 才是实际门槛，不追认此前运行时已满足这些门槛。正常业务并发为 1；满 1000 条待审记录时另测 48 个单来源并发拒绝，核验 48 次审计及本机规则应用/确认/回滚。公共拒绝审计共用每实例 64 项 FIFO，每项落盘后才响应，逐项让出事件循环；溢出或存储失败按容量不足拒绝，不冒称已记录。4/32 证明槽边界另用明确标注的合成保护器受控验证。生产并发、分布式洪泛、整机子进程资源和实际认证器不在本次容量结论中。

## 7. 验证与后续

隔离校验入口：

```powershell
node scripts/security-registration-contract.mjs
node --test test/unit/security-registration-contract.test.mjs
```

CLI 默认只生成合成描述，不读取安装配置或连接服务。导出的 `assertDeploymentCertificate` 只核对显式传入证书的 SAN、有效期和 SPKI，不代替 TLS 握手的证书链验证。测试使用仓库内明确标注的公开合成证书/私钥、进程内 `.test` DNS 映射和随机回环 TLS 端口；不会安装信任、改系统 DNS 或连接 9091。它覆盖有效描述、纯 IP/localhost/HTTP、路径和查询参数、RP ID 不匹配、TLS 指纹、实例绑定、未知秘密字段、支持矩阵和性能参数拒绝；实际 TLS 拒绝未知根、错 SAN 和错 pin 后，服务端未收到这些失败的 HTTP 请求。隔离自签名根测试不代表真实公共 CA、实际 LAN 或浏览器 Hello 验收。

DR-P1.1—P1.6 已完成，已在隔离环境用 Chrome 虚拟认证器、DPAPI/本机 CLI 验证纵向链路；下一 DR-P2.1 会话父级模型。协议与存储见[协议文档](device-registration-protocol-contract.md)，配置/注册/本机审批见[使用说明](device-registration-runtime-guide.md)。本轮未迁移真实实例；下载、待审和批准均不会向轮询者签发业务会话。

## DR-P3.1：专用托管监听器

显式 `security.hosting.enabled=true` 时，同源数据入口提供 /designer/ 和数据 API；专用 HTTP 127.0.0.1 管理入口提供 /security/、管理 API 与管理会话。实际 socket/精确 Host/Origin 及无代理头由服务端校验，数据端即使来自回环也不能访问管理 API，管理端不能进入数据/RPC/WS/注册/登录路径。OS 身份启动器经 Named Pipe 取当前准确地址，一次性配对仅放 fragment，消费后清除；不接受自选管理地址。管理授权为空，空闲 15 分钟/绝对 60 分钟，续期和重启不延长，旧八小时管理身份拒绝。原独立前端模式仅在 hosting 缺省/false 时保留。静态公开 bundle 不提供身份或权限；Cookie/CSRF、动态撤销、网络策略及 write gate 保留。不改台账、Vault 或加密格式，不隐式迁移/开放旧实例。

字段、隔离操作、构建白名单和错误处理见[托管手册](device-registration-runtime-guide.md#12-同源页面与专用本机管理入口dr-p31)。正式注册/Passkey 状态页仍在 DR-P3.2，新增审批维护 UI 在 DR-P3.3；旧安全中心复用不表示新页面全部完成。

## DR-P3.4：首次部署向导边界

`deployment-init` 仅接受明确的新目录和公开 Designer build，不发现或加载默认配置。新实例仅绑定 127.0.0.1，注册和公钥登录关闭；通过 OS 本机启动器进入管理页。向导只读取初始化标记及其绑定的 bootstrap 配置，只有尚无业务密钥引用、应用凭据及注册台账的新实例可导出部署计划。已有实例显示人工合并说明，不读取其配置、证书或业务文件。

预览只接收公开证书 PEM 和明确路径字符串，不读取证书/私钥路径、不解析 DNS、不发网络请求。LAN 必须登记准确 HTTPS DNS/RP、SAN/有效期/SPKI、明确 CIDR；注册默认关闭，开启窗口为 1—168 小时。导入仅严格有界公开描述 JSON，不能授权、更改目标或执行内容。预检不证明浏览器信任、DNS 可达或证书与私钥匹配。

本机管理员核对摘要后下载计划，停止 bootstrap 实例，再显式 `deployment-finalize --target ... --plan ... --digest ... --yes`。命令重新校验实例、bootstrap 摘要、十分钟计划期限、公开证书文件与 PEM 一致性，持有实例独占租约；保留实例/密钥，明确更新持久防护规则并以禁止覆盖方式写新配置，绝不自动启动。开始提交前写一次性提交标记；中断/结果不明保留现场，禁止自动重试或删标记，原 bootstrap 始终绑定回环。现有配置、证书和密钥不覆盖。代理部署、旧实例合并、系统信任、DNS、防火墙及私钥配对由所有者独立核验；向导不是迁移或信任安装工具。
