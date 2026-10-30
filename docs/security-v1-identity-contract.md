# SEC-M2：实例身份、凭据台账与本机维护

本契约对应 [SEC-M2 / S2.1—S2.3](security-v1-milestones.md)，承接 [Vault 与密钥契约](security-v1-vault-contract.md)。当前支持 Windows，其他 OS 不回退到明文或普通 TCP 管理接口。

DR-P1.3—P1.6 后续补充：新增默认关闭的 V2 持久台账和注册 HTTP，复用本契约的保护/所有权/原子审计路径。普通启动保留 V1，仅显式有效窗口与迁移许可才升级。证明通过后仅保存待审候选，不创建主体、授权或会话；本机审批已原子建立 operator/用户/凭证与准确授权，轮询不获会话；注册—审批纵向/重启及提交硬退出恢复已验证，公钥登录留待后续。Windows 保护桥接输出缓冲改为有界 48 MiB，以容纳台账文件上限的 base64 JSON；修复 1 MiB 桥接提前失败，不改变台账大小限制或保护格式。字段和回退边界见[设备注册持久台账](security-v1/device-registration-protocol-contract.md#8-持久台账与原子迁移)，配置与接口见[使用说明](security-v1/device-registration-runtime-guide.md)。下文 SEC-M2 的 V1 说明作为原交付边界保留。

DR-P2.1 补充：会话父级显式区分 API 凭据、登记公钥和本机管理，新增 V3 内部 CAS 迁移而不在普通 open 时升级。公钥身份仅投影自身授权，不生成 API 凭据；管理父记录保持空业务授权且禁止普通凭据轮换/邀请。原 Token 和旧配对保留，冻结 V1 reader 拒绝 V3；完整旧 V2 发行包降级未验收。字段、原子故障、访问恢复与回退限制见[会话父级模型](security-v1/device-registration-protocol-contract.md#12-dr-p21-会话父级与持久兼容模型)，以上为 D18 边界；D19 已实现公钥登录，见下述补充。

后续更新：SEC-M3 已接入限权网络入口；下文的阶段性 503 描述保留为 M2 交付记录，当前行为以[统一授权与客户端连接契约](security-v1-authorization-contract.md)为准。Designer、data-studio、web 已同步 SDK 和内存凭据，配对/Cookie 仍属于 M4。

## 本阶段能力与连接边界

本阶段提供独立安全台账、自动初始化、本机管理 CLI、凭据创建/到期/轮换/撤销、会话失效通知和早期审计。完整网络授权属于 SEC-M3，Designer 配对、Cookie、SDK 新协议及 HTTPS/WSS 属于 SEC-M4。

新生成的配置使用 `"security": { "version": 1 }`，不再生成共享 `connectToken`。第一次启动创建本机保护材料和实例身份，不自动签发具有全部权限的网络凭据。

在本阶段的 registry 模式下，`/health` 可用，其余业务/管理 HTTP 与 WS 入口返回 HTTP 503：

```json
{ "error": "SECURITY_ENTRYPOINT_NOT_READY", "requiredMilestone": "SEC-M3/SEC-M4" }
```

这是开发阶段明确的入口门禁，不能通过设置旧 Token、伪造 localhost 来源或访问一个 HTTP reset 地址解除。尚未接入的授权不会按全权限开放。启动提示明确标注此状态。

不含 `security` 的原有配置继续被识别为 legacy 网络模式，仍使用原有 `connectToken`；不会自动覆盖配置，也不代表旧协议已经完成安全改造。registry 模式拒绝混入配置、环境变量或 CLI 的旧 Token。

## 目录和存储契约

安全目录固定相对于本次配置文件，而非 shell 工作目录或业务 Vault：

```text
<config-directory>/security/
  instance.key             CurrentUser DPAPI 保护的 IMK 与公开实例标识
  <database-reference>.dek  IMK 封装的每库 DEK
  registry.mds             DPAPI 保护的安全台账与管理审计
  registry.ready           初始化完成标记，仅公开版本与实例 ID
  instance-owner.lock      进程所有权锁
```

提交时可能出现 `.pending`、`.commit`、`.lock` 和 `.reclaim`。它们是恢复材料，不应按缓存清理。业务库可以在其他目录，恢复业务备份不会回滚安全台账。

台账格式为 V1，包含实例 ID、修订号、权限策略版本、访问代次、主体、凭据摘要、授权、会话摘要、公开密钥引用及脱敏管理事件。此阶段整体使用 CurrentUser DPAPI；不在文件中保留原始 Token、会话秘密、DEK 或可直接使用的 IMK。

选择整体加密台账是为了在不增加运行时依赖的前提下，让敏感状态和其审计记录采用同一个恢复提交。每次管理写入均需序列化和 OS 保护，不应把此实现当作高频业务审计存储；SEC-M5 将提供独立审计目录、轮转、检索与保留。

实例所有权持有期间禁止第二个进程独立打开同一台账。只回收确认已退出的 PID；不按等待时间夺取活跃进程所有权。异常恢复材料拒绝猜测。并发初始化、中断后的提交恢复、缺失/损坏材料均有隔离测试。

已存在完成标记而台账丢失时明确拒绝，不重新初始化为空台账；已有台账而主密钥缺失也拒绝重建。若第一次台账提交已完成、标记尚未落盘，重开可验证台账后补齐标记。拥有当前受信 OS 身份或 SYSTEM 的攻击者仍可回滚/删除本机文件，本契约不声称抵御主机完全失陷。

## 本机通道与身份

管理通道采用 Windows Named Pipe，其名字由规范化配置目录的摘要确定。进程使用内核管道 DACL，仅允许启动账号 SID 与 SYSTEM；每个连接还通过 OS impersonation 核验实际客户端 SID。审计记录该已验证 SID，不接受请求体声明的管理员身份。

管道创建使用 first-instance 检查与拒绝远程客户端标志，不允许借 SMB 远程连接；没有 loopback HTTP 管理员回退。PowerShell broker 代码固定，命令内容和秘密经 stdio/pipe 传送，不进入进程参数。CLI 与服务须使用同一配置目录和受信 Windows 身份。

只支持状态、主体创建、凭据列表、凭据创建/轮换/撤销和访问重置；不能执行任意引擎命令、shell 或文件操作。请求有大小和读取超时限制。连接尚未建立时可有界重试管道重建窗口；命令已经发送后不自动重发，防止重复维护。

匿名 OS 身份被 ACL 拒绝已实测。被内核 ACL 提前拒绝的连接没有到达 Node 台账，当前不在台账中伪造这类事件；需要更广的 OS 拒绝审计时须使用 Windows 自身审计。完整网络失败/IP 统计在 SEC-M5。

## 凭据和会话

- 凭据使用 256 位随机秘密，台账仅保存 SHA-256 摘要；随机 Token 不属于用户口令，不使用口令派生函数。
- 主体区分 application 与 operator。创建主体不授予任何数据权限。
- 新凭据默认授权为空、有效期 30 天，可设大于 0 且不超过 365 天；授权是数据库、资源和动作的显式集合。
- 轮换默认宽限 10 分钟，允许 0—60 分钟；不扩大权限，不延长原凭据的绝对到期时间。0 分钟立即撤销旧凭据。
- 轮换立即使旧凭据下的既有会话失效；宽限期间旧凭据仅保留其剩余有效性。撤销和访问重置同步使对应会话失效。
- 会话每次新操作重新检查自身、父凭据、主体和访问代次，不能仅信任曾经通过的握手。实际 WS/浏览器接入在后续里程碑完成。
- 变更成功持久化后才通知会话/缓存订阅者；重启不会复活已撤销凭据。
- 访问重置撤销全部网络凭据和会话、提高访问代次和策略版本；不更换 IMK、DEK，不重加密业务 Vault。

原始凭据仅在创建/轮换的返回中交付一次，列表仅返回允许的元数据。CLI 强制输出到一个新文件，目标目录必须已具有或由工具创建 owner/SYSTEM ACL；不会覆盖旧文件，也不会打印 Token。

如果命令发送后连接中断，或服务端已提交但输出文件写入失败，不能假定凭据没有创建。先检查元数据，撤销交付不明的凭据，再创建新凭据；无法从列表恢复原文。禁止自动重发已发送的变更。

## CLI 使用

以下命令以已构建的工作区 CLI 为例，`C:\modeldb-lab` 表示单独的测试实例目录。不要直接将现有实例配置切换为 registry 模式并期望 Designer 在 M2 可用。

```powershell
# 独立本机维护进程；若 registry 模式的正常 Server 已运行，则不再启动第二个 serve。
node .\packages\server\dist\cli.js security serve -c C:\modeldb-lab

# 在另一个终端执行；所有命令必须指向同一配置。
node .\packages\server\dist\cli.js security status -c C:\modeldb-lab
node .\packages\server\dist\cli.js security principal-create --name reporting-app -c C:\modeldb-lab

# 用上一步返回的主体 ID；不传 grants-file 时默认为无数据权限。
node .\packages\server\dist\cli.js security token-create --principal <principal-id> --name reporting --days 30 --grants-file .\grants.json --output C:\modeldb-credentials\reporting.json -c C:\modeldb-lab
node .\packages\server\dist\cli.js security credentials -c C:\modeldb-lab
# 凭据较多时分页；默认每页 25、最大 100，返回 total/nextOffset。
node .\packages\server\dist\cli.js security credentials --offset 0 --limit 10 -c C:\modeldb-lab
node .\packages\server\dist\cli.js security token-rotate --id <credential-id> --grace-minutes 10 --output C:\modeldb-credentials\reporting-next.json -c C:\modeldb-lab
node .\packages\server\dist\cli.js security token-revoke --id <credential-id> -c C:\modeldb-lab

# 明确确认，仅撤销访问；不是删除数据库或更换数据密钥。
node .\packages\server\dist\cli.js security reset-access --yes -c C:\modeldb-lab
```

`grants.json` 示例（只是声明授权，网络执行以 SEC-M3 接入为准）：

```json
[
  {
    "database": "railway_domain_v1",
    "resource": "AdministrativeDivision_Query",
    "actions": ["callable.query"]
  }
]
```

可声明动作：`model.read`、`model.write`、`schema.manage`、`callable.query`、`callable.operation`、`callable.binding`、`transfer.import`、`transfer.export`、`backup.manage`。这些动作不能声明本机恢复、密钥接管或实例访问重置权限。

## 审计、失败和容量

初始化、主体/凭据维护、会话创建、访问重置及公开密钥引用登记与其成功事件同一提交；支持的本机管理请求在参数/目标验证被拒绝时记录固定 `maintenance.reject`，不保存输入内容。操作者与目标主体/凭据分开记录，时间为 UTC。

本阶段管理事件默认上限 10,000 条，达到上限拒绝新的敏感变更，不静默覆盖历史；CLI 状态仍可用于诊断。主体、凭据和会话也有数量界限。凭据 CLI 提供 offset/limit 分页，若某页授权元数据过大返回 `SECURITY_RESPONSE_LIMIT`，可降低 limit 后重试，不终止维护通道。存储超限明确失败。完整审计检索分页、容量预警/归档与保留操作在 SEC-M5；当前不要通过手删台账继续运行。

提交失败时拒绝变更，关闭当前台账写者并要求恢复重开；恢复依据候选、提交意图和摘要，不以报错就一定未提交来推断结果。Windows 下已验证进程中断与模拟持久化失败，不替代硬件断电或物理磁盘耗尽实验。

S7.1 补充当前匿名审计契约：只有 unverified / denied 的 `network.reject`、`authentication.reject` 按 UTC 固定 60 秒窗口聚合。键包括 action、reason、plane、transport、peer/client IP、归因依据、policyVersion、ruleId。每行 `aggregation` 保存窗口起点、first/lastSeenUtc、observedCount、savedDetails=1、suppressedDetails=observedCount-1 和最多三个请求 ID。计数每次同步原子提交，没有内存异步队列；失败不确认已观察计数。单组计数上限为 `floor(Number.MAX_SAFE_INTEGER / 50000)`，保证最多 50000 行汇总仍为安全整数。管理与已认证事件不抽样。

每窗口至多 `min(128, max(1, floor(maxEvents / 4)))` 个键；已保留行数达 80% 时拒绝新增匿名键，给本机修复保留容量。保留期仍在提交时执行，不覆盖未过期历史。`SecurityAuditSummary.total/savedDetails` 和页 `total` 是行数；observedCount、suppressedDetails 及 byCategory/byResult 是观察次数。时间筛选使用最后观察时间，requestId 只匹配首请求或保存样本；聚合行不是窗口内的逐请求明细。完整使用范围与命令见[手册 §2.1](security-v1/user-guide.md#21-高频拒绝事件的计数)。

## Designer 当前连接失败的诊断

2026-10-20 对现有 9091 服务的只读检查：健康检查和带现有 Token 的管理状态均返回 200，读取 `model_designer_workspace` 的 catalog 返回 500 / `VAULT_LEGACY_FORMAT`。其 `atlas.mld` 前缀为旧 `MDB4SVLT`，M1 后引擎要求 `MDB5SVLT`。

因此该故障发生在认证之后的开库步骤，不是端口连不通或 Token 错误。未来的网络会话开发不会自动转换旧库；需要另行执行保留旧环境、显式重建或迁移的切换方案。此阶段不自动删除、重建、重写旧 Vault，也不通过旧 Token 解密回退来隐藏错误。

DR-P2.2 / D19：显式 authentication 开关和迁移许可原子升级 V1/V2/V3 到 V4，增加只含摘要的登录挑战台账。真实 WebAuthn get 验证通过后，最新 active 公钥/用户/主体、计数器、挑战终态、会话和成功审计一次提交，不新增 API Token；匿名失败统一拒绝。会话来源仍准确绑定，30 分钟/绝对 8 小时，CSRF 与注销复用既有实现。关闭注册窗口不撤销已批准身份；关闭新登录不自动注销已有会话。以上为 D19 交付边界，D20 的动态撤销补充见下。

DR-P2.3 / D20 已补齐公钥会话的 HTTP/RPC/WS 动态授权、按凭据通知与用户反向索引、空闲连接到期和排队执行前检查；发布接口及绑定子接口逐项复查。禁用/停用与既有会话撤销同事务提交，重新启用不复活旧会话。D21 已交付 DR-P2.4 正式本机维护 CLI、换钥和登记用户管理；管理页面留待 DR-P3。 权限收缩不复制或更换数据密钥；禁用单凭据不误撤销同用户的独立 API 身份，用户停用反向覆盖其全部登记凭据。无新增持久格式或自动迁移。

DR-P2.4 / D21：本机 CLI 已支持登记凭据/用户分页、禁用/启用、终态撤销、明确减权及原子换钥。换钥保存显式新授权并撤销旧身份和会话，新公钥仍须签名登录；丢失凭据先撤销，再注册并核验重新审批。同主体 API 身份单独维护，启用不复活旧 Cookie；不改变数据密钥。步骤和错误核查见[本机维护手册](security-v1/device-registration-runtime-guide.md#10-本机用户与凭据维护dr-p24)。本次无页面/翻译改造。

DR-P2.5 / D22：排队和验签中的证明在凭据/用户一度停用后持续失效，立即重新启用也须新挑战；单纯减权按提交时最新授权生效。登录/认领、刷新/注销、维护及 V2→V4 迁移已补真实进程退出恢复矩阵，旧 Token/配对与本机管理身份保持独立。结果未知先核查列表/审计，有 Cookie 先恢复，无 Cookie 重新登录，不重放旧证明。契约与验证边界见[第 16 节](security-v1/device-registration-protocol-contract.md#16-dr-p25-故障与在途证明边界)。原配置、V4、write gate 和数据密钥层级不变。

## DR-P3.1：专用托管监听器

显式 `security.hosting.enabled=true` 时，同源数据入口提供 /designer/ 和数据 API；专用 HTTP 127.0.0.1 管理入口提供 /security/、管理 API 与管理会话。实际 socket/精确 Host/Origin 及无代理头由服务端校验，数据端即使来自回环也不能访问管理 API，管理端不能进入数据/RPC/WS/注册/登录路径。OS 身份启动器经 Named Pipe 取当前准确地址，一次性配对仅放 fragment，消费后清除；不接受自选管理地址。管理授权为空，空闲 15 分钟/绝对 60 分钟，续期和重启不延长，旧八小时管理身份拒绝。原独立前端模式仅在 hosting 缺省/false 时保留。静态公开 bundle 不提供身份或权限；Cookie/CSRF、动态撤销、网络策略及 write gate 保留。不改台账、Vault 或加密格式，不隐式迁移/开放旧实例。

字段、隔离操作、构建白名单和错误处理见[托管手册](security-v1/device-registration-runtime-guide.md#12-同源页面与专用本机管理入口dr-p31)。正式注册/Passkey 状态页仍在 DR-P3.2，新增审批维护 UI 在 DR-P3.3；旧安全中心复用不表示新页面全部完成。

DR-P4.1：登记 userId 可关联独立加密接收方公钥，不能复用任何已批准登录公钥，反向批准/换登录钥也拒绝活动、历史或未到期挑战中的接收方公钥。公钥持有证明不替代身份归属核验，仍需受保护本机管理员明确确认。登录停用/撤销不删接收方历史，新登录凭据不隐式改变解密版本；访问重置与空访问灾备按[接收方密钥契约](security-v1/recipient-key-contract.md)重新核验。
