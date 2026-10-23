# SEC-M6 交付记录

- 日期：2026-10-23
- 修订：D09
- 范围：S6.1 独立恢复及可重复演练、S6.2 备份/完整受信迁移与 S6.3 模型/Designer 资产子集。
- 技术状态：S6.2 完成；S6.3 的 v2 Designer 子集与双库分阶段发布见 D05，继承/复杂链兼容及浏览器流程仍待；D09 已核对 A/B 异机恢复功能通过，两端构建摘要不同、待查明，S6.1 保持待验证。SEC-M6 不能作为完整里程碑交付。
- 基线：SEC-M1—SEC-M5 完成，累计 5/7 里程碑、16/20 开发任务。
- 代码定位：本轮仅更新工作区文档/证据，未提交、推送、部署或发布；已收到用户 A Prepare/B Verify 成功报告，摘要核对结果见 D09。

最新内容及验证见文末 **D09**；D01/D02 为 S6.1 历史证据，D03 为 S6.2 交付，D04/D05 为 S6.3 局部交付，D06—D08 为演练工具与故障修复，D09 为用户异机证据核对，历史状态和计数不覆盖最新修订。

## S6.1 已实现内容（D01/D02）

1. `recovery-create` 生成独立密钥恢复快照；`recovery-verify` 完整解密校验。使用标准 Compact JWE（RFC 7516），固定 3072 位 RSA、`RSA-OAEP-256` 和 `A256GCM`。恢复私钥用固定成本 scrypt（N=16384、r=8、p=1）及 AES-GCM 保护；metadata、历史依赖和加密私钥绑定到认证范围。版本、字段、算法、base64url、长度、KDF、重复依赖及 key reference 均严格校验；文件在读入前检查大小，超过 128 MiB 拒绝。
2. 导出包含当前/历史 IMK 和所有 DEK 版本，不包含源 DPAPI blob、凭证、会话、registry 或网络策略；文件新建、不覆盖、刷盘并回读解密验证。Windows 输出父目录必须预先受 owner/SYSTEM ACL 保护，不更改既有父目录权限。源安全目录及 junction 别名拒绝。
3. `recovery-check` 验证显式给定原始 Vault/旧 Vault 备份副本的 key reference 是否被恢复快照覆盖；缺少依赖时 CLI 返回失败。包是生成时快照，新增库/DEK 后需重新生成，不自动覆盖未来密钥，也不代替 Vault 完整性验证。
4. `database-key-rotate` 离线重加密 Vault，要求显式临时/目标配置、实例 ID、精确配置库路径和 `--yes`。实例锁、密钥维护锁、原子 Vault 提交/CAS、磁盘空间预检、严格任务状态和旧文件摘要绑定防止冲突。旧 DEK 保留，不销毁历史备份依赖。
5. 轮换任务包含新旧 key reference；core 双密钥恢复入口认证对应提交文件。`prepared/staged/journaled/replaced/rewrapped/completed` 六个进程终止点均可接续。未完成任务阻止普通 registry 启动，只有离线轮换恢复命令可接续；损坏状态或被其他写者改动的旧文件失败并保留现场。正常 CLI 输出完成前记录 started/completed，失败记录 failed，审计不含秘密或业务明文。
6. `recovery-restore` 不依赖源配置或 Token；新恢复只发布到全新目标目录，要求 `--yes`。在受保护父目录下独立暂存，目标生成新 IMK、重新使用目标 OS 保护，并重新解封校验所有 DEK 后原子发布；写入脱敏恢复 receipt。恢复锁阻止普通启动；发布前后硬退出均可原命令重试。已有目标只允许对同一恢复包、严格匹配 receipt、身份和全部 DEK、且尚未初始化访问台账的结果确认 `alreadyRestored`，不重写目标；其他目标拒绝。保留 Vault key domain，普通首次启动建立空访问台账，必须重新授权；不导入网络策略。
7. `scripts/security-recovery-drill.ts` 提供两端合成演练。准备端只输出恢复包、合成 Vault 和脱敏 manifest，口令单独存储，临时源 DPAPI 目录自动删除；验证端在临时目标恢复、打开 Vault、核对数据和空访问台账，并测试错误口令/密文篡改拒绝。同机同账号拒绝成功；源环境摘要同时写入认证加密的 Vault，改写 manifest 不能伪造成功。

涉及文件：`packages/server/src/security/recovery-material.ts`、`local-vault-key-provider.ts`、`security-registry.ts`、`packages/server/src/cli-security.ts`、`packages/server/src/index.ts`、`packages/core/authoring/atlas-single-vault.ts`、`scripts/security-recovery-drill.ts`、`test/unit/security-recovery.test.ts`、根 `package.json` 及本次安全文档。格式细节见 [Vault 契约](../security-v1-vault-contract.md)。

## D02 验证记录

| 验收项             | 结果   | 证据与边界                                                                                                                                                                                                                                            |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M6-A1              | 待验证 | 错口令/格式/metadata/KDF/密文拒绝、源/已存在目标保留、恢复暂存失败不发布、真实 Windows DPAPI 目标重新保护通过；删除源 DPAPI 目录后恢复成功；另一个新进程不加载源配置或保护器恢复成功。但没有第二台 Windows 设备或独立 OS 身份，不能称为异机实机通过。 |
| M6-A2（S6.1 范围） | 通过   | 历史 IMK/DEK 快照、旧包缺新 key 的依赖检查、轮换六个独立进程终止点续跑、旧 Vault 备份可读、损坏提交/陈旧摘要/并发维护拒绝、启动阻断、空目标访问台账和旧 Token 无效通过。完整备份格式/业务覆盖流程仍由 S6.2 验证。                                     |
| M6-A3—M6-A5        | 未执行 | S6.2/S6.3 未开始，完整包加密、迁移和资产交付不能宣称可用。                                                                                                                                                                                            |

最终完整隔离安全回归 **98/98 通过，0 skip，约 90.2 秒**，其中 S6.1 共 27 项，沿用安全回归 71 项。D01 的 92/92（约 82.9 秒）为此前验证结果，本次新增路径、恢复中断/幂等、容量和演练脚本覆盖：

```powershell
node node_modules/tsx/dist/cli.mjs --test test/unit/security-vault-v2.test.ts test/unit/security-windows-keys.test.ts test/unit/server-directory-layout.test.ts test/unit/security-registry.test.ts test/unit/security-authorization.test.ts test/unit/security-network.test.ts test/unit/security-browser-session.test.ts test/unit/browser-connection-credentials.test.ts test/unit/interface-call-docs.test.ts test/unit/security-protection.test.ts test/unit/security-registry-http.test.ts test/unit/security-recovery.test.ts
```

此前加强 DPAPI 测试：导出后删除源安全目录，再恢复目标 Vault 副本；该项及 WebCrypto 标准互操作定向补验 **2/2 通过**，约 8.9 秒。JWE 使用独立 WebCrypto RSA-OAEP/AES-GCM 接口解密，而非仅实现自身往返。回归另包含新 DEK 已创建但任务尚未发布的中断现场：保留不同 keyId 的同版本 DEK，恢复导出仍可完整验证。Windows ADS、设备名和尾随点/空格路径新增定向补验 **2/2 通过**，随后恢复测试 **22/22 通过**；D02 最终 98 项已包含这些用例，以及暂存/发布后的硬退出续跑、已初始化目标拒绝、IMK/DEK 上限和演练脚本。同机与改写 manifest 拒绝的脚本定向检查 **1/1 通过**，约 15.0 秒，不计为异机验收。

- shared/common/core/server 的 Node 直接 TypeScript 构建通过；随后整仓 check 的 shared/common/core/server/data-kit/data-ui 包构建也通过。
- 限定 server 安全实现/CLI/导出和 core Vault 的 ESLint、涉及源码与文档的 Prettier、源码产物边界、SDK 依赖边界、`git diff --check` 验证，按本次最终检查记录。仓库忽略 `test/` 的格式检查，不将其列为格式通过。
- `pnpm run check` 在沙箱内先失败于 SQLite store `ERR_SQLITE_ERROR`。按权限规则获准沙箱外重试后越过此问题，包构建通过，根类型检查仍失败于已有 DOM/`ImportMeta.env`、旧 fixture 缺 `securityAudit/modelId`、旧只读类型及 ws 类型等，未进入整仓 lint/format。首次整仓检查还发现本次测试对 Uint8Array 调用带编码 `toString` 的两处错误，已改用 Buffer。D02 再次执行 `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`，同类既有错误仍在，恢复测试和演练脚本无类型诊断；server 包构建及本次 core/server/script 限定 ESLint 通过。不能宣称整仓 check 通过。
- 未重跑三个前端的 Chrome UI 验收，本次无 UI 改动，既有 SEC-M5 结果不作为本轮新证据。

修复中发现并处理：原型删除旧 DEK 导致历史备份不可恢复；单密钥 validator 不能处理轮换提交 journal；不规范混合封装替换为固定标准 JWE；补齐路径别名、离线互斥、任务摘要和审计；Windows 目标父目录 ACL 测试最初失败，改用独立受保护目标 home，未放宽 ACL；历史访问状态测试按实际 credential API 修正。

## 使用入口与异机验收

以下为命令形状；本次只对合成临时实例执行。创建/轮换必须显式 `-c`，verify/check/restore 不加载源配置。口令文件必须存放在预先受 owner/SYSTEM ACL 保护的专用目录，口令不放命令行，长度 12—1024 字符。

```text
modeldb-server security recovery-create -c <isolated-config> --instance <instance-id> --yes --output <protected-external-package> --passphrase-file <protected-file>
modeldb-server security recovery-verify --package <package> --passphrase-file <protected-file>
modeldb-server security recovery-check --package <package> --vault <raw-vault-or-old-vault-copy> --passphrase-file <protected-file>
modeldb-server security database-key-rotate -c <isolated-config> --instance <instance-id> --database <name> --vault <exact-configured-vault> --yes
modeldb-server security recovery-restore --package <package> --target-security <new-protected-home/security> --passphrase-file <protected-file> --yes
```

轮换中断后保留 `security/database-key-rotation.json` 及 Vault 的 `.pending/.commit` 文件，使用原配置、相同 database/vault/instance 和上面轮换命令续跑，不能删除任务后直接启动。恢复硬中断可能留下 sibling `.restore.lock` 和受保护随机暂存目录；保留现场并使用原命令重试，工具只回收已退出进程的锁，不按超时猜测归属。发布后仅允许严格幂等确认；已初始化目标拒绝。暂存残留不自动批量清除。未提供历史密钥自动销毁或 reset 归档恢复工具。

异机验收待办：在第二台隔离 Windows 设备或独立 OS 用户环境准备相同构建，只转移合成 Vault 副本、恢复包和独立交付的口令文件；不转移源 `security/`、源 DPAPI blob、配置或旧 Token。先 verify/check，再恢复到全新且受保护的 home/security，以目标 provider 打开 Vault 并核对合成数据；确认空凭证台账、重新授权与默认策略，重复错误口令/篡改包并比较原文件哈希。将 OS 环境、构建版本、命令结果与数据核对记录到本报告，不能保存秘密。当前无该环境，保持 S6.1 待验证，通过后再进入 S6.2。

两端演练命令如下，在相同源码和已构建的 shared/common/core/server 环境执行；路径必须指向专用隔离目录。准备端路径不能已存在，口令不能放入 fixture 目录。脚本不读取仓库配置、不连接服务。

```text
node node_modules/tsx/dist/cli.mjs scripts/security-recovery-drill.ts prepare --fixture <new-source-fixture-dir> --passphrase-file <separate-protected-dir/phrase.txt>
node node_modules/tsx/dist/cli.mjs scripts/security-recovery-drill.ts verify --fixture <received-fixture-dir> --passphrase-file <receiver-protected-dir/phrase.txt>
```

准备端 fixture 仅有 `manifest.json`、`material.mdrecovery`、`synthetic.mld`。接收端先在当前用户下创建 owner/SYSTEM 专用口令目录，再单独传入口令文件，不能沿用源用户 ACL；可用下面命令新建并验证该目录，不会放宽已有目录权限：

```powershell
node node_modules/tsx/dist/cli.mjs -e 'import { WindowsSecretProtector } from "./packages/server/src/security/windows-secret-protector.ts"; new WindowsSecretProtector().ensureDirectory(process.argv[1]);' '<receiver-protected-dir>'
```

验证成功只输出含 runId 和检查结果的脱敏 JSON，临时目标随后清除；保留该 JSON、源码版本、Node/Windows 版本和环境说明作为验收证据。`RECOVERY_DRILL_REQUIRES_INDEPENDENT_WINDOWS_ENVIRONMENT` 表示没有跨 OS 保护边界，不能记通过；任何失败均保留待验证。准备失败时可能留下部分 fixture/独立口令文件，应保留核查并选新目录重试，脚本不会覆盖它们。本轮只验证了准备端、本机拒绝和篡改 manifest 拒绝，没有产出异机成功结果。

## 限制与环境影响

- 当前支持与实机验证平台为 Windows；同机独立进程/目录不能代替跨机器 DPAPI 验收。
- 恢复包最多 128 MiB、10000 个 DEK、1000 个 IMK（包含 current），现有源 IMK 历史最多 1000 项；超过恢复包总量限制时导出拒绝，不自动删密钥。恢复会增加一个目标 IMK，因此源包 IMK 总数达到 1000 时在发布前拒绝恢复，不能把该包描述为可成功恢复。新建库/DEK 轮换在已达 10000 个保留 DEK 时提前拒绝，已有密钥仍可读取。历史材料默认保留，没有到期销毁机制，应在达到上限前规划维护。
- 快照不自动更新；`recovery-check` 当前检查原始 Vault/副本，不直接解析旧 JSON 备份容器，不自动导入业务数据。完整备份的包加密/一致性/统计和迁移仍属 S6.2。
- 未完成 DEK 任务阻止整个 registry 实例启动。损坏/竞争现场保留，不能手工删除标记绕过；无自动冲突合并。
- 全新目标恢复是独立 key domain 恢复，不是把源库并入已有另一 key domain；接收方完整迁移和资产导入仍未交付。
- 当前 reset 中断后的续跑/归档恢复工具仍未提供，独立恢复工具不是同机 reset 归档读取器。

开始与结束检查 `git status --short`，保留原有改动。所有服务测试仅使用系统临时目录、合成数据、显式临时配置和随机端口。真实 9091、真实配置、凭据、密钥、Vault 和业务库未读取或修改。未提交、发布或切换服务。

## 修订与后续

D01（2026-10-21）：本地实现与隔离证据如上，S6.1 待异机实机验收，SEC-M6 进行中；累计保持 5/7、15/20。下一项为补 M6-A1 异机证据，再进入 S6.2。

D02（2026-10-21）：继续复核并补齐恢复暂存/发布后硬退出重试、恢复锁对普通启动的阻断、同包未初始化目标的严格幂等确认、已初始化目标拒绝及 IMK/DEK 容量前置检查；新增可复现的两端合成演练脚本，并验证同机/伪造环境标记不能获得成功。最终完整安全回归 98/98、0 skip；server 构建及限定 lint/格式/源码边界检查通过，根类型既有错误仍在。异机 Windows 实测仍缺环境，S6.1 保持待验证，S6.2/S6.3 未开始，累计不变。

## D03：S6.2 备份与完整受信迁移

2026-10-22 用户知悉 S6.1 异机缺口后要求开始下一阶段，并要求开发同步准备简介和使用手册。按台账中的顺序例外完成 S6.2；不改变 M6-A1、S6.1 或 SEC-M6 的验收门槛。

### 实现及用户入口

1. 新备份采用 `modeldb.backup.v2`、标准 JWE General JSON（RFC 7516），每包独立随机 PEK、`A256GCM` 正文，历史 DEK `A256KW` 封装和显式 RSA 接收方 `RSA-OAEP-256` 封装。protected manifest/recipient headers 绑定认证；解密后验证 Vault GCM、引用、摘要、内部 manifest 和统计。正文仅一个完整 Vault 及该单个源 DEK，不包含任意旁文件、源 DPAPI blob、Token、registry、会话、网络/权限策略。旧 v1 包明确拒绝，保留原件，不列为可用备份。
2. 手动 HTTP/CLI、registry 管理和自动备份统一接入 provider；在线与同库写操作共用 gate，先 flush，失败不继续。自动任务以及离线 CLI 记录 started/completed/failed，下载与上传记录受控审计，成功回执在完成审计后输出。上传需要 `backup.manage` + `transfer.import`，下载需要 `backup.manage` + `transfer.export`，排队后重检；HTTP 上传最大 128 MiB，私钥/口令不经过 HTTP。
3. 导入先完整验证，随机新建备份文件、fsync 并回读验证，不覆盖。恢复使用目标 provider 的 DEK 重加密，以目标摘要 CAS 原子替换单个 Vault，保留目录旁文件、访问台账和策略；安全备份失败则停止。关闭旧引擎/相关实时连接，驱逐缓存并重新打开。新库名会同步映射内层 manifest 的 atlas/checksum，保留记录 ID 和关系。
4. 新增离线 `security backup-key-create/backup-export/backup-import`；接收方生成口令保护的 RSA3072 PKCS8，固定 scrypt/AES-GCM、指纹绑定和严格 KDF/字段验证。导出需精确实例和 `--yes`，输出拒绝源数据目录、安全目录、junction/ADS 和已有文件。导入只接受尚无 Vault 的目标名，先用目标 DEK 重加密为本地备份，返回 `restored:false`；之后用 `restore ... --yes -c ...` 显式发布，源访问策略不导入。
5. 既有/全新目标均验证 `staged/journaled/replaced` 独立进程硬退出续跑。首次恢复只剩 candidate 时，专用恢复入口在锁内认证并逐项比对所请求内容，匹配才补 intent；不同内容或损坏保留现场并拒绝，普通启动不自动猜测。恢复包与 v2 业务备份组合可在删除合成源密钥目录后恢复，并建立空访问台账。
6. shared/SDK 透传格式、包 ID 和统计；Designer 按当前选中业务库请求列表，沿用共享危险确认和 SDK 上传/下载，排除 Designer 专属库的误恢复。统计为 Vault 的条目数量，非业务行数/边数。新增[功能简介](../security-v1/overview.md)和[使用手册](../security-v1/user-guide.md)，根 README/配置指南增加入口，专项 AGENTS 固定后续同步维护要求。

主要代码：`packages/server/src/security/backup-package.ts`、`migration-key.ts`、`backup-manager.ts`、`auto-backup-scheduler.ts`、`cli-backup.ts`、`cli-backup-security.ts`、`security/registry-entrypoints.ts`、`dual-track-app.ts`；core `AtlasSingleVault` 内存快照、重新加密与 manifest 映射；shared/SDK 元信息、Designer `BackupWorkspace` 及备份/授权测试。格式冻结在 [Vault 契约第 8 节](../security-v1-vault-contract.md#8-s62-备份与完整受信迁移格式)。

### 验证结果

| 验收项       | 结果             | 证据与边界                                                                                                                                                                                                                     |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M6-A1        | 待验证           | S6.1 独立 Windows 设备/OS 身份实测仍缺；同机两实例迁移不作为替代                                                                                                                                                               |
| M6-A2        | 通过（本地范围） | 历史 key、DEK 轮换、中断续跑及 v2 备份组合恢复、撤销状态/registry 不回滚验证通过；异机依赖仍见 A1                                                                                                                              |
| M6-A3        | 通过             | gate/flush、完整包加密、独立 WebCrypto AES-KW/GCM 互操作、错误接收方/KDF/篡改/超限/路径拒绝、重复上传不覆盖、目标重新保护与统计回执；Windows 两隔离实例离线 CLI 全链路通过，删除源目录后恢复新库名、真实记录与双向关系核对通过 |
| M6-A4、M6-A5 | 未执行           | S6.3 资产签名、依赖、冲突预览和跨存储发布尚未开始；本次恶意备份拒绝用例不替代资产验收                                                                                                                                          |

最终完整隔离安全回归 **124/124 通过，0 skip，约 98.9 秒**。其中新备份用例 18 项、沿用备份/展示/HTTP 7 项、授权增加实时连接关闭 1 项，原 98 项保留。定向备份/授权验证 **40/40 通过，约 51.7 秒**；根新增 `pnpm run test:security:backup`，本次实际使用 Node 直接等价命令：

```powershell
node node_modules/tsx/dist/cli.mjs --test test/unit/security-backup.test.ts test/unit/backup-management.test.ts test/unit/backup-management-http.test.ts test/unit/security-authorization.test.ts
node node_modules/tsx/dist/cli.mjs --test test/unit/security-vault-v2.test.ts test/unit/security-windows-keys.test.ts test/unit/server-directory-layout.test.ts test/unit/security-registry.test.ts test/unit/security-authorization.test.ts test/unit/security-network.test.ts test/unit/security-browser-session.test.ts test/unit/browser-connection-credentials.test.ts test/unit/interface-call-docs.test.ts test/unit/security-protection.test.ts test/unit/security-registry-http.test.ts test/unit/security-recovery.test.ts test/unit/security-backup.test.ts test/unit/backup-management.test.ts test/unit/backup-management-http.test.ts
```

- shared/core/server/SDK 定向 TypeScript 构建、Designer `tsc --noEmit` 通过；整仓检查中的 common/data-kit/data-ui 构建也通过。涉及源码限定 ESLint、Prettier、源码/SDK 边界、文档链接和 `git diff --check` 按本次最终检查结果登记。
- `pnpm run check` 沙箱内先遇 SQLite store `ERR_SQLITE_ERROR`，按权限规则获准沙箱外重跑后包构建和源码边界通过，但根类型检查仍因既有 DOM/`ImportMeta.env`、旧 fixture/只读字段、ws 声明等失败，未进入整仓 lint/format。首次根检查发现本次 WebCrypto 用例的 Uint8Array 泛型不匹配，已复制成独立 Uint8Array 修复；复跑根 `tsc --noEmit` 没有本次备份实现/测试的诊断，既有错误仍在。不能宣称整仓 check 已通过。
- 本轮没有重跑三个前端的 Chrome UI 验收；Designer 只调整列表请求的数据库参数，类型检查通过，既有 M5 浏览器证据不计本轮新增验收。
- 最终补验中文库名的随机文件名兼容，以及新恢复目标超大 `.pending` 的读入前拒绝；备份/HTTP 7/7 复验通过。完整回归后，限定 ESLint/Prettier、源码/SDK 边界、44 个文档本地链接、任务计数 16/20 与 `git diff --check` 均通过；Designer 要求的 `pnpm --filter model-designer typecheck` 沙箱内先受相同 SQLite store 限制，获准沙箱外重跑通过。原有 server README/运维手册的维护命令已同步要求显式配置和离线执行。
- 上述收尾修改后，备份/HTTP/SDK/授权定向再次 **40/40 通过、0 skip，约 53.0 秒**；恢复关闭的 WS 对排队操作也重检连接状态，授权回归 **15/15 通过，约 4.0 秒**。最终 server 构建、涉及代码/文档格式和 diff 检查通过；124 项是此前完整回归的证据，此后仅按修改范围复验，不重复宣称整仓检查通过。
- 首轮新增测试 23/25 通过，暴露新库名恢复的内层 manifest 未映射，导致原始 Vault 可读而实际 Engine 无法重开；已通过 core manifest 校验/atlas/checksum 映射修复。另修复了测试对 Uint8Array 编码、旧 credential fixture API 和未带 provider 的无效包断言；最终完整 124 项包含这些修正。

### 限制与后续

单库 Vault 48 MiB、完整包 128 MiB，不流式处理大库；公开 manifest 会展示名称、引用、时间和统计。写入中断可能留下不完整备份文件，列表不会将其广告为可恢复；保留核查，不覆盖重用文件名。源 DEK 只在加密正文中，但受信完整迁移接收者可以获得它；不能作部分资产分享或交易格式。包未提供发布者签名/信任链。

自动备份目前只加入本机历史 DEK 封装；恢复公钥登记/自动加入接收方未交付，不能宣称备份单文件已独立灾备。恢复快照不自动更新，新增库/DEK 后需重做。跨库 Designer 接口/布局映射、签名资产包和发布事务归 S6.3；硬件断电、性能、整仓回归和正式切换归 SEC-M7。reset 中断后的操作工具缺口保留。

S6.2 完成，任务数增为 **16/20**，里程碑仍 **5/7**。S6.1 保持待验证；下一项验收补 M6-A1 异机证据，下一开发任务 S6.3，尚未启动。开发全程保留已有工作区改动，只使用系统临时合成目录、显式临时配置和随机端口；真实 9091、真实配置、凭据、密钥、Vault、业务库未读取或修改，未提交、推送、部署或发布。

## D04：S6.3 首批模型资产子集

2026-10-23（Asia/Shanghai）用户知悉 S6.1 异机缺口、S6.2 完成和下一开发项后要求开始下一阶段。本轮启动 S6.3，交付单个业务 Vault 的模型子集流程；不缩减原任务范围，不把本次部分交付算作 S6.3 或 SEC-M6 完成。累计仍为 **5/7 里程碑、16/20 任务**。

### 本次实现

1. core `authoring/asset-graph.ts` 按模型选择收集递归父模型依赖、全部所选字段、可选归并后的记录和闭包内双向关系。保留 schema/类型、原记录 ID、继承与数据 I18N 字典；不复制源 Vault 的额外 entry 或其他模型。独立校验层级、字段/记录类型、重复身份、关系端点、基数、自环和正反索引一致性。按模型/字段/记录/关系/边统计，继承校验避免为每个父模型复制全部后代记录集合。
2. `security/asset-package.ts` 提供 `modeldb.asset.v1`：每包新 PEK、单接收方 Compact JWE（RSA-OAEP-256/A256GCM），外层 PS256 JWS 签署整个密文。资产永久 ID/版本、来源实例、发布者、摘要、统计与图谱全部受加密/签名保护；接收方必须另行提供公钥及可信指纹，包不能自授信。没有源 DEK、源 Vault、DPAPI、Token、registry 或网络策略；拒绝未知字段/算法/版本、原型键、超限输入、损坏摘要和认证失败。
3. 签名密钥用独立 `modeldb.asset-signing-key.v1` 格式与 AAD 域，口令固定 scrypt/AES-GCM 保护 PKCS8；与接收方私钥互相拒绝，公钥指纹也不能相同。不引入平台签名信任链。
4. `asset-transfer.ts` 提供不创建目标库/DEK的预览，展示完整 schema、关系定义、依赖、数量、目标冲突和 OS 所有者权限要求。确认摘要绑定完整已验证正文的 SHA-256、目标实例派生的本地资产实例 ID及全部预览状态，阻止同包 ID/同统计换正文。导入默认新业务库，使用目标 DEK 和身份 receipt，复用目标加密本地备份、候选逐项比对和原子 journal 发布。只有完全一致且无本地变更的目标/候选允许续跑；其他同名库、目录旁文件、保留库名（含 Windows 大小写别名）和未验证现场拒绝。
5. `cli-asset.ts` 接入 `security asset-signing-key-create/asset-export/asset-preview/asset-import`。必须显式配置/实例 ID，导出和导入还需 `--yes`，导入需预览摘要；仅离线 OS 所有者通道，正在运行的实例拒绝。私钥/口令来自受保护文件，输出为源安全目录/数据树之外的新文件；源 Vault 打开前检查大小、regular file 和 junction/ADS，空目录不初始化新 Vault。任务 started/completed/failed 记录受控审计，成功写入后缺最终审计回执返回 `SECURITY_OUTCOME_UNCONFIRMED`。未开放远程 HTTP 私钥入口或 UI 占位。
6. 根脚本新增 `test:security:asset`；同步功能简介、手册第 7 节、Vault 契约第 9 节、总体方案、专项 AGENTS、测试说明和本台账。源码/包构建为当前工作区，未虚构提交版本。

主要变更：core `authoring/asset-graph.ts`、根导出；server `security/asset-package.ts`、`security/migration-key.ts`、`asset-transfer.ts`、`cli-asset.ts`、`cli-security.ts`、`security/security-registry.ts`；`test/unit/security-asset.test.ts`。其他既有 dirty/untracked 文件保留。

### 隔离验证

- 新增资产用例 12 项：模型/父依赖/记录筛选、独立 WebCrypto 验签与解密、随机新 PEK、错误接收方/发布者/算法、已正确签名但恶意或损坏的正文、摘要/统计错误、KDF/密钥用途隔离、冲突与预览内容绑定、Windows ADS/junction/设备名、超限、损坏/不同候选保留，以及三个独立进程硬退出点。Windows DPAPI 两隔离实例 CLI 流程包含删除合成源目录后导入、I18N/原 ID/双向关系、活跃实例拒绝、输出不覆盖、源别名/空库拒绝与审计核对。该流程不替代 S6.1 的异机验收。
- 完整安全集在限制并发后 **136/136 通过、0 skip，约 232.4 秒**。首轮默认并发统计为 134 通过/1 个文件失败（该 HTTP 文件未展开为其 2 个用例），`security-registry-http.test.ts` 整文件异常退出；单独复跑 **2/2 通过，约 90.9 秒**，再以 `--test-concurrency=4` 复跑全套通过。未确定首次异常退出根因，不将其归因为资产断言或已证明的 OS 资源问题。
- 首轮资产 7/10，三个进程退出用例暴露已退出进程的锁被当作旁文件冲突；补齐 PID 存活检查后 3/3 复验通过，随后 136 项包含修正。最后补强完整正文预览摘要、源 Vault 路径检查、Windows 大小写保留名和拒绝用例后，资产定向最终 **12/12 通过、0 skip，约 83.7 秒**；不把较早全套结果表述为收尾后的再次全套执行。
- `pnpm run check` 本轮进入源码边界和 shared/common/core/server/data-kit/data-ui 构建，均通过；根类型检查仍失败于既有 DOM/`ImportMeta.env`、旧 fixture、readonly/ws 声明等，没有进入全仓 lint/format。收尾直接根 `tsc --noEmit` 仍 exit 2，本次资产源码/测试及修改的 migration-key 没有诊断；定向 core/server 构建通过。随后 `pnpm run test:security:asset` 因本机 pnpm SQLite store `ERR_SQLITE_ERROR` 在依赖状态检查/尝试 install 时失败，改用已有 Node/TypeScript/tsx 的等价命令验证，没有安装新依赖。
- 最终涉及源码限定 ESLint/Prettier、51 个文档本地链接、20 项任务/16 项完成计数、源码/SDK 边界及 `git diff --check` 均通过；`test/` 为仓库忽略的格式路径，不记为格式通过。本轮无前端修改，未执行 Chrome UI 验收，也未把旧结果记为新增证据。

本次实际完整安全命令（16 个文件）：

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=4 test/unit/security-vault-v2.test.ts test/unit/security-windows-keys.test.ts test/unit/server-directory-layout.test.ts test/unit/security-registry.test.ts test/unit/security-authorization.test.ts test/unit/security-network.test.ts test/unit/security-browser-session.test.ts test/unit/browser-connection-credentials.test.ts test/unit/interface-call-docs.test.ts test/unit/security-protection.test.ts test/unit/security-registry-http.test.ts test/unit/security-recovery.test.ts test/unit/security-backup.test.ts test/unit/backup-management.test.ts test/unit/backup-management-http.test.ts test/unit/security-asset.test.ts
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.build.json
node node_modules/typescript/bin/tsc -p packages/server/tsconfig.json
node node_modules/tsx/dist/cli.mjs --test test/unit/security-asset.test.ts
```

### 未完成事项与环境边界

M6-A4/M6-A5 只完成模型子集的局部验证，**均不标整项通过**。下一开发内容仍为 S6.3：Query/Operation Interface、Binding Surface 及版本依赖的选择性收集；Designer 显示名/布局与内部引用映射；跨业务 Vault/Designer 系统库的持久任务日志、分阶段发布和硬退出恢复；相应预览、权限入口与前端验证。当前格式不接受这些扩展，不从整个 Designer 系统库搬运数据。合并/覆盖新策略也未提供。

当前格式按完整模型选择，不支持逐字段/行裁剪。正文 48 MiB、包 128 MiB，具体深度/条目上限见契约/手册；不流式处理大库。中断/无成功回执时保留包、加密本地备份与候选，重新预览后确认，不直接删除现场。审计是通用维护任务事件，未提供资产交易平台或在线托管/撤销服务。

S6.1 异机证据、reset 中断工具缺口、SEC-M7 性能/硬件断电/整体发布验收仍保留。所有测试使用临时合成数据、显式隔离配置和随机端口；真实 9091、真实配置、凭据、密钥、Vault 及业务库未读取或修改。未提交、推送、部署或发布。

## D05：S6.3 Designer 依赖与双库分阶段发布

2026-10-23（Asia/Shanghai）按用户“开始下一个阶段”继续 D04 未完成项，新增 v2 Designer 资产包和离线双库发布；没有跳过 S6.1 异机门槛或直接进入 SEC-M7。S6.3 继续进行中，累计 **5/7 里程碑、16/20 任务**。

### 本次实现

1. core `authoring/designer-asset.ts` 对业务库归属的 Query/Operation Interface、Binding Surface 收集草稿、当前/历史版本及固定版本依赖，并从所有选中版本计算模型闭包。包括父模型、所选范围内关系、可选完整记录，以及模型/字段/关系 I18N 与基础布局。不导出整库快照、图层、调用日志、源操作者或样本结果。按端点组合匹配关系，拒绝重复/歧义、缺失固定版本、不受支持的引用、危险键和超限。
2. 新明确格式 `modeldb.asset.v2`，沿用独立随机 PEK、RSA-OAEP-256/A256GCM 和 PS256；正文增加受签名/加密保护的 Designer 白名单行，摘要覆盖 `{graph,designer}`。冻结 v1 行为，旧解析入口拒绝 v2，显式 any-version 入口验证 format/typ/正文版本一致。嵌套 JSON 列也有深度/节点检查。所有接口和历史版本的权限清为 disabled，访问密钥摘要/角色/自定义规则不迁移，旧发布签名清空。
3. 按目标实例/包/实体用途派生新的 Designer 行及接口 ID，映射业务归属、模型/字段/关系引用、Binding 子接口和链内引用；保持业务记录 ID、引擎唯一名与版本，字面值不被全局字符串替换。向既有 Designer Vault 选择性合并、重建所有权双向关系，保留其他库数据和现有 Designer DEK。
4. `designer-asset-transfer.ts` 只在 OS 所有者持有 registry 独占 lease 时执行。只读预览绑定完整包、目标身份、两库版本、映射、统计/冲突和默认禁用策略；新业务库或目标 Designer 归属存在冲突则拒绝。先保存独立目标 DEK 加密的持久任务，内含两份目标密文和原 Designer 密文快照，再逐文件 CAS/journal 发布；任务完成前普通 registry 服务启动拒绝。原包/精确目标重预览可续跑，损坏/不同候选保留，活进程锁拒绝接管。完成后同目录更名为 `asset-publication.<localId>.completed.mld`，保留快照与证据，不自动清理。
5. 现有 `asset-export/preview/import` CLI 自动按选择文件/明确包版本路由，仍要求显式配置/实例、受保护私钥口令、指纹、预览确认和离线执行；运行中实例拒绝，维护 started/completed/failed 审计沿用既有机制。未新增远程私钥入口。同步功能简介、手册 §7.1/§7.2、Vault 契约 §9.1/§9.2、总体方案、台账、测试脚本与专项指南。

主要代码：`packages/core/authoring/designer-asset.ts` 及根导出；server `security/asset-package.ts`、`designer-asset-transfer.ts`、`asset-transfer.ts`、`cli-asset.ts`、`security/security-registry.ts`；`test/unit/security-designer-asset.test.ts`。保留所有原 dirty/untracked 文件，不修改真实配置和 Vault。

### 隔离验证

新增 Designer 资产用例覆盖选择性依赖/固定版本、I18N、上下文映射/字面值保留、正确签名恶意正文拒绝、只读预览、双库摘要确认、既有 Designer 数据保留、禁用接口的实际运行时拒绝和现有 Designer 读取器的名称/位置/关系端点还原。独立进程在 task staged/journaled/replaced、prepared、business staged/journaled/replaced/published、Designer staged/journaled/replaced/published 共 **12 个点硬退出**，逐项验证普通启动阻断、不同包/目标拒绝、原任务保留和双库续跑。Windows DPAPI 两实例真实离线 CLI 导出/预览/导入包含删除合成源、运行实例拒绝、目标实际 Engine 重开、默认禁用与审计检查。

首轮新用例 15/17：测试误用 catalog API 和以新密钥代替文件密钥引用导致两项失败；修正测试，并将实现中已有 Designer 的导出明确改为复用原 DEK。扩充后 17/19：读取器模拟缺少 group 链；Windows 流程发现安全目录归档子目录违反既有平铺/ACL校验，导致 CLI 已成功后重开失败。修正模拟并改为同目录平铺加密归档，**19/19、0 skip、约 55.9 秒**通过。之后补齐正确签名恶意 v2、不同/损坏候选、任务候选/live PID/归属冲突用例，并启动完整回归；收尾验证结果在下面登记。

- 完整安全回归（17 个文件）**157/157 通过、0 skip，约 174.3 秒**。随后资产 v1/v2 定向 **33/33 通过、0 skip，约 99.7 秒**。收尾补任务本体/候选一致性、任务及目标 sidecar regular path 验证、未映射继承引用拒绝和接收端接口数量上限后，Designer 定向 **21/21 通过、0 skip，约 56.4 秒**；再补实体/逻辑 ID/模型名别名歧义拒绝，相关验证/映射/读取/候选用例 **5/5 通过，约 1.6 秒**。不将较早全套记为这些收尾后的再次执行。
- core/server 定向构建通过；`pnpm run check` 本轮成功越过包管理器和 shared/common/core/server/data-kit/data-ui 构建，根 `tsc --noEmit` 仍因既有 DOM/ImportMeta.env、旧 fixture、readonly/ws 声明等失败，未进入整仓 lint/format。本次资产代码/测试未有类型诊断。涉及源码限定 ESLint、Prettier 和源码/SDK 边界检查通过，测试目录为仓库忽略路径，不记为 lint/格式通过。
- 本次未修改前端组件；使用现有 Designer 行读取器作自动化还原验证，未执行真实 Chrome 资产审核/重新发布验收，不把历史三前端浏览器结果当作本轮证据。收尾 51 个文档本地链接、任务总数 20/完成 16、涉及源码限定 ESLint/Prettier、源码/SDK 边界和 `git diff --check` 通过。

实际命令：

```powershell
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.build.json
node node_modules/typescript/bin/tsc -p packages/server/tsconfig.json
node node_modules/tsx/dist/cli.mjs --test test/unit/security-asset.test.ts test/unit/security-designer-asset.test.ts
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=4 test/unit/security-vault-v2.test.ts test/unit/security-windows-keys.test.ts test/unit/server-directory-layout.test.ts test/unit/security-registry.test.ts test/unit/security-authorization.test.ts test/unit/security-network.test.ts test/unit/security-browser-session.test.ts test/unit/browser-connection-credentials.test.ts test/unit/interface-call-docs.test.ts test/unit/security-protection.test.ts test/unit/security-registry-http.test.ts test/unit/security-recovery.test.ts test/unit/security-backup.test.ts test/unit/backup-management.test.ts test/unit/backup-management-http.test.ts test/unit/security-asset.test.ts test/unit/security-designer-asset.test.ts
pnpm run check
```

### 限制与后续

M6-A4/A5 新增 Designer 子集与双库中断的本地证据，仍不标整项完成。下一项继续 S6.3：继承虚拟关系/更复杂查询链的稳定引用和固定依赖规范、真实浏览器中导入后审核/重新发布/目标授权的完整流程。当前未知/虚拟继承关系引用和无版本 `dependencies.interfaces` 明确拒绝，不能将“拒绝危险包”当作这些正常资产已经兼容。

v2 仅离线 OS 所有者入口，无在线资产 API 或浏览器私钥导入向导；基础布局不含图层/快照/折线提示，按完整模型选择，不做字段/行裁剪。每接口最多 100 历史版本，Designer 行 20000、依赖接口 1000；仍有正文 48 MiB/包 128 MiB 和每 Vault 48 MiB限制，目标任务最大 224 MiB，不流式处理。归档含原 Designer 密文快照，未交付手工回滚/清理工具；任何本地重写（包括 Engine 重新持久化）改变文件摘要后，重复导入严格拒绝，不猜测语义等价。

持久任务+互斥/启动阻断是分阶段发布协议，不宣称底层跨库原子事务。进程硬退出不替代 Windows 硬件断电验收；无成功回执保留现场，用原包重新预览。S6.1 独立 Windows/OS 身份成功证据、reset 中断工具缺口及 SEC-M7 仍待。所有验证均为系统临时合成目录、显式隔离配置、随机端口；真实 9091、真实配置、凭据、密钥、Vault、业务库未接触，未提交、推送、部署或外部发布。

## D06：S6.1 可重复 PowerShell 演练与失败诊断

2026-10-23，用户在 A 设备手动执行准备命令得到 `RECOVERY_DRILL_FAILED`，随后要求把步骤制作成后续可重复使用的脚本。本次只补演练工具和说明，不将工具交付记为异机成功，也不改变 S6.3 的后续范围。累计仍为 **5/7 里程碑、16/20 开发任务**。

### 实现与操作

- 新增 `scripts/security-recovery-drill.ps1`，兼容 Windows PowerShell 5.1，提供 `Prepare`、`Receive`、`Verify -DrillRoot <B目录>`。根据脚本所在位置定位仓库，可从其他工作目录调用。默认用现有 Node/TypeScript 顺序构建 shared/common/core/server，失败即停止；`-SkipBuild` 供同一构建重复使用，不自动安装依赖。
- 新增 `scripts/security-recovery-drill-runner.ts`。准备/接收默认创建全新临时目录，可指定仓库之外、尚不存在的目标；保留失败和已有目录，不自动覆盖、接管或清理。接收端按当前 Windows 身份建立 fixture 和独立口令目录，验证只接受接收会话目录；复用既有合成数据、删除源临时密钥、恢复和拒绝测试。
- 每次操作新建脱敏 JSON 报告，含 Windows/Node 版本、明确范围的源码和构建摘要、结果或失败步骤/错误码。公开输出不含口令、密钥、原始异常消息/堆栈。旧 `prepare|verify --fixture ... --passphrase-file ...` 入口保留；只将稳定 Security/Vault/文件系统错误码公开，未知异常继续折叠。
- 更新功能简介、使用手册 §4.1、测试说明、测试脚本及本台账。两端只交换三个合成 fixture 文件，口令单独交付并继承 B 的 ACL；使用手册明确成功标准、报告回传及失败处理。

### 验证与边界

- 默认 PowerShell `Prepare` 在 Windows PowerShell 5.1 下完成四包构建，输出 `SUCCESS: Prepare` 与 `prepared: true`；`Receive -SkipBuild` 建立接收目录成功。最初发现 PowerShell 5.1 原生命令参数会移除内嵌引号，版本检测改为不含引号的表达式后通过。
- 恢复模块与新增脚本测试 **31/31 通过，0 skip，约 81.4 秒**。其中新增 4 项覆盖实际 PowerShell 包装器、跨工作目录及带空格路径、两端代码/构建摘要一致、同机同账号拒绝、重复验证不覆盖报告、篡改 manifest 拒绝、缺文件精确步骤、已有内容保留，以及错误/输出脱敏。31 项后补源码花括号格式和包装器空输出拒绝，脚本定向 **4/4 通过，0 skip，约 29.7 秒**；随后显式目录补充绝对路径拒绝，用相应定向用例验证。没有把较早 31 项表述为收尾后的再次全套执行。
- 涉及源码限定 ESLint、Prettier、48 个文档本地链接及 `git diff --check` 通过；`test/` 是仓库忽略的格式路径，不记为格式通过。未运行浏览器或第二设备成功验收。
- `pnpm.cmd run check` 本轮成功完成源码/SDK 边界及 shared/common/core/server/data-kit/data-ui 构建，根类型检查仍被既有 DOM/ImportMeta.env、旧 fixture、readonly/ws 声明等错误阻断，未进入整仓 lint/格式检查。本次演练源码和测试没有类型诊断，不能宣称整仓 check 通过。
- 用户原目录仅根据文件元数据确认部分生成，未读取口令或密文内容；未取得当时底层错误码，不能认定历史故障根因。新工具提供下次失败的步骤和稳定代码。验证使用新建系统临时目录与合成数据，原失败目录和既有工作区改动保留；真实 9091、实例配置、凭据、密钥、Vault 和业务库未接触。

S6.1 / M6-A1 仍待两台设备的成功报告及构建摘要核对。S6.3 继承虚拟关系/复杂链兼容、浏览器审核/重新发布/目标授权和 SEC-M7 均未因本工具提前完成；未提交、推送、部署或发布。

## D07：S6.1 管理员窗口预检与操作修正

2026-10-23，用户反馈新版 `Prepare` 在 `prepare.recovery-package` 返回 `SECURITY_INSTANCE_BUSY`，并明确确认 PowerShell 带管理员标识。恢复代码在取得隔离实例 lease 后将文件保护检查及密钥 lease 失败统一转换为该错误；Windows 提升令牌创建文件可能使用 Administrators 组所有者，因此不能仅凭该码认定真实服务占用。用户那次临时源目录已按脚本清除，未取得原进程 ACL 快照，保留“可能的文件所有者原因”，不写成已证明根因。

- `security-recovery-drill.ps1` 在调用 Node、构建或创建演练目录前检查实际 Windows 令牌；提升的管理员进程返回 `RECOVERY_DRILL_NON_ELEVATED_REQUIRED`、退出码 1，并提示两端均使用普通 PowerShell。该限制只作用于合成演练入口，不修改服务端安全规则，不放宽 ACL、不更改已有文件所有者。
- 使用手册 §4.1 增加普通窗口启动方式、原生令牌检查、管理员子进程继承规则和故障说明；同步功能简介、专项指南、测试说明和台账。
- 新增真实令牌条件测试，验证当前令牌对应的允许或拒绝行为及目录创建结果。脚本定向 **5/5 通过，0 skip，约 33.4 秒**，当前验证令牌为未提升状态；没有启动提升的测试子进程，不把允许分支的结果表述成管理员分支实机验证。
- 在未提升隔离进程运行 `Prepare -SkipBuild`，复用 D06 已构建四包，得到 `SUCCESS: Prepare` 和 `prepared: true`。本次未改 TypeScript 业务实现，未重复整仓 `check`；D06 已登记的根类型错误仍在。收尾检查限定为 PowerShell 解析、涉及文档格式/本地链接及 `git diff --check`。

原失败目录保留，真实 9091、配置、凭据、密钥、Vault 和业务库均未接触，未提交、推送、部署或发布。下一操作为用户在 A 普通窗口重新准备，并在 B 普通窗口完成接收/验证；两端同步新版脚本后重新生成可比较的代码摘要。用户普通窗口复验和 S6.1 / M6-A1 异机成功均仍待，5/7 里程碑、16/20 任务及 S6.3/SEC-M7 状态不变。

## D08：S6.1 中文路径解析修复与接收结果核对

2026-10-23，用户反馈 B 的 PowerShell 入口在四包构建后返回 `RECOVERY_DRILL_RUNNER_UNAVAILABLE`。用户按诊断命令直接执行 TypeScript runner，回传 Node `v24.14.1`、`ok: true`、`readyToReceive: true` 和退出码 `0`。因此 B 已成功建立接收目录，旧错误不能解读为接收程序不可用，也不能把接收就绪当作异机恢复成功。

### 修复与证据边界

- 本地先以 Node 输出含中文用户路径的 UTF-8 JSON，再用 Windows PowerShell 5.1 / CP936 捕获并 `ConvertFrom-Json`，复现解析失败。该编码组合可能破坏中文后相邻的 JSON 反斜线转义，超过纯显示乱码范围；与 B 中文用户目录的现象吻合，但尚未采集 B 实际控制台代码页，不能声称已直接测得其编码。
- `.ps1` 只在捕获 runner 输出时显式使用 UTF-8，`finally` 恢复原控制台及管道编码；不永久修改代码页、系统区域设置或目录权限。增加脚本完整性预检，区分 `RECOVERY_DRILL_SCRIPTS_MISSING`、`RECOVERY_DRILL_RUNNER_NO_OUTPUT` 和 `RECOVERY_DRILL_RUNNER_INVALID_OUTPUT`，不回显任意原始输出或异常内容。
- 另在临时代码目录 junction 上复现 CLI 退出码 `0`、stdout/stderr 均为空。新增 `scripts/security-recovery-drill-entry.ts`，两个 TS 入口按真实代码路径及 Windows 大小写规则判断直接启动，避免 URL/别名差异造成静默退出。这是独立缺陷；用户 B 直接 runner 成功，不能据此把目录别名认定为 B 的根因。恢复材料的 junction/别名拒绝保持不变。
- 源码摘要清单加入入口辅助文件，完整同步三个 TS 文件及 `.ps1`。功能简介、手册 §4.1、测试说明、专项指南与唯一台账同步更新。B 已成功的接收目录可继续使用；两端更新代码后，A 用新版重新准备，B 接收这一轮材料并执行新版 Verify，再核对 A Prepare/B Verify 的 `runId`、源码/构建摘要及全部结果。

### 隔离验证

新增真实 PowerShell 5.1 / CP936、中文默认临时目录和编码恢复回归，以及代码目录 junction 下两个 CLI/PowerShell 包装器的入口回归，同时确认恢复材料 junction 仍拒绝。首轮脚本 **6/7**：新增拒绝用例误将既有 `SECURITY_INVALID_REQUEST` 预期为不存在的路径错误码；实际保护已生效，修正测试断言后复验。最终结果如下。

- 恢复模块与演练脚本 **34/34 通过，0 skip，约 69.2 秒**，其中脚本 7 项；覆盖 Windows DPAPI、硬退出续跑、独立环境拒绝、错误口令/篡改、报告不覆盖及材料保留。中文路径用例随后换为合成用户名，再定向 **1/1 通过，约 3.4 秒**。
- `pnpm.cmd run check` 完成源码/SDK 边界和 shared/common/core/server/data-kit/data-ui 构建；根类型检查仍受此前登记的 DOM/ImportMeta.env、旧 fixture、readonly/ws 等错误阻断，本次三个 TS 脚本与测试没有类型诊断。未进入整仓 lint/格式，不能将整仓 check 记为通过。
- 收尾涉及 TS 源码的限定 ESLint、源码/六份说明文档的 Prettier、PowerShell 语法、50 个本地文档链接、20 项任务/16 项完成计数及 `git diff --check` 通过。`test/` 仍为仓库忽略的 lint/格式路径，不记为测试源码已通过 lint/格式检查。

实际命令：

```powershell
node node_modules/tsx/dist/cli.mjs --test test/unit/security-recovery-drill.test.ts test/unit/security-recovery.test.ts
node node_modules/tsx/dist/cli.mjs --test --test-name-pattern="Chinese temp path" test/unit/security-recovery-drill.test.ts
pnpm.cmd run check
node node_modules/eslint/bin/eslint.js scripts/security-recovery-drill.ts scripts/security-recovery-drill-runner.ts scripts/security-recovery-drill-entry.ts
```

所有本地验证使用新建临时目录和合成材料；旧失败现场及工作区无关文件保留。未连接真实 9091，未读取或修改真实配置、凭据、密钥、Vault 或业务库，未提交、推送、部署或外部发布。B 回传的只是接收成功；下一仍需新版 A Prepare 与 B Verify 的成功报告及摘要核对，S6.1 / M6-A1 待验证，累计 **5/7、16/20** 和 S6.3/SEC-M7 状态不变。

## D09：S6.1 用户异机报告核对与构建差异

2026-10-23，用户回传两台 Windows 的原始脱敏报告。本轮直接解析这两份 JSON，不加载演练材料、实例配置或秘密；副本保存在 [A Prepare 报告](evidence/SEC-M6-D09/prepare.json) 和 [B Verify 报告](evidence/SEC-M6-D09/verify.json)，原文件未改写。

### 报告核对

| 项目                  | A 准备端                                                           | B 验证端                                                           | 核对结果                             |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------ |
| 操作/状态/步骤        | `prepare` / `succeeded` / `report.write`                           | `verify` / `succeeded` / `report.write`                            | 符合预期                             |
| 时间（Asia/Shanghai） | 2026-10-23 15:37:06.181                                            | 2026-10-23 15:42:05.401                                            | 先准备后验证                         |
| 平台                  | Windows `10.0.26300` / x64                                         | Windows `10.0.26300` / x64                                         | Windows 实机                         |
| Node                  | `v24.15.0`                                                         | `v24.14.1`                                                         | 记录版本差异；不凭版本号解释构建差异 |
| `runId`               | `a56bbf98-3b74-4647-80ae-c3f5416da51d`                             | 同 A                                                               | 一致                                 |
| `fingerprintScope`    | `recovery-source-and-build-v1`                                     | 同 A                                                               | 一致                                 |
| `sourceFingerprint`   | `fc45a78c115063c9fb0ff841bfcdb65274f2c87c55594eae58b42a6bc8088f6e` | 同 A                                                               | 一致，且与本轮当前源码重算相符       |
| `buildFingerprint`    | `4de32c02ce28d8c17a5a69c937f7eaab546183d3aed9e29fe809b1a55a176a7f` | `159c636d2a5c7574e52cce0ddb0667ef7f435baa10e40277f95be0510a4330d7` | 不一致，仍待查明                     |

A 的 `prepared` 为 `true`；B 结果格式正确，`independentOsEnvironment`、`restored`、`emptyAccessLedger`、`wrongPassphraseRejected`、`tamperedPackageRejected` 五项均为 `true`。用户此前还回传了同一 runId 的 `SUCCESS: Verify` 终端输出。由此确认本轮独立环境恢复、合成数据校验、空访问台账及错误口令/篡改拒绝均成功；不再将其记为“仅接收就绪”。

原报告文件 SHA-256（核对回传证据身份，不是包签名或构建摘要）：

- A：`f362b430554a2027d162a99fe5e36f3e412844d88c38aabe56ff2de7afb90cc5`。
- B：`8bde24c6b49e1ee55eb9d4e6583829c0e71b44beb4474135746777cd387ccad6`。

### 构建差异调查与剩余条件

只读重算当前本地四包 `dist/**/*.js`：共 138 个，完整摘要与 A 报告一致。随后使用当前 Node `v24.22.1` / TypeScript `5.9.3`，按现有四包配置、仅覆盖 `--outDir` 编译到新建系统临时目录；未清理或覆盖仓库 `dist`。新构建共 136 个 `.js`，这些同名文件与当前本地构建逐文件规范化比较均一致，但少了两份已无对应 `.ts` 源码的旧产物：

- `packages/common/dist/atlas-vault-secret.js`。
- `packages/core/dist/templates/model-designer/initializer.js`。

临时新构建摘要为 `0b6a148d3bab8074aee27d78bf78ba8d6480042c99108a78b250ece3e11d98e1`，仍不等于 B 摘要；仅凭两份旧产物不能解释全部差异。`tsc` 不自动清理已删除源文件的历史输出，源码摘要相同也未覆盖全部包构建配置与编译器信息，因此不能据此推断构建等价、篡改或 Node 版本是根因。临时比较目录已清除，仓库旧产物保留。

初版多行诊断命令在用户复制时变为单行，PowerShell 返回 `UnexpectedCharactersAfterHereStringHeader`，尚未执行 Node；不影响已有恢复结果。随后新增 [单行调用的构建诊断脚本](../../scripts/security-recovery-build-check.mjs)，运行 `node scripts/security-recovery-build-check.mjs` 即生成全新临时 `build-check.json`，记录四包/逐文件的规范化摘要、无对应源码的路径、固定编译配置摘要和 TypeScript 版本。脚本拒绝编译目录链接，只读取代码而不加载配置/服务，无构建或清理行为；输出不包含代码正文或秘密。此独立 `.mjs` 不在已有演练源码摘要清单内，同步它不改变原演练的源码摘要，不要求重做演练。收到 B 报告后按实际差异决定是否需进一步比对或统一构建复验，不通过修改报告/忽略不明文件消除差异。

诊断脚本的本地结果已归档为 [A 当前构建清单](evidence/SEC-M6-D09/build-check-A.json)，138 文件、摘要与原 A 报告一致。另在新建合成代码目录运行脚本，验证摘要聚合兼容、逐文件/配置摘要、CRLF 规范化、缺源码标记、中文临时目录、其他工作目录调用、重复生成报告不覆盖、参数错误、代码目录链接拒绝、私有哨兵内容不进入报告及既有构建内容不变，均通过；该合成目录已清除。涉及脚本限定 ESLint/Prettier 通过。两份用户原报告按字节归档，未为格式化改写其证据身份。

文档收尾：58 个本地链接、20 项任务/16 项完成计数及两份原报告字节摘要核对通过；涉及文档/本地诊断 JSON 格式和 `git diff --check` 检查通过。B 诊断尚未回传，不把本地工具校验当作差异已闭合。

M6-A1 已有用户两台设备恢复功能成功证据；构建一致性证据尚未闭合，**S6.1 继续待验证，5/7 里程碑、16/20 开发任务不变**。S6.2 完成，S6.3 进行中，SEC-M7 未开始；整仓既有类型问题与 reset 中断工具限制未解除。本轮只新增诊断工具，无服务端业务实现变更，不重跑恢复安全回归或整仓 `check`；D08 的 34/34 证据保留，不能表述成本轮重跑。所有新增操作限于脱敏报告、源码/编译目录的读取、新建临时编译输出、诊断工具及文档更新；真实 9091、真实配置、凭据、密钥、Vault 和业务库未触及。
