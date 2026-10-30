# 安全 V1 构建、安装与切换指南

D34：发行/切换前最后的实际设备门槛仍未关闭；按[双机手册](windows-device-drill-guide.md)运行新的隔离源码演练。支持Windows/Node24/Chrome或Edge，D34本机烟测使用Chrome，Edge及双机需实际报告。运行冻结源码、全新Designer、独立profile与专用TLS，不覆盖dist、不安装系统信任，不等同于新发行包安装复验或真实部署。总证据的preparation-passed-device-pending仅代表准备验证通过；新增扩展仍22/23。

本文面向 Windows 实例所有者与发布维护者，配套[功能简介](overview.md)、[使用手册](user-guide.md)和[唯一验收台账](../security-v1-milestones.md)。研发验收与实际发布、实际服务切换分别记录。

## 1. 生成可检查的本地候选

在已安装仓库依赖的普通 PowerShell、项目根目录执行。命令每次创建新的系统临时目录，保留原 dist、真实实例及此前演练材料。

```powershell
node .\scripts\security-release-candidate.mjs
```

工具复制明确允许的开发文件，将七个包编译到新的输出目录，并对 shared/common/core/server 按现有发布规则使用 Terser 压缩。它生成 tgz，逐文件核对编译输出、包入口、声明文件、依赖版本和包内路径，拒绝 Vault、清除归档、实例配置及根运行安全目录。不会执行现有 `publish-workspaces.mjs`，也不会删除旧构建。

随后从这些 tgz 安装临时消费项目，检查 CLI、包管理器生成的 `modeldb-server` 入口和 TypeScript 消费入口。第三方依赖来自本机已安装代码的独立离线包，记录版本与摘要；这验证本地安装与运行，不代表 npm registry 可用性或一次联网依赖解析。安装使用 `--ignore-scripts`，再单独运行本包的 workspace 指南安装器；第三方安装脚本保持禁用。操作不会安装全局 CLI。

Designer、Data Studio、Web 均从允许的 `src/`、`public/`、入口和包声明复制到临时目录，再生成新的生产页面。工具显式关闭本地 Vite 配置和 `.env` 加载，不读取本地 HTTPS 证书；SDK/data-kit/data-ui/shared 指向本次临时编译输出，不要求先更新仓库 dist。原目录中未引用的历史输出不会复制进候选包。data-ui 的查询结果和导入失败面板样式随新包一起交付，不修改组件业务行为。构建输出只写入临时目录。

成功输出 `ReleaseRoot` 和 `release-candidate.json`。该 JSON 记录包、页面、文档、源码、第三方依赖的清单与 SHA-256。工具需要本地 TypeScript、Terser、三个前端的 Vite、tar 和 pnpm；未自动发现 pnpm 时，可通过 `MODELDB_PNPM_CLI` 指向本机已有的 `pnpm.cjs` / `pnpm.mjs`。不会联网下载缺失工具。

## 2. 复验候选

注册/公钥登录独立性能使用 `node scripts/security-performance-check.mjs explore`，随后登记 `registration.json`，再运行 `confirm <registration.json>`。完整逐行操作、固定样本、门槛、资源范围和失败处理见[性能手册](performance-guide.md)。它从当前源码生成新实例和公开页面，不覆盖原 dist，也不使用真实实例；先停止其他验收。原安装候选的生命周期/legacy 对照性能入口仍保留，但不代替 DR-P4.5 的注册/登录独立确认。原生洪泛中须实际经本机管道应用预览规则，之后确认并回滚，不能只检查健康接口。

DR-P4.3 提供新版安装与合成升级/停用专项入口，在普通 PowerShell、项目根目录逐行运行：

```powershell
node scripts/security-install-check.mjs
if ($LASTEXITCODE -ne 0) { throw "Install verification failed; preserve this run" }
```

也可用 `pnpm run test:security:install`。工具不接受真实配置/业务路径，每次生成新的 `ModeDB-Install-Check-*` 报告目录和 `ModeDB-Release-*` 候选。先实际离线安装七个 tgz、核对 CLI/bin、严格包类型及不带 Node 类型的浏览器 SDK 消费，再从安装后的压缩 JS 验证显式 V1→V5、旧凭据/密钥保留、注册关闭与登录停用、身份停用/重启/启用后新登录、访问重置与接收方历史。通过安装后的托管模块在随机回环端口读取新 Designer 产物；三端产物均按摘要核对。本项无页面改动，不代替浏览器视觉或实际 Hello/两设备验证。

最终 `install-check.json` 的 `ok:true`、`task:"DR-P4.3"`、候选/升级命令退出码 0、所有检查通过才算成功。报告绑定 `release-candidate.json` 的 SHA-256，运行前后重查包、前端、文档及开发源码。失败保留 candidate/upgrade 原始日志和目录，不沿用旧成功。缺依赖或工具时停止，不联网补装、不修改原 dist、不全局安装 CLI；脱敏反馈只提供报告及必要日志，不上传整个临时实例。

旧 reader 演练将仓库冻结的 V1 原源码按固定摘要编译为 JS，使用当前安装包的底层保护/文件辅助模块：先证明它可读合成 V1，再确认拒绝 V2—V5 且保护文件原字节不变。这是已知旧台账 reader 的兼容检查，不是任意历史发行包的完整二进制降级资格。未知未来台账/业务包格式拒绝；回退仍使用支持 V5 的程序关闭新入口，禁止改 version、删字段或恢复旧访问台账绕过撤销。注册窗口关闭不撤销原批准身份；authentication.enabled=false 关闭新公钥登录，不隐含撤销既有会话，须明确停用用户/凭据或撤销会话。

把下面路径替换为上一步实际输出的报告，保留引号。无需运行真实实例。

```powershell
node .\node_modules\tsx\dist\cli.mjs .\scripts\security-release-verify.ts "<ReleaseRoot>\release-candidate.json"
node .\scripts\security-release-regression.mjs
$env:MODELDB_TEST_APP_ROOT = "<ReleaseRoot>\apps"
node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 .\test\integration\security-browser-apps.test.ts .\test\integration\security-asset-browser.test.ts
Remove-Item Env:MODELDB_TEST_APP_ROOT
```

候选验证先核对 tgz 及实际安装文件摘要，再用真实 Windows DPAPI、随机端口和合成库检查独占启动、配对码消费、HttpOnly、限权拒绝、本机网络修复、备份恢复、主密钥维护和撤销。所有凭据均在临时实例中创建，验证报告只保存检查结果与时间，不保存秘密或合成记录正文。

回归入口运行全部 `test/unit/*.test.ts(x)` / `*.test.mjs` 和六个引擎集成脚本。报告记录实际 pass/fail/skip/cancelled/todo；出现跳过、取消、待办、缺失统计或非零退出时返回失败。单元测试在代码根解析子进程入口，各实例由测试创建独立临时目录；引擎集成脚本的工作目录固定为新临时目录，其相对 `data/` 因而位于临时目录内。浏览器复验使用上述三个新页面、独立 Chrome profile 和随机端口。缺 Windows/Chrome 时的 skip 不算验收通过。失败时保留报告与现场，按退出码和日志解决，不手删锁或阻断标记。两台 Windows 已完成的独立恢复证据沿用 SEC-M6 / D09—D11；这些本地命令不再声称产生第二台设备的成功证明。

性能比较包含已初始化实例启动、1000 行查询、同步持久化单行写入，以及 1010 行真实 Excel 导出。三轮交替 legacy/registry 顺序，查询预热后采样；先停止其他测试再测量。两组均使用当前候选、新加密 Vault、同一 SDK 和数据。legacy 组仅用于测量授权/同步审计增加的成本；该组不作为安全部署配置。它不是旧版本二进制与新版本的历史对比，也不能代表真实业务容量、远程 TLS、并发或硬件断电性能。具体测量和研发门槛见最新交付报告，首次基线不用于承诺生产 SLA。

首轮 Windows 探索性测量显示，registry 的同步审计/OS 保护带来明显成本：查询与持久写入约为秒级，不能宣称与 legacy 延迟相近。本轮在该基线之后、独立确认之前登记本机回归的 p95 上限：启动 10000ms、1000 行查询 4000ms、持久单行写入 4000ms、1010 行 Excel 导出 5000ms。超限会保存报告并返回失败；更换硬件或工作负载需要重新评估基线。这些宽限仅用于检测当前 Windows 实现的回归，不代表低延迟、高并发或生产容量验收。当前每次台账提交仍调用 OS 保护并同步落盘，后续吞吐优化需独立设计和安全复验。

## 3. 隔离新实例安装与配置

### 全量安全与业务回归（DR-P4.4）

在 Windows、依赖和 Chrome 已就绪的普通 PowerShell、项目根目录运行 `node .\scripts\security-full-check.mjs`，或 `pnpm run test:security:full`。它自动运行全部单元、六引擎流程、同一份全新三端页面的 9 项浏览器与另 13 项原生集成，并执行 Server/限定测试、三前端、SDK DOM 消费和 browser bundle 类型/边界检查。无需传真实配置，不覆盖原 dist，不加载本地 Vite/env 或安装系统信任。

总报告绑定源码 SHA-256 和浏览器候选摘要；源码变化、缺组、非零退出、超时、缺统计或 skip 都拒绝成功。公开页面/日志执行有界已知秘密模式扫描，恢复/认证用例另核对动态生成秘密不外泄，不宣称识别所有任意秘密。普通备份不回滚停用与接收方历史；独立恢复保持空访问台账。成功标准与日志位置见[使用手册](user-guide.md#dr-p44-隔离全量验收)。本入口不重跑七包离线安装，也不执行独立性能、真实 LAN/Hello 或两台设备验收。

### 新实例配置

首次使用应选择全新专用目录、与真实服务不同的端口。核对候选摘要、Node/Windows 版本、运行账号和目录空间；先用报告中的临时消费项目验证，不直接覆盖已安装服务。候选包仍沿用仓库版本号，版本号本身不足以标识本轮内容；以清单和摘要定位。对外发布前需要单独确定新版本号、发布目标与授权，再重新构建和安装验证。

初始化配置时显式传入新目录：

```text
modeldb-server start -c <new-isolated-home> --host 127.0.0.1 --port <unused-test-port>
modeldb-server security status -c <new-isolated-home>
modeldb-server security help
```

首次启动生成 `security: { "version": 1 }`，没有默认网络 Token。配置路径所在目录负责 security/cache/logs，`workspace` 只负责逻辑库。具体字段见[配置指南](../modeldb-config-guide.md)，跨机器访问需可信 HTTPS/WSS、准确公开地址和 Origin；来源白名单不能代替身份。服务需以能够解封本机 DPAPI 的账号运行，不从管理员窗口修正归属，也不通过放宽 ACL 绕过保护。

先用所有者本机入口建立身份、配对安全中心、选择业务库，再给应用签发明确库或准确发布版本的凭据。分别验证无权限、越权、到期/撤销与正常调用。备份自动调度默认关闭，启用前确认空间、保留策略和恢复材料覆盖范围。默认审计保留 365 天、最多 10000 行；匿名观察计数与保存行数不同，见[手册 §2.1](user-guide.md#21-高频拒绝事件的计数)。

## 4. 真实切换执行清单

本节是未来获授权后的操作清单。当前研发不执行服务停机、真实目录读取、凭据轮换、数据转换、npm 发布或端口接管。

1. 由实例所有者确认准确服务、账号、配置、库清单、客户端版本、端口和维护窗口；在受保护材料中记录这些内容，避免放进 Git。冻结写入并分别保留原程序、依赖锁、配置、原始库和必要旧秘密的可恢复快照。
2. 在全新隔离目录验证快照可读及备份/恢复闭环。旧 Vault 遇到明确格式拒绝时保留源文件。V1 不自动转换旧库；选择新格式重建，或使用已验证、适用该源格式的业务导出/导入路径。不能直接复制旧密文后改后缀、配置或删除标记。
3. 为新实例建立独立配置、实例身份、DPAPI 保护及恢复材料。旧 `connectToken` 不会变成 registry 主体，原应用、设备和会话需要重新授权、重新配对；资产导入接口保持禁用，审核后重新发布并授权准确目标版本。
4. 在预定的新端口验证客户端、Query/Operation/Binding、关系和分页、Pivot/Excel、名单误锁本机修复、备份恢复及撤销；核对数据数量与关键业务结果。测试通过后，才按单独获授权的步骤停止旧服务、切换路由/端口与客户端，记录实际时间、版本摘要和回执。
5. 切换后确认审计可持久化、无意外来源、错误率和磁盘空间正常，抽查查询、持久写入、导出与恢复。保留旧现场至所有者确认保留期限结束，清理另行授权。

## 5. 回退边界

- 切换前失败：保留新隔离现场及诊断，继续使用独立保存的旧程序和旧数据；不要覆盖旧实例。
- 新实例尚无新增业务写入：停止新实例后，仅通过已验证的原程序、原配置和原数据快照恢复旧服务。新凭据不授予旧服务权限。
- 新实例已有写入：先冻结并保全新数据，评估显式业务导出/合并；恢复旧快照会丢失快照之后的写入，不能把它称为无损回退。旧程序不得打开或写入新格式 Vault。
- 普通单库备份恢复保留当前访问台账。整实例独立恢复建立空访问台账，重新建立身份；不得恢复旧台账来复活已撤销 Token。清除中断、双库资产中断分别按[手册](user-guide.md)的认证续跑流程处理，不删除锁、任务或 tombstone 强行启动。

当前安全发布平台验收为 Windows。本地 DPAPI 归档需要原账号；变更系统/服务账号或异机恢复走独立恢复材料及新授权流程。进程退出与注入 ENOSPC 的测试不等于物理磁盘耗尽或硬件断电实测。其他平台、外部不可变审计、联合身份和多节点密钥服务需单独适配与验收。

## 6. Git 同步后的交付证据核对

普通 PowerShell、项目根目录执行 `node .\scripts\security-release-evidence.mjs`。退出 0 且 `ok: true` 表示当前开发文件和归档验收证据一致；它不启动服务、不读取实例材料，也不重新运行功能或性能测试。源码和文档仅允许 CRLF/LF 换行差异，正文改变会失败；验收报告及原始副本严格核对字节摘要，`.gitattributes` 防止 Git 自动转换证据换行。代码已修改时应重新验收并登记新快照，不能直接改摘要使检查通过。

当前核对入口优先使用 SEC-M7 / D11 快照，分别检查本轮候选、回归、浏览器、安装/性能和静态验证材料。最新快照缺项或未通过时失败，不回退到旧成功结果。D02—D10 作为历史证据保留，旧源码摘要不会随本轮修复重写；输出中的 `historicalUnitPass` 等字段属于历史记录，`currentRevalidation` 才表示本轮记录核对结果。SHA-256 用于检查内容一致性，不等同于发布者数字签名或实际部署成功。

根 `security/` 已加入 Git 忽略规则。D04 只根据 Git 路径元数据从当前索引移除了四条运行材料引用，磁盘文件没有读取或修改；提交时这些记录显示为删除，表示取消版本跟踪。`pnpm run check:sources` 及现有提交钩子新增路径检查，即使强制加入被忽略材料也会拒绝。历史提交仍可能含材料，不能仅凭目录未同步或当前跟踪数为零判断从未暴露；历史清理、真实秘密轮换及暴露范围核查需单独授权。真实配置、恢复材料和业务文件继续留在专用实例目录，不放进源码提交。

## 7. 一条命令试用 Model Designer

在已安装依赖的项目根目录、普通 PowerShell 中执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\security-designer-sandbox.ps1
```

首次会生成全新的本地候选并验证安装内容，再创建系统临时实例，启动随机 loopback 端口的 Server 与生产 Designer 页面。自动验证一次性配对、HttpOnly、重放拒绝、授权查询与匿名拒绝后，通过既有本机启动器打开浏览器。选择 `security_demo` 进入；其中只有一个 `DemoItem` 模型和一条示例记录。设计器专属库独立于业务库，不使用原业务目录。构建可能需要几分钟；本机 pnpm 自动发现失败时按第 1 节指定已有工具路径。

保留窗口运行，按 Ctrl+C 关闭本次隔离 Server 和页面服务，临时文件保留；再次执行会创建另一个新实例，不复用原配置。临时目录不适合作为正式业务存储。脚本没有接收真实配置或业务路径的参数，也不会连接真实 9091。可以用 `-Smoke` 执行连接验证后自动退出；`-NoOpen` 保留服务但不打开浏览器。已生成的候选可通过 `-Candidate "<ReleaseRoot>\release-candidate.json"` 指定；只接受系统临时目录中本工具生成的候选结构。

该命令完成的是新版功能试用，不是旧业务库迁移。真实切换仍须先明确源实例、目标目录、备份验证、停机窗口和回退条件。不能把历史版本中可能存在的运行材料自动当作已失效，也不能把试用成功视为原业务数据已升级。

## 会话模型升级边界（DR-P2.1）

D18 当时新增 V3 三类会话父级模型，仅提供 Server 内部显式 CAS 迁移，不提供真实升级命令。普通 open 仍读取 V1/V2，现有注册配置不会迁移到 V3。原 Token/配对保留；D19 的公钥登录及 V4 升级另见下节。V3 旧 reader 应拒绝，禁止删 parent/kind 或改 version 进行二进制降级；冻结 V1 reader 已执行拒绝测试，完整旧 V2 发行包安装与降级未验证。回退应保留现场，离线核查迁移前完整副本与匹配程序，不能用旧访问台账覆盖运行中的新实例；恢复空访问台账后重新授权。数据密钥、Vault、备份和资产包格式不变。详见[兼容契约](device-registration-protocol-contract.md#12-dr-p21-会话父级与持久兼容模型)。

## 公钥登录持久升级边界（DR-P2.2）

D19 增加 V4：省略 authentication 或 enabled=false 不迁移；显式 enabled=true、已验证的 registration.descriptor 和 allowStorageMigration=true 才可从 V1/V2/V3 原子升级。现有 Token、授权、撤销、实例与数据密钥保留。完成后即使关闭登录或注册仍保持 V4；禁止通过改 version、删除扩展字段或重建密钥降级。旧 V1—V3 reader 按契约应拒绝 V4，完整旧发行包降级/发布安装未验收。先在隔离副本验证，真实升级/切换另行授权。步骤与失败处理见[登录手册](device-registration-runtime-guide.md#8-公钥登录与浏览器会话dr-p22)。

## 接收方台账兼容（DR-P4.1）

本机明确确认才能把 V4 升级为 V5，普通打开、注册和登录开关均不自动升级。V5 增加接收方公钥历史与单次持有挑战，保留原授权/会话和数据密钥；旧程序不应写入 V5，禁止改版本号或删字段降级。完整发行安装及旧程序兼容/停用演练仍属 DR-P4.3，本轮源码/页面验证不替代安装验收。停用登录不删除历史解密材料，访问重置另退役活动接收方；空访问恢复仍须重新核验。操作见[运行手册](device-registration-runtime-guide.md#18-接收方加密公钥与离线持有证明dr-p41)。

DR-P4.2 在源码离线 CLI 增加 recipient-list 与准确接收方导出：V5 不再接受 backup-export / asset-export 的裸 --public-key 回退，须携带五项接收方选择和确认；V1—V4 原 PEM 入口保留。源实例停机，每次导出前重新列表。三种迁移/资产包格式和导入方式不变，升级不重新加密历史包；旧包仍须原私钥，登录停用不撤回已发包。逐行步骤与结果未知核查见[第 19 节](device-registration-runtime-guide.md#19-按已核验接收方离线交付dr-p42)。本项验证不替代 DR-P4.3 的新发行安装和升级/停用演练。
