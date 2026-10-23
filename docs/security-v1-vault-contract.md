# SEC-M1：密钥、Vault 与安全提交契约

对应任务：S1.1—S1.3。实现和验证状态见[里程碑台账](security-v1-milestones.md)与[交付报告](security-v1-deliveries/SEC-M1.md)。本文描述 M1 实现；后续阶段的契约预留会明确标识。

## 1. 改造基线与入口清单

改造前基线：Git `07e5393`。原 `common/atlas-vault-secret.ts` 通过连接 Token 派生磁盘口令，Core 将字符串经 scrypt 派生后用于 Vault AES-GCM；保存采用临时文件复制覆盖。因此换网络 Token 影响解密，复制中断还可能损坏目标文件。

| 入口                                         | M1 取密钥方式                                       | 网络认证影响                                            |
| -------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| `AuthoringEngine` / `ModelDBAdmin`           | 必填 `VaultKeyProvider`；已有文件先读取公开密钥引用 | 不读取网络 Token 或口令环境变量                         |
| `ModelDBClient.connect`                      | 必填 `{ keyProvider }`；只解析已有库，不创建库      | 不读取网络 Token；支持嵌套和扁平布局                    |
| Server runtime / `AuthoringBridge`           | 统一 `serverVaultKeys(cfg)`                         | Token 仍用于旧网络认证，凭证改造在 M2—M4                |
| `create-db`、备份相关 CLI                    | 与 Server 相同的本机密钥提供器                      | 网络 Token 不参与 Vault 解密                            |
| SDK / Designer / 发布接口 / HTTP / WS / bulk | 通过 Server 间接使用数据密钥；不向客户端传递密钥    | 本次不改变 wire/认证协议；M3、M4 统一授权和会话         |
| 备份、恢复、下载、导入                       | 保留当前入口；原备份载荷只携带 Vault 文件           | 当前备份不包含异机解密能力；M6 新封装前不能当作完整灾备 |

Core 的调用链：入口 → 读 Vault 引用 → provider 解析随机 DEK → `AtlasSingleVault` 验证头部与密文 → manifest/模型/关系读取。Server 注入本机 provider，依旧使用现有写入 gate；密钥封装和 OS 适配不放入浏览器公共包。

## 2. 密钥层级与目录

Windows 默认提供器 `LocalVaultKeyProvider` 使用两个独立随机层级：

| 材料       | 长度/用途                              | 持久化方式                                         |
| ---------- | -------------------------------------- | -------------------------------------------------- |
| IMK        | 32 字节；本实例封装 DEK                | CurrentUser DPAPI，purpose 绑定实例 ID 和主密钥 ID |
| DEK        | 每次新建数据库独立 32 字节；加密 Vault | IMK 下 AES-256-GCM 封装                            |
| 网络 Token | 当前网络握手/HTTP 准入                 | M1 沿用现有配置；与上述随机密钥无派生关系          |

默认目录相对**配置文件目录**，不是业务工作区：

```text
<config-directory>/
  modeldb.config.json
  security/
    instance.key
    <keyId>.dek
  logs/
<configured-workspace>/
  <database>/atlas.mld
```

Windows 安全目录创建时关闭 ACL 继承，只授权当前运行账号 SID 和 SYSTEM；检查目录所有者、重解析点、已有子文件所有者及其允许规则。发现更宽权限明确失败，不自动放宽权限。DPAPI 秘密通过子进程 stdin 传递，脚本和进程参数不包含密钥；不回显原始 OS 错误。当前不支持的 OS 默认失败，不能退回明文文件。

`instance.key` 的 JSON 字段：`version:1`、`instanceId`、`masterKeyId`、`protector:'windows-dpapi-current-user-v1'`、`protectedKey`（Base64 DPAPI blob）。这里的实例 ID 只是 M1 密钥域标识；完整身份、安全台账及并发启动协调在 M2。

`<keyId>.dek` 字段：`version:1`、`reference`、`masterKeyId`、`iv`、`tag`、`ciphertext`。后三者为 Base64，解码长度分别为 12、16、32 字节。AAD 为 `vaultKeyReferenceAAD(reference) + masterKeyId`；引用内容详见下节。记录恢复前必须验证解封，不能只凭 JSON 结构恢复替换。

提供器每次新建返回新的数据库 ID/密钥 ID，版本为 1；已有引用只取已有密钥。缺失 DEK、缺失/损坏 IMK、错误实例或无法 DPAPI 解封时拒绝，不生成替代空库。发现遗留 `.dek` 及其提交侧文件时也不自动重建 IMK。

运行账号、Windows 用户配置与安全目录属于本机解密依赖。M6 独立恢复工具完成前，仅复制 `atlas.mld` 或 `security` 目录不代表可异机恢复；不得清理唯一密钥材料。

## 3. 公共密钥接口

`@mode-db/common` 导出：

```typescript
interface VaultKeyReference {
  readonly instanceId: string;
  readonly databaseId: string;
  readonly keyId: string;
  readonly keyVersion: number;
}
interface VaultKeyMaterial {
  readonly reference: VaultKeyReference;
  readonly key: Uint8Array;
}
interface VaultKeyProvider {
  resolveKey(atlas: string, existing?: VaultKeyReference): VaultKeyMaterial;
}
```

三个 ID 只接受 1—96 位 ASCII 字母、数字、`_`、`-`；版本为正安全整数。`key` 必须为 32 字节，不能序列化到配置、错误或日志。引用 AAD 是 `[instanceId,databaseId,keyId,keyVersion]` 的 JSON 数组字符串，避免字段顺序歧义。

本机使用示例（Windows）：

```typescript
import { AuthoringEngine, ModelDBClient } from '@mode-db/core';
import { configureModelDBStorageRoot } from '@mode-db/common';
import { LocalVaultKeyProvider } from '@mode-db/server';

const keyProvider = new LocalVaultKeyProvider('C:/modeldb-instance/security');
const storageRoot = 'C:/modeldb-instance/vault';
const engine = new AuthoringEngine({ atlas: 'example', storageRoot, keyProvider });
engine.registerModel('Note', { text: 'String' });
await engine.insert('Note', { text: 'example' }, { sync: true });
await engine.close();

configureModelDBStorageRoot({ storageRoot });
const client = await ModelDBClient.connect('example', { keyProvider });
```

不同进程可构造相同目录的 provider；不需要交换原始 DEK。第三方远程应用继续使用 SDK/HTTP，无需引入本机 provider。调用方负责 provider 返回材料的生命周期；Engine 为自身复制一份并在 `dispose()` 时清零，`close()` 先刷盘再释放。JS/GC、解码字符串及当前进程权限不提供“内存完全不可读取”的保证。

## 4. Vault V2 字节格式

文件魔数为 **`MDB5SVLT`**，头部版本为 **2**。魔数编号与头部版本不是同一个计数器。

| 顺序 | 长度    | 内容                                                   |
| ---- | ------- | ------------------------------------------------------ |
| 1    | 8 字节  | ASCII `MDB5SVLT`                                       |
| 2    | 4 字节  | 大端无符号 JSON 头部长度 H，1 ≤ H ≤ 2048               |
| 3    | H 字节  | UTF-8 JSON `{version:2,algorithm:'A256GCM',reference}` |
| 4    | 12 字节 | 随机 AES-GCM IV                                        |
| 5    | 16 字节 | AES-GCM authentication tag                             |
| 6    | 剩余    | 加密目录                                               |

前 12+H 字节整体作为 AAD，篡改版本、算法、密钥身份、长度等不能绕过认证。数据密钥直接使用随机 DEK，不从 Token、数据库名或用户密码派生。

明文目录维持 `{v:1,entries:Record<string,string>}`：`__manifest__`、`m:<Model>`、`r:<Source>-<Target>-<Forward>`。模型/关系不改变现有查询和序列化语义。所有条目类型及 GCM tag 验证成功后才替换内存目录；失败不会清空已有内存内容。

公开头只用来定位密钥，不是可信授权来源；引用解析成功仍必须通过完整 GCM 验证。旧 `MDB4SVLT` 明确返回 `VAULT_LEGACY_FORMAT`；不尝试 Token 回退或自动覆盖迁移。其他格式/截断为 `VAULT_FORMAT_INVALID`。

## 5. 提交日志与恢复

目标文件 X 使用同目录 `X.pending`（候选）、`X.commit`（意图）、`X.lock`（PID/随机 nonce）、`X.reclaim`（死进程锁回收互斥）。侧文件和目标必须为普通文件，不允许符号链接。元信息不包含 DEK/明文业务数据。

提交：获取排他锁 → 验证/恢复已有版本 → 比较预期 SHA-256（拒绝陈旧写者）→ 创建候选 `wx` 并 fsync → 创建并 fsync 意图 → 同目录 rename 替换 → 清理日志 → 释放锁。意图为 `{version:1,previous:<digest|null>,next:<digest>}`；摘要只用于状态判断，不能代替 AEAD 验证。

| 恢复现场                                   | 行为                                            |
| ------------------------------------------ | ----------------------------------------------- |
| 只有完整目标                               | 验证认证加密后读取                              |
| 候选无意图、原目标有效                     | 验证原目标，丢弃未提交候选，保留原版本          |
| 候选无意图、没有原目标                     | 明确失败，保留现场，不创建空库                  |
| 意图存在、目标匹配 previous、候选匹配 next | 验证候选后完成替换                              |
| 意图存在、目标已匹配 next                  | 验证目标后清理侧文件                            |
| 日志损坏、摘要冲突、候选认证失败、材料缺失 | 明确失败并保留现场，不能猜测新旧版本            |
| 锁的 PID 已退出                            | 通过独占 reclaim 文件串行回收；PID 仍存在则冲突 |
| reclaim 回收本身中断                       | 明确失败；不按超时时间猜测归属，需要受控维护    |

首次创建若只剩锁/日志，不得进入密钥新建分支。已有有效 DEK 而 Vault 创建尚未开始时，可能留下未引用密钥记录；M1 不自动删它，后续台账维护可处理。

一次保存失败后该 `AtlasSingleVault` 实例不能继续写，必须重新打开恢复。后台刷盘失败只记录固定安全错误码并停止自动重试，显式 `flushAll()` / `close()` 会向调用方报告失败。Server 驱逐 Engine 时停止旧定时器/退出回调，防止旧缓存覆盖恢复后的文件；不使用 mtime 失效。

文件数据执行 fsync；非 Windows 还执行目录 fsync。**Node 在 Windows 不提供等同 POSIX 的目录 fsync，本交付证明进程中断恢复，不声称已实测硬件断电持久性。**真实断电、文件系统/存储控制器保证和性能基线留在 S7；并发全实例独占启动在 S2。

## 6. 错误、审计与恢复预留

`VaultSecurityError.message` 等于固定 `code`，不携带文件路径、OS 消息、原始 cause 或密钥。

| 错误码                         | 含义                                 |
| ------------------------------ | ------------------------------------ |
| `VAULT_KEY_REQUIRED`           | 缺提供器/密钥材料不满足契约          |
| `VAULT_KEY_UNAVAILABLE`        | 密钥记录缺失、损坏或无法解封         |
| `VAULT_KEY_MISMATCH`           | 实例/数据库/密钥引用不一致           |
| `VAULT_LEGACY_FORMAT`          | 旧格式；需保留旧环境或按明确计划重建 |
| `VAULT_FORMAT_INVALID`         | 头部、目录格式或长度错误             |
| `VAULT_AUTHENTICATION_FAILED`  | 错误密钥或密文/tag 被改动            |
| `VAULT_COMMIT_INCOMPLETE`      | 提交现场不能安全确定，需恢复检查     |
| `VAULT_COMMIT_CONFLICT`        | 活跃锁、并发竞争或陈旧写者           |
| `VAULT_WRITE_FAILED`           | 底层写入失败，需重新打开后处理       |
| `VAULT_PROTECTION_UNAVAILABLE` | 不支持 OS、DPAPI 或 ACL 不满足要求   |

`@mode-db/shared` 的 `DataSecurityEvent` 为 V1 安全事件结构：UTC 时间、事件/请求/任务 ID、主体、应用声明用户可信度、socket/可信代理 IP 依据、资源、结果/原因、策略版本和计数。不接收任意请求体/附加对象，不能放 Token、Cookie、恢复材料或数据明文。事件写入器属于 S2，检索/UI/轮转属于 S5；本次没有宣称已有安全日志页面。

S6.1 冻结独立恢复文件 `modeldb.recovery.v1`：使用标准 JWE Compact Serialization（RFC 7516），固定 `RSA-OAEP-256`（3072 位 RSA）与 `A256GCM`。恢复私钥 PKCS8 使用 Node scrypt（随机 16 字节盐，N=16384、r=8、p=1，32 字节输出）及 AES-256-GCM 加密；口令为 12—1024 字符，只由受保护文件输入。导入不接受其他 KDF 参数。全部外层元数据、依赖和加密私钥进入 JWE protected header 的认证范围；私钥封装同时绑定元数据。它不包含源 DPAPI blob、访问台账、Token、会话或网络策略。

恢复文件是生成时的全部当前/历史 IMK、DEK 快照，包含同一数据库的多个 DEK 版本。新增库或 DEK 轮换后必须重新导出并验证；`recovery-check` 比对给定 Vault/旧备份的公开 key reference，缺依赖时失败。尚未交付恢复公钥登记后自动更新封装，不能把旧文件视为覆盖未来密钥。历史 IMK/DEK 不按时间自动销毁；恢复包最多 1000 个 IMK（含 current）、10000 个 DEK 和 128 MiB，新增 DEK 达上限拒绝，恢复时还需为新目标 IMK 预留一项，源包 IMK 达 1000 项时拒绝发布。恢复仅在全新目录暂存并验证，最后原子发布；目标使用自己的 OS 保护和新 IMK，保留源 Vault key domain，重新初始化访问台账。恢复锁阻止普通启动；发布后硬退出可原命令重试，但只对同一恢复包、receipt/身份/全部 DEK 匹配且未初始化访问台账的目标幂等确认，不覆盖已有实例。完整备份/迁移及资产交付仍由 S6.2/S6.3 实现。

共享 `RecoveryKeyEnvelopeV1` 的 `HPKE|JWE` 是后续资产接收方外层契约；S6.1 恢复文件不是资产包。不把本机 DPAPI blob 作为便携恢复材料，也不在 Vault 内写入可自行解封的明文密钥。

## 7. 旧环境影响与下一阶段

本地 API 移除 `AuthoringEngine.connectToken/vaultSecret` 和 `deriveAtlasVaultSecretFromConnectToken`；运行时不再读取 `MODEL_DB_VAULT_SECRET`、`MODEL_DB_CONNECT_TOKEN` 来解密。Server 配置仍保留网络 Token，JSON 不接受 provider/明文数据密钥注入。

旧库、旧备份和正在运行的服务必须按切换计划处理；构建新源码不等于完成旧数据迁移。本次隔离测试没有删除/覆盖仓库业务 Vault，没有对当前 9091 服务执行轮换或重启。下一里程碑是 SEC-M2：安全台账、独占初始化、本机管理通道及凭证生命周期。

## 8. S6.2 备份与完整受信迁移格式

2026-10-22 冻结 `modeldb.backup.v2`。采用 RFC 7516 General JSON JWE，顶层仅 `format/protected/recipients/iv/ciphertext/tag`；所有二进制字段为无填充且规范的 base64url。每次生成独立随机 32 字节 PEK，12 字节 IV、16 字节 tag，正文用 `A256GCM`；JWE protected 字符串本身作为 GCM AAD。

protected header 仅包含 `enc/typ/manifest/recipientBindings`。manifest 包含库名、可选显示名称、时间、包 ID、嵌套/扁平类型、源 Vault key reference、Vault SHA-256 和统计。manifest 是公开且经认证的元数据，不能放秘密；它不能作为未认证授权依据。`recipientBindings` 绑定 recipient 的算法和 kid。未知字段、算法、版本、额外路径条目、非规范 base64url、超限输入和不匹配引用拒绝。

第一个 recipient 固定为 `A256KW`，kid 为所依赖 DEK 的 keyId，采用 RFC 3394 AES-256 Key Wrap 的 8 字节 `A6` 初值封装 PEK，结果 40 字节。显式受信迁移可加入第二个 `RSA-OAEP-256` recipient，RSA 3072—4096 位，kid 为 SPKI DER 的 SHA-256。包密钥、源 DEK 不在可读头部；正文仅 `{version:2,vault:<base64url>,key:<single-DEK-base64url>}`。完整迁移接收者获得该单库 DEK，不得将此包用于部分资产交付。

接收方私钥文件为 `modeldb.migration-key.v1`，PKCS8 DER 经固定 scrypt（随机 16 字节盐、N=16384/r=8/p=1）派生的 AES-256-GCM 保护，AAD 为格式与 recipientId。只接受固定 KDF、严格字段和长度，口令 12—1024 字符。它独立于 `modeldb.recovery.v1`，不能把两个私钥文件或口令用途互换。

本机历史 DEK 封装与 S6.1 密钥快照组合支持灾备；快照必须覆盖此包的 sourceReference。自动备份目前只使用该本机封装，未交付恢复公钥登记和自动更新机制。独立恢复仍保留 M6-A1 异机验收门槛。

创建在实例离线独占锁或数据库写入 gate 内完成，先 flush。验证器完整解密正文，核对摘要、内层 Vault 引用、GCM、内部 manifest 和统计。导入随机新建文件，不能覆盖；完整迁移先以目标 provider 的 DEK 重加密并映射内部 manifest 的 atlas/checksum，再保存本地包，显式恢复后发布。普通恢复先验证再关闭旧引擎和实时连接、驱逐缓存，只原子替换目标 Vault；不导入 registry、凭据、会话、配置、策略或目录旁文件。

恢复使用目标 revision 的摘要执行 CAS；保留旧文件或有效 journal。初次恢复在 candidate 已刷盘但 intent 未写入时中断，专用恢复入口可在锁内认证候选，并与当前请求恢复的内容逐项一致后补写 `previous:null` intent；不同或损坏候选拒绝并保留。普通启动仍沿用第 5 节的拒绝规则，不猜测初始候选归属。已存在目标及全新目标的三个进程终止点均有测试；不声称硬件断电已实测。

原始 Vault 上限 48 MiB、完整包上限 128 MiB，读磁盘前检查大小和路径；不递归打包或解压。统计为 `vaultBytes/entries/models/relations`，条目数不代表业务行数/边数。旧 `modeldb.backup.v1` 明确返回 `SECURITY_PROTOCOL_UNSUPPORTED`，原件保留且不作为已验证包列出。资产包的首批模型子集见第 9 节，完整依赖映射与跨存储分阶段发布仍属 S6.3 后续。

## 9. S6.3 首批模型资产格式（完整阶段仍进行中）

2026-10-23 增加 `modeldb.asset.v1` 模型子集格式。外层为带 `format` 标识的 RFC 7515 Flattened JWS JSON：仅 `format/protected/payload/signature`。protected 仅 `alg:PS256/typ:modeldb.asset.v1/kid:<publisher-SPKI-SHA256>`，RSA-PSS SHA-256、32 字节盐、RSA 3072—4096 位。签名输入是原始 ASCII `protected.payload`；payload 是完整 Compact JWE 字符串的 base64url。不获取包指定的远程密钥，不信任自报公钥；调用者必须提供经可信渠道确认的发布者公钥与精确指纹。

内层为 RFC 7516 Compact JWE，protected 仅 `alg:RSA-OAEP-256/enc:A256GCM/typ:modeldb.asset.v1/kid:<recipient-SPKI-SHA256>`。每次新建独立随机 32 字节 PEK、12 字节 IV、16 字节 tag；OAEP 固定 SHA-256。接收方和签名公钥指纹不得相同；先验签，再核对接收方并解密。所有二进制字段使用规范无填充 base64url，拒绝未知版本/字段/算法和非规范编码。正文验证完成前不向调用者返回资产内容。

正文仅包含 `version/packageId/assetId/assetVersion/sourceInstanceId/publisherId/createdAt/contentDigest/statistics/graph`。`graph` 仅有版本、源逻辑库名、是否含数据、模型 schema/记录与关系定义/双向索引；没有路径条目、源 Vault、源 DEK、DPAPI、凭据或安全策略。摘要是 common `stableStringify(graph)` 的 SHA-256，统计为真实模型/字段/记录/关系/边数量。选中子模型递归加入父模型，关系仅限闭包内两个端点；记录经过 append/tombstone 归并，保留 ID 与 I18N 原值，验证双向一致、端点存在、基数与自环策略。禁止 `sys_*` 模型，拒绝未知扩展和原型污染键。

发布者私钥为 `modeldb.asset-signing-key.v1`，沿用固定 scrypt/AES-GCM 保护的 PKCS8，但格式及 AAD 域与接收方的 `modeldb.migration-key.v1` 分离，两个解析器互相拒绝。此格式不含签名证书或平台信任链，指纹确认来自操作者。

首批仅离线 OS 所有者可导出、预览并导入新业务库。预览确认摘要绑定完整已验证正文的 SHA-256（`packageDigest`）、包 ID、发布者、资产身份/版本、目标实例派生的本地资产实例 ID、目标名、完整模型 schema/关系定义、统计及冲突状态；确认后重检。目标 receipt 只存身份/摘要，目标 Vault 使用自己的 DEK，加密本地备份与原子恢复共用既有候选匹配和 journal 协议。不同包、不同目标或已有本地改动拒绝；不是覆盖/合并接口。预览不创建目标库/DEK，CLI 审计任务仍留痕。

正文上限 48 MiB、文件 128 MiB、深度 32、JSON 节点 1000000、模型 1000、字段每模型 1000、关系 10000、记录 100000、记录与边合计 200000。无压缩解包、脚本执行或明文磁盘暂存。v1 冻结为模型子集，Designer 通过下面的明确 v2 格式扩展，不接受任意 Designer 库旁文件。

### 9.1 Designer 依赖扩展 `modeldb.asset.v2`

沿用 v1 算法、独立 PEK、密钥用途分离和显式发布者指纹信任。外层 format、JWS typ、JWE typ 均为 `modeldb.asset.v2`，正文 version 为 2；旧 `openAssetPackage` 拒绝 v2，显式 `openAnyAssetPackage` 才接受两个版本。正文在 v1 字段外仅增加 `designer: {version:1, rows:[{model,data}]}`，contentDigest 为 `stableStringify({graph,designer})` 的 SHA-256，原 statistics 仍只统计业务图谱。

Designer 模型白名单：`sys_data_asset_map`、`sys_model`、`sys_props`、`sys_relation`、`sys_query_interface`、`sys_operation_interface`、`sys_binding_surface`。各行字段白名单与类型由 core `DESIGNER_ASSET_SCHEMAS` 固定；限制 20000 行、1000 个选中/依赖接口、每接口最多 100 历史版本。嵌套 JSON 列也应用深度/节点/危险键检查，拒绝未知文档顶层字段。接口选取按 library_code 和逻辑 ID，Binding 固定版本必须存在；同一版本不同内容拒绝。模型闭包覆盖所有选中草稿和版本，父模型继承由业务 catalog 决定。无版本 dependencies.interfaces 暂拒绝。整库快照、图层、日志、样本结果、源操作者不交付。

显示行保留 I18N 和受限布局；关系以端点+forward+reverse 匹配，不能仅用 forward 全局匹配。导入生成目标作用域实体 ID，按语义字段映射模型/字段/关系/接口及 Binding 引用，不全局替换任意字符串或字面值。相同引用字符串在实体、接口逻辑 ID 或模型名之间存在歧义时拒绝，不能默默覆盖映射。业务 ID 和引擎唯一名保留。接口及历史版本的权限强制为 disabled，源策略/访问密钥摘要移除，源发布签名清空；目标端重新审核、发布与授权。

### 9.2 离线分阶段发布

仅 OS 所有者在 registry 独占 lease 内执行。预览绑定完整正文摘要、两库存储版本、目标/本地身份及映射，导入重新验证。已有业务库或目标 Designer 归属冲突拒绝，其他库元数据保留。

`security/asset-publication.mld` 是独立目标 DEK 保护的 Vault，内含任务身份、目标根/库名、两份目标加密候选、原文件摘要及原 Designer 加密快照，上限 224 MiB。先 fsync 任务，再分别发布业务和 Designer Vault；普通 registry.open 在任务本体/候选/journal/锁存在时拒绝启动。只有离线资产预览/导入允许打开台账续跑，并强制核对原包和精确目标，不自动猜测或跨任务清理。每个文件复用 CAS/journal，首次只剩 candidate 时在死进程 lease 接管后按已认证任务补 intent。两个文件都匹配新摘要才将任务更名为同目录 `asset-publication.<localId>.completed.mld`，保留平铺安全目录/ACL约束、快照和恢复证据；重复请求只在两文件完全匹配时返回已发布。现有 Designer DEK 保留，新业务库使用新 DEK，任务使用独立 DEK。

这是通过离线互斥和启动阻断实现的分阶段发布，不声称有底层跨库原子事务。未实现手工回滚入口、在线资产 API、浏览器资产向导或硬件断电保证；Windows 文件 fsync/journal 仅按实际进程中断证据验收。
