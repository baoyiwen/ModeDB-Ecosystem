# 设备注册公共协议与依赖契约

DR-P1.2 冻结的公共技术约定，DR-P1.3 增加第 8 节的持久台账实现，DR-P1.4 增加第 9 节的注册 HTTP 与真实库校验。注册默认关闭，证明通过仅待审；DR-P1.5 已提供第 10 节的本机审批 CLI，批准只登记明确授权，公钥登录尚待实现。任务状态以[唯一台账](../security-v1-milestones.md#11-设备注册扩展开发计划)为准。部署遵守[可信部署契约](device-registration-deployment-contract.md)，操作见[接口使用说明](device-registration-runtime-guide.md)。

## 1. 库与运行时边界

选用 [SimpleWebAuthn Server](https://github.com/MasterKale/SimpleWebAuthn/tree/master/packages/server) 的 `@simplewebauthn/server@14.0.3`，直接版本不使用范围。2026-10-26 查询官方 npm 元数据：14.0.3 于 2026-09-25 发布，当时为 latest、没有 deprecated 标记。它提供注册/登录选项生成与证明校验，避免自写 CBOR、签名和认证器证明算法。版本更新仍需审查和回归，latest 不等于安全保证；本轮没有执行漏洞公告数据库审计、签名/provenance 验证或完整认证器验收。

库声明 Node `>=20.0.0`；新增功能目标沿用 Node 22/24，本轮实际只验证 Node 24.22.1。现有 Server 的 Node 支持范围不因本次契约而扩大或收紧。注册必须准确绑定 HTTPS Origin、RP ID 和实例；认证器同步凭证不等于物理主机绑定。

[独立 manifest](../../scripts/security-registration-dependencies/package.json) 与[独立锁文件](../../scripts/security-registration-dependencies/pnpm-lock.yaml)固定直接及间接共 25 个安装条目及完整性值。D15 已将相同图接入 Server 直接依赖与根锁，核对根图只新增选中条目，并在全新隔离目录离线冻结安装 25 reused、0 downloaded；独立工具仍是供应链探针，不代替新发行包安装验收。shared/SDK 只提供浏览器安全类型/纯函数，不依赖此库，也不提供尚未实现的网络客户端。

主库 MIT 许可原文已保存在[许可文件](../../scripts/security-registration-dependencies/LICENSE.simplewebauthn.md)。25 个条目的包声明包含 MIT、BSD-3-Clause、Apache-2.0、0BSD；本轮核对主库实际许可全文及全部包声明，不冒充完整法律审计。发布集成时应携带全部适用版权、许可和 NOTICE，不能只带主库许可。

隔离验证使用 pnpm 11.25.0、禁用生命周期脚本：先联网填充专用 store 和供应链元数据缓存，再在全新目录 `--offline --frozen-lockfile --ignore-scripts` 安装；25 reused、0 downloaded。pnpm 新版离线时也需要供应链元数据缓存，仅复制 tarball store 可能报 `ERR_PNPM_NO_OFFLINE_META`，应预热缓存而不是关闭策略。根项目声明 pnpm 9.15.4，本轮不改变它，未声称已验证所有包管理器版本。

核对已有隔离安装可运行：

```powershell
node scripts/security-registration-library-check.mjs --installation "<isolated-install-folder>"
```

该目录应由上述 manifest/lock 全新安装得到。工具校验锁文件、版本与许可全文，实际导入库，生成两类选项并确认畸形注册证明拒绝。它不连接 ModelDB、不创建业务身份、不验证真实 Windows Hello。归档结果见 [D13 依赖报告](../security-v1-deliveries/evidence/SEC-M7-D13/dependency-check.json)。

## 2. 版本、能力与公共下载

浏览器安全的源码位于 shared `device-registration-contracts.ts`，由 shared 根入口导出，SDK 重导出公共类型。请求/响应使用 `format=modeldb.device-registration.v1`、`version=1`，schema 版本也是 1；未知版本、未知字段、类型不符或过大输入默认拒绝。状态不能由客户端指定。纯校验器仅检验结构；服务端仍须验证证明、真实时间、受信配置、挑战与权限。

固定 API 常量 `DEVICE_REGISTRATION_API_V1` 如下，**DR-P1.4 已挂载，默认关闭**：

| 方法 | 路径                                     | 请求与响应/成功码                                                                 |
| ---- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| GET  | `/security/registration/v1/capabilities` | `DeviceRegistrationCapabilitiesV1`，200                                           |
| GET  | `/security/registration/v1/connection`   | `DeviceRegistrationConnectionDescriptorV1`，200                                   |
| POST | `/security/registration/v1/begin`        | `DeviceRegistrationBeginRequestV1` → `DeviceRegistrationBeginResponseV1`，201     |
| POST | `/security/registration/v1/complete`     | `DeviceRegistrationCompleteRequestV1` → `DeviceRegistrationStatusResponseV1`，202 |
| POST | `/security/registration/v1/status`       | `DeviceRegistrationStatusRequestV1` → `DeviceRegistrationStatusResponseV1`，200   |

能力响应公开 `instanceId`、`mode`（planned/disabled/enabled）、`protocolVersions=[1]`、`proof=webauthn`、`userVerification=required`、`approval=local-operator` 和容量契约。部署默认关闭；支持版本不代表注册开放。尚无接口或未知 schema 的客户端显示“不支持”，不猜测 enabled、不降级绕过认证。disabled 实例仍可探测能力，但 begin/complete 拒绝。既有配对/应用 Token 保持原有流程。

连接描述使用 `format=modeldb.device-registration-connection.v1`，只允许实例 UUID v4、规范 HTTPS DNS Origin、相同 DNS 的 RP ID、模式、UTC 签发/到期、部署摘要和 TLS 信任信息。无路径、别名、默认端口改写或秘密；有效期大于零且最多 24 小时，UTF-8 JSON 最大 16 KiB。owner-pinned 必须提供 SPKI SHA-256，public-ca 不携带 pin。摘要均为小写十六进制 SHA-256。

`assertDeviceRegistrationConnectionDescriptor` 只做静态格式检查；导入时还须调用 `assertDeviceRegistrationDescriptorBinding` 对比独立受信的实例、Origin、RP、TLS/pin、部署摘要和当前时间，拒绝未来签发/到期/替换。首次信任来自管理员核对或有效 HTTPS 信任，不能从文件自证。描述轮换/到期只控制新注册入口，不能使原登记失效；停用/撤销须经本机管理。

## 3. 注册证明与申请查询

begin 请求绑定实例和部署摘要，设备备注为 1—80 个 UTF-16 单元、无首尾空白或控制字符；备注不是用户身份。客户端只能请求 `userVerification=required`。服务端检查精确 Host/Origin、Fetch Metadata、注册窗口和容量，不能凭 IP/来源名单给权限。JSON 请求限定同源、`Content-Type: application/json`、不开放跨源 CORS；服务端 Origin 必须与受信部署一致。

begin 返回随机不透明 registrationId、challengeId、挑战到期、实例/部署摘要及完整 JSON 创建选项 `publicKey`：

- RP id 精确匹配部署，名称最多 80；user.id 为服务端生成的独立随机 32 字节临时 handle，name 为不透明申请标识，不接受客户端指定主体；displayName 为备注。
- challenge 为 CSPRNG 32 字节、TTL 60 秒；算法按顺序 ES256(-7)、RS256(-257)，timeout 60000，attestation=none，residentKey=preferred，UV=required。UP 和 UV 都必须在库校验中满足；不以客户端声明代替认证器验证。
- continuationSecret 为与挑战独立的 CSPRNG 32 字节，仅用于同一申请 complete/status，服务端只保存摘要，并绑定实例、部署、申请及过期时间。它不提供业务/管理权限；不得进入 URL、日志、公开描述、审计或浏览器持久存储。浏览器内存丢失后需重新申请，不能凭 registrationId 找回。

complete 携带实例/部署摘要、申请/challengeId、continuationSecret 和 `credential`。后者是浏览器标准 `RegistrationResponseJSON` 的最小子集：id、rawId（两者必须相同）、type=public-key、可选 attachment、clientExtensionResults（只保留可选 credProps.rk）以及 response.clientDataJSON/attestationObject/可选 transports。浏览器适配层只投影这些字段，忽略非必需的 Level 3 输出；不得把完整证明打印到错误或审计。服务端库适配器拷贝 readonly transports 为普通数组后可交给库，不自写密码验证。

二进制字段为规范无 padding 的 base64url；按解码字节计量并拒绝非法长度和尾部无效位。服务端先做有界解析，再调用库验证 `webauthn.create` 类型、精确 expectedOrigin/expectedRPID/expectedChallenge、UP/UV、算法、重复 credential ID、实例/用户 handle 和待审批状态。任何预期值都从服务端受信记录读取，不能从提交证明中推导。attestation=none 不提供 TPM/硬件来源证明；计数器为零或同步凭证不应被武断当成克隆，应按库输出保存 backup eligibility/state。

挑战 issued → consumed/expired/rejected，其余均终态。证明校验前须原子认领 issued，竞争者不得再次验证；一次尝试失败也作废，需重新 begin。只有验证、申请和关键审计均持久提交后才报成功；崩溃后不复活已消费挑战，验证中间态的落盘/恢复由 DR-P1.3/P1.4 实现。

status 使用 POST body 中的 continuationSecret，禁止 query token。未知申请、错误 secret、错误实例统一公开为 NOT_FOUND，避免枚举；详细拒绝原因仅本机审计可查。查询返回当前申请和时间/稳定 reasonCode，不返回其他人的主体/授权、公钥、会话或 Cookie。申请 approved 也不能令轮询者直接取得业务会话；DR-P2 重新验证私钥后建立会话。complete 结果未知时先查询，不能重放挑战制造重复申请。

## 4. 状态与后续台账兼容

| 记录     | 初态与允许转换                                       | 终态/效果                                 |
| -------- | ---------------------------------------------------- | ----------------------------------------- |
| 申请     | pending → approved/rejected/expired                  | 三个终态不可恢复；最迟 24 小时到期        |
| 登记凭证 | active → disabled/revoked；disabled → active/revoked | revoked 终态；禁用/撤销按后续会话契约失效 |
| 挑战     | issued → consumed/expired/rejected                   | 三个终态不可再用，未知 kind/state 拒绝    |

审批必须由现有受保护 OS 身份管理入口执行，使用预期修订 CAS；准确绑定用户和库授权，本机管理身份不隐含数据权限。更新审批与公钥关联必须同一持久事务，审计失败不能报批准成功；不能先发布 active 再等待写盘。公开请求不能包含 role/principal/grants/revision。管理员列表/批准/拒绝仍走现有本机 CLI 管理通道；现有命令和准确参数见[使用说明第 5 节](device-registration-runtime-guide.md#5-本机审批-cli)，CLI 帮助同步。

`DeviceRegistrationCredentialRecordV1` 是可公开给管理员的元数据投影，不是完整落盘格式。DR-P1.3 已扩展版本化加密台账：申请含实例/部署/Origin/RP、备注、临时 handle、公钥证明验证结果和 secret 摘要/TTL；凭证含内部 ID、唯一原始 credential ID、COSE 公钥、计数、认证器/备份类型、主体关联及撤销修订；挑战含用途/绑定/单次状态。私钥/会话秘密不入公共类型。公钥与原始证明也不写通用审计。

格式迁移先核对旧台账/实例，保留现有身份、授权、撤销版本和数据密钥，原子提交新格式；未知格式拒绝旧程序写入。失败保留现场，不用新空台账覆盖。新功能默认关闭，灾备沿用空访问台账和重新授权，回退不能恢复旧凭证权限。DR-P1.3 已实现并验证合成迁移，具体存储字段和边界见第 8 节；未执行真实迁移。

## 5. 稳定错误与审计

错误体 `DeviceRegistrationErrorResponseV1` 仅含 format/version/requestId/code 和可选 retryAfterSeconds，无内部异常、URL secret 或证明片段。下表省略共同前缀 `SECURITY_REGISTRATION_`；服务端应固定映射，不直接返回库异常。用户文案由后续 zh/en/ja 翻译处理。

| 错误后缀                                                   | HTTP | 含义/客户端动作                             |
| ---------------------------------------------------------- | ---- | ------------------------------------------- |
| DISABLED                                                   | 403  | 注册窗口关闭                                |
| UNSUPPORTED                                                | 501  | 协议/能力不支持                             |
| SCHEMA_INVALID                                             | 400  | 字段/版本/编码/限制错误，修正输入           |
| INSTANCE_MISMATCH、ORIGIN_MISMATCH、RP_ID_MISMATCH         | 403  | 绑定失败，不自动替换部署                    |
| CHALLENGE_INVALID、PROOF_INVALID                           | 401  | 重新申请，不输出库错误                      |
| CHALLENGE_EXPIRED、EXPIRED                                 | 410  | 已过期，重新申请                            |
| CHALLENGE_REPLAYED、CONFLICT                               | 409  | 已使用或修订冲突，查询/刷新                 |
| APPROVAL_REQUIRED、CREDENTIAL_DISABLED、CREDENTIAL_REVOKED | 403  | 无当前可用身份，不重复自动注册              |
| PENDING                                                    | 409  | 需要等待；正常 pending 状态查询本身返回 200 |
| REJECTED                                                   | 403  | 管理员拒绝                                  |
| NOT_FOUND                                                  | 404  | 不存在或无申请查询权限                      |
| CAPACITY                                                   | 503  | 容量满，带有界 Retry-After                  |
| RATE_LIMITED                                               | 429  | 来源或全局限流，带有界 Retry-After          |

申请查询的防枚举统一结果优先于详细错误。认证身份的审计由服务端决定；schema 校验无法使声明的 `identityTrust=verified` 可信。网络传入的 actor/source 绝不能直接写入受信审计。

`DeviceRegistrationAuditEventV1` 固定事件/request ID、UTC、action/result/reasonCode、instanceId、可选内部申请/凭证 ID、actor、source、Origin/RP、durationMs（允许 0/小数）及 observedCount。action 覆盖描述下载、注册开始/完成/状态、批准/拒绝/到期、登录、启用/禁用/撤销；reason 为稳定枚举而非任意文本。匿名只能 unverified/无主体；verified 必须有服务端确认主体。IP 必须来自 socket 或配置好的 trusted-proxy，并记录归因；local-ipc 不接受 IP。设备声称/备注不提升信任。

审批、撤销和安全状态变更沿用关键审计持久化失败关闭；高频匿名拒绝沿用有界聚合/丢弃计数机制，禁止逐条无限写盘。SDK 只按稳定 code 分类，不解析英文异常。日志禁止 continuationSecret、完整 clientDataJSON/attestation/signature、私钥、Cookie、Token、DEK 和业务明文。

## 6. 容量初始门槛

`DEVICE_REGISTRATION_CAPACITY_V1` 为不可变、精确版本化契约；放宽须复审并更改版本，不允许客户端覆盖。注册相关上限已在运行时执行，登录/凭证维护仍按后续任务接入；以下不是压测通过值；实际性能须在 DR-P4.5 验证。

| 项目                 | 上限/规则                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| begin                | 每可信归因来源 5 次/分钟，全实例 60 次/分钟                                                        |
| 未完成挑战/待审申请  | 各最多 1000；挑战 60 秒、申请 24 小时                                                              |
| 凭证                 | 每主体 20，全实例 10000；计入 disabled，revoked 保留有界审计/墓碑                                  |
| 状态查询             | 同申请最短 5 秒；全实例 12000 次/分钟                                                              |
| 描述/能力下载        | 来源 30 次/分钟，全实例 300 次/分钟，共用预算                                                      |
| 证明验证             | 并发 4，等待 32；队满立即拒绝，不无界排队                                                          |
| 本机修复             | 独立预算、至少保留 1 个执行槽，不能被公开验证队列占用                                              |
| 请求体/描述          | 注册 JSON 128 KiB；公开描述 16 KiB，超限在解析前拒绝                                               |
| 二进制字段（解码后） | credential ID 1 KiB；clientDataJSON 和解析后 authenticatorData 各 16 KiB；attestationObject 64 KiB |
| 管理分页/审计 reason | 最多 100 条/页；稳定错误码最多 128 字符                                                            |

限流来源不是身份；代理和共享 NAT 不能绕过实例预算。额度检查、过期清理及插入须原子化，过期秘密/证明及时回收；保留时间、墓碑压缩与关键恢复路径在台账实现中定义。超限不分配新挑战、不建立会话、不回退旧的宽权限入口。上面的纯函数无法替代运行时队列、限流和磁盘保护。

## 7. 当前可执行验证

```powershell
node node_modules/tsx/dist/cli.mjs --test test/unit/security-registration-contract.test.mjs test/unit/security-device-registration-contract.test.ts test/unit/security-registration-storage.test.ts test/unit/security-registration-runtime.test.ts test/unit/security-registration-approval.test.ts
```

或使用已安装项目依赖的 `pnpm run test:security:registration`。覆盖部署/公共 schema、期限/容量、规范编码、状态机、审计字段和秘密拒绝，以及第 8 节的持久台账/迁移和第 9 节的注册 HTTP；合成 DNS/TLS 仍用随机回环端口，Windows DPAPI 为存储必需验证。shared 类型、SDK 严格类型消费和 browser bundle 边界已复核。完整注册/登录、本机审批、洪泛性能、真实 Hello/双机验收未执行，不能凭本轮通过结果开放真实注册。

## 8. 持久台账与原子迁移

实现位于 Server `security/registration-ledger.ts` 与 `SecurityRegistry`；不增加 shared/SDK 的服务端依赖。新台账沿用同一个 `registry.mds`、CurrentUser DPAPI、实例所有权和原子提交/审计路径。根 `RegistryState.version=2` 才允许 `registration` 扩展（扩展内部 version=1、mode=disabled/enabled）；V1 混入扩展、缺失扩展、未知版本或坏关联均拒绝。DPAPI purpose 保留 `modeldb-registry-v1:<instanceId>`，它是既有保护域名称，不是内容格式版本。`registry.ready` 仍为既有初始化标记，不充当内容降级开关。IMK、DEK、Vault 和备份格式不变。

普通启动及新实例初始化仍写/读 V1，不自动迁移；D15 新增显式注册配置触发的升级，见第 9 节。实际存在的 Server 内部方法如下，由注册服务完成校验后调用，不能把客户端数据直接传给它们；审批由第 10 节的受保护本机 CLI 调用：

| 方法                                                | 实际职责                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `registrationStorageStatus()`                       | 返回内容版本、实际注册模式、总修订和四类记录数量，不返回摘要/公钥/秘密                        |
| `migrateRegistrationStorage(expectedRevision)`      | 对已验证/持有租约的台账显式 CAS 升级，一次提交空扩展与迁移审计；V2 相同修订重试为只读无操作   |
| `readRegistrationStorage()`                         | 仅供可信存储适配器的深拷贝，不能透传至管理或公开 API                                          |
| `commitRegistrationStorage(expectedRevision, next)` | 在当前总修订下检查全量 schema、关联、容量、不可变字段及状态转换，再与固定脱敏存储审计原子提交 |

这些是持久化原语，不验证 WebAuthn 签名、来源、查询 secret 或本机管理员身份，也不发放会话/授权。DR-P1.4 注册服务已负责证明、来源和查询验证；DR-P1.5 审批服务验证本机身份，并在同一最终事务中批准、关联主体及赋予准确授权。测试构造的随机公钥字节只用于检查存储行为，不能作为有效 WebAuthn 证明。

扩展保存四类集合，记录 ID 为独立 UUID v4：

- `applications`：实例/规范 Origin/RP/部署摘要、备注、独立 32 字节 userHandle、continuationSecretHash、创建/到期/状态；证明通过后可存 candidate 公钥元数据和 verifiedAtUtc；终态有 decidedAtUtc，approved 还必须关联 userId/credentialId。原始 continuationSecret、完整 clientDataJSON/attestation 不落盘。
- `challenges`：申请关联、registration 用途、32 字节随机挑战的 SHA-256 摘要、创建/到期、issued/consumed/expired/rejected 和完成时间。每申请最多一条；终态不复活，过期后可由可信事务回收。新增候选证明必须对应已消费且尚未到期的挑战，注册服务另行验证真实证明和截止时间。
- `users`：独立 ID、现有 operator principalId、备注、enabled 和时间。application 主体的自报用户标签不能变成已登记人类身份；同一主体只关联一个用户，已经建立的关联不可替换。审批/主体创建已实现，用户停用服务留待 DR-P2。
- `credentials`：内部 ID、申请/用户、唯一原始 credential ID、COSE 公钥（规范 base64url，最多 4 KiB）、算法、uint32 计数器、singleDevice/multiDevice 与 backedUp、active/disabled/revoked 及时间。算法限定 -7/-257；不可换原始 ID/公钥/关联，计数器不可回退；revoked 终态保留。单设备不能声明 backedUp。登录时仍需服务检查主体、用户、凭证、会话父级和授权。

记录集合和字节数双重有界：待审最多 1000、总申请 11000、挑战集合最多 1000、用户最多 10000、凭证总量 10000、每用户保存的凭证行最多 20（当前包含 disabled/revoked），扩展 JSON 最多 16 MiB，外层受保护台账继续受原 32 MiB 限制。当前不删除已批准申请、用户或凭证墓碑；到上限明确拒绝，不静默抹掉撤销历史。后续维护压缩需另定保留/防复活策略并验证。已拒绝/过期申请在其原有效期结束后可回收，前提是关联挑战已一并处理；DR-P1.4 已实现公开服务的自动到期清理。

原有 `resetAccess()` 的同一事务会把登记凭证置为 revoked、未完成申请和挑战置为 rejected/expired，并关闭持久注册模式，访问代次/策略版本照常推进；不删除登记记录、不恢复旧权限、不更换数据密钥。通用 `status()`、安全中心快照和审计不暴露扩展原文。D14 当时未接登录；D19 在显式启用后仍须 active、正确签名和当前绑定才能建立会话。

迁移不改旧身份、授权、会话、配对、撤销、实例 ID 或密钥引用，原审计保留期仍按既有策略执行。新格式与审计同一提交：staged 尚无持久意图时重开保留旧版本并丢弃未提交候选；journaled/replaced 后由新程序完成恢复，不能因调用报错就认定未提交。错误返回关闭当前写者，保留诊断材料，重开后先查版本/修订，禁止盲目覆盖或自动重发。坏摘要/未知版本不回退空台账。

兼容测试使用 [HEAD 的冻结 V1 reader 源码](../../test/fixtures/security-registration-legacy/README.md)：确认它能开 V1，然后验证 V2 与已记录意图的 V2 恢复均拒绝、不改密钥或恢复材料。它没有代表旧发行包的完整安装测试。V2 不能直接二进制降级；正常停用继续使用理解 V2 的程序保持撤销，恢复老访问快照会丢失后续权限变化，不能用来回退。

验证只针对临时合成实例，不提供真实迁移命令：

```powershell
node node_modules/tsx/dist/cli.mjs --test test/unit/security-registration-storage.test.ts
node scripts/security-registration-storage-check.mjs
```

类型脚本在临时目录编译全新 shared 声明，对整个 Server 源码及新测试严格检查；复用当前 common/core 声明与依赖，不改工作区 dist，不等于新安装候选验证。隔离专项包含六个迁移/记录写入故障点、真实子进程硬退出和 Windows DPAPI；不代表硬件断电/物理磁盘耗尽、真实旧库或实际认证器已验收。

## 9. DR-P1.4 运行时接入约定

本节记录本轮实现边界，完成状态与实际验证以唯一台账和最新交付为准。可选 `security.registration` 仅包含 `descriptor`（第 2 节的完整非秘密连接描述）和 `allowStorageMigration`（布尔值，默认 false）。省略该块即关闭。描述的实例 ID 必须与已有实例相同，Origin 必须与 `publicBaseUrl` 相同且网络模式为 TLS 或受信 HTTPS 代理；不从 Host/转发头推导部署。enabled 描述同时确定新注册窗口，签发不得在未来、窗口最长 24 小时；过期后拒绝新 begin/complete，既有凭证不因此撤销。

V1 仅在显式 enabled 且 `allowStorageMigration=true` 时升级；否则拒绝启用。普通启动、disabled 配置不迁移。V2 的台账模式可为 disabled/enabled，模式切换也持久审计；这里的 enabled 仅开放注册申请，不授予任何业务权限。访问重置关闭登记窗口并撤销登记身份；重新启动时显式配置的尚未到期窗口可重新开放，运营 CLI 的动态窗口管理留待后续任务。不要在真实实例手改材料或照搬合成描述。

所有公开注册路由独立执行现有 data 来源/传输防护及额外精确 Host/Origin/Fetch Metadata 校验，禁止 CORS 和 URL 查询参数，JSON 在解析前限制 128 KiB，不设置会话 Cookie。GET 下载可无 Origin，存在的 Origin 必须相同；POST 要求同源 Origin 和 `Sec-Fetch-Site: same-origin`。无部署配置时只提供 disabled 能力响应，其余拒绝。待审批轮询在窗口关闭后仍允许，但只能查询持有独立 secret 的原申请。

来源/实例预算和证明并发/队列均有界。认领挑战与审计先持久提交，随后交给固定版本库校验；失败、超时、重启都不会复活已消费挑战。最终写入前重新检查时间、窗口、来源、访问代次、申请与重复 rawId；证明候选和成功审计同一事务。进程内预算重启后重建，持久挑战防重放保持；公开队列不承载本机管理通道。read-only 成功事件按动作/分钟采样，保留进程内观察/保存/抑制计数；拒绝沿用有界持久匿名聚合。所有审计只含服务端生成元数据，不能落盘查询秘密或原始证明。

## 10. DR-P1.5 本机审批约定

本节记录已实现的审批边界，验证与限制以 D16 最新交付为准。列表、批准、拒绝只经现有 Windows OS 身份 Named Pipe，不提供 HTTP 审批入口。父进程再次比较已由 broker 核验的调用 SID 与当前运行账号或 SYSTEM；请求内的 actor/role/SID 不构成身份，未知字段拒绝。内部审批方法要求受信本机调用上下文，不能由默认本机字符串或浏览器管理会话替代。

列表准确绑定 instanceId，分页 1—100 条，返回当前总修订、申请状态、备注/时间、证明是否通过及 COSE 公钥 SHA-256 指纹；不返回公钥、rawId、userHandle 或查询秘密摘要。备注为申请人声明，不证明是谁；管理员须通过可信渠道核对申请及指纹。

批准/拒绝须带准确实例、申请 ID、预期总修订和显式确认；冲突后重新列表核对，不自动重放。批准仅接受未到期且已验证候选的 pending 申请。选择已有 enabled operator 主体，或原子创建由管理员命名的新 operator；关联用户须 enabled。批准、主体/用户、公钥凭证、明确授权、策略修订及审计同事务提交。拒绝也可处理尚未完成证明的 pending 申请，并终止其未消费挑战；终态不可再批准。

登记凭证新增可选 grants 字段。缺失视为空授权，以兼容 D14/D15 的已持久合成记录；新批准必须明确提供授权数组，允许明确的空数组。每项严格限定 database/resource/actions/可选 releaseDigest，库名必须精确、不接受全库通配符；callable 动作须准确 resource 与 releaseDigest；语义沿用现有 SecurityGrant，不隐含管理员或其他凭证的权限。已存授权的普通存储事务不可修改；DR-P2.3 的内部收缩原语见第 14 节。旧 V2 reader 会拒绝未知 grants 字段，不能直接二进制降级。公共注册协议、数据密钥、Vault 和备份格式不变。

批准仅登记公钥与未来可用的授权，不签发 Token、会话、Cookie 或配对码；轮询只获得 approved 状态，DR-P2 仍须重新验证私钥。审计仅含动作、可信 SID、申请/主体/凭证 ID、结果与稳定原因；不含姓名、授权明细、公钥或原始证明。存储/审计失败不报成功，保留现场并重开核查，不能假定提交一定未发生。

## 11. DR-P1.6 纵向验收边界

可重复入口为 `node scripts/security-registration-integration-check.mjs`，操作与报告见[手册第 6 节](device-registration-runtime-guide.md#6-注册审批全流程验收与故障报告)。注册/审批协议和台账字段不因本次验收改变。原生链路用全新 Chrome 虚拟认证器、真实 HTTPS、Windows DPAPI 和本机 CLI；合成 none/HTTP 故障链路单独标记，不能混称硬件认证。

输出 `modeldb.registration-integration-check.v1`，记录 9 项测试的完整计数、Chrome 检查、命令、退出码、日志位置和真实环境边界；关键项缺失、失败、skip/cancelled/todo 或进程非零均拒绝完成。三个真实子进程退出点验证完整批准与审计的原子恢复。容量预置是明确的可信合成存储输入，虚拟认证器只负责实际边界请求；结果不支持吞吐、1000 设备或生产容量结论。

Windows 保护桥接的输出缓冲有界为 48 MiB，以容纳台账允许的 32 MiB 保护文件所需的 base64 JSON 编码；原 1 MiB 桥接会在注册容量前失败关闭。台账文件上限仍由既有解码器执行，未放宽台账字段、权限或验证规则。内存上界增大不等同于性能通过。失败报告和历史证据保留原字节；批准仍不产生业务会话，公钥登录继续属于 DR-P2。

## 12. DR-P2.1 会话父级与持久兼容模型

本步提供内部模型与显式迁移，不提供公钥登录端点或签发入口。`SecuritySessionParent` 是仅含非秘密 ID 的判别联合：

| kind                    | 引用与验证                                                                                    | 授权边界                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `api-credential`        | API 凭据 ID、同一 enabled 主体、凭据有效期与撤销状态                                          | 仅使用该凭据的 grants，原 `mdbt_v1_` Token 保留                      |
| `registered-public-key` | 登记凭据 ID 和 userId；用户、operator 主体与申请关联必须一致；凭据 active、用户和主体 enabled | 仅使用登记凭据自己的 grants；缺失视为空数组，不继承同主体 API grants |
| `local-management`      | 本机 OS 配对建立的独立管理记录；operator 主体、准确回环 Origin、显式管理标记                  | grants 必须为空；不可通过普通凭据轮换或 session-pair 变成 API 身份   |

旧本机业务 `browser-open` 保持准确数据库授权，属于 `api-credential` 数据身份；只有安全中心启动器产生管理身份。本机管理记录为兼容保留在 credentials 集合，V3 用独立 kind 标记，其随机摘要不是可交付 API 凭据。即使构造出格式和摘要匹配的 API Token，authenticate 仍拒绝管理记录。现有会话和配对的 `credentialId` 保留为 ID 投影，必须与 parent 中的 ID 相同；父级才决定查找的命名空间。API 与登记凭据 ID 不得重叠。安全中心会话元数据新增可选 parent；旧客户端可忽略，不能用于认证。

V3 要求每个 API/管理记录带明确 kind，每个会话及配对带明确 parent，并拒绝未知父级字段、会话/配对秘密字段及混用引用。公钥身份禁止进入配对集合；只能引用登记公钥，不能保存私钥、签名证明或长期 Bearer。公钥会话必须绑定申请 serverOrigin，滑动有效期不超过 30 分钟、绝对有效期不超过 8 小时；注销只撤销会话，不删除登记或数据密钥。当前仅对可信合成持久输入验证这条路径；DR-P2.2 才能在重新证明私钥后创建正式会话。

普通 open 和现有注册配置不自动迁移到 V3。Server 内部 `migrateSessionStorage(expectedRevision)` 对 V1/V2 作显式 CAS 迁移，V3 相同修订下重复调用不写入。它识别现有管理会话/配对的独立父记录并标记，其余为 API；混用或不一致记录拒绝。V1 迁移同时创建 disabled 的空登记集合；V2 的既有登记记录保留。实例 ID、Token/配对码/会话摘要、grant、撤销和期限、访问代次、策略版本、数据密钥及旧审计不改变；总修订和迁移审计同一原子提交。没有 HTTP、CLI 或配置项可以调用该原语，本步不提供真实升级命令。

读取时 V1/V2 只在内存推导旧父级，不写新字段，也不允许混入 V3 字段。迁移采用 V3 根版本，旧 V1/V2 reader 应拒绝，禁止手改 version 或删 parent/kind 做降级。冻结 V1 reader 的实际拒绝与材料保留有测试，完整旧 V2 发行包安装/降级未验收。需要回退时保留迁移现场，使用受控的迁移前完整副本与匹配程序离线评估；不得将旧访问台账覆盖到运行中的新实例。空访问恢复继续不恢复旧身份、Cookie、会话或登记授权，重新配对/审批；不改变 Vault、DEK、包和备份格式。

每次会话验证都重新读取正确父级及 enabled/active/撤销/到期状态，不缓存其他身份权限；管理资格只能由管理父级导出，不能从公钥或 API 会话标记获得。访问重置撤销全部身份及会话，通知包含两类凭据 ID。更完整的动态撤销索引、排队操作与传输通知仍属于 DR-P2.3/P2.4。原子提交故障不报成功，重开核查状态和迁移审计，不能假定失败就完全未提交。注册回收另修复离线超过申请有效期的情形：先持久化 pending 到 expired/rejected 的终态，再在下一轮合法收集，不在同一事务删除之前仍 pending 的申请。

## 13. DR-P2.2 公钥登录与短期会话契约

本节为 DR-P2.2 / D19 已实现的登录边界；实际证据见唯一台账和 SEC-M7 / D19。`security.authentication` 是独立的显式开关：`enabled` 必须为布尔值，`allowStorageMigration` 可选且默认 false；省略或 enabled=false 不开放新登录、不迁移。enabled=true 要求现有 registration.descriptor 已通过准确 HTTPS Origin、RP、实例和 TLS 校验；仅用其中部署绑定，不受注册窗口到期或关闭影响。已批准凭据只要 Origin/RP 不变即可登录，不因旧描述摘要轮换失效；客户端 begin/complete 必须使用当前部署摘要。无需改网络 Token，原配对仍可用。

首次显式启用且许可迁移时，原子升级 V1/V2/V3 到 V4：沿用第 12 节父级，新增独立的登录挑战集合。普通 open 保留旧版本；未授权迁移时启用失败关闭。旧 V1—V3 reader 应拒绝 V4，禁止手工降版本。集合只存 ID、挑战/浏览器 nonce 的摘要、准确实例/Origin/RP/部署摘要、访问代次、创建/到期和状态；不存证明、私钥或会话原文。issued→claimed→succeeded/rejected；claimed 不重放，重启使未完成挑战拒绝；到期后可收集。成功关联的 sessionId 只用于核查，不是认证材料。

公开路径固定为 `/security/authentication/v1/capabilities`（GET）、`/security/authentication/v1/begin`、`/security/authentication/v1/complete`（POST）。格式为 `modeldb.device-authentication.v1`、version=1。请求只经 data 网络边界、准确 Host/Origin、HTTPS 和 same-origin Fetch Metadata；禁用 CORS、iframe/crossOrigin、query 参数，POST 仅 JSON。begin 提交实例/当前部署摘要，可选 rawId 提示非发现式凭据；提示不表示已登记，不返回是否存在。省略提示采用可发现凭据。返回 32 字节随机挑战、60 秒期限、准确 RP、UV=required 选项及 challengeId，同时设置独立的短期 HttpOnly/Secure/SameSite=Strict 浏览器 nonce Cookie，原文不进入 JSON。

complete 携带同一绑定、challengeId 和浏览器 AuthenticationResponseJSON 的最小投影。服务端先校验 nonce Cookie、单次认领并持久审计，再由固定 WebAuthn 库校验 webauthn.get、挑战、RP/Origin、签名、UP/UV。userHandle 若存在必须准确匹配登记申请；无 rawId 提示的可发现登录必须带正确 userHandle。未知/未批准/停用/撤销身份与错误证明统一为 PROOF_INVALID，不公开主体、授权或公钥。声明角色、设备名、用户 ID 不参与授权。单设备非零计数器严格递增并在最终提交再检查竞争；multiDevice 的计数器不单独作为克隆判据，持久值只取最大值，同时核对备份属性的一致性。

验证后再次检查原始来源、当前开关/部署、挑战期限、访问代次及最新主体/用户/凭据状态。签名计数器、备份状态、成功审计、挑战终态和短期会话同一原子提交；会话只引用登记公钥的自身授权，不创建长期 API 凭据。只有提交成功才设置现有作用域隔离的会话 Cookie，JSON 仅返回期限、CSRF 和非秘密身份元数据。有效期 30 分钟、绝对 8 小时；复用现有 session GET/refresh/logout，刷新轮换且不延长绝对期限，旧 CSRF 失效，注销不删除登记。失去响应或提交异常时保留现场，不把失败理解为一定未提交；浏览器先恢复 Cookie 会话，无 Cookie 则重新执行新挑战，不重放旧证明。

登录使用独立有界预算：begin 来源 10/实例 120 次每分钟，complete 来源 20/实例 240；未到期挑战最多 1000，证明并发 4、等待 32，等待超过挑战 TTL 失败。JSON 64 KiB，credential ID 1 KiB、clientDataJSON/authenticatorData 各 16 KiB、签名 1 KiB、userHandle 32 字节。错误响应稳定、有界，匿名拒绝沿用持久聚合，成功审计不含 rawId、userHandle、nonce、签名或请求体。限流/容量是实现限制，不是性能验收。本步没有正式页面/翻译改造、用户停用/换钥管理 UI 或生产环境迁移。

## 14. DR-P2.3 动态授权与执行边界

本步实现数据面的动态检查；本机禁用/撤销/用户维护的正式 CLI 和换钥流程仍属 DR-P2.4。内部 restrictRegisteredCredential 要求可信 OS 本机上下文和准确总修订，只能移除该凭据已有授权或动作，不能改库、资源或 releaseDigest 扩权。普通注册存储事务继续拒绝任何 grants 修改。收缩、策略版本和不含授权内容的审计同事务提交，成功后才通知；存储写入失败关闭当前写者及其连接，重开核查，不能认定一定未提交。

登记状态/用户变化通过用户到凭据的反向索引计算影响范围；会话连接按父凭据订阅。凭据变化只通知该父级，用户停用影响该用户全部登记凭据；注册窗口和签名计数器更新不构成撤销。旧 API、登记公钥与本机管理命名空间保持分离，所有新动作读取当前父级和自身授权。受影响空闲 WS 主动关闭并要求重新握手；无关凭据的连接继续工作。到期使用服务器时钟计算剩余期限并安排定时复查，不能靠客户端消息驱动过期。关闭台账也主动拒绝连接。

HTTP/RPC 在进入 gate 前、等待 gate 后、等待引擎及异步授权后检查；同步执行前的最后守卫重验整组要求，包含批量发布中已检查的旧库和其他库。发布接口继续要求准确资源及发布摘要；绑定面父授权传递至子查询、子操作和每个批量项。只读结果返回前再查权限。禁用/停用与原会话撤销同事务提交，重新启用不复活旧会话。Core 对普通 batchUpdate/batchDelete 的独立项执行调用方守卫；insertMany/upsertMany 和关系导入的引擎内部执行作为一个已进入的操作，不承诺中途取消。不会强制中断正在提交的单项写入；已提交的单项成功或批量部分成功如实返回，后续项拒绝，自动刷新失败保持 mutation 成功和 refreshFailed。审计结果无法确认时沿用 OUTCOME_UNCONFIRMED，禁止把网络断开或错误响应当作回滚证明。

## 15. DR-P2.4 本机身份维护与换钥

本步沿用 Windows OS 身份 Named Pipe，不新增 HTTP 管理入口、配置项或持久版本。凭据/用户列表严格绑定实例，分页 1—100 条，只投影非秘密元数据、COSE 公钥 SHA-256 指纹及准确授权；不返回 rawId、公钥原文、userHandle、continuationSecretHash、Cookie 或证明。凭据列表可按登记 userId 过滤，API/本机管理父记录不混入其中。列表写审计并返回最新总修订；大页受原有通道响应上限限制，超限缩小 limit。

所有变更要求可信本机 OS 上下文、准确实例/记录 ID、总修订及显式确认；未知字段、伪造角色/SID 均拒绝，冲突后重新列表核对，不自动重放。登记凭据 active 可禁用，disabled 可明确启用，active/disabled 可撤销；revoked 终态不可恢复。启用还要求所属用户和主体 enabled。登记用户可停用/启用，覆盖其全部登记公钥会话；同主体的 API 凭据属于独立身份，不被登记用户开关暗中修改。状态变更及旧会话撤销、策略和审计同事务提交，持久成功后才通知；重新启用必须新登录。减权只允许原库/资源/摘要内移除动作，不能扩权；禁用凭据也可减权。

换钥需新申请已经过正常注册证明、仍 pending 且未到期；管理员通过可信渠道核对新申请/指纹。一次 CAS 事务在同一 enabled 登记用户/主体下批准新公钥、保存显式新授权、撤销旧 active/disabled 凭据及会话并审计；不继承其他凭据权限，不允许同 rawId/同旧公钥伪称换钥；ES256/RSA 比较规范化 SPKI 材料，改变 COSE 字段顺序或 RSA 整数前导零不能伪装新公钥。新登记不发 Token 或会话，必须重新验证私钥登录。审计用旧凭据 ID 和新申请 taskId 关联替换，不保存证明或授权明细。原始 ID/公钥关联不可改写，旧 approved 申请和 revoked 墓碑保留。每用户 20 行仍包含墓碑，换钥不会绕过容量，满额须另行设计维护。

凭据丢失时先单独撤销旧凭据，立即关闭其登记会话；新设备重新注册，管理员核对后通过既有批准流程明确关联原 enabled operator 和授权。已经 revoked 的记录不再充当换钥输入，不凭备注/文件下载恢复旧身份。管理员也可选择新用户及零授权，均需重新审批。注销不删除登记或数据解密密钥；以上操作不更换实例密钥、DEK、Vault 或备份。

存储/审计故障不报成功；journaled/replaced 后可能已经提交，通道中断先列表/审计核查，不自动重试。正式管理 UI 仍在 DR-P3，本步仅 CLI/后端，不能将这些命令作为真实实例迁移授权。

## 16. DR-P2.5 故障与在途证明边界

认领挑战后，在进入证明队列的第一次 await 之前解析当前身份并订阅该凭据的持久失效通知。凭据、用户或主体一度失效即永久标记该次证明无效；后续 enable 不能恢复排队或验签中的证明。关闭台账也使证明失效。监听在成功/拒绝/排队失败后释放；没有新增持久字段或协议版本。单纯减权不作停用处理，最终事务读取最新 grants；无关身份变化不影响该证明。

成功登录的计数器、挑战终态、会话和审计，以及维护动作的身份/旧会话撤销/审计均为各自一个原子提交；刷新替换与注销遵循同一持久规则。实际进程退出后按既有日志恢复，不自动重放业务决定。staged 未提交、journaled/replaced 已提交但响应丢失都可能发生；登录秘密不从磁盘重新返回，客户端无 Cookie 须新挑战。重启拒绝未完成挑战，撤销和用户停用后的旧会话不复活。原 API/配对与本机管理身份保持独立范围。

D22 的 30 个实际进程退出用例使用临时合成保护器，原生 DPAPI/CLI、HTTPS/Chrome 虚拟认证器另有回归；不将软件退出等同硬件断电/物理磁盘耗尽或实际 Hello/双机。审计容量满拒绝部分变更或成功回执，未知提交结果按[手册第 11 节](device-registration-runtime-guide.md#11-故障恢复与撤销竞争验收dr-p25)核查，不靠删锁或改台账恢复。

## DR-P3.1：专用托管监听器

显式 `security.hosting.enabled=true` 时，同源数据入口提供 /designer/ 和数据 API；专用 HTTP 127.0.0.1 管理入口提供 /security/、管理 API 与管理会话。实际 socket/精确 Host/Origin 及无代理头由服务端校验，数据端即使来自回环也不能访问管理 API，管理端不能进入数据/RPC/WS/注册/登录路径。OS 身份启动器经 Named Pipe 取当前准确地址，一次性配对仅放 fragment，消费后清除；不接受自选管理地址。管理授权为空，空闲 15 分钟/绝对 60 分钟，续期和重启不延长，旧八小时管理身份拒绝。原独立前端模式仅在 hosting 缺省/false 时保留。静态公开 bundle 不提供身份或权限；Cookie/CSRF、动态撤销、网络策略及 write gate 保留。不改台账、Vault 或加密格式，不隐式迁移/开放旧实例。

字段、隔离操作、构建白名单和错误处理见[托管手册](device-registration-runtime-guide.md#12-同源页面与专用本机管理入口dr-p31)。正式注册/Passkey 状态页已由 DR-P3.2 提供，新增审批维护 UI 在 DR-P3.3；旧安全中心复用不表示新页面全部完成。

## 18. DR-P3.2 浏览器身份流程

同源托管 Designer 提供注册、状态、Passkey 登录与恢复指引，权威仍在服务端。`GET /security/authentication/v1/capabilities` 增加可选非秘密 `deployment`：`serverOrigin`、`rpId`、`deploymentDescriptorSha256`。存在配置描述时返回，沿用顶层 instanceId；注册窗口或描述下载到期不移除该登录绑定。旧客户端可忽略新增字段，新客户端在缺绑定或与当前 HTTPS Origin 不匹配时拒绝，不从注册文件推导请求目标。该字段不是信任根、登录证明或权限列表。

注册 SDK 仅在当前准确 HTTPS Origin 发起无 Cookie 的注册 HTTP，描述输入严格 JSON、UTF-8 最多 16 KiB，导入与实时描述逐字段绑定并检查有效期。浏览器验证使用 required UV / none attestation，响应只投影协议必要字段，不运行描述内代码。continuationSecret 仅存在 SDK 内存闭包，页面只显示申请编号和状态；不写 URL、DOM、localStorage/sessionStorage、日志或错误。status 至少间隔 5 秒，终态、错误或卸载停止自动轮询。刷新丢失查询能力不会取消服务端申请，不自动重建/重放申请。

批准仍需新鲜显式公钥登录。页面退出通过 AbortSignal 中止请求和 WebAuthn，证明返回后提交前再查取消。取消/不支持/限流/过期等按稳定类别翻译，未知错误不展示响应体。Cookie/CSRF 继续由原登录 SDK 处理；登录后进入现有双库和服务端授权流程。换钥/丢失恢复展示人工核验路径，本机维护仍由 OS 身份 CLI 执行，不增加网页自动接管。支持浏览器可发现的 Passkey；non-discoverable 认证器的 rawId 提示目前仅 SDK 嵌入方可用，页面不提供该输入。

## 15. 本机托管管理 UI 委托（DR-P3.3）

专用 127.0.0.1 管理监听器可在已有 POST /api/v1/security/admin/control 接受 registration.\* 维护命令。公开数据监听器仍返回 404，独立旧监听模式拒绝该命令族。实际回环 socket、准确 Host/Origin、拒绝转发头、OS 配对的 local-management 会话（15/60 分钟）、Cookie/CSRF 和管理预算全部验证后，Registry 再验实际会话及 HTTP 审计上下文，才临时建立同步维护能力；不伪造 SID，不允许普通 withManagementActor 获得本机权力。

原审批/凭证维护严格 parser 与 CAS/confirm 原子审计复用。新增 registration.sessions.list 为实例绑定的 offset/limit 元数据投影（默认 25，上限 100，offset 上限 10000）；registration.session.revoke 要求 UUID 目标、当前 revision 和 confirm:true，只撤销一个持久会话并通知执行边界，不撤销父凭证或扩权。三个列表同样有审计，其返回版本用于下一步 CAS。HTTP 审计保留真实配对主体与 requestId/socket 来源；OS CLI 仍保留 OS 主体，公开公钥身份不能变成管理员。共享类型与 SDK 仅传输元数据，不含 rawId、公钥字节、查询秘密、Cookie 或密钥。

## 19. DR-P3.5 公共浏览器客户端与展示适配

SDK 的 createBrowserIdentityClient(config) 组合现有注册、状态查询、公钥登录和 Cookie 会话 API，既有函数仍导出。客户端固定显式 endpoint；注册/公钥登录再次校验当前 HTTPS 同源，导入描述不能改变目标。load 固定实例及部署摘要，后续登录发现绑定漂移拒绝，调用方须销毁并独立核对新实例。context/binding 冻结；导入描述内部复制，不能由外部修改影响申请。

每个视图创建一个客户端，任一时刻只允许一个操作；并发操作报 SECURITY_IDENTITY_BUSY，不排队或自动重试。dispose 幂等，传播 AbortSignal，拒绝迟到结果及后续查询；只结束本地生命周期，不等于服务器注销或撤销。注册查询秘密仍仅在闭包内，至少五秒查询一次；不写入 URL、DOM、Web Storage 或日志。浏览器提交后网络中断不能推断服务器未完成，不自动重放注册/登录/写操作。

公共 data-ui 面板只依赖结构化适配器，不引入 SDK/server/core；各应用注入 SDK 工厂和已有翻译器。Designer/Data Studio 为 zh/en/ja，Web 保持 en/zh-CN，未新增日语支持。Data Studio/Web 的公共入口只在 HTTPS 页面显示，继续连接固定当前 Origin 并清除旧 Token/配对码；其他连接方式保留显式配对和应用凭据。默认服务器静态托管仍仅提供 Designer；其他页面需部署者提供准确 HTTPS 同源站点/代理，不自动新增路径、信任或来源规则。

注册/批准不创建会话，用户明确 Passkey 登录后才可继续开库。SDK/页面不改变返回 revive 结构、业务 schema、保存逻辑或 Designer 双库分工；授权、撤销、来源检查及本机管理权限始终由服务器执行。

## 20. DR-P3.6 候选验收与浏览器攻击边界

综合验收冻结一份开发源码和三个全新前端产物，所有原生测试组使用同一候选摘要，运行期间变更拒绝。正式页面覆盖注册、明确审批、公钥登录、合成行写入与刷新读回；它不增加生产协议、页面字段、权限或托管路由。完整业务建模/保存、发行安装和实际双机认证器仍按 DR-P4 验收。

恶意页面用例特意采用同站不同端口，证明 SameSite Cookie 不是唯一防线：浏览器 fetch、预检、普通表单、null Origin sandbox 和嵌入受限，后端继续校验准确 Host/Origin、Fetch Metadata、CSRF 及真实管理 socket。原生 HTTP 控制请求即使携带有效 Cookie/CSRF，也不能靠错 Host、localhost 别名或 Forwarded/X-Forwarded/X-Real-IP/Via 升为管理员。浏览器错误 RP 不产生可用证明；拒绝有审计，原会话和未消费配对码保留。Host 重绑定是受控错误 Host/socket 请求验证，不声称实际公网 DNS 污染、代理部署或硬件攻击已实测。

## 21. 独立接收方密钥（DR-P4.1）

完整字段、OAEP label/证明、显式 V4→V5、版本及丢失恢复规则冻结于[接收方密钥契约](recipient-key-contract.md)。`RecipientKeyCommand` / `manageRecipientKey` 仅通过既有受保护本机 `registration.recipient.*` 维护通道传输公钥、公开挑战与一次性证明；没有匿名或数据面登记入口。普通打开、注册开关或认证开关不自动创建 V5。V5 保留 V4 登录集合和三类会话父级；旧 reader 必须拒绝，不手改版本降级。

登录密钥、公钥认证与数据接收方密钥独立；证明只验证私钥可用性，归属由可信本机管理员带外核验。新版本追加、旧版退役、挑战消费和审计原子提交；禁用/撤销登录不删除历史材料。身份失效后未完成挑战不可因重新启用而复活。访问重置另外退役活动接收方，空访问灾备不重建旧接收方关联。未改变迁移包/资产格式、DEK/Vault 或旧备份；按已核验接收方交付留 DR-P4.2。

## 22. 按已核验接收方交付（DR-P4.2）

离线 CLI 在明确配置/实例、Windows 本机身份、独占租约及确认下复用原 backup-export / asset-export，不新增 HTTP、RPC、公开 SDK 导出或私钥上传接口。V5 强制准确接收方 id/userId/keyVersion/fingerprint 和总修订，禁止混用或回退 PEM；V1—V4 保留原 PEM 入口。初次选择及发布前重查活动版本、用户/主体和 active 登录凭据。列表与导出审计推进修订，CAS 冲突须人工重查。

DataSecurityEvent 增加可选非秘密 delivery 元数据：recipientKeyId、userId、keyVersion、fingerprint、packageSha256、kind（backup/asset）。仅 V5 的 management/local-ipc recipient.delivery.sealed 成功事件使用；它在外部新文件写入前原子提交，不代表文件完成。原 task.completed 在写入后；尝试写入后失败返回结果未知。完整格式、恢复/重复导入边界见[接收方契约](recipient-key-contract.md#按已核验接收方离线交付dr-p42)。原 backup.v2 没有独立来源签名，asset.v1/v2 继续独立 PS256；三种包均未添加登记身份字段或物理主机约束。目标独立密钥/访问授权、历史私钥恢复规则保持原样。

## 23. 安装、升级与停用验收（DR-P4.3）

候选使用七包全新输出及三前端，实际离线安装后执行压缩 JS、公有 bin/CLI、Node 严格消费及不含 Node 类型的 SDK DOM 消费。各 ESM 模块独立压缩，禁止共享变量名称缓存污染其他模块的全局引用；不混淆公共属性或导出名。源码、包、文档和页面产物摘要在运行前后核对。

合成 V1 台账显式逐级迁移至 V5，保留实例身份、密钥、既有 API Token、会话与撤销状态；普通打开或关闭认证不迁移。固定摘要的旧 V1 reader 编译为 JS 后先验证 V1 可读，再拒绝 V2—V5 且保护文件不变；其底层辅助模块来自当前安装包，不等同完整历史发行包降级。未知未来台账和业务包拒绝。

关闭注册只停止新申请，已批准身份仍可签名登录；关闭 authentication 只停止新登录。停用用户跨重启保持，重新启用必须新鲜登录，旧会话不复活。访问重置保留用户及接收方历史，但撤销凭据并退役活动接收方。回退使用支持当前台账的程序关闭新入口，不改版本、不删字段、不回灌旧访问台账。重复步骤及证据范围见[发布指南第 2 节](release-guide.md#2-复验候选)。实际 Hello/双机、完整业务回归和独立性能另按后续任务验收。
