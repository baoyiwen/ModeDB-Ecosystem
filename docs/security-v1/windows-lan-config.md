# Windows 本机与两台设备局域网配置实例

更新日期：2026-10-25。适用于 Windows 上的 ModelDB Server 安全 V1 和当前 Model Designer。本文提供可复制的配置及操作说明；示例 IP、目录和库名均为演示值。本轮只编写文档并检查隔离样例，不执行下文的证书安装、配置切换、授权或服务启动。

## 1. 先选连接方式

| 使用场景              | Server 监听地址          | 传输配置                                   | Designer 页面             |
| --------------------- | ------------------------ | ------------------------------------------ | ------------------------- |
| 只在同一台电脑使用    | `127.0.0.1`              | `loopback`                                 | 本机 HTTP 页面可用        |
| B 电脑访问 A 电脑     | `0.0.0.0` 或 A 的网卡 IP | `tls`，提供真实证书和私钥                  | 使用 HTTPS，与 API 同站点 |
| 已部署 HTTPS 反向代理 | 通常 `127.0.0.1`         | `proxy`，配置准确可信代理和 HTTPS 公开地址 | 由代理提供 HTTPS 页面     |

默认模式是 `loopback`。只把 `host` 改成 `0.0.0.0` 会触发 `SECURITY_INVALID_CONFIG`，因为它让默认的本机传输与远程监听冲突。`publicBaseUrl` 写成 HTTPS 不会自动安装证书或启用 TLS，`dev: true` 也不会取消安全校验。

下载以下 JSON 后再编辑，不需要把 Markdown 中的说明复制进 JSON；JSON 不接受注释：

- [本机最小配置](examples/modeldb.loopback.example.json)
- [两台 Windows 原生 TLS 配置](examples/modeldb.windows-lan.example.json)
- [B 端 Designer 授权示例](examples/designer.windows-lan.grants.example.json)

常规字段、默认路径、legacy 兼容和反向代理配置见[完整配置指南](../modeldb-config-guide.md)。registry 不使用旧 `connectToken`，不能把旧 Token 填进新配置来获得权限。

已经启动服务、准备实际连接时，可按[安全检查实操示例](windows-lan-walkthrough.md)逐步操作。该文使用 `192.168.0.100`、API `9091` 与页面 `5175`，包含本机安全管理、中英文规则按钮、局域网配对、旧 Vault 拒绝及本次实际验证边界；不要混用两份示例的 IP 和端口。

两台电脑的操作顺序是：确认 A/B 地址和实例目录 → 准备证书并建立信任 → 保存 Server 配置 → 为 Designer 提供 HTTPS → 检查有效来源规则 → 签发配对邀请。第 3 节是仅供本机使用的另一套示例；局域网场景从第 4 节继续，不要混用两套地址。

## 2. 本文的设备、地址和目录

| 项目                            | 示例值                     | 应替换为什么                                 |
| ------------------------------- | -------------------------- | -------------------------------------------- |
| A：运行 Server 和 Designer 页面 | `192.168.1.10`             | A 的局域网 IPv4 地址                         |
| B：打开浏览器                   | `192.168.1.20`             | B 的局域网 IPv4 地址                         |
| API 端口                        | `9443`                     | 新实例使用的空闲端口；本文避免复用原服务端口 |
| Designer 页面端口               | `5175`                     | 实际 HTTPS 页面端口                          |
| 示例实例根                      | `C:/ModeDB-Lab/lan-a`      | 新建的专用实例目录                           |
| 示例业务库                      | `business`                 | 实际逻辑库唯一名，不是磁盘路径或显示名       |
| Designer 专属库                 | `model_designer_workspace` | 通常保持默认；修改时还须匹配前端构建配置     |

在各自电脑用 `ipconfig` 查看局域网网卡；不要选 VPN、虚拟机或断开的网卡。IP 会变时，应先固定 DHCP 租约或使用可解析的固定名称，再同步调整证书、地址和名单。

`0.0.0.0` 是监听设置，不能作为 B 的连接地址。B 访问的是 A：

```text
Designer 页面：https://192.168.1.10:5175
数据库 API：https://192.168.1.10:9443
```

B 不需要复制 A 的业务库、`security/`、台账、密钥或整个实例目录；只使用浏览器时也不需要运行第二个 Server。

推荐把新实例放在 Git 工作区之外：

```text
C:/ModeDB-Lab/lan-a/
  modeldb.config.json
  certs/
    server.crt
    server.key
  vault/          服务使用的逻辑库父目录
  logs/           运行日志
  cache/          缓存
  security/       首次启动由服务创建，不要提前手建或从 Git 复制
```

证书文件放 `certs/`，不要把子目录放进要求平铺的 `security/`。`server.key` 是私钥，应限制访问且不进入 Git。新实例由普通 Windows 账号运行，之后仍使用同一账号；DPAPI 密钥不能通过换账号或复制文件夹自动迁移。

如果你继续使用原业务实例，保留原配置所在目录、`workspace`、密钥与台账的对应关系，只合并经确认的网络字段。把原配置复制到新目录会改变 `security/` 的定位；只改配置文件名但留在同一目录，又会共用原 `security/`。本文的新实例示例不是旧业务数据迁移步骤。

## 3. 本机最小配置

[本机示例文件](examples/modeldb.loopback.example.json)使用 `127.0.0.1:9090` 和 HTTP，省略的来源名单默认只允许回环来源。可在专用新目录保存为 `modeldb.config.json`。

启动 Server 和 Designer 开发页后，从 A 的另一个普通终端运行本机启动器；每条命令都要使用实际配置路径：

```powershell
pnpm.cmd run start:server --config "C:\ModeDB-Lab\local-a\modeldb.config.json"
```

```powershell
pnpm.cmd run dev:model-designer
```

```powershell
node .\packages\server\dist\cli.js security browser-open -c "C:\ModeDB-Lab\local-a\modeldb.config.json" --url "http://127.0.0.1:5175" --server "http://127.0.0.1:9090" --databases business
```

这三条命令需要不同终端保留服务运行，均从项目根执行。启动器只打开本机浏览器并签发一次性配对；它不是远程浏览器控制工具，也不自动创建业务库。如果 `business` 尚不存在，可在已授权范围内由 Designer 显式创建。

要快速试用合成库，也可以使用[一条命令隔离试用](release-guide.md#7-一条命令试用-model-designer)。

## 4. A 端局域网 Server 配置及字段解释

把[完整 TLS 示例](examples/modeldb.windows-lan.example.json)另存到新实例目录，替换 `192.168.1.10`、`192.168.1.20` 和 `business`。该文件包含网络、审计、日志和关闭状态的自动备份；不要直接覆盖原实例整份配置。

### 4.1 常规字段

| 字段                | 示例                        | 实际含义                                                                                |
| ------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `host`              | `0.0.0.0`                   | 监听所有 IPv4 网卡；也可只绑定 A 的局域网 IP。它不授予访问权限                          |
| `port`              | `9443`                      | Server 端口，与页面的 `5175` 不同                                                       |
| `advertisedHost`    | `192.168.1.10`              | 优先展示给客户端的主机提示，不改变监听或证书                                            |
| `publicBaseUrl`     | `https://192.168.1.10:9443` | API 的准确公开 Origin，包含协议和非默认端口；不填页面端口，不带业务路径、查询参数或凭据 |
| `workspace`         | `vault`                     | 所有业务逻辑库的父目录；相对配置文件目录解析，不相对源码目录                            |
| `logDir`            | `logs`                      | 运行日志目录，同样相对配置文件目录解析；安全审计另存于加密台账                          |
| `bufferThreshold`   | `100`                       | 写缓冲刷盘行数阈值，不是限流或权限开关；省略时使用现有默认行为                          |
| `cacheSize`         | `1GB`                       | 当前仅是预留提示，不限制实际内存或缓存目录大小                                          |
| `mode`              | `production`                | 开启现有访问日志；不是安全模式选择器                                                    |
| `dev`               | `false`                     | 开发诊断标志，常规使用保持关闭；不能绕过 TLS 或授权                                     |
| `designerWorkspace` | `model_designer_workspace`  | Designer 元数据专属逻辑库，与 `business` 分开                                           |

`storageRoot`、`dbPath` 是 `workspace` 的兼容别名，一般只写 `workspace`，不要同时填多个不同的值。Windows JSON 路径可用 `C:/...`，若用反斜杠则要写 `C:\\...`。

同一字段通常按 CLI → 文件 → 环境变量 → 默认值解析。`workspace`、日志等路径遵循各字段专门规则，详见完整指南；启动时额外传入 `--host` / `--port` 会覆盖文件对应值。`MODEL_DB_CONNECT_TOKEN` 残留非空值也会与 registry 模式冲突，不能通过添加旧 Token 解决。

### 4.2 TLS、Origin 与 IP 名单

下表中的 `network` 位于 `security.network` 下，证书路径位于 `security.network.transport` 下。

| 字段                     | 示例                        | 实际含义                                                                                    |
| ------------------------ | --------------------------- | ------------------------------------------------------------------------------------------- |
| `security.version`       | `1`                         | 启用安全 V1 registry，凭据与数据密钥独立管理                                                |
| `network.transport.mode` | `tls`                       | Server 原生提供 HTTPS/WSS，远程客户端不能使用明文 HTTP                                      |
| `certificateFile`        | `certs/server.crt`          | PEM 服务端证书或证书链，相对配置文件目录解析                                                |
| `privateKeyFile`         | `certs/server.key`          | 与证书匹配、当前实现可直接加载的 PEM 私钥；不能把 PFX 文件改名代替                          |
| `allowedOrigins`         | `https://192.168.1.10:5175` | 浏览器地址栏中页面的 Origin；是 A 托管页面的地址，不是 B 的 IP，也不是 API 地址             |
| `data`                   | 四条精确 IP 来源            | 数据查询、写入等入口的来源名单                                                              |
| `management`             | 四条精确 IP 来源            | 列库、catalog、建库等管理 API 的来源名单；Designer 通常也需要，放行不等于授予安全管理员身份 |
| `allowListEnabled`       | `true`                      | 只允许 `allow` 中的有效来源；开启但列表为空时全部拒绝                                       |
| `allow[].id`             | `designer-b`                | 规则唯一标识；同一入口的 `allow` 和 `deny` 内不能重复                                       |
| `allow[].source`         | `192.168.1.20/32`           | 一台精确 IPv4 客户端；`/32` 不代表整个网段                                                  |
| `deny`                   | `[]`                        | 黑名单，匹配时优先于白名单；条目也使用 `id`、`source`，可带 `expiresAt`                     |

示例保留 IPv4/IPv6 回环来源，同时允许 A 自身的局域网 IP 与 B 的 IP。若要放行整个局域网，可把精确地址改为经确认的 CIDR，例如 `192.168.1.0/24`；这会扩大网络准入范围，仍需要身份和库授权。Origin 不支持 `*` 或带路径的地址。

**静态配置与已保存规则的区别：** `transport`、证书、Origin 等来自启动配置。`data` / `management` 在首次初始化防护状态时作为初始来源规则；实例一旦已有保存的防护状态，服务使用台账中的规则，单改 JSON 并重启不会覆盖已有名单、限流或封禁。不要删除台账强制套用配置。

已有实例先由 A 的原运行账号查看有效规则：

```powershell
node .\packages\server\dist\cli.js security network-status -c "C:\ModeDB-Lab\lan-a\modeldb.config.json"
```

需要调整时使用安全中心的网络规则预览、应用、确认和回滚，或[手册中的本机网络维护命令](user-guide.md#2-网络与审计维护)。规则文件是 `{ data, management, rate }`，不是整份 Server 配置；保留当前有效限流字段，再修改来源规则。JSON 名单正确却仍报来源拒绝时，应优先检查有效规则。

已有实例需要本机 CLI 修复时，先从 `network-status` 返回值中取出 `config` 对象，保留其 `data`、`management` 和全部 `rate` 字段，在编辑器另存为 UTF-8 无 BOM 的 `C:/ModeDB-Lab/lan-a/lan-network.rules.json`；只修改经确认的来源规则。不要把完整状态对象或 `security.network` 直接当规则文件。A 保持服务运行，由原运行账号执行预览：

```powershell
node .\packages\server\dist\cli.js security network-preview --rules-file "C:\ModeDB-Lab\lan-a\lan-network.rules.json" -c "C:\ModeDB-Lab\lan-a\modeldb.config.json"
```

检查返回的连接影响，在预览有效期内用返回的 `revision` 和 `id` 替换下面的占位符；预览后不要再编辑规则文件：

```powershell
node .\packages\server\dist\cli.js security network-apply --rules-file "C:\ModeDB-Lab\lan-a\lan-network.rules.json" --revision "<PREVIEW_REVISION>" --preview "<PREVIEW_ID>" -c "C:\ModeDB-Lab\lan-a\modeldb.config.json"
```

应用后在 120 秒内检查 B 的连接结果；确认保留时，将应用结果中的 `pending.id` 填入：

```powershell
node .\packages\server\dist\cli.js security network-confirm --id "<PENDING_ID>" -c "C:\ModeDB-Lab\lan-a\modeldb.config.json"
```

未确认会自动回滚。如需立即撤回，先重新执行 `network-status`，使用此时最新的 `revision`，不是预览前的旧版本：

```powershell
node .\packages\server\dist\cli.js security network-rollback --revision "<CURRENT_REVISION>" -c "C:\ModeDB-Lab\lan-a\modeldb.config.json"
```

出现 `SECURITY_POLICY_CONFLICT` 时重新读取状态并预览，不复用旧 ID；已有临时封禁时，还需核对 `bans` 并按实际封禁 ID 使用 `network-unban`。限流、封禁属于运行防护规则，不要自行把 `rate` 或 `bans` 填入 Server JSON。

### 4.3 审计与自动备份

| 字段                           | 示例           | 实际含义                                                                           |
| ------------------------------ | -------------- | ---------------------------------------------------------------------------------- |
| `security.audit.retentionDays` | `365`          | 安全审计保留天数，允许 `1`–`3650`                                                  |
| `security.audit.maxEvents`     | `10000`        | 台账审计行数上限，配置允许 `100`–`50000`；达到容量仍拒绝需要审计的操作，不静默丢弃 |
| `autoBackup.enabled`           | `false`        | 示例默认不启动定时备份；改成 `true` 后才生效                                       |
| `autoBackup.intervalMs`        | `3600000`      | 每小时；最小 `60000` 毫秒。也可用 `intervalMinutes`，两者都有时毫秒值优先          |
| `autoBackup.runOnStart`        | `false`        | 启用调度后是否在启动时立即备份                                                     |
| `autoBackup.reason`            | `scheduled`    | 备份文件的原因标签                                                                 |
| `autoBackup.databases`         | `["business"]` | 自动备份库名白名单；空列表或省略表示全部库                                         |

备份位于解析后的 `<workspace>/modeldb/backups/`。自动备份不是独立灾备；丢失密钥后还需要覆盖相应历史密钥的恢复材料。首次启用前核对容量、库名和恢复验证，详见[备份与恢复手册](user-guide.md#3-创建和恢复日常备份)。

## 5. 证书准备与两台 Windows 的信任

证书准备完成前不要启动此 TLS 示例。证书需要包含 A 的实际地址作为 SAN；使用 IP 访问时，要有该 IP 的 SAN，只有 `localhost` 或其他域名的证书不够。A 和 B 的浏览器都必须信任签发链。

有组织内部 CA 时，使用其签发的服务端证书与对应 PEM 私钥。开发演练也可以使用已经安装的 [mkcert](https://github.com/FiloSottile/mkcert)；以下命令仅供操作者在明确选择测试目录后执行，本文没有替你安装工具或证书。

在 A 的终端执行；目录须是新建或已确认的示例目录，已有证书时不要覆盖：

```powershell
New-Item -ItemType Directory -Path "C:\ModeDB-Lab\lan-a\certs" -ErrorAction Stop
mkcert -install
mkcert -cert-file "C:\ModeDB-Lab\lan-a\certs\server.crt" -key-file "C:\ModeDB-Lab\lan-a\certs\server.key" 192.168.1.10 localhost 127.0.0.1 ::1
mkcert -CAROOT
```

`mkcert -install` 可能提示系统信任安装权限；完成后，运行 Server 仍使用普通终端。把最后输出目录中的 **`rootCA.pem` 公共证书**通过可信方式交给 B，核对 SHA-256 后，在 B 当前浏览器所属的普通用户终端导入信任：

```powershell
certutil.exe -hashfile "D:\Transfer\rootCA.pem" SHA256
certutil.exe -user -addstore Root "D:\Transfer\rootCA.pem"
```

A 也对原公共证书运行 `certutil.exe -hashfile` 并与 B 比较。不要向 B 传 `rootCA-key.pem`、`server.key`、业务数据密钥或凭据文件。不要在 B 重新生成另一套 CA 后认为它会信任 A。若浏览器使用独立信任库，按该浏览器的证书管理方式导入；不要依赖点击忽略错误或关闭证书验证。

## 6. Designer 页面也要提供 HTTPS

当前仓库的 `pnpm run dev:model-designer` 默认是 HTTP；给 API 配好 TLS 不会把它自动变成 HTTPS。

如果已有 HTTPS 静态站点或反向代理，可运行 `pnpm.cmd run build:model-designer`，把 `apps/model-designer/dist/` 交给站点托管，并把 `allowedOrigins` 与邀请 Origin 改成真实页面地址。前端和 API 要同站点；本文使用同一个 A 的 IP、同样的 HTTPS 协议，端口不同仍可配合 Cookie 使用。

用于开发演练时，可以参考下面的 Vite 配置片段。在 `apps/model-designer/vite.config.ts` 顶部增加：

```typescript
import { readFileSync } from 'node:fs';
```

保留原有插件与 alias，把现有 `server` 块替换为：

```typescript
server: {
  host: '0.0.0.0',
  port: 5175,
  strictPort: true,
  https: {
    cert: readFileSync('C:/ModeDB-Lab/lan-a/certs/server.crt'),
    key: readFileSync('C:/ModeDB-Lab/lan-a/certs/server.key'),
  },
},
```

这是一段需要合并进配置对象的片段，不是单独运行的 TypeScript 文件；路径也要按实际替换。它只在 A 读取私钥，不向浏览器提供私钥内容。此文未修改项目 Vite 配置；采用该开发示例后，原本机 HTTP 启动流程也会改为 HTTPS，需同步调整本机启动器地址。开发服务仅用于受控演练，长期部署采用构建后的静态页面和正式 HTTPS 托管。

从 A 的项目根目录分别开两个普通终端：

```powershell
pnpm.cmd run start:server --config "C:\ModeDB-Lab\lan-a\modeldb.config.json"
```

```powershell
pnpm.cmd run dev:model-designer
```

启动前确认端口空闲，防火墙只对需要的客户端和网络配置文件开放实际端口，不必关闭整个 Windows 防火墙。B 可以先检查 TCP 可达性：

```powershell
Test-NetConnection 192.168.1.10 -Port 9443
Test-NetConnection 192.168.1.10 -Port 5175
```

这只检查 TCP，不能证明证书、来源规则或登录授权通过。B 打开 `https://192.168.1.10:5175` 应能正常显示页面且没有证书错误；不要打开 `https://0.0.0.0:5175` 或 B 自己的 `localhost`。

## 7. 为 B 配对并授权两个逻辑库

网络名单只是网络准入。Designer 要分别访问业务库和元数据专属库，需两份 grant；单独授权 `business` 仍可能在打开画布时失败。

审核[授权示例](examples/designer.windows-lan.grants.example.json)，把 `business` 替换为实际业务库唯一名。该示例允许对两个明确库名建库、改 schema、读写数据，适用于受信任的设计者，具有修改能力；不要直接发给只查询数据的用户。备份、传输及已发布接口调用没有包含在此示例中，需要时按[授权矩阵](../security-v1-authorization-contract.md#授权矩阵与范围)追加具体能力；调用发布接口还需要准确名称与完整发布摘要。

将授权文件放在已确认的外部目录，例如 `C:/ModeDB-Lab/lan-a/b-designer-grants.json`。A 保持 Server 和页面运行，从项目根目录的另一个普通终端按顺序执行：

```powershell
node .\packages\server\dist\cli.js security principal-create --name b-designer -c "C:\ModeDB-Lab\lan-a\modeldb.config.json"
```

复制输出中的主体 `id`，替换下面的 `<PRINCIPAL_ID>`。`credentials` 子目录让 CLI 首次创建，不要提前用继承宽权限的目录代替；输出文件必须尚不存在：

```powershell
node .\packages\server\dist\cli.js security token-create --principal "<PRINCIPAL_ID>" --name b-designer --days 30 --grants-file "C:\ModeDB-Lab\lan-a\b-designer-grants.json" --output "C:\ModeDB-Lab\lan-a\credentials\b-designer.json" -c "C:\ModeDB-Lab\lan-a\modeldb.config.json"
node .\packages\server\dist\cli.js security credentials -c "C:\ModeDB-Lab\lan-a\modeldb.config.json"
```

长期 Token 只交付到 A 的受保护文件，列表不会返回原文。根据名称选择凭据列表中的凭据 `id`，不是主体 ID；然后签发一次性邀请：

```powershell
node .\packages\server\dist\cli.js security session-pair --id "<CREDENTIAL_ID>" --origin "https://192.168.1.10:5175" --minutes 10 -c "C:\ModeDB-Lab\lan-a\modeldb.config.json"
```

只将这次短期 `code` 通过可信渠道交给 B，不交付长期 Token 文件。B 在刚才的 HTTPS Designer 页面选择“浏览器会话”，填写：

| 页面项目 | 填写值                                              |
| -------- | --------------------------------------------------- |
| 主机     | `https://192.168.1.10`，保留 `https://`             |
| 端口     | `9443`，填 Server 端口                              |
| 配对码   | A 刚生成的一次性 `code`                             |
| 业务库   | 连接后选择实际的 `business`，或在授权范围内显式创建 |

`--origin` 必须与 B 地址栏的页面 Origin 完全一致；`5175` 是页面端口，不能错填成 API 的 `9443`。邀请默认示例有效 10 分钟、只能消费一次；失效后重新签发。身份、来源和库授权都通过后才可进入画布；短期会话支持刷新恢复与注销，见[浏览器会话说明](../security-browser-sessions.md)。

## 8. 常见错误对照

| 现象或错误                                                          | 应检查的内容                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 改 `host` 后启动即 `SECURITY_INVALID_CONFIG`                        | 是否仍是默认 `loopback`；是否配置真实 TLS、有效 Origin、正确证书路径；仅填 HTTPS 公开地址不足以启用 TLS      |
| TLS 模式仍 `SECURITY_INVALID_CONFIG`                                | 证书与私钥是否可读、PEM 格式是否正确；`publicBaseUrl` 是否 HTTPS；来源 CIDR 与规则 ID 是否合法               |
| `SECURITY_INVALID_CONFIG: registry mode rejects legacy credentials` | 文件、CLI、环境变量是否仍提供非空旧 Token                                                                    |
| `SECURITY_STORE_INVALID` / `VAULT_PROTECTION_UNAVAILABLE`           | 原运行账号、目录所有者、owner/SYSTEM 权限、继承情况及材料完整性；保留现场，不删除 `security/` 或重新生成密钥 |
| 页面证书错误 / `ERR_CERT_*`                                         | 是否信任 A 的签发 CA；证书 SAN 是否覆盖地址栏中的实际 IP/名称；证书是否过期                                  |
| HTTPS API 能访问但 Designer 连不上                                  | 页面是否也 HTTPS、是否同站点、是否混用了 `localhost` 与 IP、主机字段是否保留协议                             |
| `SECURITY_SOURCE_DENIED`                                            | B 实际 IP 是否匹配有效的数据面和管理面名单；已有实例检查台账生效规则，不只看 JSON                            |
| `SECURITY_ORIGIN_DENIED`                                            | 页面实际 Origin 是否与配置/邀请完全一致，协议和端口也要一致                                                  |
| `SECURITY_TLS_REQUIRED`                                             | 客户端是否仍用明文 HTTP/WS                                                                                   |
| `SECURITY_CREDENTIAL_INVALID` / `EXPIRED` / `REVOKED`               | 邀请是否超时、重放或父凭据已失效；重发准确 Origin 的邀请                                                     |
| `SECURITY_FORBIDDEN`                                                | 是否同时授权正确业务库和 Designer 专属库；库名、操作 action、发布接口摘要是否匹配                            |
| 端口不通                                                            | A 的监听网卡、进程、端口冲突、Windows 防火墙与网络隔离；TCP 成功后仍须检查 TLS/授权                          |

配置完成后先在新实例验证页面、配对、打开库、刷新、注销和无授权拒绝。原业务切换、备份核对和回退按[发布指南](release-guide.md#4-真实切换执行清单)另行执行，不能把本文示例或一次网络连通当作原业务迁移已完成。
