# ModelDB 安全 V1 使用手册

更新日期：2026-10-24。适用于当前源码构建的 Windows Server、registry 模式和新格式 Vault。配套[功能简介](overview.md)、[进度台账](../security-v1-milestones.md)、[当前交付证据](../security-v1-deliveries/SEC-M7.md)。后续开发须同步更新本手册。

本文命令中的 `<...>` 都需要替换。先在专用隔离实例验证；本文不表示现有实例已经升级。源码构建后的 CLI 可用 `node packages/server/dist/cli.js` 替代 `modeldb-server`。请使用匹配本次源码的构建，已全局安装的旧版本可能没有这些命令。

构建与安装从[发布准备指南](release-guide.md)开始：`node scripts/security-release-candidate.mjs` 每次新建临时目录，构建七个包和三个前端，核对清单并离线安装本地候选。复验、性能测量、旧格式处理、真实切换和回退边界也在该指南中；命令不会发布或接管现有服务。

## 1. 连接与权限

新安装的 registry 配置包含 `security: { "version": 1 }`。它使用独立凭据台账，不从旧 `connectToken` 自动导入身份。配置示例、监听地址和 TLS 见[配置指南](../modeldb-config-guide.md)。本机 loopback 可用 HTTP；跨机器连接配置可信的 HTTPS/WSS。

实例所有者可在服务运行时通过本机受保护通道查看状态，并打开安全中心或 Designer：

```text
modeldb-server security status -c <isolated-config>
modeldb-server security security-open -c <isolated-config> --url <designer-url> --server <server-origin>
modeldb-server security browser-open -c <isolated-config> --url <designer-url> --server <server-origin> --databases <business-db>
```

安全中心管理凭据、应用、设备/会话、权限、网络和审计。安全管理员身份不隐含读取业务库权限。Designer 的业务库与设计器专属库是两个独立授权对象；不要用业务库代替设计器存储。

应用接入按[标准 HTTP 调用](../security-http-invocation.md)创建主体和限权凭据。浏览器用户按[浏览器连接说明](../security-browser-sessions.md)使用一次性配对码。配对码、浏览器会话和应用 Token 各有用途，不互换；长期凭据不写进前端构建变量或浏览器持久存储。

## 2. 网络与审计维护

网络规则区分管理面和数据面，拒绝规则优先；开启允许名单但没有允许项会拒绝该入口。修改前使用预览，应用后在 120 秒确认窗口内确认；未确认会回滚。页面还可查看临时封禁、限流状态和审计健康状况。

误锁后，在服务器本机使用同一配置的 `security network-status`、`network-preview`、`network-apply`、`network-confirm`、`network-rollback` 或 `network-unban` 修复。参数形状见 `modeldb-server security help` 和 [SEC-M5 记录](../security-v1-deliveries/SEC-M5.md)。不要通过关闭认证来恢复访问。

审计页可以按时间、来源 IP、主体、凭据、库、接口和结果筛选并导出。关键操作在审计写入不可用时拒绝或报告结果未确认。备份/恢复不会还原安全台账，也不会让已撤销的凭据或会话复活。

### 2.1 高频拒绝事件的计数

匿名 `network.reject` / `authentication.reject` 按固定 UTC 60 秒窗口聚合。同一来源（socket 与解析后地址、归因依据）、原因、管理/数据面、HTTP/WS、策略版本和规则保存一行，包含首次/最后时间、观察次数和最多三个请求 ID 样本。安全中心同时显示“观察次数”“保存明细”和“被抑制明细”；例如同组 200 次拒绝为 200 次观察、1 行保存明细、199 条被抑制明细。已认证事件、管理变更和数据操作继续逐项记录。

分页 `total` 仍为行数，分类/结果统计按观察次数累计；JSONL 导出包含 `aggregation`。时间筛选按该行的最后观察时间，不对窗口内的次数做精确切分；请求 ID 检索只匹配首请求及三个样本，未保存的请求 ID 无法逐项检索。

每窗口最多 `min(128, max(1, floor(maxEvents / 4)))` 个匿名来源键，审计容量到 80% 后拒绝新增匿名键，保留管理容量；已有组仍可累计。达到限制或落盘失败时请求失败关闭，不能将这些未成功落盘的请求计为已持久化观察。该实现每次仍同步写入计数，没有异步日志队列；不保证提高洪泛时的磁盘吞吐。来源限流窗口最多 10000 个键，自动临时封禁最多 1000 项，过期后回收。

## 3. 创建和恢复日常备份

### 在线操作

在 Designer 的业务库管理中打开“备份管理”，选择业务库并创建备份。列表针对当前选中库请求；无权限时显示服务端错误。可以下载到本地，再上传到能解开该包的实例。上传只保存已验证备份，不立即恢复；同名上传生成新文件。

恢复前选择正确库和备份，确认共享危险操作对话框。服务端先验证包、刷盘并创建当前库的安全备份，再停止旧引擎、替换 Vault、清理缓存并重新打开；相关实时连接会断开，需重新连接。已有库的安全备份失败时，恢复不会继续。

registry 模式所需权限如下，均须针对具体数据库，`resource` 为 `*`：

| 操作                   | 所需 action                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| 创建、列出备份         | `backup.manage`                                                                      |
| 下载加密备份           | `backup.manage` + `transfer.export`                                                  |
| 上传本实例可解开的备份 | `backup.manage` + `transfer.import`                                                  |
| 恢复已有业务库         | `database.manage` + `schema.manage` + `model.read` + `model.write` + `backup.manage` |

SDK 对应 `RemoteModelDBClient.createBackup/listBackups/downloadBackup/importBackup/restoreBackup`。调用 `listBackups` 时显式传 `database`。HTTP 上传使用 `application/octet-stream`。HTTP 不接收迁移私钥或口令；跨独立密钥实例使用第 5 节离线流程。

### 离线操作

关闭该隔离实例后执行，必须显式 `-c`；registry 实例锁被占用时拒绝。命令不会连接 HTTP 服务：

```text
modeldb-server backup <db> --reason manual -c <isolated-config>
modeldb-server backups <db> -c <isolated-config>
modeldb-server restore <db> <backup-file-name> --yes -c <isolated-config>
```

`backups` 只列出完整解密验证通过的包；文件存在但没列出不代表没有文件，应保留并检查版本、密钥和损坏情况。`restore` 的文件名取列表返回的 `fileName`，不是任意本机路径。离线恢复可选择新库名，内部库名和校验信息会一并映射；在线恢复当前要求目标库已存在。

备份目录是解析后的 `<storageRoot>/modeldb/backups/`，一个备份只收集一个嵌套 `db/atlas.mld` 或扁平 `db.mld`。包不包含 registry、网络策略、配置、日志、缓存、任意旁文件或整个 Designer 元数据库。其他库中的接口/布局元数据不会自动随业务库迁移。

返回信息包括 `format`、`packageId`、`database`、时间、文件字节数和 `statistics`。其中 `vaultBytes` 是源 Vault 大小，`entries` 是 Vault 逻辑条目数，`models/relations` 是相应条目数，**不是业务数据行数或关系边数**。真实业务数量应在恢复后查询核对。

## 4. 准备独立恢复材料

日常备份与密钥恢复文件分别保管。恢复文件是生成时的历史 IMK/DEK 快照，新增库或 DEK 轮换后重新生成；旧文件不会自动包含未来密钥。

先由运行账号在专用外部目录建立 owner/SYSTEM ACL，并通过独立安全方式放入口令文件。口令长度 12—1024 字符，不放命令行；文件路径不能是 junction、符号链接或 Windows ADS。现有目录权限过宽会拒绝，工具不自动放宽它。

源码环境可以用已有 Windows 保护器创建一个全新专用目录；参数必须是你选择的隔离路径：

```powershell
node node_modules/tsx/dist/cli.mjs -e 'import { WindowsSecretProtector } from "./packages/server/src/security/windows-secret-protector.ts"; new WindowsSecretProtector().ensureDirectory(process.argv[1]);' '<new-protected-directory>'
```

记录 `security status` 返回的实例 ID，关闭隔离实例，再导出：

```text
modeldb-server security recovery-create -c <isolated-config> --instance <instance-id> --yes --output <external-recovery-file> --passphrase-file <protected-phrase-file>
modeldb-server security recovery-verify --package <recovery-file> --passphrase-file <protected-phrase-file>
modeldb-server security recovery-check --package <recovery-file> --vault <raw-vault-or-copy.mld> --passphrase-file <protected-phrase-file>
```

`recovery-check` 检查原始 Vault/副本的密钥引用，不解析 `.modeldb-backup.json`，也不代替完整包认证。原始副本应在停止写入时取得。

失去源机器时，只传递业务备份、正式恢复文件和单独交付的口令。在目标账号下重新建立受保护口令目录及全新目标 home，执行：

```text
modeldb-server security recovery-restore --package <recovery-file> --target-security <new-protected-home/security> --passphrase-file <protected-phrase-file> --yes
```

该命令保留源 Vault key domain，以目标 OS 保护和新主密钥重新封装。随后在新 home 中建立匹配配置，普通首次启动建立空访问台账，重新授权；再通过上传 API 或第 3 节离线恢复业务备份。不要覆盖已有实例的 `security/`，不要拷回旧 registry、Token 或网络策略。已初始化的恢复目标不能重复覆盖；只允许严格匹配同一恢复 receipt 且未初始化台账的幂等确认。

**2026-10-23 已完成两台 Windows 的合成异机恢复验收，S6.1 完成。** 原始构建摘要差异已由逐文件报告确认为当前模块未使用的旧输出，当前源码对应的 136 个编译文件与配置一致；原报告保留。证据与边界见 [SEC-M6 / D11](../security-v1-deliveries/SEC-M6.md#d11s61-异机验收完成)。这不是实际业务库的恢复或生产切换；同机新目录或新进程通过仍不能登记成异机验收。

### 4.1 两台 Windows 设备的可重复演练脚本

使用仓库中的 [PowerShell 入口](../../scripts/security-recovery-drill.ps1)。它只生成合成 Vault 和临时密钥，调用既有恢复实现，不加载实例配置，不连接 9091 或其他服务。准备端的临时源密钥目录会自动删除。此演练不恢复实际业务库。

两端准备相同的当前源码（包含尚未提交的安全改造文件）、Node.js ≥20 和已安装的仓库依赖。仅克隆远端可能缺少本轮文件；同步源码时排除真实配置、实例 `security/`、`vault/` 和凭据，不复制 `node_modules`，在另一设备独立安装依赖。默认脚本按顺序构建 shared/common/core/server，任一步失败即停止；不会自动安装依赖或启动服务。

演练源码需完整同步三个 TypeScript 文件 `security-recovery-drill.ts`、`security-recovery-drill-runner.ts`、`security-recovery-drill-entry.ts` 及 PowerShell 入口。新版在读取 Node 的 JSON 时显式使用 UTF-8，随后恢复控制台和管道编码，支持中文 Windows 用户目录，无需修改系统代码页或区域设置。代码入口支持目录联接别名；演练材料路径仍拒绝目录联接，不用别名绕过路径保护。

在普通 Windows 登录账号下打开 PowerShell，进入各自的项目根目录。以下 `ExecutionPolicy Bypass` 仅作用于本次子进程，不修改系统或用户执行策略；组织策略仍可能限制脚本运行。

两端均须使用**未以管理员身份运行**的 PowerShell。从开始菜单正常打开 Windows PowerShell，不选择“以管理员身份运行”；在管理员窗口中再输入 `powershell.exe` 仍会继承提升权限。可执行以下检查，结果必须为 `False`：

```powershell
$drillIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    $drillPrincipal = New-Object Security.Principal.WindowsPrincipal($drillIdentity)
    $drillPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} finally {
    $drillIdentity.Dispose()
}
```

新版脚本在构建和创建演练目录前检测提升令牌，管理员窗口直接返回 `RECOVERY_DRILL_NON_ELEVATED_REQUIRED`。Windows 在提升进程中创建文件时可能使用 Administrators 组作为所有者，与严格的当前用户所有者检查不符；旧入口可能在 `prepare.recovery-package` 将该保护检查失败统一显示为 `SECURITY_INSTANCE_BUSY`。遇到这一组合时先使用普通窗口、新目录重试，不修改旧目录权限，也不依据该错误停止真实服务。历史失败现场仍保留，根因以环境及复验结果核对。

**A 设备：准备材料。**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\security-recovery-drill.ps1 -Action Prepare
```

成功显示 `SUCCESS: Prepare`、`prepared: true`、`runId`，以及 `DrillRoot` 和 `Report` 路径。默认在系统临时目录下新建 `ModeDB-Recovery-Drill-<随机值>`；每次运行使用新目录，无需保存 PowerShell 变量或保留原窗口。

**B 设备：建立接收目录。**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\security-recovery-drill.ps1 -Action Receive
```

成功显示 `SUCCESS: Receive`、`readyToReceive: true` 和 B 的 `DrillRoot`。它会按 B 当前账号建立专用 owner/SYSTEM ACL 目录。

只将 A 的 `fixture` 内三个文件复制到 B 的 `fixture`：`manifest.json`、`material.mdrecovery`、`synthetic.mld`。通过另一个安全渠道单独交付 A 的 `secret/phrase.txt`，在 B 已建立的 `secret/phrase.txt` 位置写入。复制时继承 B 目标目录权限，不保留源 ACL，不传递整个源目录或源密钥。口令文件不能放进 `fixture`，不能发送到聊天或日志。

**B 设备：验证。** 将路径替换为 B 刚才输出的 `DrillRoot`，可在新的 PowerShell 窗口执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\security-recovery-drill.ps1 -Action Verify -DrillRoot "C:\替换为B输出的演练目录"
```

成功必须同时满足退出码 `0`、`SUCCESS: Verify`、`runId` 与 A 一致，且 `independentOsEnvironment`、`restored`、`emptyAccessLedger`、`wrongPassphraseRejected`、`tamperedPackageRejected` 全为 `true`。验证后的临时恢复目标自动清除，接收材料保留。只有这些异机成功证据经过核对后，才可补登记 S6.1；脚本准备成功或本机测试通过不算异机验收。

每次操作生成独立的 `<action>-<时间>-<随机值>.json` 报告，记录成功/失败、步骤、稳定错误码、Windows/Node 版本和源代码/构建摘要；不包含口令、密钥、原始异常或业务数据。源码摘要范围是上述三个演练 TypeScript 文件、PowerShell 入口、根依赖/类型配置、相关包描述，以及 shared/common/core/server 的实现目录；构建摘要覆盖四包的 `dist/**/*.js`，忽略 CRLF/LF 差异与 source map。核对两端报告的 `sourceFingerprint`、`buildFingerprint`，保留 A 的准备报告和 B 的验证报告。回传脱敏 JSON 即可，不回传恢复材料。

重复验证可对同一个 B 目录执行 `Verify`，报告不会覆盖；重复 `Prepare` 或 `Receive` 总是新建目录。可通过 `-DrillRoot <尚不存在的绝对路径>` 指定源码目录之外、父目录已存在的全新演练目录；不接受仓库内或已有目录。两端代码和构建均未改变时，可加 `-SkipBuild` 加快重复操作。

| 输出/错误码                                                                       | 处理方式                                                                                  |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `RECOVERY_DRILL_NON_ELEVATED_REQUIRED`                                            | 两端都重新打开普通 PowerShell，不选择管理员运行，再执行原操作；本次尚未构建或创建演练目录 |
| `FAILED` / 非零退出码                                                             | 本次未通过；查看 `Step` 和 `Report`，保留现场，不传递不完整材料                           |
| `RECOVERY_DRILL_DEPENDENCIES_MISSING` / `RECOVERY_DRILL_BUILD_FAILED`             | 在该设备补齐依赖或处理构建错误；构建失败不开始演练                                        |
| `RECOVERY_DRILL_SCRIPTS_MISSING`                                                  | 同步同一修订的三个 TypeScript 演练文件及 PowerShell 入口，不只复制 `.ps1`                 |
| `RECOVERY_DRILL_RUNNER_NO_OUTPUT`                                                 | Node 未返回内容，记录退出码；核对源码是否完整，更新支持代码目录别名的入口                 |
| `RECOVERY_DRILL_RUNNER_INVALID_OUTPUT` / 旧版 `RECOVERY_DRILL_RUNNER_UNAVAILABLE` | 包装层未取得有效 JSON；先同步 UTF-8 修复，再按下面命令直接检查 runner                     |
| `EEXIST`                                                                          | 准备/接收目录已有内容，改用新目录，不覆盖原文件                                           |
| `ENOENT`                                                                          | 核对是否复制齐三个 fixture 文件及单独口令文件，检查 `Step`                                |
| `VAULT_PROTECTION_UNAVAILABLE` / `EACCES` / `EPERM`                               | 核对当前 Windows 账号及专用目录权限，不沿用源设备 ACL；不要放宽安全目录权限               |
| `SECURITY_INSTANCE_BUSY`                                                          | 查看报告步骤；隔离演练的维护租约或保护检查未通过，保留现场后使用新目录重试                |
| `RECOVERY_DRILL_REQUIRES_INDEPENDENT_WINDOWS_ENVIRONMENT`                         | 检测到同机同账号，需在另一台设备验证                                                      |
| `RECOVERY_DRILL_RECEIVER_REQUIRED`                                                | 使用 B 的 `Receive` 输出目录，不能把 A 的源目录直接当作接收目录                           |
| `RECOVERY_DRILL_DATA_MISMATCH` / `RECOVERY_DRILL_FAILED`                          | 保留报告和材料，不改写 manifest 或删除标记绕过验证                                        |

早先手动准备失败的目录不自动接管或删除。旧 CLI 将部分异常统一显示为 `RECOVERY_DRILL_FAILED`；新版会保留公开安全错误码，托管脚本另提供失败步骤。历史那次失败的根因仍需以新报告核对，不能仅凭后续准备成功认定已经修复。

若旧 PowerShell 入口只显示 `RECOVERY_DRILL_RUNNER_UNAVAILABLE`，可在普通窗口、项目根目录直接执行以下诊断，不输出口令或恢复材料：

```powershell
node --version
node node_modules/tsx/dist/cli.mjs scripts/security-recovery-drill-runner.ts receive
$LASTEXITCODE
```

返回 `ok: true`、`readyToReceive: true` 且退出码为 `0`，说明已创建可用的 B 接收目录，保留输出的 `drillRoot`，无需反复 `Receive`。Windows PowerShell 5.1 用 CP936 读取 Node UTF-8 输出时，中文路径可能损坏 JSON 转义；本地已复现并由新版修复。若直接入口也失败，按其稳定错误码处理，不把所有失败都归于编码。

同步本次脚本后，两端默认重新构建；A 用新版重新 `Prepare`，使准备报告和 B 后续验证报告的源码/构建摘要可比较。B 可继续使用之前已成功创建的接收目录，将这一轮 A 材料完整复制进去后，用新版 `Verify -DrillRoot <已有B目录>` 验证。B 的接收成功仅表示目录就绪，不能代替异机恢复成功。

### 4.2 构建摘要不同的诊断

`SUCCESS: Verify` 且五项为 `true` 表示该次恢复功能成功；如果 A/B 的 `buildFingerprint` 不同，保留成功证据，先查明编译目录差异。`tsc` 不自动清除已删除源码的旧产物，源码摘要相同也不能单独证明两个 `dist` 等价。不要删除原报告、直接忽略不明文件或为对齐摘要复制对端整个 `dist`。

将 [构建诊断脚本](../../scripts/security-recovery-build-check.mjs) 同步或复制到 B 项目的 `scripts` 目录，在项目根目录执行这一行：

```powershell
node .\scripts\security-recovery-build-check.mjs
```

脚本无需安装新依赖，不重新构建或运行恢复。它只读取 shared/common/core/server 的编译代码、对应源码路径是否存在、固定构建配置和已安装 TypeScript 版本，不加载实例配置或服务。输出 `ok: true`、四包概要和 `report` 路径；把该路径指向的 `build-check.json` 发回核对即可。报告包含相对代码路径、逐文件/配置摘要和工具版本，不包含代码正文或秘密，写入全新 `ModeDB-Build-Check-*` 临时目录，不覆盖现有报告或构建。`extra` 只表示按既定映射未找到 `.ts` 源文件，仍需结合实际清单解释，不能据此自动删除。

报告的构建摘要沿用演练报告中规范化 CRLF/LF、按排序路径聚合全部 `.js` 的规则；同步这个独立诊断脚本不改变原演练摘要范围，不需要重做已成功的演练。收到两端完整清单后，再判断是旧产物、编译配置/工具链还是代码内容的差异，并登记处置结果。

终端显示的是包概要；逐文件及编译配置摘要保存在 `report` 指向的 JSON 文件中。若只回传终端概要，仍无法确认同名文件内容是否一致；直接发送该已生成文件即可，不需要再次运行脚本。

本轮核对已完成：两端 136 个当前源码对应 JS 及六份编译配置摘要一致，137 个共有路径无内容变化；A 独有一份旧 initializer，B 独有 19 份旧 core/common、PathResolver 产物，均未被当前模块引用。因此恢复验收不需要重做，原始总摘要差异按清单解释保留。后续发布应在隔离的全新输出目录构建并检查包清单；不要把现有 `dist` 含有旧文件的事实当作发布包也已验收。

若复制长命令时遇到 `UnexpectedCharactersAfterHereStringHeader`，说明 PowerShell 的 `@'` 起始标记后没有立即换行，诊断程序尚未执行。这不影响此前恢复结果；使用上面单行脚本入口即可。

## 5. 向受信任实例完整迁移

这是单库完整迁移，目标是新库名。源实例和接收实例都应已有独立 registry 身份；分别记录实例 ID，再关闭两端隔离服务。目标保留自己的权限与策略，不接收源认证状态。

### 接收端创建迁移密钥

在接收端建立专用受保护目录和独立口令文件，执行：

```text
modeldb-server security backup-key-create --output <protected-prefix> --passphrase-file <protected-phrase-file>
```

得到 `<prefix>.public.pem`、`<prefix>.private.json` 和 `recipientId`（公钥 SHA-256 指纹）。只把公钥交给源端，通过另一个可信通道核对指纹。私钥文件和口令由接收端保管，分别交付；源端不需要它们。已有输出文件不会覆盖；部分生成失败时保留现场，改用新 prefix。

### 源端导出

```text
modeldb-server security backup-export -c <source-isolated-config> --database <source-db> --public-key <receiver-public.pem> --output <new-external-package> --instance <source-instance-id> --yes
```

输出必须是源 `security/` 和数据目录以外的新文件，父目录受保护。核对返回的 `recipientId` 与接收方提供的指纹相同，再交付文件。源端备份目录也保留一份该包。迁移包包含完整业务 Vault 和该库源 DEK 的加密内容，**仅交给完整信任的接收者**；不能用于部分资产出售或受限分享。

### 接收端导入并恢复

```text
modeldb-server security backup-import -c <target-isolated-config> --database <new-db> --private-key <receiver-private.json> --package <received-package> --passphrase-file <protected-phrase-file> --instance <target-instance-id> --yes
```

工具完整验证接收方、加密正文、Vault 和统计，以目标库自己的 DEK 重新加密，再保存本地备份。返回 `restored: false` 和 `imported.fileName`；此时业务库尚未发布。目标已有同名 Vault 或未完成提交时拒绝，不静默覆盖或合并。

```text
modeldb-server backups <new-db> -c <target-isolated-config>
modeldb-server restore <new-db> <imported.fileName> --yes -c <target-isolated-config>
```

恢复后重新连接，核对模型、真实数据条数、唯一 ID 和关系双向遍历，再按目标策略签发访问凭据。目标的库实例 ID/DEK 与源端不同。完整迁移包没有发布者签名；第 7 节模型资产包采用单独签名和显式指纹信任，不提供平台信任链。

## 6. 失败、中断和容量

| 情况                                                       | 处理方式                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SECURITY_INSTANCE_BUSY`                                   | 确认隔离实例已停止或维护任务完成；不删除活跃锁                                                            |
| `SECURITY_CONFIRMATION_REQUIRED`                           | 核对配置、实例 ID、目标和 `--yes`，不要通过改状态文件绕过                                                 |
| `SECURITY_FORBIDDEN`                                       | 按具体库核对所需权限；管理员身份不隐含数据权限                                                            |
| `SECURITY_MAINTENANCE_FAILED` / `SECURITY_INVALID_REQUEST` | 检查接收方、口令、版本、路径和文件完整性；保留源包和现有库                                                |
| `SECURITY_PROTOCOL_UNSUPPORTED`                            | 旧 JSON v1 包明确拒绝；保留旧环境及原件，制定显式迁移计划                                                 |
| `VAULT_COMMIT_CONFLICT` / `VAULT_COMMIT_INCOMPLETE`        | 保留目标、`.pending/.commit/.lock/.reclaim` 和备份，停止其他写者后按原目标和原包重试；损坏/不匹配现场拒绝 |
| 审计失败或没有成功回执                                     | 可能已写入备份或恢复数据；先列表、核对目标和审计再决定重试，不将无回执当作未执行                          |

业务恢复的 `staged/journaled/replaced` 进程中断可用相同备份和目标重试。首次创建只剩未提交候选时，只有候选认证成功且与所请求内容逐项一致才补写提交意图；内容不同或认证失败保持现场。不要手工删除这些文件后启动空库。恢复密钥目录、DEK 轮换和出厂清除使用各自任务流程，不能互相替代；清除中断按第 6.1 节处理。

当前备份上限为单个原始 Vault 48 MiB、完整包 128 MiB，不做压缩解包或流式大库处理；空间不足会拒绝或保留失败现场，损坏包不会作为可恢复备份列出。包 manifest 可见库名、名称、时间、密钥引用和统计，业务正文及密钥为密文；备份文件仍应按敏感资料保管。

自动备份默认关闭，显式配置 `autoBackup.enabled: true` 后最小间隔 60000ms；快照与写操作共用同一库写入锁，刷盘或审计失败不会返回成功。当前自动备份使用本机历史 DEK 封装，未提供恢复公钥登记后自动加入接收方的配置；独立恢复需要另外维护最新恢复文件。

Windows 已验证范围包括 DPAPI、ACL 和进程退出恢复，尚不等同硬件断电验证。Designer 资产包的当前操作范围见第 7 节，导入后审核、重新发布与目标授权的 Chrome 流程已验证。全流程、安装与性能证据见[当前交付记录](../security-v1-deliveries/SEC-M7.md#d02s72-全流程回归与发布准备)，操作材料见[构建、安装与切换指南](release-guide.md)；阶段状态以唯一台账为准。registry 的同步审计/OS 保护有明显秒级成本，不代表低延迟、高并发或生产容量已验收；真实升级切换须另行授权。

### 6.1 出厂清除中断：验证、续跑或恢复副本

这组命令用于 `factory-reset` 已生成的 `.mdreset` 本机归档，由原 Windows 账号离线执行。它依赖原账号 DPAPI，不是异机恢复材料。先停止对应隔离实例，保留原配置、`security-reset.pending` 及其提交侧文件、`reset-backups` 和所有残留数据，不手工删除标记或锁。归档固定在原配置父目录的 `reset-backups/<uuid>.mdreset`，不要改写包内路径。

先验证归档；此步不恢复数据或继续删除，也不创建缺失的归档目录：

```text
modeldb-server security factory-reset-verify -c <original-isolated-config> --package <original-archive.mdreset> --instance <original-instance-id> --target <original-workspace>
```

核对返回 `verified: true`、实例 ID、文件数和归档摘要。三个新命令及原 `factory-reset` 都必须显式传 `-c`。错误账号、篡改包、链接路径、不匹配实例/目标或不安全文件路径会拒绝。

若决定完成清除，用原包和准确原目标续跑：

```text
modeldb-server security factory-reset-resume -c <original-isolated-config> --package <original-archive.mdreset> --instance <original-instance-id> --target <original-workspace> --yes
```

工具先认证归档与原标记、取得独占锁，并检查全部残留文件。只允许归档中哈希未改变的文件或已删除文件；新文件、改动文件、活进程或 junction 会阻止续跑。成功后原业务目录和安全状态删除，原包及 `.receipt` 保留，最后移除阻断标记。已完成且没有标记的清除不重复执行续跑；核对回执即可。

若要取回数据，恢复到一个尚不存在的新隔离目录：

```text
modeldb-server security factory-reset-restore -c <original-isolated-config> --package <original-archive.mdreset> --instance <original-instance-id> --target <original-workspace> --output <new-quarantine-directory> --yes
```

输出为新目录下的 `workspace/`、受保护的 `security/` 和 `reset-restore.receipt`，不覆盖原现场。保留原数据密钥引用，但排除归档中的 `registry.mds*` / `registry.ready*`，包括大小写变体；新副本建立空访问台账，旧凭据、会话和网络规则不会复活。为副本新建显式隔离配置，指向返回的 workspace，使用随机端口，重新授权后再核对业务内容；不能直接套用仍指向原目标的配置启动。

恢复副本失败时保留该目录及其阻断标记，用另一个全新目录重试，勿删除标记后启动半成品。原归档和原清除现场保持不变。当前原始数据合计上限 128 MiB、10000 文件、128 层；归档读取上限 240 MiB。进程退出与注入 ENOSPC 的验收不代表已做硬件断电或物理磁盘耗尽实验。

## 7. 模型与 Designer 资产包

当前入口是离线 CLI，需停止相应的隔离实例，由其 OS 所有者执行；不授予远程主体隐含的整库导出权限。私钥和口令只从受保护本机文件读取，不传到 HTTP。保留原包和公钥指纹；仅凭包内声明不能信任发布者。

接收端按第 5 节 `backup-key-create` 生成独立接收方密钥，将公钥与指纹交给发布者。发布者再生成单独的资产签名密钥，不能复用接收方密钥。下面的 `<protected-file>` 和私钥父目录须预先受 owner/SYSTEM ACL 保护，口令 12—1024 字符，不放命令行。

```text
modeldb-server security asset-signing-key-create --output <protected-publisher-prefix> --passphrase-file <publisher-protected-file>
```

保管 `.private.json`，将 `.public.pem` 及输出的 `publisherId` 经独立可信渠道交给接收者。签名私钥与接收方私钥的格式/用途不同，不能混用。

准备 `selection.json`。仅选择模型时使用冻结的 v1 格式：

```json
{ "models": ["Group", "Item"], "includeData": true }
```

`includeData: false` 只导出结构；选择子模型会自动包含父模型及其全部记录（开启数据时）。关系只包含两个端点都在所选模型闭包内的定义和双向索引；指向未选模型的关系不打包。若选中关系仍引用未选子模型的记录，导出拒绝，应先明确补齐所选范围。当前不支持逐行/字段裁剪，所选模型的全部字段和数据都可能交付，应先审阅选择文件。

```text
modeldb-server security asset-export -c <source-config> --instance <source-instance-id> --database <business-db> --selection <selection.json> --asset-id <stable-asset-id> --asset-version 1.0.0 --public-key <receiver.public.pem> --signing-key <publisher.private.json> --passphrase-file <publisher-protected-file> --output <new-external-asset-file> --yes
```

输出必须位于源安全目录和数据树外，不能覆盖已有文件。`asset-id` 由发布者维护为永久 ID（1—96 个字母、数字、下划线或连字符）；版本使用三段数字。包不含源库 DEK、源 Vault、registry 或凭据；新 PEK 仅由指定接收方公钥封装。

接收端先使用独立核对的 SHA-256 发布者指纹预览：

```text
modeldb-server security asset-preview -c <target-config> --instance <target-instance-id> --database <new-db> --package <asset-file> --private-key <receiver.private.json> --passphrase-file <receiver-protected-file> --publisher-key <publisher.public.pem> --publisher-fingerprint <verified-sha256>
```

核对模型、字段、父模型依赖、记录/关系/边数量以及 `conflicts`，取本次 `confirmationDigest`。预览不创建业务库、目标 DEK 或暂存明文；本机维护审计会记录预览任务。

```text
modeldb-server security asset-import -c <target-config> --instance <target-instance-id> --database <new-db> --package <asset-file> --private-key <receiver.private.json> --passphrase-file <receiver-protected-file> --publisher-key <publisher.public.pem> --publisher-fingerprint <verified-sha256> --preview-digest <confirmationDigest> --yes
```

导入重新检查包、目标和确认摘要，以目标 DEK 加密并原子发布新库，保留原记录 ID、I18N 字典与双向关系。返回新的 `localAssetInstanceId`、包 ID 和真实记录/边统计；同时保存一份目标密钥保护的本地恢复备份。目标凭据和网络策略不从包导入，库发布后仍需独立授权。

同名既有库、已有目录/旁文件、Designer 专属库或 `sys_*` 目标默认拒绝，不提供合并/覆盖选项。`SECURITY_POLICY_CONFLICT` 应换新目标名或核查现场；`SECURITY_FORBIDDEN` 也可能表示发布者指纹不符。出错后保留包及 `.pending/.commit/.lock`，不要删除锁绕过检查；先确认实例已停止，用原包/目标重新预览，只有经认证且逐项匹配的未更改导入现场才允许续跑。若已有本地改动则拒绝。`SECURITY_OUTCOME_UNCONFIRMED` 表示写入后缺少最终回执，应先核对目标和审计，不将其视为未执行。

通用上限：正文 48 MiB、文件 128 MiB、1000 模型、每模型 1000 字段、10000 关系、100000 记录；记录与边合计最多 200000。无压缩、路径解包、脚本或动态插件，未知格式/算法拒绝。v1 不含 Designer 接口和显示元数据；需要这些内容时使用下面的 v2 选择文件。

### 7.1 Designer 依赖包（v2）

在同一个选择文件增加 `designer`，导出命令保持不变。数组填逻辑 `interface_id` / `surface_id`，不填显示名称或物理行 ID。可以用空模型数组仅从接口推导模型依赖；最终闭包必须包含至少一个模型。

```json
{
  "models": ["Item"],
  "includeData": false,
  "designer": {
    "queries": [],
    "operations": [],
    "bindings": ["<surface-id>"]
  }
}
```

源实例必须有配置指定的 Designer 专属库。打包器按业务库归属收集选中接口的草稿、当前版本和最多 100 个历史版本；Binding Surface 引用的固定查询/操作版本必须存在。接口引用的模型以及父模型自动加入，因此开启数据时，这些模型的全部有效记录也会交付。预览 `models`、`designer` 的完整新增范围后再确认。接口样本结果、源操作者、调用日志、完整 `graph_b64` 快照和其他业务库不导出；显示元数据包括 I18N、基础坐标、颜色和关系端点，不含图层、折线提示等完整画布状态。当前无版本的 `dependencies.interfaces`、未知关系或不受支持的字段会拒绝，需先整理源接口。

预览和导入沿用上面的两个命令；v2 预览返回 `modeldb.asset-preview.v2`、业务/Designer 目标摘要、源/目标行 ID、版本、`importedPermissions: "disabled"`、冲突和确认摘要。它仍不创建目标库/DEK。默认只接受新业务库，且 Designer 中不能已有该目标库的登记、元数据、接口或快照。已有 Designer 库的其他库数据保留。内部 ID 根据目标实例、包和实体用途重新映射，业务记录 ID 与引擎名称保持不变。

所有导入接口及历史版本默认 `disabled`，不复制源密钥摘要、角色或自定义访问规则。导入成功后在 Designer 中核对模型、字段、关系、位置及接口，重新审核并发布目标权限；新版本摘要发生变化，原实例的发布授权不会自动适用。当前只提供离线入口，没有浏览器上传私钥或资产导入向导。

父模型多级继承和通过父模型关系查询子模型的引用会按业务层级校验并映射。重复模型节点、反向关系、分支和约束的来源节点也随目标身份映射；未知关系、伪造祖先或悬空链引用拒绝。约束设计可交付，但现有编译器不支持的执行仍会阻止发布，不因导入而自动可执行。

导入完成后的审核与启用步骤：

1. 启动目标隔离实例，用目标实例所有者签发的浏览器邀请打开 Designer，选择新导入库。核对模型/字段显示名、父子层级、双向关系、数据数量和接口固定版本。
2. 打开“接口管理”，展开导入接口并打开编辑器。查询接口在“契约”页查看访问策略，默认应为禁用；核对选中字段、过滤和链，再按目标要求设置访问策略并保存。
3. 返回接口管理，重新发布目标草稿。发布失败时按校验诊断修正，不能直接恢复源发布签名或把权限改成已授权。历史版本仍保持导入时的禁用策略，需逐个审核。
4. 从已发布接口页面取得“当前发布版本的授权配置”，按[标准 HTTP 调用说明](../security-http-invocation.md#为调用应用签发限权凭据)创建目标实例应用身份和限权凭据。`none` 只表示接口不额外要求访问密钥，registry 身份和准确版本授权仍然必需。
5. 验证无权限/旧版本授权被拒绝、新目标授权只返回发布投影；再验证其他库、原始查询和系统库访问被拒绝，以及撤销即时生效。不要把源 Token 或源权限文件作为目标授权使用。

### 7.2 双库中断续跑

v2 先把目标加密的两份待发布 Vault 和原 Designer 快照写入 `security/asset-publication.mld`，随后分别以 CAS/journal 替换业务库和 Designer 库。这是分阶段发布协议，不是底层跨库事务。完成前所有普通 registry 服务启动都会返回 `SECURITY_MAINTENANCE_FAILED`；不要删除任务文件、锁或候选来启动服务。

实例停止后，保留原包、接收方私钥和可信发布者指纹，以相同配置、实例 ID、目标库重新执行 `asset-preview`，取得当前摘要，再执行 `asset-import --preview-digest ... --yes`。只有包、任务、目标原/新文件摘要完全一致的现场可继续；不同包、不同目标、被修改或损坏的文件拒绝且保留。进程仍存活时锁不会被接管。

两库完成后任务移动到 `security/asset-publication.<localAssetInstanceId>.completed.mld`，服务可正常启动。归档保持安全目录的平铺文件约束及 owner/SYSTEM ACL。该文件含目标密钥加密的发布结果及发布前 Designer 快照，须连同目标密钥材料保留；当前不提供人工回滚命令或自动清理。重复导入要求两个文件的密文摘要仍完全一致，Engine 重新持久化也可能改变摘要并导致拒绝。任务文件上限 224 MiB，每个 Vault 上限 48 MiB，Windows 进程退出恢复不代表硬件断电验收。没有成功回执时先重新预览，不能把失败回执当作两库均未写入。
