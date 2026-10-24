# SEC-M7 交付报告

- 交付日期：2026-10-24（Asia/Shanghai）
- 里程碑：SEC-M7 / 集成验收与发布准备
- 修订：D03（D01、D02 原验收记录保留）
- 技术状态：S7.1、S7.2 与 SEC-M7 完成；累计 7/7 里程碑、20/20 任务，真实发布/切换未执行；功能验收见 D02，交付复核见 D03
- 用户反馈：用户要求开始下一步；本轮验收反馈待收集
- 代码定位：基于 `cde9c14680b8dd26cde7f65d16ac8c4cf2a4b0dc` 的未提交工作区；接续时已有 SEC-M6 / D11—D12 改动与证据全部保留，不将该基线 SHA 当作本轮交付提交
- 本次任务：D01 / S7.1 安全与故障验收；D02 / S7.2 全流程回归与发布准备

## 交付内容

### 清除归档验证、续跑与隔离恢复

新增 [reset-recovery.ts](../../packages/server/src/security/reset-recovery.ts) 和三个离线 CLI：`factory-reset-verify`、`factory-reset-resume`、`factory-reset-restore`。兼容 SEC-M5 的 `.mdreset` v1，本机原 Windows 账号通过 DPAPI 解封并验证 AES-GCM、字段/编码/摘要/容量与路径。显式 `-c`、原实例 ID、原 workspace 和固定归档位置必须匹配；删除目标来自配置与确认参数，不能由归档路径选择。原 `factory-reset` 同样要求显式配置。

续跑认证原 tombstone，持有实例、维护及归档恢复 lease，预检全部剩余目标后复核删除。新增或被修改的文件、链接、错误标记、错误确认、活锁均拒绝；不手删现场绕过验证。最初 marker candidate、提交日志、部分删除和回执中断均可恢复。完成后保留原归档及回执，最后移除阻断标记；已无标记的完成任务不提供重复续跑成功语义。

恢复只写全新且不重叠的隔离目录，先标记阻止启动，恢复业务内容及历史数据密钥；排除旧 `registry.mds` / `registry.ready` 和各自提交侧文件（大小写不敏感）。新副本使用空访问台账，旧凭据、会话和网络状态不复活。失败副本保留标记，用另一个新目录重试；原现场和原包不改变。这是同账号本机清除归档恢复，不替代已验收的 S6.1 独立灾备。

测试：[清除恢复](../../test/unit/security-reset-recovery.test.ts)、[硬退出子进程](../../test/fixtures/security-reset-child.ts)。包含真实 Windows DPAPI CLI 验证/恢复/续跑、合成加密 Vault 读回、10 个原清除硬退出点、4 个恢复工具再次硬退出点、篡改/路径/大小写/新文件/改动/锁/junction 拒绝及失败副本隔离。

### 匿名拒绝洪泛的有界聚合

[安全台账](../../packages/server/src/security/security-registry.ts)对未认证拒绝按 UTC 60 秒、来源与归因、原因、入口、HTTP/WS、策略版本和规则分组。每组保留首次/最后时间、准确持久化观察次数、一行明细和最多三个请求 ID 样本。每窗口至多 `min(128, max(1, floor(maxEvents / 4)))` 个键，使用 80% 容量后拒绝新增匿名键，保留管理空间；已认证与管理/数据事件继续逐项记录。

[公共契约](../../packages/shared/src/security-contracts.ts)与安全中心 zh/en/ja 同步展示观察次数、保存明细及被抑制明细，事件行显示该组观察次数，JSONL 保留聚合元数据。页 total 保持行数，分类/结果统计使用观察次数。时钟倒退不会产生 first > last；来源属性顺序不影响分组。每请求计数仍同步原子落盘，无异步队列，不声称洪泛吞吐提升。失败或容量拒绝的请求不计入已持久化观察；时间筛选按最后观察时间，样本以外的请求 ID 不支持逐项追溯。

[故障专项](../../test/unit/security-fault-acceptance.test.ts)覆盖 200 次同组拒绝、重启续计、分组隔离、容量预留、注入 ENOSPC、75 次伪造代理头的 HTTP 拒绝/503、10000 个来源窗口和 1000 项封禁的容量/过期回收。

### 整仓检查修复与文档

修复此前根 tsc 的 DOM / ImportMeta.env 环境、过时 fixture、只读对象构造、路径后缀、未使用导入及 Node ws/浏览器事件公共结构类型；保留严格检查，没有关闭检查或加入 any 回避。SDK 变更仅为事件适配器结构类型，运行逻辑不变。受影响的 HTTP/Pivot/导入导出等 7 个测试文件 23/23 通过；涉及真实业务工具的 `test-modeldb-tools.ts` 只检查类型，没有运行。

ESLint 仅忽略根运行时 `security/`。原 Prettier 通配符即使有 ignore 仍会在展开时扫描受保护运行目录，因此改为 [check-format.mjs](../../scripts/check-format.mjs)：Git 枚举开发文件，在目录扫描前排除根安全目录，再沿用 `.prettierignore` 检查全部适用文件，包括未跟踪的新代码；没有扩大 test/templates 的既有排除范围，也没有批量格式化其他源码。根类型、lint 和格式门槛均恢复可运行。

新增可重复入口 `pnpm run test:security:fault`。同步[使用手册](../security-v1/user-guide.md#61-出厂清除中断验证续跑或恢复副本)、[功能简介](../security-v1/overview.md)、[审计契约](../security-v1-identity-contract.md#审计失败和容量)、[归档契约](../security-v1-vault-contract.md#10-出厂清除归档恢复s71)、方案、测试说明、专项指南及唯一里程碑台账；SEC-M5/SEC-M6 的历史结果原文保留，本修订关闭其对应后续缺口。

## 验证结果

脱敏[验收摘要及工作区文件摘要](evidence/SEC-M7-D01/acceptance.json)记录实际环境、结果、边界和本轮关键源码 SHA-256；不是 Git 提交，也不含恢复包、口令或业务正文。

| 检查              | 实际结果与范围                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 完整隔离安全回归  | 21 文件 **193/193 通过、0 skip，192.2 秒**；覆盖 M1—M6 与本轮最初 25 项故障用例。执行后补了归档位置预检/大小写回归，用下行最终定向结果覆盖；不把两个结果相加为独立用例数                                                                               |
| 最终故障专项      | **26/26 通过、0 skip，32.4 秒**；包括收尾路径/大小写与真实 DPAPI CLI，14 个进程退出点                                                                                                                                                                  |
| 类型修复影响回归  | 7 文件 **23/23 通过、0 skip，14.8 秒**；HTTP 数据传输、接口传输、Pivot 与配置路径                                                                                                                                                                      |
| 整仓检查          | `pnpm run check` **通过**，源码边界、各包构建、根 tsc、ESLint（0 error、44 条既有 warning）和格式检查（583 个开发文件）通过；收尾文档另作限定复验                                                                                                      |
| Designer / Chrome | 独立类型检查、最新 Vite 生产构建通过；保留大 chunk 提示。真实 Chrome **1/1、0 skip，205.8 秒**：聚合计数/事件行、760px 布局、三前端配对/刷新/HttpOnly/登出及规则预览/确认/回滚、主密钥维护通过。其余两个前端复用已有构建，不当作 S7.2 全新发布构建证据 |

最初 `pnpm run check` 因本轮测试 fixture 的 ban reason 字面类型不匹配失败，修正后通过。新增源码 lint 首轮缺少花括号，已按原规则修复。原全局格式 glob 因扫描运行安全目录失败，未读取其中内容，修复文件枚举后通过。沙箱内 Vite 不能读取已安装 exceljs；同命令获沙箱外执行后通过。`pnpm run test:security:fault` 的沙箱入口触发 pnpm SQLite store 不可访问，使用本地 node/tsx 等价执行得到 26/26；未修改依赖声明或锁文件。上述失败均保留，不将环境故障算作功能通过。

收尾：91 个本地文档链接/锚点、20 项任务/19 项完成计数、16 份源码摘要一致性、585 个开发文件格式、server 构建、限定源码 ESLint 和 `git diff --check` 通过。保留所有接续前的工作区改动、SEC-M6 证据和原旧产物。

核心实际命令：

```powershell
pnpm.cmd run check
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p apps/model-designer/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/sdk/tsconfig.json
node node_modules/tsx/dist/cli.mjs --test test/integration/security-browser-apps.test.ts
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=2 test/unit/security-reset-recovery.test.ts test/unit/security-fault-acceptance.test.ts
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=3 test/unit/data-kit-relation-bind.test.ts test/unit/data-transfer-http.test.ts test/unit/interface-transfer.test.ts test/unit/pivot-display.test.ts test/unit/pivot-interface-http.test.ts test/unit/pivot-sources.test.ts test/unit/server-config-path.test.ts
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=4 test/unit/security-vault-v2.test.ts test/unit/security-windows-keys.test.ts test/unit/server-directory-layout.test.ts test/unit/security-registry.test.ts test/unit/security-authorization.test.ts test/unit/security-network.test.ts test/unit/security-browser-session.test.ts test/unit/browser-connection-credentials.test.ts test/unit/interface-call-docs.test.ts test/unit/security-protection.test.ts test/unit/security-registry-http.test.ts test/unit/security-recovery.test.ts test/unit/security-recovery-drill.test.ts test/unit/security-backup.test.ts test/unit/backup-management.test.ts test/unit/backup-management-http.test.ts test/unit/security-asset.test.ts test/unit/security-designer-asset.test.ts test/unit/security-designer-references.test.ts test/unit/security-reset-recovery.test.ts test/unit/security-fault-acceptance.test.ts
# 在 apps/model-designer 中执行
node node_modules/vite/bin/vite.js build
```

## 里程碑验收与后续

| 验收 ID | 状态             | 证据与剩余范围                                                                                                       |
| ------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| M7-A1   | S7.1 范围通过    | 前六阶段 193 项隔离安全回归、最终故障专项和整仓检查；M6 用户异机证据沿用 D09—D11，不要求重做。整体发布状态待 S7.2    |
| M7-A2   | 部分通过         | 并发初始化、配对/撤销、HTTP/WS、名单回滚/本机修复、密钥/备份/恢复均有本轮回归；全新安装构建及全链路交付演练留在 S7.2 |
| M7-A3   | 待 S7.2 总验收   | 本轮受影响的 HTTP、Pivot、导入导出等 23 项通过；不据此宣称全部 Designer/Query/Operation/Binding/Excel 已完成整体验收 |
| M7-A4   | 安全故障部分通过 | 越权/伪造/撤销、洪泛/容量、注入 ENOSPC、进程退出和恶意包可复现；性能前后对比由 S7.2 提供，未做物理磁盘耗尽/硬件断电  |
| M7-A5   | 待 S7.2          | 本轮 CLI/i18n/恢复手册已补齐；隔离全新输出、打包清单、安装/切换/回退材料尚未验收                                     |

**S7.1 完成，累计 6/7 里程碑、19/20 开发任务；SEC-M7 进行中，下一为 S7.2。**S7.2 仍须按 SEC-M6 / D11 用隔离全新输出构建并核对发布清单，原旧 dist 保留；完成完整功能回归、性能基线与对比、可安装产物及切换/回退说明。

全部测试使用系统临时合成目录、显式配置、随机端口和独立 Chrome profile。未连接或切换真实 9091，未读取/修改真实配置、凭据、密钥、Vault 和业务库；未改真实 ACL、未清理旧 dist、未提交、推送、部署或发布。物理磁盘耗尽和硬件断电不在本轮证据范围内。

## D02：S7.2 全流程回归与发布准备

日期：2026-10-24。基于相同 HEAD 的未提交工作区，保留 D01、SEC-M6 / D11—D12 以及接续时全部既有改动。以下为本轮新增交付，D01 的历史结果、未执行范围和当时状态保持原样。

### 全新候选与可重复验收

新增 [security-release-candidate.mjs](../../scripts/security-release-candidate.mjs)、[security-release-verify.ts](../../scripts/security-release-verify.ts) 和 [security-release-regression.mjs](../../scripts/security-release-regression.mjs)，对应根脚本 `security:release:prepare`、`security:release:verify`、`test:security:regression`。具体命令见[构建、安装与切换指南](../security-v1/release-guide.md)。

候选每次创建新临时目录，从允许的源码和当前声明生成七个包，shared/common/core/server 沿用现有 Terser 发布压缩规则。实际输出 **202 个 JS、包内合计 587 文件**；tar 清单与本轮编译输出完全对应，入口、声明、包内路径、workspace 依赖替换与逐文件摘要均核对。原 dist 及其历史文件保留，没有把它整体复制为候选。

七个 tgz 实际离线安装到独立消费项目，验证 CLI、包管理器生成的 `modeldb-server` bin、当前安全命令帮助、workspace 指南安装器与严格 TypeScript 消费检查（`skipLibCheck: false`）。第三方使用本机已安装代码的 **74 份离线依赖快照**，包含消费测试所需的开发类型；记录版本与 SHA-256。未验证 registry 联网解析或执行第三方安装脚本。安装使用 `--ignore-scripts`，仅随后显式执行本包 postinstall 安装器；没有修改依赖版本或锁文件。

实际消费验证发现 shared/common/core/sdk/data-kit/data-ui 六个包的 `types` / `exports.types` 仍指向 `.ts/.tsx` 源码，会让消费项目继续编译包内实现并产生 React/ws 类型错误。已统一指向各自真实生成的 `dist/index.d.ts`，复验通过；运行入口与业务行为不变。三个前端全部在新目录生产构建，依赖的 SDK/data-kit/data-ui 当前输出逐文件与全新编译对齐；发现过期 SDK 格式输出后只重建对应包，没有删除旧输出。

同步[功能简介](../security-v1/overview.md)、[使用手册](../security-v1/user-guide.md)、[配置指南](../modeldb-config-guide.md)、server README 和实际安装的 workspace 指南。明确 registry 默认身份、HTTP/WS 路径、浏览器短会话、Windows 平台、旧格式保留、新授权以及切换/回退边界。对照 CLI 帮助核对手册中的命令，zh/en/ja 的安全/审计/网络/维护 **157 项键全部对应且非空**。

### 完整功能链与既有测试修复

从安装后的压缩产物执行真实 Windows DPAPI 合成实例：独占启动、准确库授权、跨库拒绝、一次性配对/重放拒绝/HttpOnly、本机规则预览/应用/回滚修复、单库备份恢复、主密钥维护后读回、凭据与浏览器会话撤销。不同 OS 环境的灾备成功沿用 SEC-M6 / D09—D11 用户证据，本机命令不冒充新的异机成功验收。

全量回归入口覆盖 **63 文件、424/424 单元测试、0 skip，274.8 秒**，包括前六阶段安全、清除恢复/故障、Designer、Query/Operation、Binding、关系/分页、Pivot、模型图和 Excel。六个引擎流程全部退出 0：`e2e-engine-workflow`、`relate-conserved-forest`、`children-tree-query`、`group-lateral-attach`、`multi-branch-network`、`protocol-operations`。

单元测试在代码根解析硬退出子进程，各实例继续使用现有 mkdtemp 合成 fixture；六个引擎脚本改由验收入口从新临时 cwd 执行，其相对 `data/` 写入留在临时目录内。新入口显式传递 tsconfig 和依赖解析环境，避免临时 cwd 导致 `tsx`、子进程入口或 `@mode-db/server` 找不到。未运行任何 `live-check`、仓库业务工具或真实路径脚本。

完整检查还发现两份既有测试已落后于当前契约：Binding catalog mock 未提供当前 `batchRegister`，JSON 协议关系断言错误读取 `row.data.relates`。分别修复为批量 mock 和真实 `WireEntityNode.relates`，保留原有 schema、行数和关系数量断言；未改变引擎来迎合测试。

真实 Chrome 最终 **2/2、0 skip，318.3 秒**。三份全新生产页面完成配对、工作区、刷新恢复、HttpOnly、注销；Designer 安全中心覆盖独立管理入口、事件聚合计数、760px 布局、规则预览/应用/确认/回滚和主密钥维护。另一浏览器用例完成资产导入后的禁用审核、重新发布、目标准确版本授权、跨库/原始/系统拒绝、撤销及重开。独立性能确认与全部必需验证均通过，S7.2 / SEC-M7 完成。

### 性能方法与门槛

探索性基线保留在 [performance-exploratory.json](evidence/SEC-M7-D02/performance-exploratory.json)。在它之后、独立确认之前登记本机 p95 上限：已初始化实例启动 10000ms、1000 行查询 4000ms、同步单行持久写入 4000ms、1010 行 Excel 导出 5000ms。工具超限返回失败且保留报告，不能通过删除慢样本产生成功。该门槛只用于当前实现的本机回归，不是生产 SLA 或高并发验收。

两组均为当前压缩候选、相同合成数据、新格式加密 Vault 和 loopback HTTP SDK short；比较 legacy Bearer 路径与 registry 授权/同步审计路径，**不是历史旧版本二进制对比**。三轮 AB-BA-AB，每轮 5 次查询预热、20 次全量查询、10 次同步单行写入、3 次实际 Excel 编码/读回；启动三组样本不包含密钥生成和种子写入。最终测量在其他验收进程结束后单独执行，关闭两组 SDK 交互跟踪，保留正常 server 日志和 registry 同步审计；与探索性结果的日志/并行条件不同，不把两轮样本混合。

Windows registry 每次台账提交仍经 OS 保护并同步持久化，存在明显秒级开销。该实现没有异步审计队列，不声称延迟接近 legacy；后续若要求低延迟或高并发，应单独设计 OS 保护/台账持久化优化并重新做故障与性能验收。当前证据不覆盖 TLS 网络成本、重负载并发、生产数据量、物理磁盘耗尽和硬件断电。

独立确认使用 Windows `10.0.26300` / x64、Intel i7-14650HX、Node v24.15.0；原始样本保存在 [performance.json](evidence/SEC-M7-D02/performance.json)，全部 10 项安装/生命周期/性能检查为 true。性能数据未四舍五入后再判门槛：

| 工作负载                              | legacy 中位数 ms | registry 中位数 ms | registry p95 ms | 中位数比值 | 已登记 p95 上限 ms |
| ------------------------------------- | ---------------: | -----------------: | --------------: | ---------: | -----------------: |
| 已初始化实例启动（每组 3 次）         |             9.28 |            4760.67 |         4795.75 |     513.17 |              10000 |
| 查询 1000 行（每组 60 次）            |             9.21 |            1579.38 |         1747.57 |     171.47 |               4000 |
| 同步单行持久写入（每组 30 次）        |            10.69 |            1560.64 |         1692.82 |     145.96 |               4000 |
| Excel 导出 1010 行并编码（每组 9 次） |           105.86 |            1629.07 |         1801.57 |      15.39 |               5000 |

legacy 分母很小且启动仅三个样本，倍数不适合外推；registry 的绝对延迟仍是部署容量评估时必须考虑的限制。这里登记的是安全 V1 的可复现研发基线，不把显著性能差异隐藏成零开销，也不将通过本机门槛写成生产容量已通过。

### 环境与失败事实

最终候选使用 Windows、Node **v24.15.0**、TypeScript **5.9.3**、pnpm **10.33.0**；部分沙箱定向检查使用 Node v24.22.1。仓库 `packageManager` 声明仍是 pnpm 9.15.4，本轮没有把它写成实际已验证版本，也没有变更依赖或锁文件。整仓 `pnpm run check` 退出 0，保留 **44 条既有 lint warning、0 error**。追加证据时格式检查曾因两份性能 JSON 的数组格式失败，按仓库规则格式化后复验；原始字节报告另存 `.original.json.txt`，不重写其绑定摘要。

保留的失败包括：沙箱内 dayjs/exceljs 读取受限、浏览器 CDP 初始化超时；初版临时 cwd 缺少 tsx、tsconfig 及子进程代码相对入口；离线包管理器缺少 registry 元数据缓存；pnpm 在 bundled/system Node 下的发现路径、消费端 React 类型路径和旧源码类型入口。通过已安装依赖的独立离线快照、显式解析、正确声明入口和隔离的沙箱外验证解决，未通过改 ACL、联网下载、读取真实配置或关闭严格类型检查解决。工具开发过程中的失败不当作功能成功证据。

新增[发布指南](../security-v1/release-guide.md)给出完整安装/切换/回退材料：旧 Vault 不自动迁移，旧 Token 不转成身份，新格式不可交给旧程序写入；切换后有新增写入时回到旧快照不保证无损。候选沿用当前包版本号，正式发布前另定版本并重新生成/验收。实际 npm 发布、真实 9091 接管、服务账号变更和业务数据迁移均未执行，且不包含在本轮研发授权中。

### D02 最终验收与结项

脱敏[验收汇总](evidence/SEC-M7-D02/acceptance.json)、[发布清单](evidence/SEC-M7-D02/release-candidate.json)、[回归摘要](evidence/SEC-M7-D02/regression.json)、[浏览器结果](evidence/SEC-M7-D02/browser.json)与性能原始样本共同定位本次工作区及产物。最终文档结项后重新生成交付候选：七个 tgz、587 个包内文件、18 个前端文件和 239 份源码摘要与受测候选完全一致，只更新简介与手册的结项说明。74 份第三方快照的 tar 容器字节不同，逐文件核对其中 2758 个路径和内容全部相同，未仅按版本号认定等价。原验收候选清单与性能绑定保留，见 [equivalence.json](evidence/SEC-M7-D02/equivalence.json)、[受测原始清单](evidence/SEC-M7-D02/tested-release-candidate.original.json.txt)及[性能原始报告](evidence/SEC-M7-D02/performance.original.json.txt)。

最终候选目录为 `C:\Users\51153\AppData\Local\Temp\ModeDB-Release-CSAzAx`，其中 `artifacts/` 保存七个可安装 tgz，`apps/` 保存三份生产页面，`docs/` 保存四份用户文档，`consumer/` 是已验证的离线安装项目。目录属于临时验收产物，后续发布前须重新生成并验收；没有把 tgz、恢复包、合成实例或原始测试日志纳入本次文档证据。

收尾复验：整仓 `pnpm.cmd run check` 退出 0，包含包构建、根类型、源码边界、ESLint（0 error、44 条既有 warning）和 596 个开发文件格式检查；11 份文档的 144 个本地链接/锚点、20 项任务计数及 `git diff --check` 通过。验收证据共 11 份，保留原始候选和性能报告字节及对应 SHA-256；最终汇总记录关键源码/文档和其他证据摘要，不把未提交工作区写成已发布版本。

| 验收 ID | 结果             | 最终依据与适用边界                                                                                                               |
| ------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| M7-A1   | 通过             | 63 文件 424/424（0 skip）包括前六阶段、S7.1 故障与完整功能回归；两台 Windows 灾备证据沿用 M6 D09—D11                             |
| M7-A2   | 通过             | 新 tgz 实际安装后的 DPAPI/独占启动/配对/授权拒绝/撤销/规则修复/主密钥/备份恢复；新页面 Chrome 两项通过；独立灾备沿用既有实机证据 |
| M7-A3   | 通过             | Designer/Query/Operation/Binding/关系/分页/Pivot/模型图/Excel 单元、三前端/资产 Chrome 2/2；六个引擎流程共 82 项断言全部通过     |
| M7-A4   | 通过（登记范围） | 安全/洪泛/容量、注入 ENOSPC、进程退出、恶意包回归和独立四项性能对比；物理耗尽/硬件断电未执行，性能与容量限制见上表               |
| M7-A5   | 通过             | 七个新包/三前端、严格消费类型、CLI/bin/安装指南、157 项 zh/en/ja 对齐；配置、用户手册、旧格式/切换/回退材料齐备                  |

**S7.2、SEC-M7 与安全 V1 研发验收完成，累计 7/7 里程碑、20/20 任务。**用户反馈待收集；不把未回复写成用户已确认。后续不再隐含新增 V1 开发阶段，新增缺陷按实际影响重开任务；性能优化、额外平台或真实发布另立明确范围。

全部实例均为临时合成目录、显式配置和随机端口，Chrome 使用独立 profile。真实配置、9091、凭据、密钥、Vault、业务库及真实 ACL 未接触；保留原 dirty 工作区和旧产物。未提交、push、部署、发布、切换或清理真实现场。根 `security/` 仍是受保护目录，不纳入源码扫描或候选。

## D03：S7.2 提交后交付复核

日期：2026-10-24。接续 HEAD 为 `c0923aef6b6a6fc74c644cd8531f028d2d48076a`，保留用户已暂存的收尾报告、验收汇总和根安全目录的既有删除状态。D02 的功能与性能验收仍有效；此前 26 份关键文件摘要中，交付报告的唯一差异来自 CRLF/LF，统一换行后与原摘要相同。没有业务代码变更，不重复累计历史用例或重跑性能。

新增[只读核对命令](../../scripts/security-release-evidence.mjs)：按固定开发路径检查当前源码/文档快照、11 份 D02 原始证据、候选等价性和性能绑定，拒绝正文变化、报告字节变化、不安全路径及链接。开发文本记录原始和 LF 摘要；历史证据仍逐字节核对，没有修改 D01、D02 的原始报告或摘要。证据路径设置 Git `-text`，避免提交/拉取自动改写原始副本。补充运行目录忽略规则、简介、使用手册和发布指南。

Git 只读路径元数据同时显示根 `security/` 的四条历史跟踪记录；本地已处于删除状态。本轮未读取材料、未恢复或删除文件、未变更索引、未轮换秘密或改写历史。新增忽略规则不能移除已跟踪内容，也不能证明历史没有秘密；真实材料的处置不在本轮授权内。不能把目录缺失写成同步安全证明。

复核结果与当前开发文件的原始/LF 摘要见 [D03 验收汇总](evidence/SEC-M7-D03/acceptance.json)。该快照包括新增交付工具及更新后的用户文档；D02 候选保留其原验收时的文档快照，没有冒充重新构建的新候选。正式生成候选仍按发布指南在新临时目录构建、安装和验收。研发完成计数保持 7/7、20/20，真实发布、切换、生产容量和硬件故障限制保持原记录。

实际复核：260 份开发文件和 11 份历史证据一致；临时副本六项检查全部通过，包括正常基线、仅换行变化通过、正文变化拒绝、历史报告字节变化拒绝、运行目录路径提前拒绝及目录链接拒绝。整仓 `pnpm.cmd run check` 退出 0，类型/源码边界/598 个开发文件格式通过，ESLint 为 0 error、44 条既有 warning；11 份文档的 149 个本地链接/锚点有效，任务计数 20/20。核对只读取明确开发路径及系统临时副本，没有运行真实实例或读取实际安全材料。
