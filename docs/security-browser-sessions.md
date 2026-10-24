# 浏览器安全连接（SEC-M4 / S4.2）

Model Designer、Data Studio 和 Web 默认采用短期浏览器会话。服务凭证仍可在高级模式下输入，但只保存在当前页面内存中。认证 Cookie 为 HttpOnly、SameSite=Strict；HTTPS 下另带 Secure。CSRF proof 绑定实际 session，由服务端返回，只保存在 SDK 内存中。

应用后端、curl 与 Postman 使用独立限权 Bearer 凭据，见[发布查询接口的标准调用](security-http-invocation.md)。不要把配对码当成服务 Token。

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

## 复验

先构建 SDK、server 和三个前端，再运行：

```powershell
.\node_modules\.bin\tsx.cmd --test test/unit/security-browser-session.test.ts test/unit/security-authorization.test.ts test/unit/browser-connection-credentials.test.ts test/unit/security-network.test.ts test/unit/security-registry-http.test.ts
.\node_modules\.bin\tsx.cmd --test test/integration/security-browser-apps.test.ts
```

浏览器验收使用临时 registry、随机端口、真实 Windows 管道和 Chrome headless。可通过 `MODELDB_TEST_BROWSER` 指定 Chrome/Edge 可执行文件；缺少 Windows 或浏览器时测试会跳过，跳过不能登记为浏览器验收通过。
