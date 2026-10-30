# 设备注册接口使用说明

D34实际Windows Hello/双机操作入口为[双机隔离演练手册](windows-device-drill-guide.md)。Prepare/Serve/Client复用本章正式协议和OS本机管理；Smoke不创建虚拟认证器且不完成硬件验收。实际注册/登录、停用后旧会话/新签名、独立进程重启与恢复策略仍需两端证据和操作者确认。

DR-P1.4 提供默认关闭的注册 HTTP，DR-P1.5 提供本机审批 CLI。证明通过后先保存待审候选；管理员批准才建立主体、公钥凭证和明确授权。批准不创建 Token、登录会话或 Cookie。DR-P2 提供公钥登录，DR-P3.2 提供同源托管 Designer 的注册与 Passkey 登录页面，原配对和应用 Token 模式继续保留。

## 1. 安全准备与启用字段

先具备稳定 DNS、受信 HTTPS、准确 `publicBaseUrl` 和对应 data 来源规则，详见[部署契约](device-registration-deployment-contract.md)与[Windows 配置说明](windows-lan-config.md)。纯 IP、localhost 和远程明文不能启用注册。注册需 Node 22 及以上，本轮实际验证 Node 24；Server 既有能力的 Node 范围不变。

以下只是可选 `security.registration` 块的结构示意，不能原样覆盖已有配置。所有占位符必须由管理员在隔离环境核对后替换；不要把原始 Token、私钥或业务授权放入描述。

```json
{
  "descriptor": {
    "format": "modeldb.device-registration-connection.v1",
    "version": 1,
    "instanceId": "<已有实例的 UUID v4>",
    "serverOrigin": "https://modeldb.example.test",
    "rpId": "modeldb.example.test",
    "registrationMode": "enabled",
    "issuedAtUtc": "<当前 UTC 时间，精确到毫秒并以 Z 结尾>",
    "expiresAtUtc": "<最多 24 小时后的 UTC 时间>",
    "deploymentDescriptorSha256": "<已核对的非秘密部署描述的 SHA-256>",
    "tls": {
      "mode": "owner-pinned",
      "minVersion": "TLS1.2",
      "spkiSha256": "<管理员独立核对的服务器公钥 SPKI SHA-256>"
    }
  },
  "allowStorageMigration": false
}
```

- `instanceId` 必须属于当前实例，不能凭主机名/MAC 派生，也不能复制别人的实例 ID。已有状态命令会显示非秘密实例 ID。
- Origin 与 `publicBaseUrl` 必须完全相同；RP ID 等于 DNS 主机名，不包含协议或端口。直接 TLS 还核对本地公开证书的 SAN、有效期及 SPKI pin；代理部署的外部证书信任由管理员和客户端独立建立。
- 描述只确定新注册窗口，最多 24 小时；不能未来签发。过期窗口自动关闭，重启时也按关闭处理，不阻止数据库继续启动，不撤销已经登记的身份。
- `allowStorageMigration` 默认 false。已有 V1 的首次启用，必须在明确接受原子格式升级后显式设为 true；否则拒绝启用。省略整个块或 disabled 不升级 V1。V2 不能用旧程序直接降级写入，回退限制见[协议第 8 节](device-registration-protocol-contract.md#8-持久台账与原子迁移)。本轮未迁移任何真实实例。
- 同一有效窗口下，新申请无需逐个修改配置或重启。本机审批见第 5 节；动态注册窗口开关尚无 CLI，继续以显式配置和期限控制。

`tls.mode=public-ca` 时去掉 `spkiSha256`，由客户端正常证书链/主机名验证建立信任。下载描述本身不能使错误证书可信，也不能自授任何权限。保留既有安全台账和密钥，不通过删除材料解决启用错误。

## 2. 接口与注册顺序

所有路径位于同一受信 HTTPS Origin；没有跨源 CORS。POST 必须是 JSON、准确 Origin 和 `Sec-Fetch-Site: same-origin`，不接受 URL 查询参数。字段完整定义见[公共协议](device-registration-protocol-contract.md)。

| 操作         | 方法与路径                                   | 结果                                                             |
| ------------ | -------------------------------------------- | ---------------------------------------------------------------- |
| 能力探测     | GET `/security/registration/v1/capabilities` | 200；未配置仍显示 disabled，不能据此假定开放                     |
| 下载连接描述 | GET `/security/registration/v1/connection`   | 200 JSON 附件，no-store；未配置/过期拒绝                         |
| 开始注册     | POST `/security/registration/v1/begin`       | 201；独立 registrationId、challengeId、32 字节查询秘密和创建选项 |
| 完成注册     | POST `/security/registration/v1/complete`    | 202；验证证明后仍为 pending，不返回会话                          |
| 查询原申请   | POST `/security/registration/v1/status`      | 200；须持有独立查询秘密，最短间隔 5 秒                           |

客户端将 begin 的选项交给浏览器 WebAuthn，投影标准响应后提交 complete。挑战有效 60 秒，一次尝试即持久消费；失败需重新 begin，不重放 complete。查询秘密只保存在当前页面内存，不放 URL、日志或浏览器持久存储；内存丢失后重新申请。complete 结果未知时查询原申请。未知申请、错误实例和错误秘密统一返回 NOT_FOUND。

首版严格请求 `attestation=none`、UP/UV、ES256 或 RS256；服务端使用固定版本库解析/校验，不接受 packed 等外部证明格式以避免引入外部证书验证访问。none 不提供硬件来源或私钥持有证明；之后仍需本机审批及 DR-P2 的公钥登录挑战，才能建立有准确授权的业务会话。浏览器 Passkey 不等于物理设备绑定。

## 3. 限制、错误与维护

begin 与 complete 各限制每来源 5 次/分钟、全实例 60 次/分钟；下载和能力共用来源 30/实例 300 次每分钟；查询全实例 12000 次/分钟，单申请至少间隔 5 秒。证明最多同时 4 个、等待 32 个；等待最多 60 秒，满载立即拒绝，本机维护不进入公开队列。JSON 在解析前限制 128 KiB。预算重启后重建，已消费挑战持久保持，重启不会恢复使用资格。

每 30 秒后台检查并持久处理未完成申请的到期状态；请求内和重启回收也处理已完成挑战等有界垃圾，避免没有待处理申请时后台单独清理阻塞 TLS。注册开始的清理与新申请共用一次事务，清理和注册两条审计均保留；审计不足或写入失败整体拒绝，挑战截止时间不延长。未证明的过期挑战使申请拒绝；证明已通过的申请继续待审，最长 24 小时。公钥/已批准记录和撤销墓碑不会被窗口到期删除。访问重置会关闭持久模式、撤销身份；重启时尚有效的显式 enabled 配置可再次开放窗口。

read-only 成功审计按动作/分钟采样，进程内保留观察/保存/抑制计数，重启重新计数；匿名拒绝沿用有界持久聚合。申请、挑战认领和候选写入与对应审计同一事务。审计或存储失败拒绝报成功；已记录持久意图后不能假定未提交，应保留现场并重开检查。错误响应只含稳定 code/requestId 和可选重试秒数，不返回内部错误、证明或秘密。

常见结果：DISABLED 表示窗口关闭；SCHEMA_INVALID 表示格式/大小错误；ORIGIN_MISMATCH 表示传输或来源绑定失败；CHALLENGE_REPLAYED 表示已使用；PROOF_INVALID 表示校验失败；RATE_LIMITED/CAPACITY 带 Retry-After；它们不应通过关闭安全校验来解决。

## 4. 隔离验证

已安装本轮依赖的 Windows 开发目录可运行：

```powershell
node node_modules/tsx/dist/cli.mjs --test test/unit/security-registration-contract.test.mjs test/unit/security-device-registration-contract.test.ts test/unit/security-registration-storage.test.ts test/unit/security-registration-runtime.test.ts test/unit/security-registration-approval.test.ts
node scripts/security-registration-storage-check.mjs
node scripts/security-registration-consumer-check.mjs
```

也可使用 `pnpm run test:security:registration`。这些定向单测使用临时合成实例，包括真实 Windows DPAPI/TLS Server；完整注册审批集成使用第 6 节的独立命令。合成 none 响应和虚拟认证器均不代表 Windows Hello、真实双机、公钥登录、生产容量或发布安装已验收。依赖安装证据按交付修订区分，不将历史安装当作本轮重装。

## 5. 本机审批 CLI

仅在数据库所在 Windows、受信运行账号的普通 PowerShell 中操作。数据库服务须正在运行，或由明确配置的 `security serve` 提供原有本机维护通道；不额外启动第二个实例。Named Pipe 拒绝远程连接，并验证 Windows SID；本机 IP、浏览器管理员会话或请求中的 role 都不能代替此身份。列表操作也写审计，受审计容量约束。

以下命令使用已构建的当前 Server；所有尖括号占位符须先替换为隔离测试实例中的值，不能原样执行或覆盖真实配置。

```powershell
node .\packages\server\dist\cli.js security registration-list -c "<隔离配置的绝对路径>" --instance "<准确实例 UUID>" --offset 0 --limit 25
```

先用原有 `security status -c <配置>` 核对实例 UUID。列表返回 `revision`、申请 `id/state`、申请人备注、期限、`proofVerified` 和 `publicKeyFingerprint`（COSE 公钥 SHA-256）。通过可信渠道核对申请人和指纹；设备备注、通过 none 校验和 UV 标志都不能单独证明申请人的身份或硬件来源。列表不显示公钥、rawId、userHandle 或查询秘密。

准备单独的授权 JSON 数组文件，例如下面仅授予合成库读取权限。使用真实库时必须由管理员明确选择，不能把所有库自动加入：

```json
[
  {
    "database": "business_demo",
    "resource": "*",
    "actions": ["model.read"]
  }
]
```

database 必须准确，禁止 `*`；resource 的 `*` 仅覆盖该库。动作沿用 SecurityGrant；发布接口的 callable 动作须准确 resource 和 releaseDigest。`[]` 明确表示无数据权限。文件最多 32 KiB，新 CLI 拒绝未知/重复选项、符号链接及非文件输入。授权不会继承同主体其他 Bearer 凭据的范围；Designer 未来登录仍须分别具有业务库和设计器库所需权限。

批准一条尚未到期、`proofVerified=true` 的 pending 申请，同时创建管理员命名的 operator：

```powershell
node .\packages\server\dist\cli.js security registration-approve -c "<隔离配置的绝对路径>" --instance "<准确实例 UUID>" --id "<申请 UUID>" --revision <刚核对的修订号> --name "<核实后的用户备注>" --grants-file "<授权 JSON 的绝对路径>" --yes
```

若关联已有 enabled operator，使用 `--principal <主体 ID>` 替换 `--name`，二者必须且只能提供一个；关联用户也须 enabled。批准结果只含申请/主体/用户/凭证 ID、授权与新修订，不含访问秘密。已关闭注册窗口但尚未到期的已证明申请仍可审批，不必重新开放窗口。

拒绝申请使用：

```powershell
node .\packages\server\dist\cli.js security registration-reject -c "<隔离配置的绝对路径>" --instance "<准确实例 UUID>" --id "<申请 UUID>" --revision <刚核对的修订号> --yes
```

拒绝为终态，也可拒绝尚未完成证明的申请，其未消费挑战同时终止。批准、拒绝和到期不能相互恢复。每次操作前核对最新列表；读审计、公开轮询或其他维护也可能推进总修订，`SECURITY_POLICY_CONFLICT` 后重新列表并人工核对，不自动替换修订重放。

常见错误：`SECURITY_LOCAL_IDENTITY_DENIED` 为本机身份不符；`SECURITY_FORBIDDEN` 为错实例、未验证候选或不可用主体/用户；`SECURITY_CONFIRMATION_REQUIRED` 缺少确认；`SECURITY_PROTOCOL_UNSUPPORTED` 为尚无 V2 台账，列表不会自动迁移；`SECURITY_RESPONSE_LIMIT` 表示分页/身份容量等上限。审计满或落盘失败不报批准成功；通道中断或提交结果未知时保留现场，重开后列表核查状态与审计，不盲目再次批准。

普通存储不能改写已存授权；DR-P2.4 的本机维护支持状态管理和明确减权，见第 10 节。旧 V2 缺 grants 时视为空授权，旧程序不能读取带新 grants 的记录，禁止直接二进制降级。业务库、DEK、Vault 和备份不受审批改变。完整协议见[本机审批约定](device-registration-protocol-contract.md#10-dr-p15-本机审批约定)。

## 6. 注册—审批全流程验收与故障报告

在 Windows 开发目录安装本项目既定依赖，并安装 Chrome；使用普通 PowerShell，在项目根目录执行：

```powershell
node scripts/security-registration-integration-check.mjs
$LASTEXITCODE
```

也可执行 `pnpm run test:security:registration:integration`。该命令不读取默认配置或已有实例，自动创建临时合成实例、随机回环 HTTPS 端口及独立 Chrome profile。Chrome 路径默认是 `C:\Program Files\Google\Chrome\Application\chrome.exe`；安装位置不同时，可仅对本次终端设置 `MODELDB_TEST_BROWSER` 为准确可执行文件路径。测试仅在新 profile 中允许测试夹具的准确 SPKI，并在该浏览器进程内映射合成 DNS；不修改 hosts、系统证书或现有浏览器设置。

程序返回 JSON，包括 `ok`、`exitCode`、`unit`、`browser.checks`、`report` 和 `log`。成功需要 `ok=true`、进程退出码 0、9 项全通过且 fail/skip/cancelled/todo 全为 0，并具有实际 Chrome 虚拟认证器和原生 DPAPI/Named Pipe/CLI 证据；缺 Chrome/Windows 或关键证据时失败，不标记跳过。JSON 报告和完整 TAP 保存在新建的 `ModeDB-Registration-Flow-Report-*` 临时目录中。

浏览器验证下载/注册、真实 `navigator.credentials.create`、none 校验、待审、列表/批准/拒绝、并发证明至多一次、旧修订冲突、容量边界与本机维护、重启并关闭注册后仍保留批准状态；批准前后均不产生 Cookie、Token 或业务访问权限。容量测试先用可信的未验证合成记录填充槽位，再由虚拟认证器实际走最后一个槽位及超限拒绝，不等同于 1000 个真实认证器或压测。

另外八项纵向测试连接真实校验库、HTTP 和本机审批分发，覆盖准确授权/指纹、坏证明终态、证明与拒绝竞争、1000 条待审上限、最终候选落盘失败，以及 staged/journaled/replaced 三个提交点的子进程强制退出。故障测试只用临时 AES-GCM 保护夹具；原生浏览器链路另用真实 Windows DPAPI。staged 后恢复为 pending，journaled/replaced 后恢复为 approved；主体/用户/凭证和成功审计要么全无、要么各一次，不自动重放审批。

失败时保留 `report` 和 `log` 指向的文件。`REGISTRATION_INTEGRATION_PROCESS_FAILED` 表示子测试失败；`REGISTRATION_INTEGRATION_INCOMPLETE` 表示有跳过、取消或未完成项；`REGISTRATION_VIRTUAL_AUTHENTICATOR_EVIDENCE_REQUIRED` 表示缺少实际浏览器证据。先查看 TAP 中稳定错误和失败步骤，再修复环境或代码重跑新实例，不能删台账、关闭鉴权或以单测结果替代浏览器通过。受执行沙箱限制时，Chrome GPU 进程可能拒绝启动，应在获授权的正常执行环境运行同一命令。

只分享脱敏 JSON/TAP；不要打包整个临时实例、security 目录、浏览器 profile 或恢复材料。该验收未开发注册/审批页面，不是页面视觉或 i18n 验收，也不验证 Windows Hello、双机实际认证器、公钥登录、真实性能、完整发行包或真实业务切换。DR-P2.1 已建立会话父级及持久兼容模型；D19 新增的公钥登录验收另见第 8 节。

## 7. 会话父级模型与兼容验证

DR-P2.1 后，现有应用继续使用原 Token，Designer 的实际连接继续使用既有配对流程；批准公钥仍不能直接登录。不需要修改真实配置，也不要手动把台账改为 V3。V3 迁移当前只提供受信内部 CAS 原语，无用户 CLI/HTTP 开关；正式登录启用与迁移操作留给后续任务。

会话元数据可区分 `api-credential`、`registered-public-key` 和 `local-management` 三类父级。公钥身份只使用自己获批的授权；管理身份始终无业务授权，不能转成可复用 API Token，进入模型设计仍需另建准确授权的业务会话。父级记录不是连接秘密或可下载许可证，不接受把元数据作为 Token 上传。

开发者在已安装依赖的 Windows 项目目录可运行隔离验证：

```powershell
node node_modules/tsx/dist/cli.mjs --test test/unit/security-session-parent.test.ts
node scripts/security-registration-storage-check.mjs
node scripts/security-registration-consumer-check.mjs
```

第一条也可用 `pnpm run test:security:session`。测试仅使用全新系统临时目录；包含合成公钥持久输入、原生 DPAPI、V1/V2 显式迁移、错误父级拒绝、管理空授权、注销/重置及三个提交点异常恢复。合成输入不证明 WebAuthn 登录完成；原生保护测试不是双机认证。后两项使用临时全新 shared 声明，不改已有 dist。

迁移错误 `SECURITY_POLICY_CONFLICT` 表示修订已变化，先重新核查；`SECURITY_STORE_INVALID` 表示父级/持久结构不合格或保护材料不可用，保留现场；`SECURITY_AUDIT_CAPACITY` 和 `SECURITY_STORE_WRITE_FAILED` 均不能报迁移成功。后者可能已留下可恢复的提交意图，重开后核对版本和迁移审计。不要删除台账、改版本字段或重建密钥来消除错误。V3 不能直接换回旧程序；完整旧发行包降级和真实升级仍未验收，见[兼容契约](device-registration-protocol-contract.md#12-dr-p21-会话父级与持久兼容模型)。

## 8. 公钥登录与浏览器会话（DR-P2.2）

D19 已实现登录后端和 SDK，正式 Designer 注册/登录按钮留待 DR-P3。现有页面继续使用配对流程；不要把登记 ID 当 Token 输入。浏览器私钥由认证器保管，登录提交签名证明，服务端不接收私钥。Passkey 可能跨设备同步，不代表严格物理主机绑定。

### 启用与升级

默认不开放公钥登录。先按前文完成准确 DNS/RP、HTTPS、实例绑定、可信部署描述和注册审批，再在**隔离实例**现有 `security` 块中加入下面两个字段；这是配置片段，不是完整可启动配置：

```json
{
  "authentication": {
    "enabled": true,
    "allowStorageMigration": true
  }
}
```

同级 `registration.descriptor` 必须存在并通过部署校验。登录使用其中准确 Origin/RP/实例/部署摘要；registrationMode 可以关闭，已批准身份不因注册窗口或描述下载期限到期失效。首次显式许可会原子升级到 V4；后续可将 allowStorageMigration 设为 false。省略 authentication 或 enabled=false 不升级旧格式、不接受新登录，已有有效会话继续使用。关闭注册与注销会话是不同操作。

V4 不能直接交给旧 V1—V3 程序写入。保留完整隔离副本和匹配程序，禁止手改版本、删除台账或重建密钥来“回退”。本轮没有修改真实配置或迁移原业务实例。

### 浏览器接入

接入方必须在数据库的**准确同源 HTTPS 页面**调用 SDK。通过受信渠道核对部署绑定；文件能下载不等于可信，也不等于已获访问许可。示例使用占位实例/摘要，须替换为已经核对的当前值：

```ts
import {
  loginBrowserSession,
  getBrowserSession,
  refreshBrowserSession,
  logoutBrowserSession,
} from '@mode-db/sdk';

const endpoint = { host: 'https://db.example.test:9443', port: 9443 };
const binding = {
  format: 'modeldb.device-authentication.v1' as const,
  version: 1 as const,
  instanceId: '<已核对的实例 UUID>',
  deploymentDescriptorSha256: '<已核对的当前部署 SHA-256>',
};
await loginBrowserSession(endpoint, binding); // 触发浏览器用户验证
await getBrowserSession(endpoint); // 页面重载后恢复 CSRF 元数据
await refreshBrowserSession(endpoint); // 轮换 Cookie 与 CSRF
await logoutBrowserSession(endpoint); // 注销当前会话，保留登记
```

可发现凭据无需输入 Token。非发现式认证器可在 endpoint 中增加可选 rawId，它是浏览器凭据 ID 提示，不是登记内部 ID或授权声明。SDK 只向本 Origin 的固定 begin/complete 路径发送请求，禁用重定向；仅在内存保留 CSRF/期限元数据，不向 localStorage/IndexedDB 保存证明、Cookie 或私钥。浏览器取消认证时由调用页面处理取消状态。

服务端发出 60 秒单次挑战和绑定浏览器的短期 HttpOnly/Secure/SameSite=Strict Cookie。complete 验证用户存在/验证、准确 RP/Origin、挑战与签名，拒绝 iframe/crossOrigin；只有最新 active 公钥、enabled 用户和主体可登录。成功持久提交后才发出会话 Cookie，JSON 只含期限、CSRF 和非秘密元数据；Cookie 不可由 JS 读取。认证挑战 Cookie 按挑战区分，并行登录不会清除另一个挑战的 Cookie。

会话有效期 30 分钟，绝对期限 8 小时。使用中的 SDK 仅在临近到期时续期，不延长绝对期限；显式 refresh 同样受该期限约束。刷新后旧会话/CSRF 失效；注销不删除登记或解密密钥。GET session、refresh、logout 使用数据网络规则，安全中心等管理接口仍使用管理规则及独立管理身份；公钥登录不授予管理员权限。

### 验证和故障处理

在已安装依赖的 Windows 普通终端执行：

```powershell
pnpm run test:security:authentication
node scripts/security-authentication-integration-check.mjs
node scripts/security-registration-storage-check.mjs
node scripts/security-registration-consumer-check.mjs
```

第二项也可用 `pnpm run test:security:authentication:integration`。它要求 Chrome，通过新的临时 profile、合成 TLS 证书、随机回环端口和原生 DPAPI/本机审批执行真实 navigator.credentials.get 及新 SDK；输出临时 integration-check.json 和完整 TAP。测试不安装系统信任、不连接真实 9091。只分享脱敏 JSON/TAP，不上传整个临时实例或浏览器 profile。它不替代 Windows Hello、两台物理设备、正式页面视觉/i18n、性能或生产切换验收。

| 错误后缀                                | 含义和处理                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| DISABLED                                | 没有显式开启新登录或服务已经关闭；不要改用明文 Token 绕过。                          |
| INSTANCE_MISMATCH / DEPLOYMENT_MISMATCH | 核对当前实例与部署绑定；不要自动信任另一个下载链接。                                 |
| ORIGIN_DENIED                           | 核对准确 HTTPS、Host/Origin、同源页面和来源/代理规则。                               |
| PROOF_INVALID                           | 未批准/停用/未知凭据、错签名或绑定等统一拒绝；核对本机审批，不公开区分账号是否存在。 |
| CHALLENGE_EXPIRED / CHALLENGE_REPLAYED  | 新建挑战；重启、失败或已认领的旧证明不能重复提交。                                   |
| RATE_LIMITED / CAPACITY                 | 遵循 Retry-After，停止并发重试；检查隔离实例的存储/审计与容量，不删材料。            |

上述后缀均带 `SECURITY_AUTHENTICATION_` 前缀。begin 来源 10/实例 120 次每分钟，complete 来源 20/实例 240；挑战最多 1000，证明同时 4 个、等待 32 个，body 64 KiB。这些是限额，不是吞吐承诺。

存储提交失败可能发生在落盘之后：浏览器若已有 Cookie，先调用 getBrowserSession 核查；没有 Cookie 就发起新挑战。不要重放旧证明，也不要把 HTTP 失败解释为“肯定没有提交”。重启会拒绝未完成挑战，已成功的计数器/会话/审计共同恢复。动态撤销与执行边界见下一节；本机用户停用/换钥的正式 CLI 见第 10 节。

## 9. 动态授权与连接失效（DR-P2.3）

已批准公钥登录后，每次 HTTP、RPC、WebSocket 和发布接口调用都读取该凭据自己的最新权限。撤销前已排队的写入在实际执行前再检查；没有权限时不打开业务引擎。异步授权会保留整组要求，批量发布涉及的所有库都要在最后再次满足授权；关系、间接删除和批量导入继续要求整库写入/导入权限。

权限收缩会主动关闭该凭据已有的 WebSocket，客户端重新握手后只能使用剩余权限；禁用或撤销凭据、停用用户会拒绝新动作和续期。禁用/停用还原子撤销原会话，即使随后重新启用也必须重新登录。同用户的独立 API 身份不会继承登记权限，也不会因只禁用一个登记公钥而失效。空闲流按服务器时钟到期，无须客户端再发一条消息；续期轮换后原 Cookie/CSRF 失效，流需要用新会话重连。

发布查询/操作仍须准确 resource 和 releaseDigest。绑定面必须同时持有自身及每个子接口的准确发布授权，父级权限在子调用和每个批量项执行前仍须有效。只读结果返回前再检查；普通 batchUpdate/batchDelete 及发布批量的各独立项执行前均重查。insertMany/upsertMany 和关系导入的引擎内部执行视为一个已进入的操作，不承诺中途取消。单项写入一旦提交就不强行中断。批量部分成功保留已完成项，后续拒绝不会回滚它们；写入后的自动刷新失效时保留 mutation 结果并返回 refreshFailed。连接断开不能证明写入未执行；遇 SECURITY_OUTCOME_UNCONFIRMED 应先通过审计/数据核查，避免盲目重试产生重复写入。

本步没有新增配置项或正式维护页面。收缩原语及第 10 节的正式 CLI 均要求可信本机身份和准确总修订且只能减权；普通注册存储接口不能改 grants。不要手改台账、删除安全目录或重建密钥。

在已安装依赖的普通 Windows PowerShell、项目根目录重复隔离验证：

```powershell
pnpm run test:security:dynamic
node scripts/security-registration-storage-check.mjs
```

专项使用临时合成安全台账、真实软件签名、实际隔离引擎及随机回环 WS 端口，不使用原业务库。它不是正式页面、硬件、两台物理设备或生产容量验收。SECURITY_FORBIDDEN 表示当前范围不足；SECURITY_RELEASE_SCOPE_CHANGED 表示发布摘要不符；SECURITY_CREDENTIAL_REVOKED/EXPIRED 表示会话或父级不可用；WS 的 SECURITY_REAUTH_REQUIRED 要求重新握手。提交失败应保留隔离现场，重开核查，不能假定未落盘。

## 10. 本机用户与凭据维护（DR-P2.4）

实例所有者在服务器同一 Windows 账号的普通终端，通过既有受保护 Named Pipe 维护已经登记的身份。服务须已运行，命令必须明确指定配置和实例；LAN 来源、浏览器 Cookie、申请中的姓名或自行声明的管理员角色均不能调用这些命令。此步只交付 CLI/后端；Designer 的正式维护页面仍待 DR-P3。

### 核对列表

以下命令为占位示例，先在隔离实例使用；`<...>` 须替换，不能直接照抄占位内容执行。

```text
modeldb-server security registration-credentials-list -c <isolated-config> --instance <instance-uuid> --limit 25
modeldb-server security registration-users-list -c <isolated-config> --instance <instance-uuid> --limit 25
modeldb-server security registration-list -c <isolated-config> --instance <instance-uuid> --limit 25
```

凭据列表可增加 `--user <registered-user-uuid>`。分页使用 `--offset` 和 `--limit`，每页 1—100 条。列表返回当前总 `revision`、ID、状态、时间、公钥 SHA-256 指纹与准确授权；不返回公钥原文、rawId、私钥、会话或查询秘密。登记用户 ID、operator 主体 ID、登记凭据 ID 是三个不同字段；原 API 凭据和本机管理记录不混入登记凭据列表。每次列表也记审计、推进修订，多个列表全部核对完后，使用最后一次返回的 revision。

### 禁用、启用、撤销与减权

```text
modeldb-server security registration-credential-disable -c <isolated-config> --instance <instance-uuid> --id <registered-credential-uuid> --revision <latest-revision> --yes
modeldb-server security registration-credential-enable -c <isolated-config> --instance <instance-uuid> --id <registered-credential-uuid> --revision <latest-revision> --yes
modeldb-server security registration-credential-revoke -c <isolated-config> --instance <instance-uuid> --id <registered-credential-uuid> --revision <latest-revision> --yes
modeldb-server security registration-credential-restrict -c <isolated-config> --instance <instance-uuid> --id <registered-credential-uuid> --revision <latest-revision> --grants-file <reduced-grants.json> --yes
modeldb-server security registration-user-disable -c <isolated-config> --instance <instance-uuid> --id <registered-user-uuid> --revision <latest-revision> --yes
modeldb-server security registration-user-enable -c <isolated-config> --instance <instance-uuid> --id <registered-user-uuid> --revision <latest-revision> --yes
```

这些是分别选择的操作，每次变更前重新列表核对，不能复用同一个 revision 顺序运行。禁用单凭据影响该公钥的所有会话，停用用户影响其全部登记公钥；同主体独立 API 凭据仍按自身状态管理。启用只接受 disabled 凭据或已停用用户，且相关主体须可用；启用用户不自动启用其 disabled 凭据。撤销是不可恢复终态。禁用/停用与原会话撤销一起落盘，重新启用后必须重新登录；已关闭的连接不会自动恢复身份。

`reduced-grants.json` 是不超过 32 KiB 的 JSON 授权数组，格式同前文批准示例。只允许在原 database/resource/releaseDigest 内移除授权或动作；不能通过把 `*` 改成其他资源、更改发布摘要或新增动作来扩权。`[]` 表示零权限，不表示继承其他凭据；disabled 凭据也可减权，revoked 不可修改。授权变化会要求该凭据的 WebSocket 重新握手。

### 正常换钥与凭据丢失

1. 在原注册窗口允许时，用新认证器重新注册，完成证明并等待审批。窗口已关闭则需实例所有者另行按部署流程开放；下载描述不等于获批。
2. 本机查看申请和旧凭据，可信渠道核对新申请的指纹、实例和本人身份。不要单凭设备名、备注或可下载文件关联用户。
3. 正常替换 active/disabled 旧凭据时，执行下面的原子换钥命令。新授权必须明确提供；不继承旧凭据或同主体 API 的权限。

```text
modeldb-server security registration-credential-replace -c <isolated-config> --instance <instance-uuid> --id <old-registered-credential-uuid> --application <new-verified-pending-application-uuid> --revision <latest-revision> --grants-file <new-grants.json> --yes
```

一次事务在原 enabled 用户/主体下批准新公钥、保存新授权、撤销旧凭据及会话并记审计。新申请必须仍 pending、证明通过且未到期；同旧 rawId 或公钥不能伪称换钥。成功返回 `replacementCredentialId` 和新修订；它们不是 Token。新认证器仍须执行第 8 节的私钥挑战登录，换钥命令本身不发会话。

凭据丢失或疑似泄露时，先单独执行 revoke 立即切断旧身份，不等新申请完成。新认证器注册后，管理员核对身份，使用第 5 节 `registration-approve --principal <原 enabled operator ID> --grants-file ... --yes` 明确重新关联和审批。已经 revoked 的旧记录不能作为 replace 输入；新申请批准前不能登录。可选择创建新主体或明确零授权，均须重新审批。

旧批准记录与撤销墓碑保留，每用户上限 20 条包含墓碑；换钥不绕过容量，达到上限会拒绝且不部分撤销旧身份。注销只结束当前会话，禁用、撤销、停用和换钥均不删除数据解密材料、不更换实例密钥、DEK、Vault 或备份。

### 故障与重复验证

`SECURITY_POLICY_CONFLICT`：修订或状态已变化，重新列表核对；`SECURITY_CONFIRMATION_REQUIRED`：缺少 `--yes`；`SECURITY_FORBIDDEN`：实例/主体/用户或新候选不合格；`SECURITY_NOT_FOUND`：ID 或命名空间不符；`SECURITY_RESPONSE_LIMIT`：分页或容量超限，列表可缩小 limit。不要通过删记录或重建密钥解除限制。

`SECURITY_AUDIT_CAPACITY`、`SECURITY_STORE_WRITE_FAILED` 或通道中断不能当作成功；journaled/replaced 后可能已经提交。保留现场，用列表和审计核对旧凭据、新申请和新凭据是否一起切换，不自动重放命令。用户或凭据启用后旧 Cookie 仍失效，应新登录。

```powershell
pnpm run test:security:maintenance
node scripts/security-registration-storage-check.mjs
```

第一项也可用 `node node_modules/tsx/dist/cli.mjs --test test/unit/security-registration-maintenance.test.ts`。验证使用临时合成实例，覆盖真实软件签名、单凭据/全用户、减权、正常及丢失换钥、审计容量、三个提交点异常恢复与原生 Windows DPAPI/实际 CLI；缺 Windows 不跳过。异常注入不代表进程硬退出、物理断电或磁盘耗尽，也不替代 Hello/新双机、正式页面、性能与真实切换验收。

## 11. 故障恢复与撤销竞争验收（DR-P2.5）

本步不新增配置、台账版本或管理命令。凭据或登记用户在登录排队/签名验证期间一旦停用，即使随即重新启用，该次在途证明仍拒绝。重新发起登录即可使用重新启用的身份；旧 Cookie 不恢复。减权不会误判成身份停用，最终登录会话使用提交时的最新授权。注销或刷新与撤销先后发生，重启后均不能恢复已撤销的会话。

开发者在项目根目录运行：

```powershell
pnpm run test:security:resilience
```

也可直接执行 `node scripts/security-authentication-resilience-check.mjs`。脚本只在系统临时目录创建合成实例，输出报告路径和结果，保留 `resilience-check.json` 与 `resilience.tap`。成功须 ok=true、退出码 0、55/55 且无 fail/skip/cancelled/todo；报告还核对 30 个硬退出、10 类真实软件签名/排队竞争、4 个审计满边界，缺矩阵或关键检查失败就拒绝通过。

硬退出子进程在 staged、journaled、replaced 直接退出，覆盖登录、挑战认领、刷新、注销、禁用、撤销、用户停用、减权、换钥及 V2→V4 迁移。重开会完成既有日志恢复，身份、会话、计数器与审计保持一个完整结果，不自动重放操作。此专项使用合成保护器；原生 Windows DPAPI/Named Pipe/CLI 与 Chrome 验证分别运行第 10 节维护专项及 `node scripts/security-authentication-integration-check.mjs`。软件签名和虚拟认证器不证明实际 Hello/新双机，也不证明物理磁盘耗尽、硬件断电或生产性能。

遇到错误、中断或没有回执，按以下顺序核查：

1. 保留原实例/报告和原修订，不删除锁、journal、台账或密钥，不直接重复变更。进程仍存活时不能强行接管。
2. 确认原进程已退出后，由正常程序重开原隔离实例，让已有原子日志自行恢复。用第 10 节列表及审计核对旧/新凭据、申请终态和对应变更。staged 可能未提交；journaled/replaced 可能已提交，即使客户端未收到成功。
3. 有 Cookie 先尝试会话恢复；无 Cookie 就重新发起登录，不能重放旧签名。登录可能已持久提交但未送达 Cookie，这个不可用会话由既定期限或管理员撤销回收，不会返回原会话秘密。
4. `SECURITY_AUDIT_CAPACITY` 时按原审计保留/维护流程处理，不能清空台账来解除。换钥若已提交，旧钥应拒绝且新钥须重新签名；若未提交，新申请应保持待审、旧身份保持原状态。结果不一致应停止后续变更并保留诊断。

完整后端出口仍需登录、动态授权、维护和原认证回归及严格类型/browser 边界检查；单独一份合成故障报告不能替代这些检查。Git 同步后的源码/历史证据核对仍用 `node scripts/security-release-evidence.mjs`，最新交付缺关键证据时不回退旧版本。正式注册/审批维护页面在 DR-P3 继续。

## 12. 同源页面与专用本机管理入口（DR-P3.1）

此模式须显式开启，默认保持原独立前端部署。数据监听器提供 `/designer/` 和同源数据 API；专用 HTTP 管理监听器只绑定 `127.0.0.1`，提供 `/security/`、管理 API 与管理会话。即使从本机访问数据端口也不能进入管理页/API。管理端不能执行 RPC、WebSocket、数据库管理、注册或公钥登录。服务端验证实际 socket、精确 Host/Origin，管理端拒绝所有代理/转发头。

### 在新的隔离目录试用

在项目根目录的普通 PowerShell 逐行执行。依赖须已按仓库锁安装；本步不安装依赖或证书信任，不做发行升级。

```powershell
$hostingRoot = Join-Path $env:TEMP ("ModeDB-Hosting-Demo-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $hostingRoot -ErrorAction Stop | Out-Null
node scripts/security-hosting-build.mjs --output "$hostingRoot\public-designer"
if ($LASTEXITCODE -ne 0) { throw "Designer build failed; preserve this run" }
Copy-Item -LiteralPath .\docs\security-v1\examples\hosted-designer.loopback.json -Destination "$hostingRoot\fixture.json" -ErrorAction Stop
node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts --config "$hostingRoot\fixture.json"
```

构建脚本只写全新目标，不加载本地 Vite 配置、`.env` 或真实 certs，不覆盖原 dist。保留第一窗口运行，使用启动信息中准确的 `http://127.0.0.1:<数据端口>/designer/` 打开页面。随机端口无需修改真实配置或停止真实服务。

第二个普通 PowerShell 使用第一窗口打印的同一个隔离路径，替换占位符：

```text
node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts security security-open -c "<hostingRoot>\fixture.json"
```

命令经 Windows OS 身份 Named Pipe 获取当前管理监听器地址及一次性配对，在系统浏览器打开管理页。必须显式 `-c`，不接受 `--url`、`--server` 或 `--databases` 覆盖。配对码只放 fragment，消费后清除，stdout 不返回配对码。用过或过期后重新运行命令。原生验收经同一 OS 通道取链接，由受控 Chrome 打开；未自动化操控默认系统浏览器。

直接打开管理页只加载公开页面，未配对的管理请求仍拒绝。管理身份无数据授权，空闲 **15 分钟**、绝对 **60 分钟**；续期/重启不延长绝对期限。Cookie 为 HttpOnly/SameSite=Strict，变更须有当前 CSRF；旧八小时管理身份不能在新监听器使用。准确地址为 `127.0.0.1`，localhost 别名、LAN、代理头、错 Host/Origin 均拒绝。

数据页面采用当前准确 Origin 作为连接默认值；管理页面不显示进入模型设计指引。访问数据应另开数据页面并取得明确的数据身份/库授权，不能沿用管理 Cookie。现有数据配对/API 模式保留；正式免 Token 注册/Passkey/待审状态页在 DR-P3.2 继续，本步没有把下载描述或公开页面当作访问许可。

### 字段与局域网部署

完整样例：[hosted-designer.loopback.json](examples/hosted-designer.loopback.json)。

| 字段                                 | 解释与限制                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `security.version`                   | 仍为 1，不改变台账或密钥格式                                                       |
| `security.hosting.enabled`           | 显式 true 才开启；缺省/false 保留旧部署；legacy 模式拒绝                           |
| `security.hosting.designerDirectory` | 可信公开 build 目录；相对配置文件目录解析，或明确绝对路径；不能是源码/实例根/vault |
| `security.hosting.managementPort`    | 整数 0—65535，默认 0 随机；绑定地址固定 127.0.0.1，不允许配置或回退                |
| `host` / `port`                      | 只控制数据监听器，管理监听器独立                                                   |
| `publicBaseUrl`                      | LAN、TLS 或代理托管须明确登记规范 Origin，不从动态 Host 推导                       |

远程注册继续要求 HTTPS、固定 DNS/RP ID、证书信任和显式注册窗口。原网络白名单、来源策略与认证仍执行；托管不自动开放 LAN/注册。代理只能转发数据端，不得发布管理监听器。本机 HTTP 样例只用于隔离托管/配对，不能作为远程 WebAuthn 配置。

静态 build 仅允许唯一 index.html 和 JS/CSS/图片/字体，资源位于根或一级 assets 目录。拒绝未知扩展、额外 HTML、源码、map、JSON、env、密钥、链接/目录联接/硬链接及受保护目录重叠。单文件 16 MiB、总计 64 MiB、最多 1024 文件。启动时固定为内存快照；更新后需重启加载，无目录列表、任意路径回退或请求路径拼接读盘。CSP self、nosniff、no-store、no-referrer 和禁止嵌入头同时执行。共享公开 bundle 不是权限边界，权限由数据库端验证。

### 错误、停止与重复验收

- `SECURITY_INVALID_CONFIG`：核对目录/字段、静态文件/链接、protected 重叠及 LAN/TLS/publicBaseUrl；不能把实例根设为公开目录。
- `EADDRINUSE`：端口占用，启动失败并释放已创建的监听器、台账和本机通道；不自动扩大绑定。
- `SECURITY_LOCAL_CHANNEL_UNAVAILABLE`：确认准确隔离配置及服务已经启动，不改用任意管理 URL。
- `SECURITY_ORIGIN_DENIED/SOURCE_DENIED`：使用准确 127 地址和端口，不经代理。
- `SECURITY_CSRF_REQUIRED/CREDENTIAL_INVALID/FORBIDDEN`：重新经本机启动器配对，不复制 Cookie 或修改浏览器存储。

第一窗口 Ctrl+C 关闭两个监听器和 OS 通道；不删除台账/密钥。再次启动端口 0 可能分配新管理端口，重新运行启动器。审计写入失败返回 503，不交付静态内容或伪报拒绝成功。

```powershell
pnpm run test:security:hosting
pnpm run test:security:hosting:integration
node scripts/security-registration-storage-check.mjs
node scripts/security-release-evidence.mjs
```

集成 runner 使用临时全新 Designer build、原生 Windows DPAPI/Named Pipe、随机回环端口及新 Chrome profile，生成脱敏 JSON/TAP 和 12 张 zh/en/ja、1280/390 截图。缺原生/浏览器证据、关键检查、准确计数或有 skip 均拒绝。本步不替代真实 LAN、Hello/新双机、远程 TLS 页面、生产性能、完整发行安装或真实切换验收。

## 13. Designer 注册与 Passkey 登录（DR-P3.2）

适用于第 12 节同源托管的 `/designer/` 数据页面。管理员须先按第 1、8、12 节配置准确的受信 HTTPS DNS/Origin/RP、公开注册描述、`security.authentication.enabled` 和托管目录；首次升级另需显式迁移许可。注册默认关闭，页面不会替管理员修改网络策略、证书或注册窗口。第 12 节的纯 HTTP 回环样例只验证托管与配对，不能创建 Passkey。独立前端仍使用原有连接方式，部署向导继续 DR-P3.4。

### 首次申请与登录

1. 打开管理员通过可信渠道提供的准确 HTTPS `/designer/` 地址，确认浏览器证书正常。页面显示当前服务器和实例标识；下载描述文件不是信任建立方式，不要绕过证书警告。
2. 展开“首次连接？申请访问权限”，输入便于管理员识别的申请名称。可选下载或导入此服务器的 JSON 描述文件；导入最多 16 KiB，严格核对实时实例、Origin、RP、部署摘要、TLS 和有效期。文件不执行，不改变地址，不携带登录权限。
3. 点击“创建通行密钥并申请”，在浏览器提示中完成身份验证。系统可能提供 Windows Hello、其他认证器或同步 Passkey，是否可用由系统和浏览器决定。取消或超时会显示可重试提示，不授予权限。
4. 看到“等待本机管理员审批”后，将申请名称、编号和所需权限通过可信渠道告知管理员。页面每隔至少 5 秒查询，待审不能访问数据。管理员仍在服务器本机使用第 5 节 CLI 核对并批准/拒绝；审批维护界面将在 DR-P3.3 提供。
5. 页面显示“申请已批准”后，点击“使用 Passkey / Windows Hello 登录”，再次完成签名验证。批准本身不创建会话。认证 Cookie 保持 HttpOnly/Secure/SameSite=Strict，页面无需输入 Token。
6. 看到已验证身份后，点击“继续选择逻辑库”。后续沿用现有双库流程：设计器元数据进入 `model_designer_workspace`，业务库单独选择。管理员须分别授予所需权限；未授权不能依靠登录页绕过。连接错误不等于数据已写入，不自动重发写操作。
7. 刷新后可恢复仍有效的 Cookie 会话；“退出登录”只注销当前会话，不删除登记身份或数据解密材料。会话失效时重新登录；管理员停用/撤销后继续拒绝，重新启用也须新登录。

### 拒绝、到期、更换与恢复

- 被拒绝：页面明确显示结果，请向管理员确认原因。不要反复申请绕过审批。
- 挑战/申请到期：重新开始申请。注册窗口/描述下载到期只关闭新申请，已有获批身份仍可在同一页面登录；登录能力接口独立提供公开绑定。
- 页面刷新/关闭：查询秘密仅在内存，不进入 URL、DOM 或浏览器持久存储。申请仍在服务器；页面不能恢复原查询能力，请管理员按名称/编号核查。获批后直接登录，不为恢复查询反复建申请。
- 更换 Passkey：先产生新的待审申请，经可信渠道让管理员核实身份并按第 10 节原子换钥；页面不能自行接管原用户。
- 丢失凭据：用另一枚已获批 Passkey，或让本机管理员核实身份、撤销旧凭据再批准替换。没有自动跳过认证的恢复入口，不重新生成实例密钥解决登录问题。
- 不支持/证书错误：确认 HTTPS DNS、证书信任、浏览器 WebAuthn 及 OS 支持；纯 IP、localhost 或远程明文不作为此流程的替代。
- 限流/繁忙：至少等待一分钟再重试。结果未知先让管理员核查列表和审计，不重复提交。其他来源/格式错误需修正部署或描述，不降低校验。

“其他连接方式”保留原配对码和应用 Token。通行密钥流程始终使用当前页面 Origin；导入其他实例文件被拒绝，不向文件指定地址发送会话或证明。HTTPS 默认值也保留协议，避免自动回落到 HTTP。

### 开发者与可重复验证

SDK 新增 `getBrowserPublicKeyContext`、`getBrowserRegistrationDescriptor`、`parseBrowserRegistrationDescriptor`、`registerBrowserCredential`。只访问当前 HTTPS Origin；注册查询秘密封装在内存句柄中，`status()` 最短间隔 5 秒；`AbortSignal` 可取消页面退出后的操作，浏览器证明返回后、提交前再次检查取消状态。该最小客户端用于本页面，不代表 DR-P3.5 的三前端公共客户端工作全部完成。

```powershell
pnpm run test:security:designer-identity
pnpm run test:security:designer-identity:integration
node scripts/security-registration-consumer-check.mjs
node scripts/security-registration-storage-check.mjs
node scripts/security-release-evidence.mjs
```

集成仅在全新临时目录中构建 Designer，禁用本地 Vite 配置/env，使用合成 TLS、原生 DPAPI/Named Pipe、随机回环端口和新 Chrome profile。强制实际页面按钮、注册/拒绝/批准、Passkey 登录、Cookie 恢复/注销、到期窗口与停用拒绝；输出 JSON/TAP 和中英日三语言宽窄屏截图。Chrome 使用虚拟认证器和仅该进程的合成 SPKI pin，不安装系统信任；不能冒充 Windows Hello 硬件或两台设备验收。此轮数据 scope 验证不替代完整业务建模/保存、发行安装或生产容量验收。

## 14. 本机审批与身份维护（DR-P3.3）

本节适用于显式启用同源托管的 registry 实例。管理界面只由专用 HTTP 127.0.0.1 监听器提供；公开 HTTPS /designer/ 仅供注册、登录与数据操作。先按第 12、13 节准备隔离部署和获信任的 HTTPS，确认启用注册/认证所需的显式迁移许可。升级代码与旧库迁移、真实配置修改仍需单独安排；本节不会自动处理旧 Vault 或安装证书。

### 14.1 打开管理页并核对申请

在服务器本机，以实例所有者的普通 PowerShell 打开项目或已安装 CLI 所在目录。将下面路径替换为你明确选择的配置路径，每行单独执行；不要把示例路径直接当作真实配置。

```powershell
modeldb-server security security-open -c "C:\明确选择的目录\modeldb.config.json"
```

启动器经 Windows 身份验证的 Named Pipe 获取实际管理地址，浏览器消费一次性配对链接后清除 fragment。不要手工拼接端口、复制 Cookie，或把管理监听器代理到局域网。新管理会话空闲 15 分钟、绝对 60 分钟；到期重新运行启动器。公开监听器即使从本机访问也不提供管理 API。旧的独立前端安全页仍有原功能，新增“注册身份”只在专用托管管理页出现。

1. 进入“注册身份 → 连接申请”，按“重新加载并核对”获取当前页。每页 10 条，可前后翻页；列表包含待审与历史终态，不会因打开页面自动批准。
2. 展开“核对详情”，核对申请编号、显示名、时间、Origin/RP ID、注册响应状态、公钥指纹、算法及备份属性。通过独立渠道与申请人对照编号和指纹；显示名和指纹本身不是身份证明，none 注册响应也不证明硬件归属或私钥不可导出。
3. “批准”选择新用户名称或已存在且启用的操作员主体编号，二者只填一个。关联已有主体前独立核验身份，不能仅凭申请人声称的用户名建立关联。
4. 逐条填写准确授权：逻辑库、资源、动作及需要时的 releaseDigest。动作名称是协议值，例如 model.read。空列表表示没有数据权限；授权不会继承其他凭证，也不会自动授予管理权限。Designer 的设计器专属库与业务库继续分离，按既有授权契约分别配置，不能把 sys\_\* 元数据写入业务库。
5. 按“预览操作”，核对实例、对象、台账版本和全部授权。勾选独立核对确认后才能执行。预览期间编辑区锁定，需“返回编辑”修改；批准后申请人仍需从公开 Designer 主动执行一次新的 Passkey 登录。
6. 不符合要求时用“拒绝”，同样经过预览与确认。未完成响应验证的申请可拒绝，不能批准；到期或已终结申请不能再次批准。

### 14.2 用户、凭证、授权与会话的区别

| 页面/操作              | 影响范围与恢复方式                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 注册用户：停用         | 该注册用户下全部公钥及其数据会话失效；启用用户不复活旧会话，需重新登录                                                         |
| 公钥凭证：禁用/启用    | 仅此公钥；禁用使其会话失效，启用后必须新登录；不能把已撤销公钥重新启用                                                         |
| 公钥凭证：收缩授权     | 只能减少当前授权，允许清空；不会通过这个入口增加旧公钥权限；后续请求与排队执行重新核对授权                                     |
| 公钥凭证：永久撤销     | 永久终态，关联会话失效；通过新申请和独立核验恢复，不通过恢复旧文件或重复启用                                                   |
| 换钥 / 丢失恢复        | 选择已验证的新待审申请、核对两份指纹并明确填写新授权；原子撤销旧公钥并批准新公钥，不自动登录；同一个公钥重新编码也不能冒充换钥 |
| 浏览器会话：撤销此会话 | 仅撤销所选会话；父级公钥/应用凭证保持，用户可以凭有效身份重新登录。包括公钥、应用配对及本机管理三类会话，列表标明父级类别      |
| 撤销当前管理会话       | 确认后立即失去该管理会话，重新加载会提示失败；通过本机启动器重新配对进入                                                       |

所有变更要求实例绑定、严格字段白名单、准确版本与显式确认。身份不来自 IP、Origin、前端角色标记或请求体中的 SID。HTTP 操作的审计记录保留已验证管理主体、requestId 与实际 socket 来源，不冒充 Named Pipe 的 OS SID。台账/审计提交失败会拒绝变更；不会为了页面可用而跳过审计。

换钥下拉只显示前 100 条申请中的已验证待审候选。若目标不在其中，使用原本机 CLI 的 offset/limit 分页核查并按第 10、11 节完成操作；不要重新注册多次绕过容量或限流。凭证、用户、会话页面均按 10 条分页，切换/翻页会关闭旧草稿。

### 14.3 冲突、结果不明和排障

- “台账已变化”：当前草稿和最终确认已关闭。重新加载、再次核对目标和完整授权，再生成新的预览；页面不会自动换用新版本或重放操作。其他审批、登录、审计读取和后台活动也可能改变版本，这是正常的并发保护。
- 成功后列表仍展示提交前快照且操作锁定，按“重新加载并核对”确认最新状态；不要凭旧行继续操作。
- “操作未完成”：草稿关闭并锁定旧快照。先检查会话、网络和审计，再重新加载。若响应中途丢失，变更可能已提交，通过列表与审计确认结果，不盲目重复提交。
- 会话到期或自行撤销：重新运行本机启动器；局域网公开页、旧管理身份、普通数据 Passkey、伪造转发头均不能取得此权限。
- 授权拒绝：核对资源及 releaseDigest 契约、是否尝试扩权、主体/用户是否启用、新申请是否待审且在期限内。页面不展示服务端原始响应体或秘密。
- 限流或审计容量不足：停止重复请求，按现有安全维护手册处理；不要关闭限流、删除台账、重建实例密钥或清空业务库来解决。

### 14.4 重复隔离验证

```powershell
node node_modules/tsx/dist/cli.mjs --test test/unit/security-identity-admin.test.ts test/unit/security-identity-admin-report.test.mjs
node scripts/security-identity-admin-check.mjs
node scripts/security-registration-storage-check.mjs
node scripts/security-registration-consumer-check.mjs
node scripts/security-release-evidence.mjs
```

浏览器入口创建新临时 build、合成 HTTPS/原生 DPAPI 实例、随机回环端口和全新 Chrome profile，生成脱敏 TAP/JSON 与 24 张截图；不读取项目真实配置、certs/ 或根 security/，不连接真实 9091。分页容量夹具仅在停止临时实例后添加无公钥合成记录，正式注册限流保留。zh/en/ja、1280/390 覆盖申请列表、批准预览、冲突与凭证页；真实 Hello、局域网双机、完整业务保存、发行安装与性能容量仍由后续任务验收。

## 15. 首次部署向导（DR-P3.4）

### 15.1 创建全新隔离实例

向导只用于 `deployment-init` 新建、尚未使用业务功能的实例，默认仅本机且注册关闭。它不升级或覆盖原实例，不发现配置、网卡、证书或密钥。普通 PowerShell 中在项目根目录逐行执行；下面全部放在全新临时目录，不使用原业务配置：

```powershell
$deploymentRoot = Join-Path $env:TEMP ("ModeDB-First-Deployment-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $deploymentRoot -ErrorAction Stop | Out-Null
$publicBuild = Join-Path $deploymentRoot "designer-build"
$instanceRoot = Join-Path $deploymentRoot "instance"
node scripts/security-hosting-build.mjs --output "$publicBuild"
if ($LASTEXITCODE -ne 0) { throw "Designer build failed; preserve this run" }
node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts security deployment-init --target "$instanceRoot" --designer "$publicBuild" --port 19443 --yes
if ($LASTEXITCODE -ne 0) { throw "Initialization failed; preserve this run" }
$bootstrapConfig = Join-Path $instanceRoot "modeldb.bootstrap.json"
node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts --config "$bootstrapConfig"
```

保留这个运行服务的窗口。在第二个普通 PowerShell 中回到同一项目根目录，将下面路径替换为第一窗口实际打印/保留的 `$bootstrapConfig`，不要使用示例占位符：

```powershell
node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts security security-open --config "<bootstrap 配置的实际绝对路径>"
```

这是经过源代码入口验证的命令；已构建安装包可用 `modeldb-server security deployment-init`、`modeldb-server security deployment-finalize` 和 `modeldb-server security security-open`。当前扩展的完整新发行安装尚未验收。初始化要求目标不存在（空目录也拒绝）、父目录已存在、Designer 为明确公开 build；不允许把配置、Vault、证书或 security 目录当作公开 build。失败时保留现场，改用新的目标，不清理原目录来重试。

### 15.2 在本机管理页预览

打开“首次部署”。默认“仅本机”生成 127.0.0.1、无 TLS、注册和公钥登录关闭的候选；管理入口永远是专用 127.0.0.1。要让另一台电脑连接，明确选择“局域网 · HTTPS”并填写：

| 项目        | 填写与预检                                                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origin / RP | 先由所有者确定稳定 DNS。Origin 如 `https://modeldb.example.com:19443`，RP 为 `modeldb.example.com`，必须逐字匹配主机名和实际端口；IP、localhost、路径、查询或动态 Host 不接受 |
| 公开证书    | 选择单份服务器 `CERTIFICATE` PEM，最大 16 KiB；不上传私钥。核对准确 SAN、有效期覆盖整个窗口和 SPKI。未检查 DNS、证书链信任或私钥匹配，不自动安装信任或绕过安全警告            |
| 文件路径    | 服务器上证书和私钥的绝对路径，二者不同；HTTP 预览不打开这两个路径。停机提交只读取公开证书核对一致性，私钥内容由正常 TLS 启动读取                                              |
| 信任模式    | 公共 CA，或所有者带外核对 SPKI；后者额外填写 64 位小写 SHA-256 SPKI。两者都需要浏览器正常信任证书链                                                                           |
| 来源网段    | 每行一个 CIDR，最多 32 个，例如 `192.168.10.0/24`。拒绝 /0，保留回环，其他来源默认拒绝。网段不是用户身份，不能代替审批与公钥登录                                              |
| 注册窗口    | 默认关闭；明确勾选后才能接受新申请。描述/申请窗口为 1—168 小时，从预览时间起算，过期关闭新申请，不撤销已有获批身份。即使注册关闭，LAN 候选仍启用已有批准公钥的登录能力        |

按“预览并检查”，核对实例 ID、计划摘要、期限和完整配置。候选未应用，下载也不会启动服务。计划仅有效十分钟；过期需返回编辑重新预览。公开描述可下载，也可导入严格 JSON 与当前候选比较实例、Origin、RP、TLS、绑定摘要及期限；不能执行脚本、修改目标或自授权限。候选描述只在配置成功启动并独立确认信任后分发。需要开启注册时必须在首次提交前勾选，后续续窗按第 2—4 节显式维护配置；此向导不反复修改已部署实例。

### 15.3 停机后一次性提交

独立核对网络、DNS/证书信任/密钥配对及停机步骤的三项确认后，下载计划和需要时的候选公开描述。停止第一窗口的 bootstrap 服务（Ctrl+C），确认退出，再在该窗口执行，替换计划路径及页面显示的摘要：

```powershell
node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts security deployment-finalize --target "$instanceRoot" --plan "<下载计划的绝对路径>" --digest "<页面核对的 64 位摘要>" --yes
if ($LASTEXITCODE -ne 0) { throw "Commit not confirmed; preserve files and inspect before proceeding" }
$deployedConfig = Join-Path $instanceRoot "modeldb.deployment.json"
node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts --config "$deployedConfig"
```

提交重新核对实例、bootstrap 文件摘要、期限、公开证书文件，独占实例租约，保留原身份与密钥。它通过原防护预览/应用/确认路径保存网络规则，保留当前限流预算，再禁止覆盖地写新配置，不重启服务。原 bootstrap 配置保留、始终仅绑定回环。配置及计划含部署路径，属于本机管理资料；公开描述只含公开连接绑定，不含私钥或授权。不要把整个初始化目录或计划上传 Git。

`SECURITY_INSTANCE_BUSY` 表示实例仍被占用，先正常停机；摘要/期限/实例不符时不提交。`SECURITY_OUTCOME_UNCONFIRMED` 表示提交标记已经存在或提交可能只完成部分：保留 `.modeldb-deployment-commit.json`、配置、台账及报告，不删标记或盲目重复执行。离线核对新配置、台账网络规则及审计；必要时只以原 bootstrap 恢复回环管理，再按网络防护手册修复。此跨文件操作不承诺硬件断电下的全事务。TLS 启动拒绝可能是文件、私钥不匹配或证书问题，先独立修复材料，不重建实例密钥。

### 15.4 现有实例与重复验证

没有合法 bootstrap 标记、配置被修改、已有业务密钥/应用凭据/注册台账或已开始提交时，页面只显示人工合并说明。按第 12 节核对托管边界及 TLS/RP 契约，先备份、审核现有配置；网络规则以持久防护状态为准，通过“网络防护”预览、确认及回滚。不得删除 security、Vault、台账或密钥来取得向导资格。代理部署遵循独立代理契约，此向导不生成代理配置。

```powershell
node node_modules/tsx/dist/cli.mjs --test test/unit/security-deployment-wizard.test.ts test/unit/security-deployment-wizard-report.test.mjs
node scripts/security-deployment-wizard-check.mjs
node scripts/security-registration-storage-check.mjs
node scripts/security-registration-consumer-check.mjs
node scripts/security-release-evidence.mjs
```

验收工具使用新临时实例、随机回环端口、原生 DPAPI/Pipe、全新 build/Chrome profile 和合成 TLS；候选配置仍写 LAN 的 0.0.0.0，但测试启动显式覆盖为 127.0.0.1，绝不开放实际 LAN。浏览器仅该进程固定合成 SPKI，不安装系统信任；这不等于真实 DNS/CA、Hello、双机、生产容量或完整发行安装验收。

## 16. 公共客户端与三个前端（DR-P3.5）

Designer/Data Studio 身份页面支持中文、英文、日文，Web 沿用中文/英文。HTTPS 同源页面提供注册、描述 JSON 导入/下载、申请状态、Passkey 登录和注销。Data Studio/Web 的“其他连接方式”保留配对码及应用凭据；本机 HTTP 继续原配对流程。默认服务器只托管 Designer，不会新增 Studio/Web 静态路由；如需部署它们，先由管理员核对 HTTPS 同源站点/代理、RP、证书和来源策略。独立开发站点不能跨 Origin 使用 Passkey，不能通过忽略证书错误解决。

1. 打开管理员提供的准确 HTTPS 页面，核对显示的 Origin 和实例 ID。新设备展开注册区域，填写备注后按系统提示创建公钥凭据；备注不构成身份认证。
2. 等待管理员在专用本机安全中心独立核对并批准。页面间隔至少五秒查询；批准后仍须点击 Passkey 登录。
3. 会话就绪后点击继续连接。Data Studio 选择授权业务库并打开；Web 加载授权库目录。Designer 保持 workspace 设计数据与用户业务库分离。
4. 页面刷新可恢复有效 HttpOnly Cookie 会话，待审查询秘密不恢复；不要因刷新丢失申请状态连续申请。已批准设备直接登录，注册窗口到期不影响已批准登录。
5. 注销需要服务器确认；关闭页面、组件销毁或 dispose 不撤销服务器会话。网络失败时核对实际结果或请管理员撤销。应用 Token 仅在内存，刷新后须重新提供，不恢复旧明文存储。

开发者使用公共工厂，现有底层 API 继续兼容：

```typescript
import { createBrowserIdentityClient } from '@mode-db/sdk';
const identity = createBrowserIdentityClient({
  host: location.origin,
  port: Number(location.port) || 443,
});
const context = await identity.load();
// 用户明确点击后调用；申请、批准与登录是独立步骤。
await identity.login();
await identity.session();
// 卸载时调用；明确用户注销时另行 await identity.logout()。
identity.dispose();
```

公共方法：

| 方法                                  | 返回及操作要求                                                 |
| ------------------------------------- | -------------------------------------------------------------- |
| load()                                | 获取当前同源能力，固定实例/部署绑定；不是登录                  |
| descriptor() / importDescriptor(text) | 下载或严格核对当前公开 JSON；不改变目标或授予权限              |
| register(displayName)                 | 用户点击后创建申请，返回 initialStatus 和 status()；不发放会话 |
| application.status()                  | 查询该申请；间隔至少五秒，查询能力只在闭包内                   |
| login() / session()                   | 用户点击后公钥登录，或检查当前 Cookie 会话                     |
| logout()                              | 请求服务器注销，网络失败须另行核对                             |
| dispose()                             | 取消本地流程并禁止后续调用；不注销服务器会话                   |

每个视图一个客户端，操作期间禁用重复操作；SECURITY_IDENTITY_BUSY 等待当前操作完成，不自动重试。绑定变化显示描述错误，先核对服务器。取消/不支持、拒绝、过期、限流、身份停用及会话失效分别显示本地化说明。

重复验证：普通 PowerShell、项目根目录运行 node scripts/security-public-clients-check.mjs（或 pnpm run test:security:public-clients）；类型/浏览器边界运行 node scripts/security-registration-consumer-check.mjs。构建到全新临时目录，不加载本地 Vite/env、真实配置或旧 dist；原生验收需 Windows/Chrome，使用合成 TLS、随机回环端口和虚拟认证器，不安装系统信任。完整候选验收入口见第 17 节，实际 Hello、LAN 双机与发行交付仍需后续验收。

## 17. 浏览器候选验收与操作排障（DR-P3.6）

### 17.1 一条命令重复验证

在 Windows 的普通 PowerShell 中进入已安装本项目依赖的项目根目录，逐行执行：

```powershell
node --version
node scripts/security-browser-candidate-check.mjs
if ($LASTEXITCODE -ne 0) { throw "Candidate verification failed; preserve this run" }
```

也可使用 `pnpm run test:security:browser-candidate`。需要项目当前支持的 Node 版本和本机 Chrome；默认浏览器路径为 `C:\Program Files\Google\Chrome\Application\chrome.exe`。若 Chrome 安装在其他路径，仅为当前终端设置 `$env:MODELDB_TEST_BROWSER` 为该可执行文件的实际路径，再运行命令。不要使用管理员终端、生产配置参数或真实实例目录。命令不安装依赖、不启动真实 9091、不修改系统信任，也不加载本地 Vite 配置、`.env` 或原 dist。

每次创建新的 `ModeDB-Browser-Candidate-*` 临时目录，构建 Designer、Data Studio 和 Web，一次构建供下面六组使用。服务端以源码执行；这是浏览器候选验收，七个发行包的离线安装另在 DR-P4.3 验证。页面使用临时合成数据库、随机 127.0.0.1 端口、原生 Windows DPAPI/本机通道和独立 Chrome profile。HTTPS 使用测试专用名称与合成证书，仅固定到测试 Chrome 进程，不安装系统信任，不代表真实局域网 DNS、CA 或 Hello 已验证。

| 组名       | 覆盖操作                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------- |
| hosting    | 主数据/专用管理双监听器、OS 启动、端口冲突清理、刷新/注销、三语言和宽窄屏                       |
| identity   | Designer 正式注册、拒绝/批准、Passkey 登录、合成行写入及刷新读回、失效与恢复提示                |
| admin      | 本机页面审批、准确授权、用户/凭据/会话维护、冲突、分页和确认                                    |
| deployment | 新实例回环初始化、公开证书/RP 预检、计划预览、停机单次提交和保留身份                            |
| public     | Studio/Web 正式注册登录、授权库连接及合成行读写；三个前端的原配对/应用凭据兼容                  |
| hostile    | 恶意页面、同站不同端口请求、CSRF/预检/表单、null Origin、嵌入、错误 RP、Host 重绑定与代理头伪造 |

开头的 `candidate-start` 输出保存目录；每组完成输出进度。只有最后 JSON 中 `ok: true`、`task: "DR-P3.6"`、`totalNativePass: 9`，且 PowerShell 退出码为 0，才是本次综合验收成功。未完成、取消、超时、缺浏览器、skip、任何失败或源码/构建摘要变化均不能算通过。

目录中 `candidate-manifest.json` 记录本轮开发源码和三端产物的逐文件摘要，`candidate-check.json` 记录候选摘要及六组结果，各组 `.tap` 是原始测试记录，`screenshots/` 是页面截图。每组前后重查源码及构建，不能一边修改相关代码一边把本次运行当作同一候选的验收。阅读最终报告，确认六组均为成功且 `candidateSha256` 相同；不要用旧目录的成功覆盖新目录失败。工具不会删除失败目录或自动重试安全操作。

对外反馈优先提供 `candidate-check.json` 及失败组的脱敏错误码。不要打包整个临时实例、Chrome profile、恢复包或凭据/密钥目录；源码清单和截图也应先核对是否只含合成内容。可单独执行 `node scripts/security-release-evidence.mjs` 核对本仓库交付记录的完整性；该只读命令不重新运行功能验收。

### 17.2 管理员与连接者的操作顺序

以下是部署操作说明，不表示本轮已经操作真实服务；首次新实例按第 15 节初始化，已有实例按第 12、15.4 节审核并人工合并。

1. 管理员先确定稳定 DNS、准确 HTTPS Origin/RP 和可信证书，核对生效来源规则、托管 build 与有限注册窗口。默认仅托管 `/designer/`；Studio/Web 如单独部署，必须满足同源契约，不能任意更改端口或跨站复用 Cookie。
2. 管理员在服务器本机通过 `security security-open --config <明确配置>` 打开专用 `127.0.0.1` 管理页。URL 由 OS 通道获取，不能改成数据端口、localhost 别名或代理地址；仍需一次性配对和短期管理会话。
3. 连接者在准确 HTTPS 页面提交注册。下载/导入的连接描述是公开 JSON，只用于核对实例、Origin、RP 和期限，不是许可证、Token 或私钥，不能单独授予连接权限。
4. 管理员通过独立渠道核对申请人、申请编号/指纹，再在本机页批准准确库及操作权限。名称备注不能证明身份。拒绝或批准后不自动发放业务会话；批准错误或重复申请应核对后处理，不按名称批量批准。
5. 连接者点击 Passkey 登录，完成系统确认后再连接授权库。Designer 的设计库和业务库保持分离，按实际设计/保存操作分别授予必要权限；管理员身份本身不含业务数据访问权。Studio 选择授权业务库，Web 打开授权库目录。
6. 先在隔离库新建一条可辨认的合成记录并保存，再刷新、读回。需要管理员禁用测试时，确认后续请求被拒，重新启用后重新登录；已成功提交的数据不会因注销或禁用自动回滚。完整模型设计、关系、接口、Pivot、Excel 与备份回归仍按后续总验收执行。
7. 注销必须收到服务器确认。管理会话为空闲 15 分钟/绝对 60 分钟，普通公钥会话为空闲 30 分钟/绝对 8 小时；刷新不延长绝对期限。注册窗口到期只关闭新申请，已批准凭据仍可登录。

真实两台 Windows 与实际 Hello 的确认步骤和脱敏回传属于 DR-P4.6；既有恢复演练报告与本轮虚拟认证器结果均不能替代它。

### 17.3 按现象排障

| 现象或错误                                             | 核对与处理                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `CANDIDATE_SOURCE_CHANGED` / `CANDIDATE_BUILD_CHANGED` | 本轮期间开发文件或构建变化，保留失败目录，完成修改后重新运行生成新候选。不要改报告或跳过摘要检查                                               |
| Chrome 不存在、CDP 不可用、超时或非零退出              | 检查 Chrome 路径与本地执行环境、失败 TAP；本轮未通过。保留现场后重新验证，不复用浏览器 profile                                                 |
| 证书警告、RP/描述不匹配                                | 核对稳定 DNS、Origin 的协议/主机/端口、RP、实例和证书信任。公开描述不能安装信任；不要忽略警告或改用 IP 规避                                    |
| 注册描述返回 410，但原设备可登录                       | 注册/下载窗口已关闭或到期，已批准身份登录独立存在；新设备需管理员明确续窗，不能通过旧描述延长期限                                              |
| 申请待审，刷新后不见状态                               | 查询秘密只在内存，刷新不撤销服务器申请。保存申请编号请管理员核对，避免反复注册；批准后重新点击登录                                             |
| 用户取消或浏览器不支持 Passkey                         | 按页面本地化提示检查浏览器/系统认证器。取消不等于密码错误；不自动改成长期 Token 或降低用户验证                                                 |
| 登录成功但开库/保存 403                                | 核对当前身份的准确库、模型及操作权限，Designer 另核对设计库/业务库；权限不足由管理员审核，不通过扩大网络名单解决                               |
| Host/Origin/CSRF 或代理头拒绝                          | 使用服务器给出的准确同源 URL，写请求使用 SDK 的 Cookie/CSRF 流程；本机页直接访问准确 127.0.0.1 端口。不要伪造代理头或把远程请求标成回环        |
| `SECURITY_IDENTITY_BUSY` 或管理修订冲突                | 等待当前操作结束，刷新列表后重新核对并明确提交；不自动排队、重放或沿用过期修订                                                                 |
| `SECURITY_INSTANCE_BUSY` / `SECURITY_STORE_INVALID`    | 实例被占用或存储/OS 保护验证失败，保留配置、台账和日志；核对运行账号、明确路径、当前兼容版本与原实例。不要删 security、Vault、锁文件或重建密钥 |
| `SECURITY_OUTCOME_UNCONFIRMED`、保存/注销网络中断      | 结果可能已提交。通过本机列表/审计或重新查询合成记录核实；先核查再决定是否重新操作，不盲目重复写入或删除提交标记                                |
| 凭据丢失、禁用、撤销或恢复后无法登录                   | 由管理员独立核验并按第 10 节重新登记/换钥；启用不复活旧会话。登录凭据不同于数据解密密钥，不能用 Passkey 代替备份恢复材料                       |

SameSite=Strict Cookie 不能独自防御同站不同端口的恶意页面，因此服务端仍验证准确 Host/Origin、Fetch Metadata 和写操作 CSRF。本机 socket 和拒绝代理头的校验由数据库端执行，不依赖前端隐藏入口。浏览器的 CORS/CORP/嵌入限制是附加防护，不能代替认证和授权。

## 18. 接收方加密公钥与离线持有证明（DR-P4.1）

这一流程登记将来用于接收加密包的独立公钥，不创建业务包，也不增加登录或数据权限。Passkey 只负责登录。完整协议见[接收方密钥契约](recipient-key-contract.md)，实际阶段与验证见唯一台账和 SEC-M7 最新记录；按登记对象导出包属于下一项 DR-P4.2。

### 18.1 接收方准备

在接收方设备的普通 PowerShell 中，按[使用手册第 5 节](user-guide.md#5-向受信任实例完整迁移)创建独立 RSA 3072 位迁移密钥。私钥和口令文件位于仓库外的专用 owner/SYSTEM ACL 目录，不提交 Git。已有同格式的独立加密密钥可继续使用；TLS、WebAuthn、资产签名或恢复文件不可混用。

```text
modeldb-server security backup-key-create --output <protected-prefix> --passphrase-file <protected-phrase-file>
```

仅把 `.public.pem` 交给管理员，并通过独立可信渠道核对其 `recipientId`。这一步不需要连接或重启数据库，源管理员不需要私钥和口令。不要向聊天或工单上传它们。接收者必须保留每个历史版本的私钥及独立受保护备份。

### 18.2 本机管理员建立挑战

1. 用第 12 节 OS 启动器打开服务器专用准确 `127.0.0.1` 管理页，进入“接收方密钥”。远程数据监听器不提供此能力；直接改 URL、添加代理头或前端角色不能获得权限。
2. 未初始化时，先核对已启用的 V4 公钥登录台账，再预览“初始化台账”，明确勾选并提交。它原子升级为 V5，不改变原身份、会话、授权或业务密钥。普通启动不迁移；旧程序不能直接写 V5，不能手改版本号回退。
3. 重新加载，选择已批准且仍有 active 登录凭据的 enabled 用户，导入其 `.public.pem`，核对人员后预览并确认“核验新公钥”。列表目前显示前 100 位用户，更多用户可由受保护本机通道配合公共 SDK 命令操作；不按显示名称推断身份。
4. 核对返回的 userId、SHA-256 指纹、版本与五分钟期限，下载 `recipient-challenge.json`，交给接收方。挑战只包含公开绑定和密文，不含私钥或口令。版本 1 为首次登记；替换时挑战也绑定当前活动 key ID。

页面刷新会丢失当前挑战上下文，需要开始新挑战；旧挑战不会因此自动撤销，会按原期限失效。单实例最多 128 条未过期挑战，满额等待到期再发起，不删除台账。列表与其他管理动作也会推进总修订；冲突后重新加载并人工核对，不重放旧请求。

### 18.3 接收方离线生成证明

两端先同步开发代码。以下命令在接收方项目根目录执行，不构建旧 dist、不加载配置、不连接服务。把占位路径替换为自己的绝对路径，每行分别执行；无需 PowerShell here-string。

先检查挑战：

```powershell
node node_modules/tsx/dist/cli.mjs scripts/security-recipient-key.ts inspect --challenge "<挑战文件绝对路径>"
$LASTEXITCODE
```

退出码应为 `0`。通过可信渠道逐项核对 `binding` 中的实例、userId、指纹、版本、前版本和期限，不能只看文件名。确认后复制本次输出的 `bindingDigest`，执行：

```powershell
node node_modules/tsx/dist/cli.mjs scripts/security-recipient-key.ts prove --challenge "<挑战文件绝对路径>" --private-key "<接收方.private.json>" --passphrase-file "<受保护口令文件>" --binding-digest "<刚核对的bindingDigest>" --output "<专用受保护目录中的新proof.json>"
$LASTEXITCODE
```

私钥、口令和输出的父目录需符合 owner/SYSTEM ACL；工具验证现有权限，不放宽目录权限。成功返回 `ok:true`、输出路径及退出码 `0`，不打印证明正文。已有输出不覆盖。错误摘要、错私钥、篡改、过期、错误格式或目录权限会统一返回 `SECURITY_RECIPIENT_TOOL_FAILED` 和退出码 `1`；不要关闭检查或把目录改成全员可读。

仅将 `proof.json` 交回可信管理员。它是五分钟内的一次性敏感回执，应按敏感文件传递；私钥与口令始终留在接收方。工具只接受专用挑战，不提供任意密文解密接口；本流程不安装系统信任或使用 WebAuthn 私钥。

### 18.4 完成、替换与丢失恢复

管理员在原页面导入当前挑战的证明，核对指纹及用户后预览并独立确认“确认持有并登记”。证明仅驻当前页面内存，不写 URL 或 Web Storage；服务端再次验证实例、版本、用户状态、期限、单次性和摘要。成功后重新加载，检查活动版本及审计；错误证明被消费，不能改正确后重放，需新挑战。

替换时使用新的独立密钥重复以上步骤。新证明成功后旧公钥自动退役，历史版本保留；“退役公钥”永久停止该版本用于新交付，无删除或重新启用入口。停用/撤销登录、停用用户或替换 Passkey 不删除历史公钥或接收方历史私钥；身份重新启用不能恢复已消费或失效的挑战。访问重置另外退役活动接收方并保留历史。

丢失私钥时，管理员先独立核验本人，再按新公钥流程换版本；这不能解开旧包。没有历史私钥备份或另行批准的恢复接收方，旧包可能无法恢复。空访问灾备仍需重新登记与核验，不导回旧访问状态；不自动迁移旧 Vault 或重封装旧包。

发生写入失败、审计满、网络中断或结果不明时，保留现场并重新加载/查审计。可能已经提交，不能将报错当作回滚证据。每用户最多 20 个版本（含退役历史），全实例最多 10000 个版本，不能删除历史绕过上限。

开发重复验证：`pnpm run test:security:recipients`、`node scripts/security-recipient-check.mjs`。后者强制 Windows/Chrome/DPAPI、新隔离构建及 profile，输出临时报告、清单、TAP 和三语言宽窄屏截图；`ok:true`、所有检查为 true、零失败和零 skip 才表示通过。它不证明实际 Hello/两台设备、生产性能或后续包交付已验收。

## 19. 按已核验接收方离线交付（DR-P4.2）

### 19.1 准备与选择接收方

先在隔离环境演练。接收方按第 18 节建立独立密钥，管理员带外核对人员、公钥指纹并完成持有证明。登录 Passkey 与解密私钥各自保管。源实例为已显式初始化的 V5；接收方用户/主体必须启用，且至少有一个 active 登录凭据。暂停源实例服务后才执行导出，目标导入也需停机。不要删除活跃锁或停掉不属于本次演练的服务。

以下在普通 PowerShell、项目根目录逐行执行。替换占位值；本节以源码 CLI 为例，不构建或覆盖旧 dist。输出/私钥/口令使用专用受保护目录，不能放 Git 仓库或源 security/数据树内。

```powershell
$sourceConfig = "<隔离源配置的绝对路径>"
$sourceInstance = "<源实例ID>"
$recipientId = "<核对过的接收方key ID>"
$recipientUser = "<核对过的登记userId>"
$recipientVersion = "<核对过的版本数字>"
$recipientFingerprint = "<核对过的64位SHA-256指纹>"
$pageText = node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts security recipient-list -c "$sourceConfig" --instance "$sourceInstance" --offset 0 --limit 100
if ($LASTEXITCODE -ne 0) { throw "Recipient list failed; preserve this run" }
$page = ($pageText -join "`n") | ConvertFrom-Json
$page | ConvertTo-Json -Depth 8
```

核对 `instanceId`、`keys` 中准确 id/userId/keyVersion/fingerprint 及 `state: active`。超过一页时用下一 offset 重新列表；每次列表也推进总修订，使用最后一次返回的 `revision`。这些值是选择条件，不能仅凭备注名称批准。下列数组供紧接着的一次导出使用：

```powershell
$recipientArgs = @("--recipient-id", $recipientId, "--recipient-user", $recipientUser, "--recipient-version", $recipientVersion, "--recipient-fingerprint", $recipientFingerprint, "--revision", [string]$page.revision)
```

五项参数必须完整，不能再传 `--public-key`。V5 禁止裸 PEM 导出；尚未初始化接收方台账的 V1—V4 仅保留原 PEM 兼容路径（使用手册第 5、7 节）。不要为兼容旧命令改台账版本号。每次导出、列表或维护都会改变修订；另一次导出前重复列表、核对及重建 `$recipientArgs`，不复用旧修订或自动重试 CAS 冲突。

### 19.2 完整迁移包或资产包

完整迁移使用准确业务库名和新的外部输出文件：

```powershell
node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts security backup-export -c "$sourceConfig" --instance "$sourceInstance" --database "<源业务库>" @recipientArgs --output "<外部新迁移包绝对路径>" --yes
if ($LASTEXITCODE -ne 0) { throw "Export not confirmed; inspect files and audit" }
```

成功 JSON 的 `recipient` 必须与本次核对相同；`recipientId` 为原包格式的公钥指纹，`packageSha256` 绑定完整包字节。通过可信渠道把摘要和包交给该接收方。`modeldb.backup.v2` 包含完整 Vault 和受加密保护的源 DEK，适用于完全信任的迁移；它没有独立发布者签名。包在源备份目录也保留一份。

资产发布者先按使用手册第 7 节准备独立签名密钥、受保护口令文件和 selection.json；此签名私钥属于发布者，与接收方解密私钥不同。重新列表取得当前修订后执行：

```powershell
node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts security asset-export -c "$sourceConfig" --instance "$sourceInstance" --database "<源业务库>" --selection "<选择JSON绝对路径>" --asset-id "<稳定资产ID>" --asset-version 1.0.0 @recipientArgs --signing-key "<发布者.private.json>" --passphrase-file "<发布者受保护口令文件>" --output "<外部新资产包绝对路径>" --yes
if ($LASTEXITCODE -ne 0) { throw "Export not confirmed; inspect files and audit" }
```

模型选择仍为 `modeldb.asset.v1`，含 Designer 查询/操作/绑定的选择仍为 `modeldb.asset.v2`。签名 PS256、加密套件和选择闭包沿用原契约，接收方另须通过独立渠道核对发布者公钥指纹。包不带源访问授权或接收方登记 userId/版本，不能据此证明物理主机身份或行级隔离。

### 19.3 接收端导入与历史密钥

接收端保存原包和可信摘要，使用**本次公钥对应的历史私钥及口令**，源端无需在线。完整迁移按[使用手册第 5 节](user-guide.md#5-向受信任实例完整迁移)执行 `backup-import`，返回 `restored: false` 仅表示本地备份暂存；核对后另行 `restore`。发布前原流程允许重复暂存，目标库存在后重复迁移拒绝，不能把暂存回执当作业务库已恢复。

资产按[使用手册第 7 节](user-guide.md#7-模型与-designer-资产包)先 `asset-preview`，核对目标准确实例/库、包及冲突，再带当次 `confirmationDigest` 显式 `asset-import --yes`。错误私钥、篡改、错误发布者或错误目标拒绝；旧确认摘要重复使用拒绝。故障后重新预览的同包续跑沿用原恢复任务，不承诺跨实例的全局一次性接收。目标生成独立 DEK，源用户、凭据和权限不迁移，业务访问另行准确授权。

退役、换钥或禁用阻止未来新交付，不能追回已发包。新版本私钥不能解旧包；保留各版本的独立受保护备份，私钥与口令均不上传服务器、聊天或 Git。丢失时按第 18.4 节核验并重新登记，不能靠重建源密钥恢复旧包。

### 19.4 结果核查与重复验收

导出先原子记录 `recipient.delivery.sealed` 的接收方元数据、源库及包摘要，再新建外部文件，最后记录原任务完成。sealed 只证明封装记账，不证明文件写入完成；审计满/提交失败时拒绝交付。`SECURITY_INSTANCE_BUSY` 先核对正常停机；CAS 冲突重新列表并人工确认。任何文件尝试写入后的异常返回 `SECURITY_OUTCOME_UNCONFIRMED`：保留文件、原包与审计，核对摘要和任务状态，不覆盖文件或盲目重发。该流程不承诺跨文件硬件断电原子性。

重复开发验收无需配置或业务路径参数：

```powershell
pnpm run test:security:delivery
node scripts/security-recipient-delivery-check.mjs
if ($LASTEXITCODE -ne 0) { throw "Native delivery verification failed; preserve this run" }
```

原生工具需要 Windows，创建两个临时合成实例，实际使用 DPAPI 和离线 CLI；封装三种原格式后移除合成源，测试正确/错误私钥、篡改、目标摘要、重复发布和独立目标密钥/空访问台账。最终 `ok:true`、单项原生验收成功且零 skip 才算通过；报告、源码清单、原始 TAP 写入新临时目录。不要上传整个临时实例、交付包、私钥或口令。本项无页面改动，不代替视觉、发行安装、实际 Hello/双机或性能验收。

## 20. 独立性能与满容量维护（DR-P4.5）

按[独立性能验证手册](performance-guide.md)执行探索、门槛登记和新实例确认。工具测量注册、登录、续期、1000 行查询、10 行保存、静态页面和撤销；满待审容量时验证正常拒绝审计及真实本机规则预览、应用、确认和回滚。只使用临时合成实例，不需要真实配置或业务数据，不代替后续两台 Windows/实际认证器验收。
