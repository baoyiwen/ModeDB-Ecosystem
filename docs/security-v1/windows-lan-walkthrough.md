# ModelDB 安全 V1 实操示例：从本机管理到局域网图谱设计

更新日期：2026-10-26。适用于当前源码构建的 Windows ModelDB Server、registry 安全模式和 Model Designer。

本文根据一次实际连接排查整理，供实例所有者和 Designer 使用者逐步操作。先通过本机受保护入口管理安全策略，再为局域网页面签发一次性配对码，最后验证能否打开图谱。文末单独记录这次操作实际验证到的范围；示例命令不表示已经替读者执行。

## 1. 示例地址与准备条件

| 项目                 | 本文示例                     | 用途                            |
| -------------------- | ---------------------------- | ------------------------------- |
| 数据库电脑 A         | `192.168.0.100`              | 运行数据库 API 和 Designer 页面 |
| 数据库 API           | `https://192.168.0.100:9091` | 接收配对、查询、管理及数据请求  |
| Designer 页面        | `https://192.168.0.100:5175` | 浏览器打开的图谱设计工具        |
| 本机安全管理页面地址 | `https://127.0.0.1:5175`     | 由本机启动器配对进入安全管理    |
| 本机数据库 API       | `https://127.0.0.1:9091`     | 本机管理会话连接的 Server       |
| 业务逻辑库           | `railway_domain_v1`          | 示例业务模型与数据              |
| Designer 专属逻辑库  | `model_designer_workspace`   | 图谱布局、接口及设计器元数据    |

请按自己的部署替换 IP、端口、目录和逻辑库名。`vault` 是逻辑库的父目录，不是应当填写到 grant 中的业务库名。

本文从 Server 与 Designer 均已启动开始。完整配置、证书生成与信任、前端 HTTPS 和启动步骤见[Windows 配置实例](windows-lan-config.md)。进入下文前确认：

- CLI、Server 和 Designer 使用匹配的构建；全局旧版 CLI 可能没有这些命令。
- API 与 Designer 均提供 HTTPS；证书覆盖实际访问的 IP/名称，客户端信任签发链。
- 配置为 `security.version: 1`；局域网使用 `security.network.transport.mode: "tls"`，或按正式部署配置可信代理。
- `publicBaseUrl` 对应 API：`https://192.168.0.100:9091`；`allowedOrigins` 包含页面 Origin：`https://192.168.0.100:5175`。
- 页面与 API 使用相同的 HTTPS 主机，本例只区分端口。不要混用 `localhost`、`127.0.0.1` 和局域网 IP。
- 本机 CLI 在数据库电脑 A 上，由启动实例的同一个 Windows 账号执行。使用普通 PowerShell，保持服务运行。

如果只想试用新库而不接触旧环境，可先使用[隔离 Designer 试用入口](release-guide.md#7-一条命令试用-model-designer)。它创建合成数据，不迁移原业务库。

## 2. 在 PowerShell 设置准确路径

下面使用源码项目中的绝对 CLI 路径，因此即使当前终端位于 `C:/Users/...` 也可以执行：

```powershell
$projectRoot = "C:/workspace/web_code/ModeDB-Ecosystem"
$serverCli = Join-Path $projectRoot "packages/server/dist/cli.js"
$serverConfig = Join-Path $projectRoot "modeldb.windows-lan.example.json"

Test-Path -LiteralPath $serverCli
Test-Path -LiteralPath $serverConfig
```

两项应返回 `True`。这是路径存在性检查，不代表配置或服务已验收。将 `$serverConfig` 改成启动该实例时实际使用的配置文件；新建实例推荐放在项目目录之外，已有实例保持原配置目录与安全材料的对应关系。

本机管理通道通过配置文件目录定位 `security/`。不要通过复制配置到另一个目录、改 Windows 账号或新建一套安全目录来处理原实例的连接问题。

常见的命令输入错误：

| 错误                                                          | 原因与处理                                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Cannot find module C:\Users\...\packages\server\dist\cli.js` | 相对路径基于终端当前目录；使用上面的绝对路径                                                              |
| `SECURITY_INVALID_REQUEST`                                    | 检查命令参数、必要文件、JSON 和变量拼写，例如误写 `$serverConfigf`                                        |
| `SECURITY_LOCAL_CHANNEL_UNAVAILABLE`                          | 核对实例是否运行、账号是否一致、配置目录是否准确；本机命令中的文件读取异常也可能被当前 CLI 汇总为这个错误 |

本机通道不可用时，还要检查 `--grants-file` 指定的文件是否存在并且可读。不要仅凭这个汇总错误就删除台账或重建身份。

## 3. 先进入本机安全管理

在数据库电脑 A 执行：

```powershell
node $serverCli security security-open `
  -c $serverConfig `
  --url "https://127.0.0.1:5175" `
  --server "https://127.0.0.1:9091"
```

CLI 正常输出包含 `opened: true`、页面 `origin` 和 `expiresAt`，并打开浏览器。这表示启动器已经签发邀请并发起打开页面，后续仍需浏览器完成配对。启动器不会在终端输出长期 Token。

如果页面停留在连接表单，按下表检查：

| 表单项目       | 填写值                                                  |
| -------------- | ------------------------------------------------------- |
| Host           | `https://127.0.0.1`                                     |
| Port           | `9091`                                                  |
| Authentication | `Browser session (recommended)`，即“浏览器会话（推荐）” |
| 一次性配对码   | 启动链接带入的码，通常显示为密码圆点                    |

当前源码已修复旧认证偏好问题：有效启动链接会自动将此前的 `Service credential (advanced)` 切换为 `Browser session`，不需要手动改选。若仍停留表单，确认使用新构建、页面 Origin 和服务器地址正确；配对码为空、过期或已经使用时，重新执行启动命令，用新页面重试。尚未更新的旧构建可先不刷新，在当前页改选 `Browser session`，再点击 `List databases & continue`。

配对成功后进入安全中心。`security-open` 签发的是安全管理会话，不自动授予业务库读写权限，因此不会直接进入模型画布。

## 4. 检查生效规则，允许局域网来源

### 4.1 配置文件与运行规则的区别

```powershell
node $serverCli security network-status -c $serverConfig
```

返回结构包含 `revision`、`config.data`、`config.management`、`config.rate`、`bans`，有待确认变更时还包含 `pending`。

如果两个 `allow` 中都只有 `127.0.0.0/8` 和 `::1/128`，实例当前只允许回环来源。即使浏览器就在数据库电脑上，通过 `192.168.0.100` 访问 API 仍会被拒绝。

Server 配置文件中的 `security.network.data` / `management` 用于初始化来源规则。实例已有保存的防护状态时，以台账中的规则为准；单改 JSON 并重启不会覆盖已保存的名单、限流和封禁。`network-status` 的输出是状态报告，直接编辑或重新粘贴它不会更新服务。

### 4.2 在安全中心添加规则

回到刚才的本机安全管理页面：

1. 左侧打开 `Network policy`（网络策略），滚动到可编辑的规则区域。
2. 在 `Data plane`（数据面）下保持 `Enable allow list` 勾选，在 `Allow rules`（允许规则）点击 `Add rule`。
3. 填写下面的规则；到期时间和原因可留空。
4. 在 `Management plane`（管理面）的 `Allow rules` 下也添加同样规则。

| 字段               | 填写值             |
| ------------------ | ------------------ |
| Rule ID            | `server-a`         |
| IPv4 / IPv6 / CIDR | `192.168.0.100/32` |

这条规则要分别放入两个入口的 `allow` 数组。保留已有回环规则、拒绝规则和限流值。`allowListEnabled: true` 才会限制为允许名单；`false` 表示关闭该入口的允许名单限制，不应把关闭开关当作修复步骤。

第三方电脑 B 访问时，需要再添加 **B 实际的来源 IP**，例如 B 为 `192.168.0.101` 时填写 `192.168.0.101/32`。添加 A 的地址只解决 A 自身通过局域网地址访问。Origin 填浏览器打开的页面地址，来源规则填发起请求的客户端 IP，两者不是一回事。

### 4.3 预览、应用和确认

按顺序点击：

1. `Preview current connections`（预览当前连接命中），核对已有连接的影响。
2. `Apply and await confirmation`（应用并等待确认）。
3. 在另一个标签访问 `https://192.168.0.100:9091/health`，或执行下面的检查。
4. 检查正常后，在应用后的 **120 秒内**回到本机安全管理页点击 `Verify and confirm`（重新验证并确认）。

```powershell
curl.exe -i "https://192.168.0.100:9091/health"
```

健康检查应返回 HTTP 200 和包含 `ok: true` 的 JSON。它验证传输与该路径的来源准入，不证明业务授权、开库或全部功能已通过。证书错误应处理信任链或 SAN，不使用关闭证书校验来制造成功结果。

未及时确认会自动回滚；需要撤回时可用页面的 `Rollback`（回滚）操作。之后重新运行 `network-status`，核对数据面、管理面都包含新规则，版本已更新且没有未确认的 `pending`。

如果界面不可用，使用[配置文档中的本机网络维护步骤](windows-lan-config.md)执行 `network-preview`、`network-apply`、`network-confirm`。`--rules-file` 接收 `{ data, management, rate }`，应从最新状态的 `config` 提取并保留完整限流字段，不能传入整份 Server 配置或完整状态报告。

## 5. 为图谱设计准备准确的双库权限

### 5.1 已有凭据时直接复用

```powershell
node $serverCli security credentials -c $serverConfig
```

选择有效、未撤销、同时授权以下两库的设计者凭据：

- `railway_domain_v1`：业务库。
- `model_designer_workspace`：设计器专属库。

本文所需操作为 `database.manage`、`schema.manage`、`model.read`、`model.write`，资源为 `*`，适用于受信任的模型设计者。只读应用应使用更小权限。

后续配对使用列表中的 **凭据 `id`**，不是 `principalId`。名称相同的多个 `remote-designer` 凭据可能有不同授权，必须核对 `grants`；授权 `vault` 不等于授权 `vault/` 下的所有逻辑库。

### 5.2 没有合适凭据时才创建

创建主体、凭据会改变访问台账，应由实例所有者按实际权限需要执行。已经有合适凭据时跳过本节。

在编辑器中把下面内容保存为 UTF-8 无 BOM 的 `C:/ModelDB-Access/designer-grants.json`；父目录需要存在。目录与库名可替换为自己的值：

```json
[
  {
    "database": "model_designer_workspace",
    "resource": "*",
    "actions": ["database.manage", "schema.manage", "model.read", "model.write"]
  },
  {
    "database": "railway_domain_v1",
    "resource": "*",
    "actions": ["database.manage", "schema.manage", "model.read", "model.write"]
  }
]
```

```powershell
node $serverCli security principal-create --name "remote-designer" -c $serverConfig
```

把上一步返回的主体 `id` 替换到 `<PRINCIPAL_ID>`。输出凭据文件必须尚不存在，`credentials` 目录首次由 CLI 建立，不提前创建宽权限目录：

```powershell
node $serverCli security token-create `
  --principal "<PRINCIPAL_ID>" `
  --name "remote-designer" `
  --days 30 `
  --grants-file "C:/ModelDB-Access/designer-grants.json" `
  --output "C:/ModelDB-Access/credentials/remote-designer.json" `
  -c $serverConfig

node $serverCli security credentials -c $serverConfig
```

`Credential delivered to protected file; it cannot be retrieved again.` 表示成功：长期凭据只交付到受保护文件，后续列表不返回原文。它不是错误，不需要为这个提示反复创建主体或凭据。浏览器连接使用下一节的短期配对码，无需把长期凭据文件交给浏览器使用者。

本例没有默认授予导入、导出、备份或发布接口调用权限。这些功能按[授权契约](../security-v1-authorization-contract.md)另行添加准确操作和资源范围。

## 6. 为局域网页面生成一次性配对码

在数据库电脑 A，用上一节核对的凭据 ID 替换 `<CREDENTIAL_ID>`：

```powershell
node $serverCli security session-pair `
  --id "<CREDENTIAL_ID>" `
  --origin "https://192.168.0.100:5175" `
  --minutes 10 `
  -c $serverConfig
```

返回的 `code` 是一次性配对码，`id` 是配对记录 ID，`expiresAt` 是 UTC 到期时间。通过可信渠道交给实际使用者；不把真实码、长期 Token 或私钥写入教程、截图、Git 和日志。

本例邀请 10 分钟有效，只能成功消费一次；过期、已使用或父凭据失效后应重新签发。配对码 `mdbp_v1_...` 与服务凭据 `mdbt_v1_...` 用途不同。

`--origin` 必须对应浏览器地址栏的页面 Origin：协议、主机、端口均一致。这里是 `5175`，不是数据库 API 的 `9091`；改成另一个页面地址需要为那个地址重新签发。`security-open` / `browser-open` 是本机启动器，不能把它们的回环地址参数直接换成 LAN 地址作为远程登录方法。

## 7. 打开局域网页面并进入图谱

访问 `https://192.168.0.100:5175/`，在连接页填写：

| 项目                  | 内容                                   |
| --------------------- | -------------------------------------- |
| Host                  | `https://192.168.0.100`                |
| Port                  | `9091`                                 |
| Authentication        | `Browser session (recommended)`        |
| One-time pairing code | 第 6 节生成的完整 `code`，仅填写码本身 |

Host 填数据库主机，浏览器地址栏填 Designer 页面地址，避免把两者混为一谈。当前 SDK 会用 Port 字段覆盖 Host URL 中的端口，所以 Host 意外带上 `5175` 不能单独证明失败原因；推荐统一按表填写。

点击 `List databases & continue`（列出库并继续）。正常流程是建立浏览器会话、列出授权库、打开设计器专属库，再选择业务库 `railway_domain_v1` 并打开图谱。缺失的库需要在明确授权范围内创建；本例不会把已有旧格式库自动重建。

浏览器会话通过 HttpOnly Cookie 保存，30 分钟有效、使用期间自动续期、最长 8 小时。成功配对后输入框清空是正常行为；已有会话可留空继续。`127.0.0.1` 与 `192.168.0.100` 不共用登录上下文，浏览器换电脑、换主机地址或换协议后需要重新建立对应会话。

| 入口                                     | 目的                                       | 配对成功后的界面             |
| ---------------------------------------- | ------------------------------------------ | ---------------------------- |
| 本机 `security-open`                     | 管理网络、凭据、会话、权限、审计和密钥状态 | 安全中心                     |
| 本机 `browser-open --databases <业务库>` | 在本机为明确库签发设计会话                 | 选择业务库并进入图谱         |
| `session-pair` + 局域网页面              | 基于现有凭据给指定页面配对                 | 在该凭据允许范围内选择业务库 |

管理会话不隐含业务库读写权限；进入安全中心不代表已经进入图谱设计。当前安全页可以展开“进入模型设计 / Open model design / モデル設計を開く”，查看本机启动或局域网邀请步骤。先断开管理会话，再按上表建立设计会话；语言切换和查看指引都不会自动授予业务库权限。

## 8. 语言设置

连接页顶部、安全中心侧栏都有“语言 / Language / 言語”选择，可直接选 English、中文、日本語，不必先打开图谱。进入图谱后，也可打开齿轮设置切换语言。语言保存在当前页面 Origin 的本地偏好中；同一地址刷新保留，换成另一个页面地址后需单独设置。

浏览器禁止写入本地存储时，本次页面仍可切换语言，刷新可能恢复原偏好。切换语言不会重新配对或增加权限。若仍看不到控件，请确认使用了包含本次修复的新构建；旧部署的缺口不能靠刷新旧产物修复。文末保留原部署排查记录，页面改造的隔离结果不代表旧业务库已经开图通过。

## 9. 出错时按返回证据定位

| 现象或错误                        | 含义与下一步                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SECURITY_INVALID_CONFIG`         | 检查 TLS 模式、证书/私钥路径、监听地址、Origin 和旧 Token 残留；仅填 HTTPS 公开地址不会开启 TLS                                                  |
| `ERR_CERT_*`                      | 处理证书信任、有效期和 SAN；第三方电脑也要信任签发链                                                                                             |
| `403 SECURITY_SOURCE_DENIED`      | 当前来源未通过有效名单或命中拒绝规则；检查 `network-status`，不要只看启动 JSON                                                                   |
| `CORS` / `Failed to fetch`        | 先检查浏览器 Network 的配对 `OPTIONS`。本次曾是来源检查在 CORS 前返回 403、缺少允许头造成；其他场景也可能是 TLS 或网络故障，不能只凭这行文字判断 |
| `SECURITY_ORIGIN_DENIED`          | 核对页面实际 Origin、配置和邀请 Origin                                                                                                           |
| `401 SECURITY_CREDENTIAL_INVALID` | 核对完整配对码、到期/重放/撤销及实际构建；当前源码的有效启动链接会自动覆盖旧 Token 模式                                                          |
| `403 SECURITY_FORBIDDEN`          | 核对凭据是否授权准确业务库和设计器库，以及所需操作                                                                                               |
| `409 VAULT_LEGACY_FORMAT`         | 已进入存储格式检查，发现旧 Vault；按下一节保留源环境，不能计为图谱验收成功                                                                       |
| API 根路径 `/` 返回 404           | 根路径不是健康检查接口，使用 `/health`；404 本身不能证明认证或业务库状态                                                                         |

Windows PowerShell 5.1 不支持 `Invoke-WebRequest -SkipHttpErrorCheck`。查看状态码和错误正文可使用系统中的 `curl.exe -i`；不使用 `curl` 别名替代，以免执行成 PowerShell 的另一个命令。

必要时做不携带配对码的 CORS 预检：

```powershell
curl.exe -i -X OPTIONS "https://192.168.0.100:9091/api/v1/security/pair" `
  -H "Origin: https://192.168.0.100:5175" `
  -H "Access-Control-Request-Method: POST" `
  -H "Access-Control-Request-Headers: content-type"
```

允许时应为成功状态，包含与请求页面一致的 `Access-Control-Allow-Origin`，以及 `Access-Control-Allow-Credentials: true`。预检成功仍不等于配对码或业务授权有效。少量检查后记录错误码、时间、路径及 `requestId`，在安全中心审计页查询网络/认证事件；不要反复刷错误请求。

## 10. 旧 Vault 格式拒绝该如何理解

`VAULT_LEGACY_FORMAT` 表示旧数据文件不能按当前新安全格式打开。新版有意拒绝自动覆盖或自动转换；更新 Server 程序不等于迁移 `atlas.mld`。

Designer 在选择业务库之前会打开 `model_designer_workspace`，所以此错误也可能来自设计器专属库，仅凭连接页截图不能确定具体文件。应根据服务端诊断与实际开库路径核对，保留原文件。

此时应记录“旧格式保护已触发，图谱业务验证受阻”。不要删除 `security/`、旧库或密钥来消除提示。后续有两条明确路径：

- 功能验证：在全新隔离目录与空闲端口运行独立实例，同时使用新格式业务库和 Designer 专属库。
- 保留旧数据：保留可运行的旧程序、配置与原始数据，另行验证适用于旧源格式的业务导出/导入方案，或按明确计划重建。当前 V1 不提供旧 Vault 自动转换命令。

旧库处理、真实升级和回退见[发布指南](release-guide.md)。新格式 Vault 不应交给旧程序写入。

## 11. 如何记录验收结果

| 验证层级        | 通过依据                                        | 不能据此推断                       |
| --------------- | ----------------------------------------------- | ---------------------------------- |
| 页面与 TLS      | 页面可打开、证书正常                            | API 已授权                         |
| 来源准入与 CORS | 健康检查正常、配对预检允许准确 Origin           | 配对码有效、允许操作业务库         |
| 身份配对        | 创建有效浏览器会话、可刷新恢复及注销            | 拥有所有数据库权限                 |
| 库授权与格式    | 准确双库可打开，越权库被拒绝                    | 模型数据、查询及导入导出已全部正确 |
| 图谱业务        | 合成库中实际开图、读取/编辑/持久化结果正确      | 旧库已迁移、生产容量已验收         |
| 审计与防护      | 记录可查、来源与结果准确，规则确认/回滚符合预期 | 上游防火墙丢弃请求也能被引擎记录   |

本次实际排查记录如下，未包含任何真实配对码、Token、凭据 ID、私钥或业务记录：

| 项目                                   | 本次证据与状态                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| LAN Designer 页面                      | 直接网络检查曾返回 200，用户可看到连接表单                                                       |
| API HTTPS                              | 在当前 Windows 账号系统信任环境中验证通过；不能把受限工具环境的 CA 缺失当作用户机器证书故障      |
| 初始网络规则                           | 读取状态为 revision 2，双入口仅允许回环；健康检查与配对预检实测返回 `403 SECURITY_SOURCE_DENIED` |
| 本机安全中心                           | 用户切换 Browser session 后确认成功进入                                                          |
| 局域网邀请                             | 用户提供签发成功输出，凭据授权两个准确逻辑库，Origin 对应 LAN 页面                               |
| 后续库打开                             | 用户回传 `VAULT_LEGACY_FORMAT`，已推进到存储格式检查；具体库文件及全部 HTTP 证据未单独核对       |
| 双库开图与业务回归                     | 受旧格式阻挡，尚未完成                                                                           |
| 第三方电脑连接、最终规则状态、审计核对 | 本次未完成独立验收                                                                               |
| 旧库迁移、正式发布及升级切换           | 未执行                                                                                           |

这份记录用于展示操作与排障方法。下一位使用者应填写自己的实际结果，不把本次用户截图或历史隔离测试当作自己的部署验收。

## 12. 相关文档

- [Windows 配置实例与逐字段说明](windows-lan-config.md)：首次配置、证书、Origin、网络维护 CLI。
- [安全 V1 使用手册](user-guide.md)：审计、防护、备份、恢复与资产交付。
- [浏览器会话说明](../security-browser-sessions.md)：Cookie、CSRF、续期、配对与注销。
- [授权契约](../security-v1-authorization-contract.md)：操作范围与资源授权。
- [发布与切换指南](release-guide.md)：隔离试用、旧格式处理和真实环境回退。
