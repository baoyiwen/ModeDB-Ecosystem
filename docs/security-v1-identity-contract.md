# SEC-M2：实例身份、凭据台账与本机维护

本契约对应 [SEC-M2 / S2.1—S2.3](security-v1-milestones.md)，承接 [Vault 与密钥契约](security-v1-vault-contract.md)。当前支持 Windows，其他 OS 不回退到明文或普通 TCP 管理接口。

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

## Designer 当前连接失败的诊断

2026-10-20 对现有 9091 服务的只读检查：健康检查和带现有 Token 的管理状态均返回 200，读取 `model_designer_workspace` 的 catalog 返回 500 / `VAULT_LEGACY_FORMAT`。其 `atlas.mld` 前缀为旧 `MDB4SVLT`，M1 后引擎要求 `MDB5SVLT`。

因此该故障发生在认证之后的开库步骤，不是端口连不通或 Token 错误。未来的网络会话开发不会自动转换旧库；需要另行执行保留旧环境、显式重建或迁移的切换方案。此阶段不自动删除、重建、重写旧 Vault，也不通过旧 Token 解密回退来隐藏错误。
