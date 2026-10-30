# 浏览器安全连接（SEC-M4 / S4.2）

Model Designer、Data Studio 和 Web 默认采用短期浏览器会话。服务凭证仍可在高级模式下输入，但只保存在当前页面内存中。认证 Cookie 为 HttpOnly、SameSite=Strict；HTTPS 下另带 Secure。CSRF proof 绑定实际 session，由服务端返回，只保存在 SDK 内存中。

应用后端、curl 与 Postman 使用独立限权 Bearer 凭据，见[发布查询接口的标准调用](security-http-invocation.md)。不要把配对码当成服务 Token。

DR-P2.1 增加显式的 API 凭据、公钥登记和本机管理三类会话父级及 V3 内部迁移模型；普通启动不升级到 V3，现有配对操作继续可用。本机管理父记录不能再通过普通 API 凭据轮换或邀请入口变成数据身份。DR-P2.2 / D19 已新增默认关闭的公钥登录后端/SDK；显式启用与许可后迁移到 V4，普通 open 不迁移。不能把登记 ID 当 Token；兼容与回退边界见[会话父级契约](security-v1/device-registration-protocol-contract.md#12-dr-p21-会话父级与持久兼容模型)。

## 本机开发与默认连接

启动 registry 模式的引擎和所需前端后，在引擎所在 Windows 账号下运行：

```powershell
modeldb-server security browser-open --url http://127.0.0.1:5175/
```

如果启动引擎时指定了配置文件，启动器也必须使用同一个配置文件：

```powershell
modeldb-server security browser-open -c C:/path/to/modeldb.config.json --url http://127.0.0.1:5175/
```

把 `--url` 换为 Data Studio 或 Web 的实际前端地址即可。该命令不启动前端开发服务；它通过 Windows 命名管道验证当前 OS 身份，签发 5 分钟一次性配对码，然后打开页面。普通 HTTP 请求不能调用此授权入口。无需在配置中填写 connectToken，也无需事先创建可复用服务 Token。

启动器将当前已有逻辑库和设计器专属库明确列入本次 8 小时访问范围。新增库名可在启动时声明，例如 `--databases new_graph,another_graph`；没有声明的新库名仍然返回权限不足。此范围不包含安全管理、凭据维护或任意未授权发布接口。

前端与 API 必须使用相同协议和本机主机名：例如都使用 `127.0.0.1`，不要一边用 `localhost`、另一边用 `127.0.0.1`。端口可以不同。引擎使用 HTTPS 时，需要相应的 HTTPS 前端，并可通过 `--server https://127.0.0.1:9443` 明确服务地址。证书必须被浏览器信任。

一次性码放在 URL fragment 中，前端加载后立即清除并交换会话；不放在 query string 中，也不保存到 Web Storage。Cookie 名按前端 Origin 和 API 地址隔离，同时打开多个工具不会互相覆盖。

有效启动链接会优先于该页面地址此前保存的服务 Token 模式，自动选择浏览器会话；Model Designer 的业务入口和安全中心入口、Data Studio、Web 均适用。即使浏览器禁止写入本地存储，本次页面仍采用浏览器会话。清除内存中的启动码后不会退回旧模式；用户之后仍可主动切换认证方式。格式无效或包含远程 HTTP 地址的链接不会改变原有模式，也不会获得身份；配对码是否到期、已使用或具有权限始终由服务端判断。

## 远程邀请与手动配对

远程部署使用 HTTPS，并把数据面、管理面的来源名单配置为实际客户端网段。浏览器前端与 API 采用同站点部署，例如 `https://designer.example.com` 与 `https://db.example.com`，或通过同域反向代理统一部署。跨站点第三方 Cookie 部署不在本阶段支持范围内，不能通过放宽 SameSite 来绕过浏览器限制。

管理员先通过本机安全 CLI 创建具有指定库权限的凭据（Designer 还需要设计器专属库的独立权限），然后签发邀请：

```powershell
modeldb-server security session-pair -c C:/path/to/modeldb.config.json --id <credential-id> --origin https://designer.example.com --minutes 10
```

该命令仅交付一次性的 `code`、ID 和到期时间，不交付原服务凭证。用户在对应前端选择“浏览器会话”，填写 HTTPS 主机、端口和配对码，再连接。`--origin` 必须与页面实际 Origin 完全一致，包括非默认端口；码到期、被复用、来源不符或父凭据失效都会拒绝。

可信管道签发的有效邀请会临时允许这个精确 Origin 进行 CORS 配对和会话访问，仍需通过 TLS、代理链和 IP 来源名单。邀请用完后由对应有效会话继续维持该 Origin；撤销或到期后不再临时放行。配置中的 `allowedOrigins` 仍是独立的固定允许来源。

## 会话行为

- 单次有效期 30 分钟，最长 8 小时，且不会超过父凭据有效期。
- 页面恢复时从 HttpOnly Cookie 获取会话信息及新的内存 CSRF proof；JavaScript 无法读取认证 Cookie。
- SDK 在请求前检查并按需续期；可见页面近期有键盘或鼠标活动时，也会检查续期。隐藏或空闲页面不持续续期。
- 续期轮换 session，旧 session 及其 WS 随即失效。三个前端默认使用短 HTTP 会话，显式 WS 调用者在轮换后需重新连接。
- 注销撤销服务端 session 并清除对应 Cookie。CSRF 校验失败不会清除 Cookie，也不会假装已经注销。
- 配对、轮换、注销记录到安全台账；父凭据撤销或访问重置会使会话失效，不改变业务数据密钥。

安全中心中的会话列表、可视化邀请与维护属于 SEC-M5。发布接口的完整地址、标准 HTTP/Postman 示例和最终调用反馈属于 S4.3。

Designer 的连接页和安全中心可直接选择 English、中文、日本語。安全中心的“进入模型设计”指引提供本机 `browser-open` 与远程邀请步骤；先断开管理会话，再以独立授权建立设计会话，不能用管理员身份隐含访问业务库。语言切换和查看指引不签发新权限。操作见[手册 §1.1](security-v1/user-guide.md#11-页面语言与进入模型设计)。

## 复验

先构建 SDK、server 和三个前端，再运行：

```powershell
.\node_modules\.bin\tsx.cmd --test test/unit/security-browser-session.test.ts test/unit/security-authorization.test.ts test/unit/browser-connection-credentials.test.ts test/unit/security-network.test.ts test/unit/security-registry-http.test.ts
.\node_modules\.bin\tsx.cmd --test test/integration/security-browser-apps.test.ts
```

浏览器验收使用临时 registry、随机端口、真实 Windows 管道和 Chrome headless。可通过 `MODELDB_TEST_BROWSER` 指定 Chrome/Edge 可执行文件；缺少 Windows 或浏览器时测试会跳过，跳过不能登记为浏览器验收通过。

DR-P2.3 / D20 已补齐公钥会话的 HTTP/RPC/WS 动态授权、按凭据通知与用户反向索引、空闲连接到期和排队执行前检查；发布接口及绑定子接口逐项复查。禁用/停用与既有会话撤销同事务提交，重新启用不复活旧会话。D21 已交付 DR-P2.4 正式本机维护 CLI、换钥和登记用户管理；管理页面留待 DR-P3。 WebSocket 在服务器期限到达时主动复查并关闭，在有效父级的权限变化时要求重新握手；仅另一会话注销或轮换不会误关仍有效的同父级流。已提交写入与网络响应分别看待，不能以断开推断回滚。见[动态连接手册](security-v1/device-registration-runtime-guide.md#9-动态授权与连接失效dr-p23)。

DR-P2.4 / D21：本机 CLI 已支持登记凭据/用户分页、禁用/启用、终态撤销、明确减权及原子换钥。换钥保存显式新授权并撤销旧身份和会话，新公钥仍须签名登录；丢失凭据先撤销，再注册并核验重新审批。同主体 API 身份单独维护，启用不复活旧 Cookie；不改变数据密钥。步骤和错误核查见[本机维护手册](security-v1/device-registration-runtime-guide.md#10-本机用户与凭据维护dr-p24)。本次无页面/翻译改造。

DR-P2.5 / D22：排队和验签中的证明在凭据/用户一度停用后持续失效，立即重新启用也须新挑战；单纯减权按提交时最新授权生效。登录/认领、刷新/注销、维护及 V2→V4 迁移已补真实进程退出恢复矩阵，旧 Token/配对与本机管理身份保持独立。结果未知先核查列表/审计，有 Cookie 先恢复，无 Cookie 重新登录，不重放旧证明。契约与验证边界见[第 16 节](security-v1/device-registration-protocol-contract.md#16-dr-p25-故障与在途证明边界)。原配置、V4、write gate 和数据密钥层级不变。

## DR-P3.1：专用托管监听器

显式 `security.hosting.enabled=true` 时，同源数据入口提供 /designer/ 和数据 API；专用 HTTP 127.0.0.1 管理入口提供 /security/、管理 API 与管理会话。实际 socket/精确 Host/Origin 及无代理头由服务端校验，数据端即使来自回环也不能访问管理 API，管理端不能进入数据/RPC/WS/注册/登录路径。OS 身份启动器经 Named Pipe 取当前准确地址，一次性配对仅放 fragment，消费后清除；不接受自选管理地址。管理授权为空，空闲 15 分钟/绝对 60 分钟，续期和重启不延长，旧八小时管理身份拒绝。原独立前端模式仅在 hosting 缺省/false 时保留。静态公开 bundle 不提供身份或权限；Cookie/CSRF、动态撤销、网络策略及 write gate 保留。不改台账、Vault 或加密格式，不隐式迁移/开放旧实例。

字段、隔离操作、构建白名单和错误处理见[托管手册](security-v1/device-registration-runtime-guide.md#12-同源页面与专用本机管理入口dr-p31)。正式注册/Passkey 状态页仍在 DR-P3.2，新增审批维护 UI 在 DR-P3.3；旧安全中心复用不表示新页面全部完成。
