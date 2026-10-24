# 发布查询接口的标准调用（SEC-M4 / S4.3）

Query Designer 发布的接口可直接通过 HTTP 调用，无需安装 SDK。本文针对配置了 `security: { "version": 1 }` 的 registry 模式；本机可以使用 loopback HTTP，其他机器必须使用配置好的 HTTPS 地址。接口是否放行由服务端的身份、权限、发布摘要和来源策略决定。

## 从接口管理取得模板

在 Model Designer 的“接口管理”中展开已发布查询接口，可以看到：

1. 完整的 `POST` 地址，优先使用服务端提供的 `publicBaseUrl`，没有配置时使用当前连接地址。更换连接时地址会更新。
2. Bash curl 示例。凭据从 `MODELDB_TOKEN` 环境变量读取，示例中没有真实 Token。
3. “下载 Postman 模板”，得到 Collection v2.1 JSON，包含完整地址、参数类型示例、版本、分页和可选接口访问密钥占位符。
4. “当前发布版本的授权配置”，包含库名、接口名、`callable.query` 和完整 release 摘要，不包含秘密。

参数来自**发布版本**。数字和布尔值保留 JSON 类型，日期、日期时间使用明确格式，有默认值时保留默认值。示例值必须按业务条件调整；可选参数可以省略。分页字段只在接口发布了对应分页能力时出现，offset 的第一页为 `page: 0`。

浏览器地址栏发起的是 GET，不会自动添加应用凭据或请求体，不能用来执行这个 POST 接口。浏览器的配对码、HttpOnly 会话 Cookie 和接口自身的 `accessKey` 都不能替代应用服务凭据。

## 为调用应用签发限权凭据

由实例所有者在服务器本机执行。将页面中的授权 JSON 保存为 `query-grants.json`，审核其库、接口及摘要，再创建应用身份和凭据：

```powershell
modeldb-server security principal-create --name query-app -c "C:\path\modeldb.config.json"

# 将返回的主体 id 填入 --principal；输出文件必须是尚不存在的新文件。
modeldb-server security token-create --principal "<PRINCIPAL_ID>" --name query-reader --grants-file "C:\path\query-grants.json" --days 30 --output "$env:LOCALAPPDATA\ModelDB-Access\query-app.json" -c "C:\path\modeldb.config.json"
```

输出文件受本机 ACL 保护，原始凭据只交付一次。不要把它放进源码、前端构建变量或共享模板。凭据只允许调用已授权的接口，不会同时取得任意原始数据、其他库或管理接口权限。本机启动器的默认开发会话也不会自动取得所有发布接口的调用权限；需要有对应 release grant 的邀请/凭据。

重新发布可能改变完整摘要。遇到 `SECURITY_RELEASE_SCOPE_CHANGED` 时重新审核页面中的配置，签发新凭据并撤销旧凭据；不要通过删除摘要或改成通配资源来绕过。

## Postman

1. 导入下载的 `*.postman_collection.json`。
2. 检查 Collection 的 `baseUrl` 是否能从调用机器访问。本机的 `127.0.0.1` 不代表服务器在局域网或公网的地址。
3. 在私有 Environment 中添加 `modeldbToken`，值为本机签发文件中的 `token`，标记为敏感值。模板中同名的 Collection 变量为空，Environment 会覆盖它。若使用 Postman Vault，将请求的 Bearer 值改为对应的 `{{vault:秘密名}}`。
4. 保持方法 POST、Authorization 类型 Bearer Token、Body 类型 raw / JSON。根据已发布条件填写参数。只有接口额外启用访问密钥时才填写 `accessKey`。
5. 发送。模板关闭自动重定向；HTTPS 部署应正确安装并信任证书，不通过关闭证书验证解决部署错误。

模板没有内置真实凭据，也不导出浏览器会话。使用后不要将含真实值的 Environment 或 Collection 分享给他人。

## PowerShell 直接请求

下面示例假设接口名为 `ListItems`、库名为 `business`。请替换为页面展示的地址和请求体。`Invoke-RestMethod` 的返回结构与 SDK `invokeQueryInterface` 一致：包括 `kind`、`rows` 和接口实际返回的分页信息。

```powershell
$queryCredential = Get-Content -LiteralPath "$env:LOCALAPPDATA\ModelDB-Access\query-app.json" -Raw | ConvertFrom-Json
$queryHeaders = @{ Authorization = "Bearer $($queryCredential.token)" }
$queryBody = @{ version = '1.0.0'; parameters = @{} } | ConvertTo-Json -Depth 20

try {
    Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:9091/api/v1/databases/business/query-interfaces/ListItems' -Headers $queryHeaders -ContentType 'application/json; charset=utf-8' -Body $queryBody -MaximumRedirection 0
} finally {
    Remove-Variable queryCredential, queryHeaders
}
```

此示例不在控制台打印 Token。远程地址换成配置好的 HTTPS 域名；配置方法见[配置指南](modeldb-config-guide.md)。Bash 用户可以直接使用页面中的 curl 示例，先由自己的秘密管理机制注入 `MODELDB_TOKEN`。

## SDK 对照

应用后端也可以使用同一份限权凭据：

```typescript
import { RemoteModelDBClient } from '@mode-db/sdk';

const client = await RemoteModelDBClient.connect({
  url: process.env.MODELDB_URL!,
  dbName: 'business',
  token: process.env.MODELDB_TOKEN!,
  mode: 'short',
});
try {
  const result = await client.invokeQueryInterface('ListItems', {
    version: '1.0.0',
    parameters: {},
  });
  console.log(result.rows);
} finally {
  client.close();
}
```

SDK 使用安全 RPC，直接 HTTP 使用命名接口地址，两者执行相同的已发布模板和授权检查。应用可以附带 `X-ModelDB-User-Subject` 以记录自己的用户标识；仅在已验证应用主体下记录为 `application-asserted`，不会因此获得额外权限。

## 错误与处理

| HTTP | 稳定错误码                                                                    | 处理方式                                                       |
| ---- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 401  | `SECURITY_CREDENTIAL_INVALID`                                                 | 检查 Bearer 格式和凭据。旧 connectToken 请求头会被拒绝。       |
| 401  | `SECURITY_CREDENTIAL_EXPIRED`                                                 | 凭据已到期，使用本机管理通道轮换或重新签发。                   |
| 401  | `SECURITY_CREDENTIAL_REVOKED`                                                 | 凭据或主体已撤销，重新取得授权。                               |
| 403  | `SECURITY_FORBIDDEN`                                                          | 缺少目标库/接口能力；原始数据和管理权限不会随接口权限附送。    |
| 403  | `SECURITY_RELEASE_SCOPE_CHANGED`                                              | 完整发布内容改变，审核并更新准确 release grant。               |
| 403  | `SECURITY_TLS_REQUIRED` / `SECURITY_SOURCE_DENIED` / `SECURITY_ORIGIN_DENIED` | 检查 HTTPS、来源 IP、Origin 和代理策略。                       |
| 426  | `SECURITY_PROTOCOL_UNSUPPORTED`                                               | wire 版本不匹配或使用旧 `/v2/*` 入口，升级调用协议。           |
| 400  | `INTERFACE_RELEASE_NOT_FOUND`                                                 | 接口名或**业务发布版本**不存在，与 wire 协议版本错误不同。     |
| 400  | `INTERFACE_PARAMETER_*` / `INTERFACE_ACCESS_*`                                | 按发布契约修正参数或接口访问密钥。以实际返回的完整 code 为准。 |
| 503  | `SECURITY_OUTCOME_UNCONFIRMED`                                                | 操作可能已完成但结果审计未落盘；核对结果后再决定是否重试。     |

错误响应带 `error` 和 `requestId`。SDK 将安全错误转换为 `ConnectionSecurityError`；Designer 的测试控制台显示本地化提示及稳定 code。HTTP 调用者保留 requestId 供排查，不要把凭据或完整业务请求体写进诊断日志。

`security.protocol: 1` 是传输协议版本；请求体中的 `version: "1.0.0"` 是接口发布版本，两者不是同一个版本号。旧安全服务仍按原协议工作，Designer 只在明确使用旧服务凭据时生成旧示例；新 registry 服务不会自动降级。

## 验证边界

自动化验证包括原生 curl、实际 HTTP、SDK short/stream 的结果一致性，以及生成的 Postman 请求结构和等价 HTTP 执行。真实 Chrome 验证完整地址、Bearer 示例与模板下载。不以此声称已手工打开 Postman 桌面端验收；跨机器、公网代理与生产部署继续按实际部署验证。全部研发测试使用临时目录和随机端口。
