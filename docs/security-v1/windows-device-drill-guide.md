# 两台 Windows 实际认证器验收

这是 DR-P4.6 的隔离操作手册。D34 已提供重复演练工具；**真实 Windows Hello 和 A/B 双机验收尚未完成**，不能将 `Smoke` 或历史恢复报告计作完成。工具复用正式 Model Designer 页面及服务端认证/授权，不新增认证接口。当前支持 Windows、Node 24、已安装的 Chrome 或 Edge；其他平台、Node 22、本阶段 Edge 实际运行仍待对应验证。

D36 修复登录后进入模型库的 `SECURITY_SOURCE_DENIED`：数据面列库/catalog 与管理操作分开，预建并准确授权业务库及设计器专属库。旧轮保留；A/B 同步本次源码后新建 Prepare，重新传公开 ticket/证书、独立核对新 pin、注册和审批，不修改旧轮摘要或放开 management 来源。

## 1. B 先确认 Windows Hello

在 B 打开 **设置 → 账户 → 登录选项**，查看是否已设置“PIN（Windows Hello）”。已设置 PIN 即可，不要求购买指纹或人脸设备。未设置则按 Windows 指引添加，由你本人输入 Windows 账户验证信息和 PIN。若显示“此选项当前不可用”，记录非敏感错误文字，先解决设备/组织策略；不要改用文件签名冒充 Hello。

浏览器发起注册或登录时，要在 Windows 安全窗口中选择**本机 Windows Hello**并由本人完成 PIN/指纹/人脸操作。不要选择手机跨设备扫码或同步到其他设备的账户密钥来声明本机 Hello。脚本不会读取、代输或保存 PIN、生物特征或私钥，也不创建虚拟认证器。

浏览器的 `platformAuthenticatorAvailable: true` 只表示平台能力可用，不能证明你已经完成了 Hello。报告的 `attestation none` 也不能证明物理不可导出、TPM 绑定或绝对无法复制。DR-H1 是单独可选工作。

## 2. 两端准备

两端使用普通 PowerShell（标题无“管理员”），切换到各自项目根目录。A 是演练服务端，B 是浏览器客户端；只同步源码与必要依赖，不同步任何实例或浏览器目录。先提交/同步本次脚本，再开始演练；开始后到结束前不要改源码。两端 LF 归一化摘要必须相同；Git 换行差异允许，缺文件或旧源码会拒绝。

```powershell
node --version
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.AddressState -eq 'Preferred' } | Select-Object InterfaceAlias,IPAddress
```

选同一可信局域网的两条准确私网 IPv4，例如 A `192.168.1.10`、B `192.168.1.11`。下面示例要替换为实际地址。仅允许 10/8、172.16/12 或 192.168/16 的明确地址，不支持公网、VPN 转发、代理、`0.0.0.0` 或整网段放行。脚本不自动修改系统防火墙/hosts/证书信任；网络不通先停止，核对选中的网络与组织策略，不关闭整个防火墙。

## 3. A 生成本次隔离演练

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\security-device-drill.ps1 -Action Prepare -ServerAddress "192.168.1.10" -ClientAddress "192.168.1.11"
$LASTEXITCODE
```

成功退出码为 0，输出 `prepared: true`、`drillRoot`、`transferOnly`、`pin` 和到期时间。全新目录在 `%TEMP%\ModeDB-Device-Drill-*`；工具构建新的 Designer，预建合成业务库 `synthetic_business` 与元数据库 `model_designer_workspace`，生成专用 TLS 私钥/证书并冻结源码/页面。`taskComplete` 仍为 false。不要把“准备成功”当双机通过。

保存 A 的输出路径：

```powershell
$deviceRoot = "替换为 A 输出的 drillRoot"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\security-device-drill.ps1 -Action Serve -DrillRoot $deviceRoot
```

保持窗口打开。服务只监听指定 A 地址的随机高端口，拒绝真实 9091；来源仅回环/A/B 准确地址，管理仍走 Windows 身份管道。所有数据都是新建合成数据。

只将 `transferOnly` 指定目录里的 **`connection.json` 与 `server.crt`** 复制给 B，例如 B 的下载目录 `ModeDB-device-transfer`。私钥、`private`、`security`、`vault`、浏览器 profile、整个演练目录都不复制、不提交 Git。通过另一条可信途径（当面核对或已信任会话）告诉 B 那个完整 64 位十六进制 `pin`；不要只从同一张可替换的 ticket 中复制 pin 当作独立校验。

注册窗口为生成后两小时；过期保留旧现场，重新 `Prepare` 生成新演练，不手改时间、摘要或密钥。此期限是演练 ticket，不改变正式产品已注册凭据独立于注册窗口的语义。

## 4. B 启动专用浏览器并注册

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\security-device-drill.ps1 -Action Client -Ticket "$env:USERPROFILE\Downloads\ModeDB-device-transfer\connection.json" -Pin "替换为从 A 独立核对的完整 pin" -Browser edge
```

若 Edge 不可用可改 `-Browser chrome`。浏览器必须由这个命令打开：它使用新 profile，仅在该浏览器进程内将本次 `.example.test` 域名映射到 A，只对本次 TLS 公钥作精确校验，不安装系统信任。复制地址到日常浏览器不会沿用映射/校验；不要点击忽略证书错误继续访问。

在正式 Designer 的连接页面展开“设备身份/Passkey”区域，输入合成名称，点击注册，由本人完成 Windows Hello。不要输入 Token。看到“待审批”后，在 **B 脚本窗口**输入：

```text
status
```

应有 `state: pending` 和准确 `applicationId`。此时还没有数据权限；刷新前先通知 A 处理这一申请，因为继续查询所需秘密只在当前页面内存中。报告不包含它。

## 5. A 批准，B 登录、保存、刷新、断网

在 **A 脚本窗口**逐条输入（尖括号连同内容替换为 B 给出的 UUID）：

```text
list
approve <applicationId>
credentials
```

核对 `list` 中对应申请，准确 ID 审批。工具使用当前修订 CAS、本机 Windows 管道，给 `synthetic_business` 模型读/写，给 `model_designer_workspace` 模型读/写、schema 管理及导入权限，用于初始化和保存元数据；没有库创建/删除、备份或安全管理权限，`sys_*` 不写入业务库。记录 `credentials` 中本次准确凭据 UUID，后续停用它。

B 页面显示批准后，先输入 `status`，记录批准尚未登录时仍无会话；再点击 Passkey 登录，完成一次 Windows Hello。B 脚本输入 `status`，应有 `ready: true`。随后在页面点击“继续访问模型库”，选择 `synthetic_business` 并“打开库”。等建模编辑器出现，再在 **B 脚本窗口**依次输入：

```text
status
save
refresh
offline
online
```

进入编辑器后的 `status` 应显示 `editorReady: true`，记录 `formalLibraryOpened`；未开库执行 `save` 会提示 `DEVICE_OPEN_LIBRARY_BEFORE_SAVE`。成功还会记录 `formalLogin`、`syntheticSaveReadbackAndBoundaries`、`reloadReadback`、`simulatedOfflineRejected`。`save` 通过正式会话 RPC 保存固定合成行并读回，验证无 CSRF、跨库拒绝和公共管理入口的准确拒绝（404/`SECURITY_NOT_FOUND` 或 403/`SECURITY_SOURCE_DENIED`，其他错误不算通过）。它不等同完整画布业务验收；`refresh` 验证重载后会话和合成行读回。

`offline` 用当前隔离浏览器的 DevTools 网络仿真产生断网，网络请求必须失败；`online` 只恢复网络并检查会话，不自动补发写请求。这不等于拔网线或服务端断网测试。另可由操作者临时断开 B 的网络，观察失败再恢复，记录真实操作的结果；不要以误报成功或自动重试写入作为通过。

## 6. 停用、旧会话拒绝、新签名拒绝和重启

A 输入：

```text
disable <本次准确 credential UUID>
```

B **先不要刷新页面**，输入 `denied`，应看到原会话 `session: 401`、`context: 401`，记录旧会话立即失效。随后刷新页面，点击 Passkey 登录，由本人再次完成 Hello；页面应显示身份不可用。再输入 `denied`，这次报告事件的 `freshLoginIssue` 应为 true。

A 输入 `restart`，只关闭/重开该临时服务，必须输出成功，报告中 `disabledStateSurvivesRestart` 为 true。B 再尝试实际 Hello 登录并输入 `denied`，应仍为401且新鲜登录失败。两端事件顺序和准确凭据摘要需一起核对，单独一条401不能证明完整撤销链路。

还要验证独立进程重启：A 输入 `stop` 后，在同一普通 PowerShell 再运行第 3 节的 `Serve -DrillRoot $deviceRoot` 命令，保留新旧两份服务器报告。新报告的 `disabledCredentialsAtStartup` 应包含旧报告停用事件的同一个 `idSha256`。B 再尝试实际 Hello 登录并执行 `denied`，仍须拒绝。内置 `restart` 只是同进程关闭/重建服务，不能单独替代这一步。

## 7. 取消、设备丢失与恢复策略

实际取消一次浏览器的 Hello 提示：页面应给出取消/未完成反馈，不能出现登录成功。可在注册之前执行，再正常注册；不把此步骤记成生成了凭据。

演练设备丢失时只模拟“操作者不能再使用原凭据”，**不要真删除 Windows Hello 或重置 TPM**。A 停用准确凭据/用户，旧会话与新证明拒绝；新设备注册新申请后，由 A 在线下核验持有人再批准，不自动认领旧用户。若要保留同一用户并换钥，使用正式本机管理的换钥操作及准确修订，按[运行手册](device-registration-runtime-guide.md)执行，不能靠同名或IP继承。

恢复边界：普通数据备份保留停用/撤销；独立恢复包恢复数据但建立空访问台账，必须重新注册授权；WebAuthn 私钥不负责解密备份，旧交付包仍依赖对应的接收方历史私钥。D32 已验证合成恢复机制，**本工具没有执行真实双机恢复包导入**。最终验收须另外记录隔离恢复场景的实际执行或明确保留待验证，不能从 `Smoke` 自动推导通过。

## 8. 交回结果和结束

两边输入 `stop`，记录输出的文件位置。仅回传 A 的 `server-report-*.json`、B 的 `client-report.json`；另用文字说明 B 的 Windows 版本、实际选用 Hello PIN/指纹/人脸、注册与登录是否确实由本人完成、取消/实际断网/丢失恢复哪些步骤做过及结果。不要发送 PIN、口令、Cookie、私钥、挑战、证明、原始浏览器调试记录或整个目录。

报告的 `environmentSha256` 使用本轮 runId 与主机名散列，只辅助区分两个运行环境，不是可靠设备身份证明；同名设备可能相同，伪造主机名也不能被此字段阻止。Windows Hello 的实际使用需结合操作者确认，服务端 `attestation none` 无硬件证明。

D34 脚本始终保留 `taskComplete: false`，由交付审查结合两端报告、硬件人工确认和剩余恢复项目判断是否关闭 DR-P4.6。失败保留原报告/实例，修正后创建新的演练，不覆盖旧结果。退出码非0是失败；窗口仍在 Serve/Client 运行时尚无最终退出码。退出只关闭本次服务和新浏览器，临时目录留存便于核查，系统临时清理可能删除它。

## 9. 本机工具烟测与故障码

开发者可运行以下隔离烟测，不需要实际 Hello：

```powershell
node .\scripts\security-device-drill.mjs smoke
node --test --test-reporter=tap .\test\unit\security-device-drill.test.mjs
```

烟测启动全新回环TLS/DPAPI/Named Pipe、可见独立 Chrome，检查正式注册页面/安全上下文、匿名/公共管理拒绝、关闭及重启；不创建虚拟认证器，也不生成硬件通过声明。不加载本地 Vite/env、不覆盖旧 dist、不安装依赖。生成证书使用已锁定的传递依赖 `@peculiar/x509`。

| 提示                                                                 | 处理                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DEVICE_NON_ELEVATED_REQUIRED`                                       | 关闭管理员终端，在普通 PowerShell 重试。                                           |
| `DEVICE_SERVER_ADDRESS_NOT_ON_THIS_COMPUTER`                         | 用 A 实际网卡私网地址，不能照抄示例。                                              |
| `DEVICE_SOURCE_MISMATCH_SYNC_CODE`                                   | 两端同步全部本次源码；不要复制实例/密钥。重新准备演练。                            |
| `DEVICE_PIN_MISMATCH_OBTAIN_FROM_A_SEPARATELY`                       | 向 A 独立核对 pin，不绕过检查。                                                    |
| `DEVICE_TICKET_EXPIRED`                                              | 保留本轮，重新 Prepare，新生成 ticket 与 pin 一起核对。                            |
| `DEVICE_PREPARED_BYTES_CHANGED` / `DEVICE_GENERATED_CONFIG_REQUIRED` | 本轮现场变动，保留核查；不要修改摘要强行启动。                                     |
| `DEVICE_PAGE_UNAVAILABLE_CHECK_NETWORK`                              | 检查 A Serve、两端IP、隔离端口可达与网络策略；不关闭全局防火墙。                   |
| `DEVICE_SECURE_CONTEXT_REQUIRED`                                     | 停止；核对专用浏览器启动方式/组织策略，不降为HTTP。                                |
| `platformAuthenticatorAvailable: false`                              | 先设置Hello/检查浏览器策略；不能以软件签名替代验收。                               |
| `DEVICE_STEP_FAILED`                                                 | 本步骤未通过，报告保留；检查执行顺序、审批准确ID、页面状态及终端错误，不宣称通过。 |

命令行进度提示为开发演练工具的英文错误码，不是新增产品页面。正式页面沿用现有中英日翻译与布局；本轮无页面/可见翻译改造，不产生新的视觉验收结论。
