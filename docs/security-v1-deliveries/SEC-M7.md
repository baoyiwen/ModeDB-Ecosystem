# SEC-M7 交付报告

- 交付日期：2026-10-24（Asia/Shanghai）
- 里程碑：SEC-M7 / 集成验收与发布准备
- 修订：D35（2026-10-30；D01—D34 历史记录和原证据保留）
- 技术状态：基础 V1 已复验完成，7/7、20/20；新增扩展22/23、DR-P4为5/6。D34 的 DR-P4.6 工具准备通过，实际Hello/双机仍待验证；D35 修复提交检查，不增加研发完成数，真实发布、迁移和升级切换未完成
- 用户反馈：用户要求开始下一步；本轮验收反馈待收集
- 代码定位：D11 基于 `fd40ade27acdec54c4e5ba4dd8ddc5ac4e061a0f` 的未提交工作区，按证据中的文件摘要定位；D01/D02 当时基线为 `cde9c14680b8dd26cde7f65d16ac8c4cf2a4b0dc`。接续时全部已有改动及历史证据保留，不将基线 SHA 当作本轮交付提交
- 最新任务：D30 / DR-P4.2 按已核验接收方离线交付；D29 / DR-P4.1 接收方公钥及持有证明；D28 / DR-P3.6 浏览器候选综合验收；D18 / DR-P2.1 会话父级与持久兼容模型；D17 / DR-P1.6 纵向集成、恢复与故障报告；D16 / DR-P1.5 本机审批与准确授权；D15 / DR-P1.4 注册 HTTP 与防护；D14 / DR-P1.3 持久台账与原子迁移；D13 / DR-P1.2 公共协议与依赖契约；D12 / DR-P1.1 可信部署契约；D11 / S7.2 修复后回归与交付核对；D01 / S7.1、D02 / S7.2 等历史交付见下文

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

## D04：Designer 隔离试用与 Git 跟踪整改

日期：2026-10-24。用户要求完成后续整改；沿用不触及真实 9091、配置、密钥和业务库的约束。本修订提供可复用的新安全实例试用入口及当前 Git 跟踪防护，未把操作范围扩大为真实迁移或历史秘密处置。

新增 [PowerShell 入口](../../scripts/security-designer-sandbox.ps1)和[启动器](../../scripts/security-designer-sandbox.mjs)。普通窗口运行时生成新候选、核对七包实际安装文件和 Designer 页面，再创建全新临时目录、示例业务库及随机 loopback 端口。页面仅提供经过摘要验证的内存资源，不提供任意文件服务。连接检查完成后，由既有 OS 本机 `browser-open` 签发一次性配对并打开 Designer；不交付长期 Token。Ctrl+C 关闭本次 Server/页面服务，临时文件保留；`-Smoke` 验证后退出，`-NoOpen` 不打开浏览器。脚本不接受实例路径。

新增 [Git 路径防护](../../scripts/assert-no-security-material.mjs)，接入 `check:sources` 和既有提交钩子。四条根 `security/` 引用仅通过 `git update-index --force-remove` 从当前索引取消跟踪，没有读取 Git blob 或实际文件，没有删除/恢复磁盘材料、轮换秘密或改写历史。忽略规则阻止正常新增；强制加入会被检查拒绝。历史提交仍可能含材料，实际暴露核查、轮换和历史清理仍需明确授权，不能报告为已完成。

定向测试覆盖临时仓库的忽略/强制加入/仅索引移除/不可用索引，以及候选篡改、越界路径和静态页面拒绝配置访问。新增 `.test.mjs` 已纳入完整回归入口；D02 的 424 项业务回归仍按原报告引用，不把历史结果说成重跑。简介、手册、发布指南及唯一台账同步更新。新验收摘要见 [D04 记录](evidence/SEC-M7-D04/acceptance.json)，D02/D03 原证据保留。

交付检查发现已提交的 Pivot 展示测试缺公共导出且查询 mock 不完整，补充现有函数的导出与四个链式过滤方法后，相关三文件 17/17 通过。Designer 独立类型检查进一步发现 19 处已有接入错误：补齐工具模式和透视展示导入，模型字段策略复用已有 schema/policy 构建，移除旧表格渲染遗留的未用参数与计算，补齐查询接口按钮的 zh/en/ja 文案绑定；独立 `pnpm --filter model-designer typecheck` 通过。未变更服务端授权或查询接口投影规则。沙箱内因现有 dayjs/exceljs 依赖不可读而失败，同命令在隔离的沙箱外通过，未改依赖或 ACL。

D03 曾记录的 D02 `acceptance.json` 字节在后续提交时由 CRLF 转为 LF。经验证仅换行变化，按 CRLF 重建的字节摘要与 D03 记录完全相同；该重建副本单独保存在 D04，明确标记为重建文件。D02/D03 文件未改写；D04 分别绑定当前已提交 LF 文件及重建 CRLF 副本，原性能报告和候选摘要继续严格校验，不通过更新摘要掩盖正文变化。

初版隔离工具曾因查询操作名、快照字段和结果读取结构与现有协议不符而失败，已按公共契约修正；失败临时现场保留，未修改服务端权限来放行。最终普通 PowerShell 指定候选与默认全新构建两条 `-Smoke` 路径均退出 0，验证配对、HttpOnly、重放拒绝、授权读回一条示例记录、匿名拒绝、页面可访问及配置不对外提供，结束后关闭临时服务。新防护/静态服务测试 8/8、0 skip。

Designer 修复后重新生成七包/三前端候选 `ModeDB-Release-o6QVeK`，默认 PowerShell `-Smoke` 退出 0；原始清单和停止后的沙箱报告在 D04 按原始字节归档。最终定向回归共 38/38（新工具 8、Pivot 基础 17、展示及接口 13），最新页面真实 Chrome 1/1（覆盖三个客户端的配对、刷新恢复、HttpOnly、注销及独立安全中心，194.4 秒），均 0 skip；Designer 独立类型和整仓 check 通过，ESLint 0 error / 44 条既有 warning，zh/en/ja 的 973 个 UI 键一致。检查与候选的具体摘要见 D04 记录。候选文档是构建时快照，最终验收说明随后补记；当前文档由 D04 开发快照绑定，没有将更新后的说明冒充候选内原始文档。

收尾只读核对通过：274 份开发文件、12 份历史证据和 3 份本轮原始/验证报告一致。临时副本的八项核对全部通过，包括正常基线、仅开发换行变化允许、开发正文/历史报告/本轮报告字节变化拒绝、运行目录路径提前拒绝、未完成验收状态拒绝及目录链接拒绝。没有读取运行材料。

D04 后续整改完成；V1 仍为 7/7、20/20。用户可按发布指南第 7 节试用合成库。真实 9091、业务迁移、历史材料暴露核查/轮换/清理均未执行；本轮没有提交、推送、发布或部署。

## D05：Windows 本机与局域网配置实例

日期：2026-10-25。用户要求可复制的配置实例及详细解释，当前场景是 B 设备通过局域网使用 A 的 ModelDB 和 Designer。本修订属于 S7.2 配套操作文档，不新增安全 V1 研发阶段，计数保持 7/7、20/20。

新增[详细配置文档](../security-v1/windows-lan-config.md)、[本机 JSON](../security-v1/examples/modeldb.loopback.example.json)、[局域网原生 TLS JSON](../security-v1/examples/modeldb.windows-lan.example.json)及[Designer 双库授权](../security-v1/examples/designer.windows-lan.grants.example.json)。说明每个常规/网络/审计/备份字段、配置目录与安全材料关联、A/B 地址、证书 SAN 与信任、HTTPS 页面、一次性邀请和故障定位。明确 `0.0.0.0` 与默认 loopback 冲突，现有实例的已保存来源/限流/封禁状态不会被 JSON 名单覆盖；提供本机预览、应用、确认及回滚命令。

同步完整配置指南、简介、使用手册、专项会话指引和唯一台账。只读证据工具增加 D05 快照选择及对应报告路径，D04 原始结果作为历史证据继续逐字节核对；没有修改 D02—D04 报告或原始性能/候选摘要。当前文档不是重新构建的发布候选。新[核对快照](evidence/SEC-M7-D05/acceptance.json)与[文档验证结果](evidence/SEC-M7-D05/verification.json)区分本轮验证和历史全量验收。

实际验证使用新临时目录中的两份配置副本，调用现有配置加载器和网络策略，不调用 TLS 材料加载、不监听端口。九项分组检查通过：三份 JSON 解析；本机配置/路径/来源；局域网双入口允许 A/B/回环并拒绝其他 IP；拒绝明文和错误 Origin；TLS 配置/审计/关闭备份解析；只改 host 仍拒绝；双库 grant 通过共享类型检查；Vite 示例片段 TypeScript 语法；七份相关文档本地链接及锚点。另核对 PowerShell 片段语法、指定文件格式、证据完整性、Git 路径防护和指定路径的空白差异；检查结果记录在验证报告中。

本轮没有重跑 D02 的 424 项单元、性能或真实 Chrome，也未验证新证书的签发/信任、实际防火墙或两台设备的 HTTPS 部署；隔离检查不能支持这些结论。此前用户另行授权的真实 ACL 检查/修复是独立维护操作，不属于本修订的文档验证；本轮没有再次读取或修改真实配置、凭据、密钥、Vault、业务库和 ACL，没有启动/连接真实 9091，也未执行文档中的证书安装、规则变更或凭据签发。保留原工作区改动及 security/ 索引移除状态，未提交、推送或部署。

## D06：安全检查实操示例与部署反馈

日期：2026-10-25。用户要求把本次本机与局域网安全连接过程整理为可供其他人使用的文档。本修订新增[实操示例](../security-v1/windows-lan-walkthrough.md)，并从简介、使用手册、Windows 配置文档和专项会话指引添加入口。没有新增安全机制或修改 Server、SDK、Designer 实现。

文档覆盖准确地址和绝对 CLI 路径、本机 `security-open`、当前认证模式缺陷的手动处理、保存规则与启动 JSON 的区别、双入口白名单、中英文预览/应用/确认按钮、第三方客户端来源、双库授权、已有凭据复用、首次凭据创建、LAN `session-pair`、图谱入口、语言入口限制、PowerShell 5.1、CORS 预检、旧 Vault 拒绝及分层验收表。示例不用真实凭据 ID、配对码、Token、私钥或业务记录；不把命令示例当作本轮已执行的操作。

此前用户授权的真实诊断和用户手动操作作为案例背景单独登记：LAN 页面曾返回 200，API 在当前 Windows 账号系统信任环境中通过 TLS；当时有效状态 revision 2 仅允许回环，健康检查与配对预检实测返回 `403 SECURITY_SOURCE_DENIED`。用户后续确认进入本机安全中心、提供签发成功的 LAN 邀请及 `VAULT_LEGACY_FORMAT` 截图。后者说明已进入存储格式检查，不足以证明全部业务开图、第三方电脑、最终规则或审计均通过。旧格式自动迁移、正式发布和升级切换未执行。本文档整理阶段不再次连接真实实例，不签发/消费邀请，不修改规则、配置、密钥、Vault 或业务数据。

按唯一台账“发现缺陷后重开”的约定登记以下后续事项，历史 D02 及 D04/D05 证据不改写：

| 原任务 / 验收项      | 部署反馈与当前状态                                                      | 后续验收范围                                                           |
| -------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| S4.2 / M4-A3         | 待修：启动链接读取到配对码，但连接表单优先沿用保存的 Token 模式         | 预先保存 Token 模式后，本机启动器应正确使用浏览器配对，并覆盖相关回归  |
| S5.1 / M5-A1         | 待修：连接页/独立安全页缺少语言切换入口，安全会话到设计流程缺少清楚指引 | 无需先开图即可选择语言；明确引导普通设计会话，保持管理员与业务权限边界 |
| S7.2 / M7-A1、A2、A5 | 待验证：上述修复完成后进行相关客户端与文档复验                          | 不沿用历史通过结果替代新修复验证；旧格式拒绝不计为业务验收通过         |

当前 SEC-M4、SEC-M5、SEC-M7 重开，完成计数为 4/7 里程碑、17/20 任务。这是对新反馈的状态更正，不表示已重做或推翻其他安全能力的历史证据。本次用户授权的是文档整理，修复实现和业务验证留待后续任务。源库保留，旧格式拒绝本身属于预期保护行为。

本轮定向检查通过：七份文档的 141 个本地链接/锚点、一份双库 JSON 示例、九段 PowerShell 语法、实操文档秘密/真实 ID 扫描，以及 20 项任务中 17 项完成、七个里程碑中四项完成的计数核对。命令、端口覆盖、启动器、会话与英文按钮按当前源码核对。初次 Prettier 检查发现更新后的状态表和新增 D06 表格未对齐，限定格式化这两份文档的受影响表格后复验；七份文档格式和限定 `git diff --check` 通过。不重跑 D02 全量测试或性能，不重签证书，不做第三方电脑或旧库迁移演练。D05 的核对快照继续表示 D05 时的文件状态，不为本次文档改动改写历史摘要。

## D07：设备注册与免 Token 连接设计建议

日期：2026-10-25。用户在讨论设备注册、公钥身份和性能后要求合理方案。本轮新增[设计建议](../security-v1/device-registration-proposal.md)，并同步总体方案、简介、使用手册、专项指引及唯一台账；没有开发新的认证或修改当前实现。

推荐公开连接描述、WebAuthn 注册与公钥登录、本机审批、短期会话及动态撤销；严格 Windows TPM 绑定为独立可选增强。方案覆盖公开下载无业务权限、挑战重放/并发、实例/RP/Origin 绑定、用户和设备区别、本机 Named Pipe 身份与回环专用管理入口、注册洪泛、权限隔离边界、独立加密接收方、历史解密与恢复、性能方法及安装/两台 Windows 验收。注册描述轮换不替代审批，登录撤销不删除数据解密密钥。

建议按既有缺陷修复 → DR-P1 注册/台账 → DR-P2 会话/权限 → DR-P3 页面/部署 → DR-P4 交付/验收推进；DR-H1 的硬件助手另冻契约。新增建议工作包均未开始，不把方案当作实施授权或功能交付。D06 重开的 S4.2、S5.1、S7.2 保持原状态，当前完成数仍为 4/7、17/20。

本轮七份设计/索引/台账文档的 139 个本地链接与锚点、方案秘密字面量扫描、格式和限定空白差异检查通过；计数核对为 17/20 任务、4/7 里程碑完成，五个新增建议工作包均未开始。未运行新功能、WebAuthn、浏览器、性能或双机测试。初次格式检查指出新增方案和台账表格未按仓库规则对齐，限定格式化后复查。D02—D05 原验收报告和绑定摘要未修改，不通过重写历史快照掩盖新文档变化。

保留所有既有工作区变更，包括用户新增的证书目录、Vite 和配置文件；本轮未读取这些证书或真实配置，不接触真实服务、凭据、密钥、Vault、业务库或 ACL，未安装工具、签发身份、变更规则、提交、推送或部署。后续实施首先需要冻结 DR-P1 的 API/字段与兼容策略，实际开发仍以明确任务为准。

## D08：设备注册扩展开发计划

日期：2026-10-25。用户要求制定开发计划；本轮把 D07 建议细化到[唯一台账第 11 节](../security-v1-milestones.md#11-设备注册扩展开发计划)，不新建第二份状态表。计划分为既有缺陷修复、DR-P1 注册/审批、DR-P2 登录/权限、DR-P3 页面/部署、DR-P4 加密交付/总验收五个必需阶段；可选 DR-H1 的 TPM 绑定另定契约。新增四个工作包共 23 子任务均未开始，原 V1 仍为 4/7、17/20。

计划逐项登记依赖、模块、可审查交付和验收要点；明确本机 CLI 审批先于管理 UI、最小同源测试先于正式静态托管、台账升级保留原授权/撤销及数据密钥。区分虚拟认证器自动化与两台 Windows 实际 Hello 证据；最终性能门槛在基线后、独立确认前登记。没有无依据承诺工期，完成前置缺陷和 DR-P1 契约/依赖评估后再细化剩余工期。

兼容/回退计划保留原 API Token 和配对，新增注册默认关闭；停用扩展仍执行撤销规则，旧二进制不能直接写新台账，不用旧访问快照覆盖来回退。真实业务切换、旧 Vault 迁移、通用行级隔离、企业身份及硬件严格绑定不混入默认版验收。接收方加密私钥与认证私钥分离，禁用登录不破坏历史备份。

同步总体方案、设备注册设计、简介、使用手册和专项会话指引，技术方案通过链接引用计划。当前只完成计划编制，没有修复 S4.2/S5.1 或开发新身份机制；下一开发任务为 S4.2，相关修复复验通过后再进入 DR-P1.1。

本轮七份文档的 146 个本地链接/锚点、23 个连续唯一子任务编号、31 条显式子任务依赖、0/23 新实现和 V1 的 17/20、4/7 计数检查通过；格式及限定 `git diff --check` 通过。初次格式检查仅提示新增台账表格，限定格式化后复验。不运行功能、浏览器、WebAuthn、性能或双机测试。历史 D02—D05 原证据和摘要保留，不为新计划重写。未读取/修改用户现有证书、真实配置、安全材料、Vault 或业务库，未连接真实服务、安装工具、提交、推送、发布或部署；工作区原改动及索引状态保留。

## D09：页面长期要求与 S4.2 启动配对修复

日期：2026-10-26。用户要求将新页面和旧页面改造的美观、i18n 写入长期指引，然后开始既定改造。本轮新增 [apps/AGENTS.md](../../apps/AGENTS.md)，并在 Designer、Data Studio 与安全专项 AGENTS 中要求每次相关开发先读；覆盖主题/组件一致性、布局层级、状态、窄屏、长文案、无障碍标签、现有翻译机制和支持语言（Designer/Studio 为 zh/en/ja）。可见界面变更须实际检查，纯逻辑改动说明无界面/文案变化。本次启动模式修复没有改变布局或翻译文案，不宣称重做视觉或多语言验收。

完成阶段 0 的 S4.2：三个前端在模块初始化时识别有效启动链接，优先选择浏览器会话并保存非秘密认证偏好；本地存储不可写时使用内存状态，清除配对码后不回退。之后仍可主动选择 Token 模式。无启动链接、无效配对码或远程 HTTP 地址不会覆盖原偏好；URL fragment 仍立即清除，配对码不写入 Web Storage。是否到期、已用、撤销或具有权限仍由服务端判断，未放宽管理员与业务库授权边界。实现仅涉及三个连接偏好模块；Chrome 用例预置旧 Token 模式，覆盖普通启动和 Designer 独立安全入口。

实际验证：

| 检查             | 结果及范围                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增启动偏好用例 | 18/18，三个前端分别覆盖有效/无效/无链接、存储写入失败/完全不可用、清码后保持与主动切换                                                                                                  |
| 相关回归         | 47/47、0 skip；网络、授权、registry HTTP、浏览器会话、旧凭据清理、启动偏好和接口调用文档；包含过期/重放/撤销拒绝                                                                        |
| 类型             | 根 `tsconfig.json` 与三个前端 `tsconfig.json` 均通过                                                                                                                                    |
| 全新页面构建     | 三个前端均构建到新临时目录；显式 `configFile:false`、`envFile:false`，使用源码别名，未加载现有 Vite 配置或证书；Designer 保留大分块警告                                                 |
| Windows Chrome   | 1/1、0 skip，测试体 195.3 秒；三个前端在旧 Token 偏好下配对、开库、刷新、HttpOnly 与注销；Designer 另覆盖管理员无业务 grant、接口下载、防护预览/确认/回滚、隔离实例主密钥轮换与窄屏断言 |
| 文档/开发检查    | 定向 Prettier、本地链接/锚点、状态计数和限定空白差异核对；仓库 ESLint 默认忽略 apps/test，本次该调用只产生忽略提示，不算这些文件的 lint 验收                                            |

相关命令为 `node node_modules/tsx/dist/cli.mjs --test` 加 `security-network`、`security-authorization`、`security-registry-http`、`security-browser-session`、`browser-connection-credentials`、新增 `browser-pairing-launch` 和 `interface-call-docs` 七份单测文件。授权/网络快捷脚本已加入新文件，完整回归脚本按目录自动发现。类型检查使用 `node node_modules/typescript/bin/tsc`。Chrome 使用 `MODELDB_TEST_APP_ROOT` 指向新输出，再执行 `node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap test/integration/security-browser-apps.test.ts`。输出与输入摘要汇总在 [D09 验证记录](evidence/SEC-M7-D09/verification.json)。

保留失败事实：沙箱内首次类型/构建无法解析既有 ExcelJS、Day.js 依赖；同命令在普通用户环境检查通过，未安装依赖或改 ACL。Chrome 首次调用在约 7 秒仅返回进程级 `test failed`，没有内部堆栈，根因未确定；同一构建未改实现，启用 TAP 后完整重跑通过。首次不计成功，S7.2 后续仍关注测试进程稳定性。单测使用沙箱 Node 24.22.1，普通用户的构建/类型/Chrome 使用 Node 24.15.0、Chrome 156.0.8078.48，不声称两种运行时都完成 Chrome 验收。

S4.2 / M4-A3 恢复通过，SEC-M4 恢复完成，V1 当前 5/7 里程碑、18/20 任务；S5.1 和 S7.2 保持未完成。下一项 S5.1 按新增规则完善连接页/独立安全页语言入口与设计导航，再完成对应 S7.2 复验。新增设备注册 DR-P1—P4 仍为 0/23；WebAuthn、本机审批与 TPM 未实现。

同步简介、手册、浏览器连接说明和实操指南；保留旧构建的临时处理说明及历史真实部署证据，不把隔离成功改写成真实 LAN/旧库验收。没有读取或修改真实配置、证书、根 security/ 材料、凭据、密钥、Vault、业务库或 ACL，没有连接/重启真实 9091；测试仅在临时合成实例、随机回环端口和独立 Chrome profile 中执行。用户原改动和索引取消跟踪状态保留，未提交、推送、发布或部署；历史 D02—D05 证据与摘要未改写。

## D10：S5.1 语言入口与设计导航

日期：2026-10-26。接续 D09，按用户要求推进下一任务并同步文档。本轮完成阶段 0 的 S5.1 / M5-A1；对应 S7.2 总结性复验留待下一任务。工作区原有改动、四条根 security/ 索引删除及 D02—D09 历史证据保留，未提交或发布。

### 页面行为与权限边界

- 新增共享 [LanguageSelector](../../apps/model-designer/src/components/LanguageSelector.tsx)，在连接页顶部、安全中心侧栏直接选择 English、中文、日本語。使用现有 i18n 管理器，带可访问标签及当前区域 `lang`；正常保存语言偏好，同一页面地址刷新恢复。存储不可写时，当前页面仍可切换语言。切换不会重新连接、签发或提升权限。
- 独立安全页新增“进入模型设计”指引：先断开管理会话，再通过本机 `browser-open` 或远程一次性邀请建立单独授权的设计会话，核对业务库及 Designer 工作区双库授权，再选择业务库。命令仅提供占位模板，不自动执行。编辑器内安全页保留关闭返回编辑器的流程，不显示要求重新连接的独立入口指引。
- 修复服务地址重复端口显示，复用 SDK 的端点规范化；无效端点显示本地化“不可用”，不在页面输出原始无效 URL。安全按钮使用已有正确翻译键，概览副标题同步三语言，以匹配现有管理能力。
- 沿用主题、卡片和控件风格，补连接页工具条、长文案滚动和安全侧栏滚动。编辑器安全页通过两层现有容器的 scoped flex 撑满高度，保留隐藏编辑器组件和上下文；不通过卸载其他面板修复布局。

同步[简介](../security-v1/overview.md)、[手册 §1.1](../security-v1/user-guide.md#11-页面语言与进入模型设计)、[Windows 实操 §7—8](../security-v1/windows-lan-walkthrough.md#7-打开局域网页面并进入图谱)和[浏览器连接说明](../security-browser-sessions.md)。测试说明补三语言、窄屏、存储失败及可选截图目录。新增设备注册、WebAuthn、本机审批与 TPM 功能仍未实现。

### 实际验证与视觉检查

| 验证           | 本轮结果及范围                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 相关单元测试   | `browser-pairing-launch`、`browser-connection-credentials`、`security-browser-session` 三份文件，21/21，0 fail、0 skip，774.5848ms                                                                                                                                                                           |
| 类型检查       | 根 `tsconfig.json`、Designer `tsconfig.json` 的 `tsc --noEmit` 均退出 0；包含最终测试诊断代码的收尾复查                                                                                                                                                                                                      |
| 三语言         | 9 个新增键及 12 个相关键的 zh/en/ja 非空、对应与占位符检查通过；不把本次范围写成全仓翻译审计                                                                                                                                                                                                                 |
| 隔离生产构建   | 三个前端全部成功，显式 `configFile:false`、`envFile:false`，data-kit/data-ui/sdk/shared 使用源码别名；没有执行用户真实 Vite 配置；Designer 保留大于 500kB chunk 警告                                                                                                                                         |
| Windows Chrome | 最终完整测试 1/1，0 fail、0 skip；用例 177969.5705ms，总计 183502.6192ms；沿用三前端配对、工作区、刷新、HttpOnly、注销及管理员规则/密钥维护流程                                                                                                                                                              |
| 新增浏览器断言 | 连接页、普通会话安全拒绝页、管理员独立安全页，三语言 × 1280/390px、900px 高；可聚焦语言控件/标签、无横向溢出、偏好/刷新、存储拒绝、规范地址及编辑器安全页高度；普通会话取得有效 CSRF 后仍为 `securityAdmin:false` 且管理 API 返回 403；管理员切语言/看指引后仍无业务库权限，关闭编辑器内安全页可返回原工作区 |
| 实际视觉       | 最终产出 19 张 PNG，人工检查宽屏、窄屏、日文长文案、中文权限拒绝页及展开的英文设计指引；归档其中 7 张合成截图及原始字节 SHA-256，见 [验证记录](evidence/SEC-M7-D10/verification.json)                                                                                                                        |
| 定向收尾       | 本轮前端源码/翻译/文档格式、文档链接/锚点、任务计数、归档摘要及限定 `git diff --check` 通过；未运行整仓 check 或全量 lint，apps/test 默认被现有 ESLint 忽略                                                                                                                                                  |

实际单元与类型命令：

```powershell
node node_modules/tsx/dist/cli.mjs --test test/unit/browser-pairing-launch.test.ts test/unit/browser-connection-credentials.test.ts test/unit/security-browser-session.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p apps/model-designer/tsconfig.json
# MODELDB_TEST_APP_ROOT 指向上述全新隔离三前端输出，截图目录也是新临时目录
node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap test/integration/security-browser-apps.test.ts
```

构建及最终截图来自 `modedb-s51-build-WwBTW5`、`modedb-s51-reviewed-visuals-fea6e268be484d47a9c3f6860ea8e406` 两个系统临时目录；验证记录保存构建方式、产物清单、最终源码 LF 摘要和归档图像摘要，历史 receipt 不随新源码改写。

### 失败修复与后续

首次完整 Chrome 已通过，但实际截图发现重复端口和编辑器安全页半高；修正地址并补高度断言后，第二次因内部两层容器未撑满而失败（用例 100407.3743ms，总计 106078.9532ms）。补齐容器样式后，第三次完整通过上述最终结果。首次通过为 182622.6749ms、总计 188283.8665ms，保留为修复前历史，不混入最终产物证据。英文宽屏拒绝页的一张截图仍处于抽屉入场动画，归档采用随后已稳定的中文宽屏图；临时连接通知可能短暂遮挡页顶，不把瞬时截图当作布局最终状态。

沙箱内既有 ExcelJS/Day.js 依赖解析限制沿用 D09；类型及构建在普通用户环境通过，没有安装依赖或改 ACL。本轮没有复现 D09 的首次 Chrome 进程级无堆栈退出，但其根因仍未查明，S7.2 继续关注。没有重跑全量 424 项、离线安装/打包、资产浏览器用例或性能确认，不把历史结果当作本轮执行。现有发布证据工具仍引用历史快照，S7.2 应为当前修复建立新快照并更新核对入口，不能为消除摘要差异改写旧 receipt；执行候选构建前仍须避开读取真实证书的用户 Vite 配置。

S5.1 / M5-A1 恢复通过，SEC-M5 恢复完成；当前 **6/7 里程碑、19/20 任务**。下一 **S7.2** 按影响完成相关回归及当前构建/用户文档/交付证据核对，再进入 **DR-P1.1**；新增注册实现仍 **0/23**。本轮未读取/修改真实配置、certs/、根 security/、凭据、密钥、Vault、业务库或 ACL，未连接/重启真实服务；所有验证使用新临时目录、合成实例、随机回环端口和独立 Chrome profile。真实 LAN/旧库开图、迁移、发布和切换未执行。

## D11：S7.2 修复后回归与交付核对

日期：2026-10-26。接续 D09、D10，针对 D06 重开的 M7-A1、M7-A2、M7-A5 进行复验，用户要求同步文档。沿用当前 HEAD `fd40ade27acdec54c4e5ba4dd8ddc5ac4e061a0f` 的未提交工作区，保留用户既有修改和索引状态。下面只记录本轮实际执行的验证，不把 D02 的历史全量结果冒充本轮结果。

### 候选构建与证据工具

候选工具原先运行各应用的默认 Vite 配置，会涉及用户本地证书配置。新增 [security-release-apps.mjs](../../scripts/security-release-apps.mjs)，显式 `configFile:false`、`envFile:false`；三前端仅从允许的入口、包声明、`src/`、`public/` 复制到临时目录，SDK/data-kit/data-ui/shared 指向本轮临时编译输出。构建不加载本地配置、`.env` 或本地证书，不依赖仓库旧 dist，也不修改用户 Vite 配置。新增测试以会抛错的合成配置、写入标记和 env 哨兵验证这些边界，未知应用及已存在输出目录被拒绝。

首次候选在七包编译及离线安装后，因 data-ui 输出缺少 `query-result-view.css` 而失败；复核同样发现 `import-failure-panel.css` 漏拷贝。补齐 [copy-css.mjs](../../packages/data-ui/scripts/copy-css.mjs) 的两项资源，未修改组件行为、文案或现有样式内容。第二份全新候选成功，第一份失败目录保留。新三前端实际使用包输出完成构建，可复现原先源码别名构建未暴露的打包缺口。

证据工具优先核对 D11 新快照，分别校验当前开发文件、归档报告、候选、完整回归、浏览器、安装及性能结果；最新快照未完成或失败时不回退旧成功记录。源码仅允许 CRLF/LF 差异，历史报告及 PNG 严格核对原始字节，路径越界、运行材料、junction 和重复路径拒绝。八项工具测试覆盖上述允许/拒绝、源码/报告/截图篡改及“跳过不能算通过”。D02—D10 的 28 份历史证据保持原样，旧源码摘要不随本轮修改更新；SHA-256 只说明内容一致，不充当发布签名。

### 本轮验证

| 项目               | 实际结果                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 全新候选           | `ModeDB-Release-droqFl`；七包合计 589 个包内文件（202 JS），三前端 18 文件，443 份构建源文件摘要；74 份本机第三方离线快照、实际 tgz 安装、包内清单、bin/CLI 及严格消费类型通过 |
| 安全 i18n          | zh/en/ja 各 167 项，包含本轮语言入口及设计指引，键对应且非空；实际三语言/长文案及窄屏随 Chrome 再验                                                                            |
| 完整回归           | 70 文件、471/471 单元，0 fail、0 skipped、0 cancelled、0 todo，302090.1399ms；六个引擎流程全部退出 0，保留各流程耗时及原日志摘要                                               |
| Chrome             | 两项用例 2/2，0 fail、0 skipped、0 cancelled、0 todo，总计 385084.3184ms；资产流程 190907.6375ms，三前端会话/管理页流程 187537.7711ms                                          |
| 安装生命周期与性能 | 新 tgz 安装后的 10 项检查全部为 true，四项性能 p95 在原登记门槛内；Windows DPAPI、独占启动、跨库拒绝、一次性配对/HttpOnly、名单修复、备份恢复、主密钥维护及凭据/会话撤销通过   |
| 类型与源码边界     | 根及 Designer/Data Studio/Web 四份 `tsc --noEmit` 通过；Git 运行材料跟踪、源码构建产物及 SDK 边界三项检查通过                                                                  |
| 静态与文档         | 本轮五个工具/资源脚本限定 ESLint 通过；432 份相关开发文件格式通过；用户手册、简介、发布指南和测试说明同步，收尾文档链接、状态计数、源码/历史/归档摘要及限定空白检查通过        |

Chrome 从新候选执行三前端配对、刷新、HttpOnly、注销；Designer 的三语言入口、存储拒绝、规范服务地址、编辑器全高与返回上下文、有效 CSRF 下普通会话管理 403、管理员无隐含业务权限，以及网络规则维护和主密钥维护均通过。另一用例完成资产导入审核、目标重新发布、目标准确版本授权、跨库/原始/系统拒绝、撤销及刷新。实际复核最终候选的中文连接页、日文窄屏管理页及中文全高拒绝页，归档三张截图；拒绝页的合成连接通知短暂遮挡顶部，不影响权限及布局断言。本轮没有修改页面实现或翻译文案，复制样式资源的效果由新包构建和真实浏览器验证，不以类型检查代替视觉检查。

### 失败事实与适用边界

回归脚本和本轮浏览器汇总包装最初以 `# skip` 解析 TAP，而 Node 实际输出 `# skipped`。虽然全部功能子命令退出 0，包装层因缺失统计分别退出 1。已修复仓库回归脚本，并从未改动的原始 TAP 日志重新提取正确计数；原错误汇总与日志 SHA-256 一并保留，新汇总明确标注只修统计。没有把未知统计当作零，没有隐藏失败或删减测试；原始日志留在临时验证目录，不把可能包含合成请求细节的完整日志纳入 Git。工具八项测试在最终允许 HTML/SVG 摘要后另行 8/8 通过。

扩展格式探索检查包含了既有 CSS，发现 Data Studio 的 `index.css`/`studio-shell.css`、Designer/Web 的 `index.css` 和 data-ui 的 `app-shell.css` 五份既有格式差异。它们不在仓库原常规格式扩展范围，本轮未重排；按既有开发格式范围及 D10 修改的 Designer CSS 定向检查 432 份通过。未运行会枚举真实本地配置的整仓 check/format，也不声称整仓 lint 通过；本轮所需类型、源码边界、工具 lint 与相关格式分项记录。Designer 大 chunk 警告保留，依赖/锁文件和真实 ACL 未改。

D09 首次 Chrome 进程级退出的根因仍未知，本轮两项 Chrome 未复现该退出；不能将一次成功解释为已查明根因。两台 Windows 独立恢复继续沿用 SEC-M6 / D09—D11，不冒充本轮新双机实测。正式发布、真实 LAN/旧业务库开图、旧库迁移、升级切换、硬件断电和物理磁盘耗尽均未执行。

### 独立性能确认

全部回归及浏览器进程结束后，单独对上述安装候选执行 `security-release-verify.ts`。Windows `10.0.26300` / x64、Intel i7-14650HX、Node 24.15.0、TypeScript 5.9.3、pnpm 10.33.0；同一当前候选的 legacy Bearer 与 registry 授权/同步审计对比，不是历史旧版本二进制比较。三轮 AB-BA-AB、每轮 5 次查询预热；启动、1000 行查询、单行持久写入、1010 行 Excel 实际导出的样本分别为每组 3/60/30/9。沿用 D02 已登记 p95 上限，未在看到本轮结果后调宽门槛。

| 工作负载           | legacy 中位 ms | registry 中位 ms | registry p95 ms | 既有 p95 上限 ms |
| ------------------ | -------------: | ---------------: | --------------: | ---------------: |
| 已初始化实例启动   |           9.40 |          4548.27 |         4829.04 |            10000 |
| 查询 1000 行       |           9.54 |          1496.51 |         1524.45 |             4000 |
| 单行持久写入       |          10.40 |          1527.57 |         1609.65 |             4000 |
| Excel 导出 1010 行 |         107.21 |          1649.46 |         2057.85 |             5000 |

判门槛使用未四舍五入的原始数据，见 [performance.json](evidence/SEC-M7-D11/performance.json)。同步审计及 OS 保护仍带来明显秒级延迟；这些本机回归门槛不代表生产 SLA、低延迟、高并发、TLS 网络成本或生产容量验收。结果绑定受测候选原始清单 SHA-256，候选及性能原始字节另存 `.original.json.txt`；阅读版与原始版必须解析一致，不能为格式化重写已绑定字节。

### 最终验收与接续

| 重开验收项 | 结果 | 本轮依据                                                                                  |
| ---------- | ---- | ----------------------------------------------------------------------------------------- |
| M7-A1      | 通过 | 70 文件 471/471、六引擎流程；D09/D10 缺陷修复在新候选 Chrome 再验，历史 M6 异机证据沿用   |
| M7-A2      | 通过 | 新包实际安装与完整 DPAPI 生命周期、三前端/资产 Chrome 2/2；本轮不伪造第二台机器的恢复结果 |
| M7-A5      | 通过 | 七包与三前端全新输出、严格消费类型、167 项 i18n、四份候选用户文档及当前/历史快照核对      |

M7-A3/M7-A4 的既有门槛保留，本轮全量功能回归、资产浏览器及四项性能再次通过；硬件断电等原未验证边界不变。完整回归之后仅修正汇总/证据工具和文档，最终工具 8/8 另行通过；受测包与页面未变，不重复无关长测试。汇总及摘要见 [verification.json](evidence/SEC-M7-D11/verification.json) 与 [acceptance.json](evidence/SEC-M7-D11/acceptance.json)，只读入口 `node scripts/security-release-evidence.mjs` 核对本轮快照。

**S7.2 / SEC-M7 恢复完成，V1 当前为 7/7 里程碑、20/20 任务；阶段 0 完成，下一 DR-P1.1 冻结可信部署契约。** 新增设备注册仍为 **0/23**，WebAuthn、公钥登录、本机审批和 TPM 未实现，不能把基础 V1 复验完成写成新注册机制已交付。

本轮仅使用新临时目录、合成实例、独立 Chrome profile 和随机回环端口；未读取/修改真实配置、certs/、根 security/、凭据、密钥、Vault、业务库或 ACL，未连接或重启真实服务，未提交、推送、部署或发布。原工作区改动、四条索引删除与历史证据保留；正式发布、真实旧库迁移及升级切换仍未执行。

## D12：DR-P1.1 可信部署契约

日期：2026-10-26。接续 D11，开始新增设备注册扩展。依据用户要求和专项指引，本轮只冻结非秘密部署边界，不实现 WebAuthn、公开注册 API、本机审批、运行时身份台账或 TPM 助手；不改变现有认证、Vault、备份、网络配置或真实实例。

新增 [可信部署契约](../security-v1/device-registration-deployment-contract.md)、[合成示例](../security-v1/examples/device-registration.deployment.v1.json)、[校验器](../../scripts/security-registration-contract.mjs)和 [19 项定向单测](../../test/unit/security-registration-contract.test.mjs)。契约固定 `modeldb.device-registration-deployment.v1`、随机 UUID v4 `instanceId`、精确 HTTPS DNS Origin/RP ID、TLS1.2 与公共 CA/所有者 SPKI 指纹模式、精确实例绑定、浏览器 secure context 与 `userVerification=required`、Node 22/24 目标矩阵（本轮实际为 Node 24），以及隔离合成注册/登录/撤销/查询性能基线方法。公开描述拒绝 token、privateKey、passphrase、grant、database、command 等未知敏感字段，不能下载后直接获得权限。

校验器与测试覆盖有效描述、HTTP/IP/localhost、路径和查询参数、Origin/RP ID 漂移、owner-pinned 缺失指纹、主机派生身份、未知秘密字段、性能样本/门槛、通配符和实例不匹配。实际验证：`node scripts/security-registration-contract.mjs` 输出合成描述并退出 0；`node --test test/unit/security-registration-contract.test.mjs` 为 **19/19、0 fail、0 skip**；定向 ESLint 通过。首次使用 `pnpm exec` 的格式/lint 调用受本地 pnpm SQLite store 无法打开影响，改用仓库已有的本地 Prettier/ESLint 二进制完成验证；格式检查限定本轮开发文件；test 目录沿用仓库忽略规则，没有把忽略文件说成已格式/lint 检查。新增测试脚本 `test:security:registration`，全量回归入口原本自动发现 `.test.mjs`，无需改其枚举规则。

隔离 TLS 测试使用明确标为公开测试材料的合成证书/私钥和进程内 DNS 映射，随机绑定回环端口。正常信任/准确 SAN/准确 pin 允许；未知根、错误 SAN、错误 pin 在收到 HTTP 前拒绝；证书尚未生效/已过期也拒绝。未安装信任、改系统 DNS 或运行任何业务库。

交付核对入口增加 D12 契约快照，分别绑定当前文件与 D11 历史报告；不为消除摘要变化改写 D11。相关证据工具 **10/10、0 skip**，覆盖当前契约收据、证书夹具篡改、最新收据未完成/skip 不回退 D11，以及原有路径/源码/历史证据保护。首次新夹具测试因缺少换行摘要元数据为 9/10，补齐夹具后复验通过，失败临时日志保留；没有修改功能规则来放行。

操作偏差单独记录：一次 `node scripts/check-format.mjs --help` 调用遇到该工具不支持参数，实际启动了仓库开发文件格式扫描，可能读取已跟踪的本地配置 JSON 文本；没有返回配置正文或写文件，不能再把本轮概括为完全未读真实配置。后续格式/摘要均改为明确路径列表。未读取真实证书/私钥/Vault/业务库，也没有更改真实配置或 ACL、连接真实服务。工作区既有改动和根 `security/` 索引删除保留，未提交、推送、安装信任证书、启动真实 9091 或发布。DR-P1.1 已完成，新增扩展进度为 **1/23**；下一任务为 **DR-P1.2：WebAuthn 库/版本、公共 schema、注册状态机、错误与审计字段、连接描述和容量契约**。本轮没有页面或翻译文案变更，不进行视觉/语言验收；没有运行 WebAuthn、完整业务回归、真实 LAN/Windows Hello、安装或性能验收。本轮证据见 [SEC-M7-D12 verification](evidence/SEC-M7-D12/verification.json)。

## D13：DR-P1.2 公共协议与依赖契约

日期：2026-10-26。接续 D12，同一 HEAD 的未提交工作区；全部既有修改、四条 security 索引删除及 D02—D12 历史证据保留。本轮只做公共契约和隔离依赖核对，不启用注册或接入真实实例。

shared 增加浏览器安全的版本化连接描述、能力、注册开始/完成/查询、凭证元数据、错误和审计类型及纯校验器；SDK 只重导出公共类型。固定 API 路径、单次挑战、待审批/凭证状态机、受信实例/Origin/RP/TLS/到期绑定、规范 base64url 解码字节上限及独立 32 字节 continuationSecret。查询不发放业务会话；公开请求不接受主体/授权。容量包括申请/挑战/凭证、来源与实例预算、证明并发/队列和本机修复预留。完整技术约定见[公共协议与依赖契约](../security-v1/device-registration-protocol-contract.md)。

选用 `@simplewebauthn/server@14.0.3`，官方元数据确认发布于 2026-09-25、当时 latest 且未标记 deprecated，声明 Node >=20、MIT。独立工具 manifest/锁文件固定 25 个条目及完整性，保留主库许可全文并核对全部包许可声明；不改变根锁、现有 Server 依赖或 Node 支持。Node 24.22.1 / pnpm 11.25.0 隔离安装后，预热专用供应链缓存，全新目录实际离线冻结安装 25 reused、0 downloaded，通过模块导入、注册/登录选项生成和畸形注册证明拒绝。未核验公告数据库、registry 签名/provenance、真实认证器或 Node 22；选型核对不是“无漏洞”结论。DR-P1.4 集成时须将相同依赖图接入 Server 根锁并重新验证，不能把独立工具锁当作已发布运行依赖。

实际定向验证：部署/公共协议 **29/29**、证据工具 **12/12**，均 0 fail/skip/cancelled/todo；shared 类型、临时全新 shared 声明、SDK 严格类型消费（DOM、无 Node 环境类型）、shared/SDK browser bundle 通过，不含 server/core/WebAuthn 依赖。新脚本 lint、限定路径格式、文档链接/23 项编号与两项完成计数、Git 运行材料守卫及 D13 摘要核对通过。测试目录沿用既有 lint/format 忽略规则，不能把退出码当作测试文本已格式检查。没有重跑整仓 check、全量业务/浏览器/性能/硬件/双机认证验收，也没有页面或翻译文案改动。

保留失败事实：直接 Node 测试不能解析源码 `.js`→`.ts` 导入，改用既有 tsx；初稿 lint/格式及 schema 边界不足，在冻结前修正并补拒绝用例。默认沙箱访问 registry 为 EACCES，经外部访问审批后仅查询公开 npm/下载隔离依赖；初次离线安装缺供应链 metadata，预热专用缓存后成功，未关闭策略或完整性校验。依赖探针误将 `.pnpm/lock.yaml` 当目录，修正为仅扫描目录；browser 探针首次找不到根级 esbuild，再从已声明的 tsx 的真实安装位置解析其依赖后通过。未修改现有依赖树或 ACL 来规避问题。

最终复核补强字符串整串匹配，拒绝 UUID/摘要/编码中的末尾换行，避免正则 `$` 的宽松结尾被接受；补充用例通过。新增测试文件的定向类型检查初次指出夹具 TLS 属性被推断成宽泛 string，收紧夹具类型后通过，不用整仓已存在的问题掩盖本次新类型错误。

简介、使用手册、专项指引、方案和唯一台账同步。**DR-P1.2 完成，新增扩展为 2/23，DR-P1 为 2/6、必需工作包为 0/4；下一 DR-P1.3：申请/公钥/用户关联台账和原子兼容迁移，默认关闭。** HTTP 能力/注册路由、WebAuthn 正常证明认证、持久申请/审批和登录尚未实现，不能使用下载文件获得连接权限。未读取/修改真实配置、凭据/密钥/证书、Vault、业务库或 ACL，未连接真实服务、信任安装、提交/推送或发布。原 D12 格式扫描的历史边界不被本轮声明覆盖。证据见 [D13 verification](evidence/SEC-M7-D13/verification.json) 和[依赖报告](evidence/SEC-M7-D13/dependency-check.json)；历史报告保持原字节。

## D14：DR-P1.3 持久台账与原子迁移

日期：2026-10-27（Asia/Shanghai）。接续 D13，同一 HEAD 的未提交工作区；保留全部既有改动、四条根 security 索引删除及历史报告。本轮完成默认关闭的 Server 内部持久台账和兼容迁移，不开放注册、审批或登录服务。

### 实现与边界

新增 Server registration-ledger 存储 schema：申请与独立查询秘密摘要、单次挑战摘要、现有 operator 主体关联用户、公钥凭证四类集合，严格检查规范编码/时间、准确实例/Origin/RP、唯一 ID、跨记录关联、容量和不可变字段。新增候选证明须关联已消费且未到期挑战；存储仍不验证 WebAuthn 签名、来源或管理员身份。测试的随机公钥字节不能作为认证证明。凭证计数器不得回退，撤销终态不复活，已批准申请/用户/凭证保留墓碑；resetAccess 在原访问重置事务中撤销这些新记录。公开安全状态/审计不返回公钥、查询摘要或扩展原文。

SecurityRegistry 新增内部状态、深拷贝读取、CAS 迁移与提交方法。普通启动/新初始化仍为 V1；只有显式内部迁移才把内容升级为 V2 和空 disabled 扩展，与迁移审计原子落盘。V2 相同修订重试不写，旧修订冲突。沿用 CurrentUser DPAPI 保护域、实例所有权/租约和既有 staged/journaled/replaced 提交机制，实例 ID、原授权/撤销、会话/配对、密钥文件字节和旧审计前缀保持；不修改 IMK/DEK/Vault/备份格式。未知格式、损坏意图、保护/审计失败均拒绝，保留现场；journaled 后的失败须重开检查，不能假定未提交或盲目重试。详见[协议第 8 节](../security-v1/device-registration-protocol-contract.md#8-持久台账与原子迁移)。

固定 HEAD 的 V1 reader 源码夹具（SHA-256 ca5c64f8b3c5559cefffc0e11dfa2aa3240f96775b90f4f2a4e6f532fb3bdf0c），实际确认可开 V1，再拒绝 V2 及已 journaled 的 V2 恢复、不覆盖原材料。该夹具不是完整旧发行包安装/降级验收；V2 不支持直接换回旧程序写入。存储 API 仅供可信 Server 适配层使用，未挂配置/HTTP/CLI，用户没有可执行的真实迁移或启用命令。

### 实际验证

Node 24.22.1 / Windows，所有材料为临时合成实例；定向入口使用已安装的本地 tsx/TypeScript/ESLint/Prettier，不解析真实配置或安装依赖。

| 检查           | 结果与范围                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册存储专项   | 23/23；默认关闭、CAS/无操作重试、旧身份/密钥保留、关联/克隆/秘密边界、容量、状态/计数器、撤销重置、坏格式/意图、审计/保护失败、迁移与记录各三故障点               |
| 进程/OS 必需项 | 包含在上述 23 项；真实子进程在 durable journal 后 exit(73)，通过死亡 PID 租约重开、同实例恢复且迁移审计仅一次；另测隔离 Windows DPAPI 迁移与密钥字节保留，无 skip |
| 原安全台账     | 10/10；临时真实 DPAPI/管道/CLI、进程并发、审计及随机回环服务回归                                                                                                  |
| 部署/公共协议  | 29/29；合成 DNS/TLS 与公共字段校验复验                                                                                                                            |
| 证据工具       | 14/14；D14 绑定当前存储与历史报告，skip/旧读取器/DPAPI/硬退出失败不回退 D13，不冒充注册运行时验收                                                                 |
| 类型/browser   | 临时新 shared 声明、整个 Server、存储测试 strict/noUnused、SDK DOM 严格消费及 shared/SDK browser bundle 通过；复用既有 common/core 声明，不改原 dist              |
| 文档/静态      | 定向 lint/格式、相对链接/锚点、23 个唯一编号及 3 项完成计数、Git 运行材料守卫、限定路径 diff 和当前/历史证据摘要核对通过                                          |

全部测试 fail/skip/cancelled/todo 为 0。原始执行结果和运行命令见 [checks.original.json.txt](evidence/SEC-M7-D14/checks.original.json.txt)，汇总见 [verification.json](evidence/SEC-M7-D14/verification.json)，当前文件及历史证据绑定见 [acceptance.json](evidence/SEC-M7-D14/acceptance.json)。test/\*\* 沿用现有 lint/format 忽略规则，未声称测试文本经过这两项检查；测试已实际执行并通过严格类型检查。

保留修正事实：专项第一轮为 22/23，坏 Origin 应按冻结契约返回 ORIGIN_MISMATCH，测试错误期待 SCHEMA_INVALID；修正精确预期后为 23/23，没有放松实现。新测试首次类型检查发现 unused 校验器导入，补充实际负例使用后通过。本轮记录失败事实，未另存这两次失败的原始日志文件。

简介、使用手册、方案、身份/部署/协议契约、专项 AGENTS、测试说明和唯一台账同步。本轮无页面或可见翻译文案变更，无视觉/i18n 验收；未重跑整仓 check、全业务/浏览器/性能/新发布安装、Node 22、Windows Hello 或双机新认证验收，未验证物理磁盘耗尽或硬件断电。D13 的依赖安装证据只作为历史保留，不代表本轮已把 WebAuthn 接入 Server 根锁。

**DR-P1.3 完成，新增扩展 3/23，DR-P1 为 3/6，必需工作包 0/4；下一 DR-P1.4：连接描述下载、注册开始/完成/查询、单次挑战、到期回收、来源与全局限流。** 注册 HTTP、真实证明验证、本机审批和会话接入尚未实现。未读取/修改真实配置、certs/、根 security/、凭据/密钥、Vault、业务库或 ACL，未连接/重启真实服务，未安装信任、提交、推送、部署或发布；不以本轮边界覆盖 D12 的历史扫描事实。

## D15：DR-P1.4 注册 HTTP 与防护

日期：2026-10-27（Asia/Shanghai）。接续 D14，仍为同一 HEAD 的未提交工作区，保留全部既有修改、四条根 security 索引删除和历史证据。本轮完成注册申请服务，不提供审批、业务授权或登录。

### 实现与安全边界

新增 RegistrationService 和五个版本化 HTTP 路径，提供能力/连接描述下载、begin、complete 与私有 status；配置与顺序见[接口使用说明](../security-v1/device-registration-runtime-guide.md)。缺省关闭，只有明确有效的 enabled 描述及迁移许可才升级 V1；过期描述按关闭处理，不阻止数据库启动或触发迁移。准确实例、HTTPS Origin、RP、窗口和直接 TLS 的公开证书 SAN/有效期/pin 均检查；不从请求头推导配置。V2 持久模式支持 enabled/disabled，访问重置会关闭窗口；重启时仍有效的显式配置可再次开放。迁移继续保留原身份、授权、密钥和保护域。

注册请求独立执行现有来源/网络防护及准确 Host/Origin/Fetch Metadata 校验，在解析前限制 JSON 128 KiB，禁止查询参数、跨源 CORS 和 Cookie。随机挑战、userHandle 和查询秘密相互独立，秘密/挑战仅摘要落盘。持久认领后才调用固定库；失败/重启不复活，异步边界重验来源、期限、访问代次和申请。最终候选与成功审计同事务；失败关闭、保留现场，不把未知落盘结果当作未提交。

真实调用 `@simplewebauthn/server@14.0.3`，校验挑战、Origin/RP/type、UP/UV、ES256/RS256 和重复 rawId。首版仅接受 none，拒绝 packed 等外部证明格式，避免引入外部证书验证网络访问。none 不证明硬件来源或私钥持有；待审候选仍需后续本机审批及公钥登录挑战。status 必须持有独立查询秘密，错误实例/ID/秘密统一 NOT_FOUND，最短轮询 5 秒，不返回公钥、主体、权限或会话。

来源/全局预算、最多 10000 条预算记录、4 个验证槽和 32 个等待槽、60 秒等待上限均有界；本机维护不进入公开队列。30 秒后台和请求内回收处理过期挑战及申请，已证明申请待审最多 24 小时，批准/撤销墓碑保留。只读成功审计按动作/分钟采样并保留进程内计数；匿名拒绝沿用持久有界聚合。预算重启重新计数，持久挑战仍防重放。这些功能测试不等于容量/性能验收。

### 依赖与实际验证

Server 直接依赖及根锁接入 D13 选定的同一 25 包图，YAML 语义核对确认根锁只新增 Server importer 项及选中图。全新临时目录离线冻结安装为 25 reused、0 downloaded、ignore-scripts，库/许可/锁与探针通过；没有重装当前根依赖树，也没有验证整个新发行包。当前开发安装通过指向隔离选中包的未跟踪模块链接解析，最终包安装验收仍属 DR-P4。根锁同时绑定原始与 LF 摘要，允许 Git 仅转换开发文本行尾，内容或依赖摘要漂移仍拒绝；证据原字节不放宽。

Node 24.22.1 / Windows，所有实例、DNS/TLS 和数据均为临时合成材料：

| 检查               | 结果与范围                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册定向           | 74/74：部署/公共协议 29、存储 23、运行时 22；fail/skip/cancelled/todo 均 0                                                                                                                |
| 运行时重点         | 默认关闭/过期不阻止启动、显式迁移、秘密隔离、真实库合成 none、Origin/RP/UV/挑战拒绝、并发至多一次、重启不复活、私有查询、到期回收、重置/来源/时间竞争、重复 rawId、限流/4+32 队列及写故障 |
| 原生必需项         | 包含在运行时 22 项中；真实 Windows DPAPI、随机回环 HTTPS Server、启用后完成返回 202 pending，无 CORS/Cookie/会话，原 RPC 仍拒未认证                                                       |
| 原安全台账         | 10/10，隔离 DPAPI、管道/CLI、并发和进程恢复，无 skip                                                                                                                                      |
| 网络与原浏览器会话 | 9/9，HTTPS/WSS、来源/Origin、旧配对及短会话，无 skip                                                                                                                                      |
| 证据工具           | 16/16，最新 D15 不完整/skip、缺原生 TLS、依赖图/根锁漂移等均拒绝，不回退 D14                                                                                                              |
| 类型/browser       | 全新临时 shared 声明、整个 Server、存储/运行时测试 strict/noUnused、SDK DOM 严格消费、shared/SDK browser bundle 通过；原 dist 未改                                                        |
| 静态与文档         | 明确开发路径 lint/格式、23 个唯一任务及 4 项完成、相对链接/锚点、Git 材料守卫、限定 diff、当前/历史摘要核对通过                                                                           |

最终定向测试共 **109/109**，0 fail/skip/cancelled/todo。原始结果与命令见 [checks.original.json.txt](evidence/SEC-M7-D15/checks.original.json.txt)，注册完整 TAP 见 [registration.original.txt](evidence/SEC-M7-D15/registration.original.txt)，依赖与边界见 [dependency-check.json](evidence/SEC-M7-D15/dependency-check.json)，汇总及绑定见 [verification.json](evidence/SEC-M7-D15/verification.json) 和 [acceptance.json](evidence/SEC-M7-D15/acceptance.json)。历史 D14 及更早报告保留原字节；test/\*\* 仍被现有 lint/format 忽略，不宣称测试文本完成这两项检查，严格类型与执行结果另有记录。

### 修正事实、限制与接续

首次类型检查发现 never 箭头 helper 未收窄输入及测试 unused/变量问题，改为明确函数声明并修正测试后通过；旧存储负例将 enabled 当非法，随模式扩展改测 unknown。队列测试最初重复同一挑战，无法证明队列上限，改为 37 个独立申请验证 4+32 边界，没有放宽实现。原生测试移除对已监听 Server 的重复 listen，并用正确 family=4 DNS lookup 连接合成名称，保留完整 TLS 验证。初稿 lint/格式问题修复后复验。本轮保留这些失败事实，未归档早期失败原始日志。

简介、手册、专项 AGENTS、总体方案、技术契约和唯一台账同步。无 UI 或可见翻译文案变更，未作视觉/i18n 验收；未运行整仓 check、全业务/浏览器回归、Node 22、Windows Hello、新双机认证、性能、整个新发行包安装或实际二进制降级；物理磁盘满/硬件断电也未验证。

**DR-P1.4 完成，新增扩展 4/23，DR-P1 为 4/6，必需工作包 0/4；下一 DR-P1.5：受保护本机 CLI 的申请列表、批准/拒绝、主体与准确库授权、修订冲突和审计。** 本机审批、公钥登录、正式注册页面及 TPM 均未实现。本轮未读取/修改真实配置、certs/、根 security/、凭据/密钥、Vault、业务库或 ACL，未连接/重启真实服务、安装信任、提交、推送、部署或发布；不覆盖 D12 历史扫描边界。

## D16：DR-P1.5 本机审批与准确授权

日期：2026-10-27（Asia/Shanghai）。接续 D15，同一 HEAD 的未提交工作区；保留全部原有修改、四条根 security 索引删除及原历史报告。本轮交付本机审批，不接公钥登录或新页面。

### 实现与边界

新增 `registration-list/registration-approve/registration-reject`，均要求显式配置和准确实例。操作步骤、授权文件与错误见[手册第 5 节](../security-v1/device-registration-runtime-guide.md#5-本机审批-cli)，技术约定见[协议第 10 节](../security-v1/device-registration-protocol-contract.md#10-dr-p15-本机审批约定)。沿用 Windows Named Pipe 的 DACL、远程拒绝和 impersonation；Node 父进程再次将 broker 的 SID 与当前账号/SYSTEM 比较。内部审批要求受信本机上下文，默认 actor 字符串、前端管理会话、请求中的 role/actor/SID 不能取得该权限。没有 HTTP 审批入口。

列表分页返回申请备注/状态/期限、证明通过标志、COSE 公钥 SHA-256 指纹和当前总修订，不返回公钥、rawId、userHandle 或查询秘密/摘要。列表自身也有持久审计；V1 列表不触发迁移。备注、UV 和 none 候选不独立证明申请人身份，管理员仍须带外核对申请/指纹。

批准/拒绝带准确实例、申请 ID、总修订和确认。只有未到期的 pending 已验证候选可批准；选择 enabled operator 或同事务创建管理员命名的 operator，关联用户也须 enabled。申请、公钥凭证、用户/主体关联、准确授权、策略修订和审计一次提交；失败不会留下半个主体或未持久化成功。拒绝可处理未完成证明的申请并终止其 issued 挑战；三种终态不相互恢复。并发或任何其他持久审计推进修订后，旧请求冲突，必须重新核对，不自动重放。

登记凭证的可选 grants 严格限定准确数据库、资源、已知动作与可选 releaseDigest；callable 必须准确资源与版本摘要。新批准必须明确传授权数组，`[]` 为无权限；既有 V2 缺 grants 时默认无权限，不继承同主体 Bearer 范围。已存范围本阶段不可修改，停用/撤销/权限维护留待 DR-P2；旧 V2 reader 会拒绝新字段，不能直接二进制降级。批准不创建 Token、配对码、Cookie 或会话，公开 status 仍只返回 approved 状态；DR-P2 需重新完成私钥挑战。

审计只含可信本机 SID、申请/主体/凭证标识、动作/结果和稳定原因，不写姓名、授权明细、公钥或查询秘密。拒绝和冲突也有有界台账审计；审计满或保护/写入失败均不能报批准成功。已记录 journal 后即使调用报错，也可能已提交，保留现场并重开列表/审计核查。

### 实际验证

Node 24.22.1 / Windows；仅临时合成实例、公开 TLS 夹具与随机回环端口，不读取真实配置或运行材料。

| 检查              | 结果与范围                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册定向          | 95/95：部署/公共协议 29、持久存储 23、注册运行时 22、本机审批 21                                                                                                                                                |
| 审批重点          | 本机上下文、foreign/malformed SID 拒绝、分页/指纹与秘密边界、新建/复用 operator、准确/空授权、未验证/到期/终态拒绝、CAS、容量、公开 approved 不获会话、旧 V2 无授权、返回对象隔离、访问重置、审计满及写保护失败 |
| 提交故障          | 审批 staged/journaled/replaced 三点失败后重开，同一批准的主体/用户/凭证及成功审计要么全无，要么各一次                                                                                                           |
| 原生必需项        | 包含在审批 21 项；真实 Windows DPAPI/Named Pipe、实际 CLI 列表/批准/拒绝、中文 operator 备注、可信 SID 审计及重启保留，无 skip；候选由可信存储夹具构造，不冒充实际认证器证明                                    |
| 原安全台账        | 10/10，真实隔离 DPAPI、管道/CLI、进程并发/恢复及原 HTTP 认证回归                                                                                                                                                |
| 网络/原浏览器会话 | 9/9，HTTPS/WSS、来源/Origin 和原配对/短会话                                                                                                                                                                     |
| 证据工具          | 18/18；D16 的 skip、身份/准确范围/原子审计/原生 CLI 缺失均拒绝，不回退 D15，不冒充公钥登录                                                                                                                      |
| 类型/browser      | 临时新 shared 声明、整个 Server 与存储/运行时/审批测试 strict/noUnused、SDK DOM 严格消费及 shared/SDK browser bundle 通过，原 dist 未改                                                                         |
| 文档/静态         | 定向 lint/格式、13 份文档链接/锚点、23 个唯一任务及 5 项完成、Git 材料守卫、限定 diff 与当前/历史摘要核对通过                                                                                                   |

最终定向测试共 **132/132**，fail/skip/cancelled/todo 均 0。原始命令/结果见 [checks.original.json.txt](evidence/SEC-M7-D16/checks.original.json.txt)，完整注册与台账 TAP 见 [registration.original.txt](evidence/SEC-M7-D16/registration.original.txt)、[registry.original.txt](evidence/SEC-M7-D16/registry.original.txt)，汇总及摘要见 [verification.json](evidence/SEC-M7-D16/verification.json)、[acceptance.json](evidence/SEC-M7-D16/acceptance.json)。D15 及更早报告保持原字节；依赖图/锁未改，本轮未重新安装依赖或发行包，D15 25 包离线证据仅作为历史保留。

### 修正事实与接续

第一轮审批专项为 16/17，测试发现返回 grants 与内存台账共享引用；改为返回深拷贝，补充/保留返回数组修改不影响内存或重开状态的断言。另将凭证 ID 不能冒充 Bearer 的测试预期收紧为既有 `SECURITY_CREDENTIAL_INVALID`。新增公开轮询及旧 V2 缺授权兼容用例后，最终审批 21/21。初次定向 lint 指出新 callable 检查的箭头参数格式，格式修正后复验；早期失败事实保留，未归档完整失败原始日志。

本机身份允许/拒绝规则由纯测试与实际 owner 管道调用覆盖；未在新 OS 账号下执行真实 foreign-SID 连接，不宣称跨账号攻击实测完成。审批测试候选为明确标注的可信存储输入，P1.4 真实库校验另行复验；完整虚拟认证器注册—待审—批准的纵向与故障报告仍为下一 DR-P1.6，不能以本轮单项通过替代。

简介、手册、方案、专项 AGENTS 和唯一台账同步；本轮无页面或翻译文案变更，无视觉/i18n 验收。未运行整仓 check、全业务/浏览器、真实 Hello/新双机、Node 22、性能/容量压测、新发行包安装、完整旧程序降级或硬件断电/物理磁盘满验收。

**DR-P1.5 完成，新增扩展 5/23，DR-P1 为 5/6，必需工作包 0/4；下一 DR-P1.6：注册—待审—批准纵向集成、持久恢复与故障报告。** 公钥登录、正式注册/审批页面和 TPM 尚未实现。本轮未读取/修改真实配置、certs/、根 security/、凭据/密钥、Vault、业务库或 ACL，未连接/重启真实服务、安装信任、提交、推送、部署或发布；工作区原有改动与四条索引删除保留，不覆盖 D12 的历史扫描边界。

## D17：DR-P1.6 纵向集成、恢复与故障报告

日期：2026-10-27（America/New_York）。接续 D16，仍为 `fd40ade27acdec54c4e5ba4dd8ddc5ac4e061a0f` 的未提交工作区。全部既有修改、四条根 security 索引删除、D16 及更早证据保持；不将本轮文件摘要当作提交记录。

### 交付与修复

新增两个纵向测试文件及合成/浏览器/硬退出夹具，通过 `node scripts/security-registration-integration-check.mjs` 或 `pnpm run test:security:registration:integration` 重复运行。报告与故障处理见[手册第 6 节](../security-v1/device-registration-runtime-guide.md#6-注册审批全流程验收与故障报告)，验收边界见[协议第 11 节](../security-v1/device-registration-protocol-contract.md#11-dr-p16-纵向验收边界)。命令不加载默认/真实配置，自动创建临时合成实例、随机回环端口及独立 Chrome profile；无系统信任/hosts 修改。

实际 Chrome CDP 虚拟认证器调用 `navigator.credentials.create` 生成响应，由固定 WebAuthn 库经真实 HTTPS 接收与校验，再通过 Windows DPAPI/Named Pipe/实际 CLI 完成列表、批准和拒绝。覆盖坏挑战终态、相同证明竞争至多一次、旧审批修订冲突、容量边界和本机维护、关闭注册后重启保留批准状态；批准前后均无 Cookie、API 凭据或业务会话，登记 ID 不能充当 Bearer。容量准备明确使用未验证合成申请/issued 挑战填满其余槽位，由真实虚拟认证器验证边界请求，不声称创建了 1000 个认证器。

其他八项纵向用例经真实 WebAuthn 校验库、HTTP 和受信本机审批分发，使用临时 AES-GCM 保护夹具，覆盖准确授权/指纹及秘密审计边界、坏 UV、证明与拒绝竞争、1000 条待审容量、候选最终写失败，以及 staged/journaled/replaced 三个真实子进程硬退出。恢复后，主体、用户、公钥凭证和成功审计要么全无、要么各一次；数据密钥文件不变。合成分发身份不冒充真实 SID，原生身份由独立浏览器链路及既有台账回归验证。

容量实测发现 WindowsSecretProtector 的 1 MiB stdio 输出缓冲小于大台账的 base64 JSON，原实现提前失败关闭。改为有界 48 MiB，以覆盖台账既有 32 MiB 保护文件上限的编码；保护格式、解码器大小上限、ACL/身份和鉴权保持原规则。完整容量链路现已通过；没有据此声称整个 32 MiB 极限、性能或所有资源耗尽场景已验收。

### 实际验证与原始证据

最终运行 Node 24.22.1 / Windows，Chrome 156.0.8078.48。Chrome GPU 在执行沙箱内被拒绝，获自动审批后使用固定相同 Node 的正常环境执行隔离浏览器测试；未调整 Chrome 安全沙箱或放宽业务校验。

| 检查                  | 本轮结果                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册定向              | 95/95：部署/公共协议 29、持久存储 23、运行时 22、本机审批 21                                                                                |
| 纵向集成              | 9/9，约 135.1 秒；含 1 项 Chrome/原生 HTTPS/DPAPI/CLI 与 8 项 HTTP/合成保护及真实硬退出链路                                                 |
| 原台账与 Windows 密钥 | 13/13：原台账 10、DPAPI/隔离恢复及不同网络凭据重开 3                                                                                        |
| 网络与原浏览器会话    | 9/9，HTTPS/WSS、来源/Origin、配对及短会话                                                                                                   |
| 证据与报告工具        | 24/24：证据工具 20、集成报告解析 4；缺证据、失败/skip、容量/硬退出/无会话检查缺失均拒绝完成                                                 |
| 类型与 browser 边界   | 临时新 shared 声明、整个 Server 和存储/运行时/审批/集成/硬退出夹具 strict/noUnused，SDK DOM 严格消费与 shared/SDK bundle 通过；原 dist 未改 |
| 文档与静态            | 定向源码 lint/格式、文档相对链接/锚点、23 个唯一任务及 6 项完成、Git 材料守卫、限定 diff 与当前/历史摘要核对通过                            |

共 **150/150 定向测试，0 fail/skip/cancelled/todo**。完整原始命令/结果见 [checks.original.json.txt](evidence/SEC-M7-D17/checks.original.json.txt)，[集成报告](evidence/SEC-M7-D17/integration-check.json)及[完整集成 TAP](evidence/SEC-M7-D17/integration.original.txt)；汇总和文件绑定见 [verification.json](evidence/SEC-M7-D17/verification.json)、[acceptance.json](evidence/SEC-M7-D17/acceptance.json)。本轮不重排任何历史证据；test/\*\* 的既有 lint/format 排除保留，不宣称测试文本经过这两项检查。

### 失败事实与接续边界

原始失败均保留：沙箱中两轮 Chrome 在 Runtime.enable 前后退出，独立启动诊断确认 GPU 进程 access denied；正常执行环境首轮进入容量准备后触及 1 MiB 保护桥接限制。首次正常环境解析到 Node 24.15.0，后续固定 Node 24.22.1，版本据报告区分。桥接修复后，两轮容量夹具分别因旧挑战自动回收和先前竞争申请仍占待审槽而不准确；改为显式终止旧申请、等待其挑战自然到期再合法回收，并预置准确 999 个空槽占位，不放宽任何上限。失败报告/TAP 以 `integration-failed-*.json` 和对应 `.original.txt` 归档。初次严格类型检查的未类型化 json 泛型调用及新脚本三处 curly lint 已修复，原始输出也保留。

简介、手册、部署/协议/身份契约、总体方案、专项 AGENTS、测试说明和唯一台账同步。本轮无页面或可见翻译文案变更，无视觉/i18n 验收；未运行整仓 check、全业务/生产页面/发布安装、Node 22、Windows Hello/新双机认证、独立性能或生产容量压测，未验证物理磁盘满/硬件断电、完整旧程序降级及整个 32 MiB 文件极限。既有 common/core 声明用于类型检查，依赖图/锁未变且未重装，D15 安装报告仅历史保留。OS foreign-SID 实际跨账号连接仍非本轮验收。

**DR-P1.6 完成，DR-P1 完成 6/6，新增扩展 6/23，必需工作包 1/4；下一 DR-P2.1：API 凭据、公钥身份和本机管理身份的会话父级及持久兼容模型。** 公钥登录、正式注册/审批页面和 TPM 尚未实现。本轮未读取/修改真实配置、certs/、根 security/、凭据/密钥、Vault、业务库或真实 ACL，未连接/重启真实 9091、安装系统信任、提交、推送、部署或发布；保留全部原有工作区改动和四条索引删除。

## D18：DR-P2.1 会话父级与持久兼容模型

日期：2026-10-27（America/New_York）。继续 `fd40ade27acdec54c4e5ba4dd8ddc5ac4e061a0f` 的未提交工作区，保留全部既有变更和四条根 security 索引删除。D17 及更早原证据不改写。

### 交付与兼容

shared 增加 metadata-only 的 `SecuritySessionParent` 判别联合：`api-credential`、`registered-public-key`、`local-management`。Server 按明确命名空间校验父级、主体和登记用户关联；API/登记凭据 ID 不能重叠，公钥父级不能进入配对集合。每次验证重新投影自身 grants；登记授权缺失视为空，不继承同主体其他凭据的权限。安全中心会话元数据保留 credentialId，新增可选 parent，不输出秘密。

普通 API Token、配对码和 Cookie 格式保持。管理父记录仍兼容保存在 credentials 集合，V3 用独立 kind 标记且 grants 必须为空；普通 authenticate、rotateCredential、session-pair 不能将其转换为可复用 API 身份，构造匹配摘要的 Token 也拒绝。公钥路径只引用登记公钥，不新增 API 凭据；当前仅以可信合成持久输入验证，没有公钥登录或会话签发入口。已验证的旧配对/短会话、Origin/CSRF、轮换/注销仍可使用。

V3 必须带明确 kind/parent，拒绝混用、未知父级字段及秘密字段；Server 内部 `migrateSessionStorage(expectedRevision)` 显式 CAS 迁移 V1/V2。普通 open、注册配置、HTTP 和 CLI 均不隐式迁移到 V3。迁移保留原实例、授权、摘要/撤销/期限、策略/访问代次和旧审计，只原子增加总修订和迁移审计；V1 新建 disabled 登记集合，V2 原记录保留。数据密钥、Vault、备份和资产格式不变。冻结 V1 reader 实际拒绝 V3 并保留材料；旧 V2 reader 按版本契约应拒绝，但完整旧 V2 发行包安装/降级未执行，禁止手改版本降级。完整说明见[协议第 12 节](../security-v1/device-registration-protocol-contract.md#12-dr-p21-会话父级与持久兼容模型)与[手册第 7 节](../security-v1/device-registration-runtime-guide.md#7-会话父级模型与兼容验证)。

补测 V3 注册运行时发现既有停机跨期问题：pending 申请在一次回收内先变 expired 又被删除，不满足存储必须先提交终态的约束。现保留本轮刚结束的申请，下一轮再合法收集；重启、私密查询及回收验证通过。未放宽状态转换、申请容量或公共查询边界。

### 实际验证与证据

Windows / Node 24.22.1，全部为随机临时目录和合成数据；没有构建或覆盖原 dist。本轮没有浏览器页面/翻译变化，不声称视觉或 i18n 验收。

| 检查                  | 结果                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话父级与迁移        | 35/35；V1/V2 显式 CAS 与幂等、原 Token/配对保留、管理空授权及禁止转为 API、公钥自身授权、坏父级/混用/秘密字段、失效/注销/重置；原生 DPAPI 迁移/重开，以及三个提交点的注入异常恢复 |
| 注册回归              | 95/95：部署/公共协议 29、存储 23、运行时 22、本机审批 21；冻结 V1 reader 现同时拒绝 V2/V3                                                                                         |
| 原台账与 Windows 密钥 | 13/13：registry 10、DPAPI/隔离恢复/不同网络凭据重开 3                                                                                                                             |
| 旧认证和传输边界      | 26/26：原短会话、网络、授权、registry HTTP；含真实 HTTP/WS、SDK、配对、审计与撤销路径                                                                                             |
| 证据工具              | 22/22；D18 优先，缺迁移/原生保护/管理边界、失败或跳过、TAP 计数不匹配均拒绝完成，不回退 D17                                                                                       |
| 类型/静态/文档        | 临时新 shared 声明、整个 Server 与新旧注册/集成测试严格类型，SDK DOM 与 shared/SDK browser bundle、限定源码 lint/格式、文档链接与任务计数、Git 材料守卫、当前和历史文件摘要通过   |

共 **191/191，0 fail/skip/cancelled/todo**。[会话原始 TAP](evidence/SEC-M7-D18/session-parent.original.txt)、[注册 TAP](evidence/SEC-M7-D18/registration.original.txt)、[旧台账 TAP](evidence/SEC-M7-D18/registry.original.txt)、[兼容 TAP](evidence/SEC-M7-D18/compatibility.original.txt)和[工具 TAP](evidence/SEC-M7-D18/tools.original.txt)保存原字节。命令及检查结果见 [checks.original.json.txt](evidence/SEC-M7-D18/checks.original.json.txt)，汇总与绑定见 [verification.json](evidence/SEC-M7-D18/verification.json)和[acceptance.json](evidence/SEC-M7-D18/acceptance.json)。test/\*\* 仍受既有 lint/format 排除，仅声明其严格类型与实际执行结果通过。

### 失败事实与限制

初轮合成夹具直接通过事务新增 approved 申请，正确触发存储转换拒绝；改用明确的可信加密存储输入，未放宽生产状态机。原“未来版本”测试从 3 调整到 4。初版仅从记录字段推断会话/配对，使复制了会话字段的配对可被误判，现按集合分别验证，且只允许各自字段。原生测试先对预建、继承 ACL 的临时根目录打开而被拒绝，改为由保护器创建专用子目录。异步 begin 未 await、过期查询已回收的预期也修正。离线 pending 直接删除的真实缺陷按前述修复。聚合首轮 57 项为 32 pass/25 fail（工具输出截断）；其针对性原始失败保存在本目录 `session-parent-*-failed.original.txt`，未改写成成功。首次类型检查发现投影类型仍调用要求 secretHash 的 helper，改为非秘密结构副本；初次 lint 的限定格式差异已修复。执行本地 Python 别名失败后使用已有 Node，不安装新运行时。

本轮未运行整仓 check、Chrome/正式 UI、Windows Hello/新双机认证、独立性能/生产容量、完整发布安装/升级降级、物理磁盘满或硬件断电；V3 三提交点测试是异常注入恢复，不冒充真实 V3 子进程硬退出。D17 Chrome/纵向硬退出等证据只作历史保存，不替代本轮结果。通用动态撤销、用户停用/换钥和队列执行边界仍在 DR-P2.3/P2.4，登录/恢复/续期正式流程为 DR-P2.2。当前 common/core 已安装声明用于类型检查，未重装依赖；SDK/shared 新声明与 browser 消费另验。

**DR-P2.1 完成；新增扩展 7/23，DR-P2 为 1/5，必需工作包仍 1/4。下一 DR-P2.2：公钥登录、验证确认、Cookie/CSRF、恢复、续期与注销。** 功能简介、用户手册、协议/身份/浏览器契约、构建回退说明、总体计划、专项 AGENTS 和唯一台账同步。未读取或修改真实配置、certs/、根 security/、凭据/密钥、Vault/业务库或真实 ACL，未连接/重启真实 9091、安装系统信任、提交、推送、部署或发布。

## D19：DR-P2.2 公钥登录与浏览器会话

日期：2026-10-27（America/New_York）。接续同一未提交工作区，保留全部既有变更、四条根 security 索引删除和 D18 及更早证据。

### 交付内容

新增浏览器可用的 shared 登录协议、Server 登录挑战台账/服务/HTTP，以及 SDK `loginBrowserSession`。新登录默认关闭；只有明确 `authentication.enabled=true`、已验证的准确 HTTPS 部署描述和迁移许可，才将 V1/V2/V3 原子升级到 V4。普通 open 或关闭的新功能不迁移旧格式。原 Token、配对、授权/撤销、实例及数据密钥保留；V4 禁止手工降级，完整旧发行包降级/升级和生产切换未验收。

挑战绑定实例、当前部署摘要、Origin/RP、访问代次和每次浏览器 nonce，只保存摘要，60 秒单次认领。独立的 HttpOnly/Secure/SameSite=Strict 挑战 Cookie 按 challengeId 隔离，不把浏览器秘密放进 JSON。固定 WebAuthn 库实际验证 get、签名、挑战、RP/Origin、UP/UV；拒绝 crossOrigin/topOrigin，发现式 userHandle 必须准确匹配。未知、未批准、停用或错误证明统一拒绝。单设备计数器最终再比较，防止不同挑战的同计数器竞争；同步 multiDevice 不单凭计数回退判克隆，持久值不回退。

异步验证后重查来源、开关/部署、到期、访问代次及最新公钥/用户/主体。计数器、备份属性、挑战终态、短会话与成功审计同一原子提交，完成后才发送 Cookie；不新增 API 凭据，不获取管理员权限。会话复用原有 GET/refresh/logout，30 分钟滑动、绝对 8 小时，刷新轮换 Cookie/CSRF，注销保留登记。注册窗口关闭或描述过期不阻止已批准身份登录；关闭新登录不自动注销已有会话。

补齐会话生命周期网络分类：准确的 session GET/refresh/logout 三条路径使用数据网络规则，局域网客户端可恢复自己的会话；安全中心与其他管理接口继续使用管理规则和独立身份。公开登录前置检查准确 Host/Origin、HTTPS、same-origin Fetch Metadata、JSON/64 KiB、无 query/CORS，并有来源/实例预算、1000 挑战、4 并发/32 等待上限；匿名拒绝使用持久聚合，本机管理不进入证明队列。限额不表示性能/生产容量通过。

### 实际验证与证据

Windows / Node 24.22.1 / Chrome 156.0.8078.48；全新系统临时目录、随机回环端口、合成 TLS 证书和独立 Chrome profile。Chrome 按已确认的沙箱 GPU 限制在正常执行环境运行，未关闭浏览器安全沙箱或安装系统信任；新 SDK bundle 来自当前源码，既有 dist 未覆盖。

| 检查           | 结果                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 登录与 V4 存储 | 55/55；真实 ES256/RSA 软件签名、错证明/Origin/RP/UV/来源、nonce、重放、计数器竞争、异步后拒绝、窗口独立、4/32 队列与本机列表、限流、1000 挑战、30 分钟/8 小时、V1/V2/V3 CAS/幂等及三个原子提交点恢复  |
| 原有路径回归   | 169/169：会话父级 35、注册 95、原台账/Windows 密钥 13、网络/授权/HTTP/短会话 26                                                                                                                       |
| 原生浏览器纵向 | 1/1，包含真实 navigator.credentials.create/get、原生 HTTPS/DPAPI/Named Pipe 批准、新 SDK、未批准拒绝、Cookie 属性、数据范围、管理拒绝、重载恢复、CSRF/续期/注销、重启、关闭新登录和过期注册窗口独立性 |
| 证据与报告工具 | 28/28；D19 优先，缺原生浏览器、原子登录/计数器/队列、Cookie/CSRF、失败/skip 或计数不符时拒绝完成，不回退 D18                                                                                          |
| 类型/静态/文档 | 临时新 shared 声明、整个 Server 与新旧测试严格类型、SDK DOM 消费与 browser bundle、限定源码 lint/格式、文档链接/锚点及 23 项任务计数、Git 材料守卫和当前/历史摘要核对通过                             |

共 **253/253，0 fail/skip/cancelled/todo**。[登录 TAP](evidence/SEC-M7-D19/authentication.original.txt)、[回归 TAP](evidence/SEC-M7-D19/regression.original.txt)、[浏览器 TAP](evidence/SEC-M7-D19/browser.original.txt)、[原生集成报告](evidence/SEC-M7-D19/integration-check.json)和[工具 TAP](evidence/SEC-M7-D19/tools.original.txt)保留原字节。命令/静态检查见 [checks.original.json.txt](evidence/SEC-M7-D19/checks.original.json.txt)，汇总与源码/历史证据绑定见 [verification.json](evidence/SEC-M7-D19/verification.json)、[acceptance.json](evidence/SEC-M7-D19/acceptance.json)。test/\*\* 沿用原 lint/格式排除，只声明严格类型和实际测试结果。

### 失败事实与边界

保留首轮 32 项中的 31 个失败、后两轮 HTTP 失败及两轮原生浏览器失败报告。固定库生成选项包含 extensions=undefined，严格契约正确拒绝；现用最小显式投影。新路由错误投影残留格式字段已修正。HTTP 发现原会话生命周期落在管理网络规则，按前述修复。原生成功签名后提交因两次 Date.now 相差毫秒而越过“创建时间+8 小时”的持久上限，现由同一取时点计算全部期限；不放宽期限校验。首次浏览器失败仅暴露封闭的 evaluate 失败，第二轮只输出稳定 CAPACITY 码，未记录证明或秘密。初次严格类型发现 TLS 测试夹具错误嵌套已修正，限定 lint/格式也按实际运行归档。首轮回归聚合参数切片遗漏每组首文件，只执行了 103 项且全部通过；保留 partial 原始 TAP，补齐后实际执行 169/169，不用部分结果代替完整回归。首轮文档检查因最终回归日志尚在生成而缺链接，待其完成后重验；README 追加的 EOF 空行也已修正。

三个登录提交点是异常注入及重开恢复，不是真实进程硬退出、物理磁盘满或硬件断电；journaled/replaced 后可能已有成功会话和审计但未向浏览器返回 Cookie，不能声称一定未提交。1000 挑战测试使用受信合成持久占位及真实边界请求，不冒充 1000 设备或吞吐验收。Chrome 虚拟认证器不证明 Windows Hello、硬件不可导出或两台实际设备。未运行整仓 check、正式页面视觉/i18n、Node 22、独立性能/生产容量、完整发布安装/旧发行包降级；依赖/锁未变，不重装依赖。动态撤销通知、排队写入、用户停用/换钥仍留待 DR-P2.3/P2.4。

**DR-P2.2 完成；新增扩展 8/23，DR-P2 为 2/5，必需工作包仍 1/4。下一 DR-P2.3：HTTP/RPC/WS/发布接口动态授权、撤销索引/通知和写队列执行前检查。** 简介、手册、配置说明、协议/身份/浏览器契约、总体计划、专项 AGENTS、测试说明和唯一台账同步；本轮无正式页面/翻译变化。未读取/修改真实配置、certs/、根 security/、凭据/密钥、Vault/业务库或真实 ACL，未连接/重启真实 9091、安装系统信任、提交、推送、部署或发布。

## D20：DR-P2.3 动态授权、撤销通知与执行边界

日期：2026-10-27（America/New_York）。接续原未提交工作区，全部既有变更、四条根 security 索引删除、D19 及更早证据保留。

### 交付行为

登记凭据状态或用户 enabled 变化计算准确影响集合，推进策略版本，禁用/停用与旧会话撤销同一原子事务提交，成功后才通知。重新启用不复活原会话。用户到凭据反向索引覆盖该用户所有登记公钥，WS 按父凭据订阅；单公钥变更不误撤销独立 API 身份，签名计数器和注册窗口变化不导致会话失效。空闲 WS 按服务器剩余期限主动复查；权限改变需重新握手，存储失败关闭当前台账及关联连接。

新增内部 restrictRegisteredCredential：可信本机 OS 上下文、准确总修订、严格 grants 和动作子集，仅能减权，不能修改库/资源/发布摘要扩权。原通用注册存储接口仍拒绝 grants 改写。本步没有公开减权、禁用/启用/撤销或用户维护 HTTP/CLI；正式本机维护及换钥留 DR-P2.4，不把内部测试原语称为可用管理命令。

Server 在 gate 等待后、引擎加载后、异步授权返回后保留同步最终守卫，重验整组要求，包括批量发布先前项及旧/新业务库。发布接口仍准确锁定 resource/releaseDigest；绑定父授权传入子查询、子操作和批量每一项，只读结果和异步日志完成后再次查验。Core 执行器增加可选调用方守卫，在普通 batchUpdate/batchDelete 每独立项、关系异步准备后首个变更前复查；不复制引擎语义到 Server，不修改远程协议。

单项已提交不强制中断；普通/发布批量保留已提交项并准确报告部分计数，绑定自动刷新失败保留 mutation 和 refreshFailed；安全结果审计失败沿用 OUTCOME_UNCONFIRMED，不谎称回滚。insertMany/upsertMany 和关系导入引擎内部执行作为一个已进入的操作，不承诺中途取消或撤回。原 write gate、Vault、数据密钥、台账格式及显式迁移边界保留，无新增配置项。

### 实际验证

| 检查           | 结果                                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 动态授权专项   | 42/42；真实软件公钥登录、HTTP/RPC/准确 callable、随机回环 WS、单凭据/用户范围、服务器到期、重新启用不复活、队列/异步微任务、整组发布权限、父子/逐项批量、关系准备竞态、审计与三个原子提交点恢复 |
| 登录与原有路径 | 登录/存储 55/55，原父级/注册/Windows 密钥/网络/授权/HTTP/会话 169/169                                                                                                                           |
| 原生浏览器     | 1/1；复用现有真实 Chrome 虚拟认证器、HTTPS、DPAPI、Named Pipe 批准及新 SDK Cookie/CSRF 登录/恢复/轮换/注销验收，无正式页面改造                                                                  |
| 证据工具       | 30/30；D20 优先，缺动态/原生证据、跳过、计数不符或关键守卫不通过均拒绝，不回退 D19                                                                                                              |
| 类型/静态/文档 | 全新 shared/Core 声明、整个 Server/专项测试严格类型、SDK DOM/browser 边界、限定 lint/格式、Git 材料守卫、本地文档链接/锚点及 23 项任务计数通过                                                  |

共 **297/297，0 fail/skip/cancelled/todo**。本机测试 Node 24.22.1；另保留先前 Node 24.15.0 的原生浏览器通过记录，最终浏览器复验使用固定 Node 24.22.1。所有实例使用系统临时合成目录、随机回环端口；原生 Chrome 保持安全沙箱，按已确认 GPU 限制在正常执行环境运行，无系统信任安装。

原始 [动态 TAP](evidence/SEC-M7-D20/dynamic.original.txt)、[登录 TAP](evidence/SEC-M7-D20/authentication.original.txt)、[回归 TAP](evidence/SEC-M7-D20/regression.original.txt)、[工具 TAP](evidence/SEC-M7-D20/tools.original.txt)、[浏览器 TAP](evidence/SEC-M7-D20/browser.original.txt)与[原生报告](evidence/SEC-M7-D20/integration-check.json)原字节保留。[检查命令](evidence/SEC-M7-D20/checks.original.json.txt)、[文档核验](evidence/SEC-M7-D20/documents.original.json.txt)、[验证汇总](evidence/SEC-M7-D20/verification.json)和[源码/历史绑定](evidence/SEC-M7-D20/acceptance.json)可复查。严格类型包括新的 Core 可选执行守卫；没有覆盖既有 dist。test/\*\* 沿用既有 lint/格式排除，不声称测试文件经过该检查。

### 失败事实与边界

保留首轮 24 项的 4 个失败、次轮 1 个失败、单查询诊断失败、扩展 37 项的 1 个失败及 38 项候选的 1 个失败。原因是合成查询缺 trailing、绑定发布缺 publishedAt、测试调用 createCredential 签名错误及自动刷新枚举误用；按真实协议修正夹具，没有放宽认证或发布解析。扩展类型首次也暴露错误 createCredential 调用，修复后严格通过。初次限定 lint 14 处 curly 规则失败，已逐处修复并复验；初始 lint 文件被最终输出覆盖，失败事实见 validation-notes.json，不称其原字节已保存。Python 启动器不可用时未执行计划的文件修改；改用 Node 后才成功创建证据目录，保留该执行事实。首轮文档检查因所链接的文档报告自身尚未生成而失败，报告文件写入后重验。早期成功测试保留为 before-batch / candidate 记录，不代替最终新增关系/批量的验证。

三个限制授权提交点是异常注入/重开恢复，不是进程硬退出、物理磁盘满或硬件断电。journaled/replaced 后可以已经持久减权与审计，即使调用报错也不能假定没提交。未运行整仓 check、正式页面视觉/i18n、实际 Windows Hello/新双机身份验证、Node 22、独立性能/容量、完整发布安装/升级降级或真实切换。无新依赖或锁变更，不重装依赖；common 仍使用已安装声明，Core/shared 使用临时新声明。原生登录回归不冒充本步所有动态竞态的浏览器 UI 验收。

**DR-P2.3 完成；新增扩展 9/23，DR-P2 为 3/5，必需工作包仍 1/4。下一 DR-P2.4：正式本机禁用/启用/撤销、用户停用、换钥及丢失凭据重新审批。** 简介、手册、身份/授权/浏览器契约、总体计划、专项 AGENTS、测试说明与唯一台账同步。本轮无页面/翻译变化；未读取/修改真实配置、certs/、根 security/、真实凭据/密钥、Vault/业务库或真实 ACL，未连接/重启真实 9091、提交、推送、部署或发布。

## D21：DR-P2.4 本机身份维护与换钥

日期：2026-10-27。接续 D20 和本轮已有后端/CLI 草稿，保留所有既有工作区变更、D02—D20 历史证据及 D21 首次失败记录。本轮只使用系统临时合成实例，不接续此前真实 ACL 修复授权操作业务实例。

### 可用行为

既有 Windows OS 身份 Named Pipe 新增登记凭据/用户列表、凭据禁用/启用/终态撤销、登记用户停用/启用、明确减权及原子换钥。CLI 全部要求显式配置/实例，变更另需准确记录 ID、总 revision 和 `--yes`；角色/SID 注入、错误命名空间、未知字段、旧修订均拒绝。列表分页 1—100 条，仅投影状态、ID、时间、公钥 SHA-256 指纹和授权，不返回 rawId、公钥、证明或查询/会话秘密。列表记审计后返回最新 revision；大页仍受通道上限保护。

禁用一个公钥只撤销其自身会话，停用登记用户覆盖该用户全部登记凭据，同主体独立 API 身份不混用。启用要求父级有效、不复活旧 Cookie；revoked 终态不能启用或替换。减权只在已有准确库/资源/发布摘要内移除授权/动作，disabled 也可减权。普通存储事务仍禁止 grants 改写。

正常换钥要求新申请已经过注册证明、仍 pending 且未到期，由管理员可信核对；单次 CAS 在原 enabled 用户/主体下批准新公钥、保存显式授权、撤销旧 active/disabled 公钥和会话并审计。新授权可明确为空，不继承旧/API 范围；新公钥仍须签名登录，换钥不发 Token/Cookie。丢失时先 revoke，再用新申请经可信核验和既有 approve 显式关联原主体；不能靠备注或下载文件接管。每用户 20 行包含墓碑，满额不部分撤销旧钥。以上均不改变实例密钥、DEK、Vault 或备份，也不新增持久版本、配置开关或依赖。

### 发现与修复

复核发现同一公钥改变 COSE map 顺序后可绕过原始字节相等检查。新增 `same-key-reencoded` 实际注册用例在修复前失败（原文保留），已改为解码后由 Node 规范化为 SPKI 比较，覆盖 ES256/RSA、重排 CBOR、RSA 前导零、不同公钥和坏输入；不改变列表中既定的 COSE 指纹算法。重新编码旧钥不再被接受为换钥。

初次专项因新增软件身份夹具漏闭合失败；补齐后 29/31，剩余两项分别是匿名未知路径实际先受 401 门禁而断言 404，以及容量测试未跨注册限流窗口。修正断言和合成时钟后 31/31；补齐规范公钥比较后最终 33/33。故障恢复测试还实际验证 staged 时旧钥可重新签名、新申请不能登录；journaled/replaced 后旧钥拒绝、新钥可签名登录，身份/会话/审计共同恢复。

Chrome 首轮在当前执行沙箱内 `REGISTRATION_CDP_CLOSED:Runtime.enable`，未进入登录流程，原始报告保留。正常执行环境以同一测试、新临时实例/profile 重跑成功，未关闭浏览器安全检查或安装系统信任。主测试/类型使用 Node 24.22.1，原生浏览器最终使用正常环境 Node 24.15.0；报告准确保留各自运行时。

限定 lint 首轮发现新增分支缺少大括号，补齐后通过；保留初始输出。`test/**` 沿用既有 lint/格式排除，测试文件只声明实际运行和严格类型结果。

### 实际验证

| 检查              | 本轮结果                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本机维护专项      | **33/33**，0 fail/skip/cancelled/todo；含软件 ES256/RSA、正常/丢失审批、单凭据/全用户、墓碑容量、审计满、9 项提交点异常及实际 Windows DPAPI/Named Pipe/CLI；原生用例约 71.3 秒 |
| 动态授权/执行边界 | **42/42**；自身授权、HTTP/RPC/WS、队列、发布/绑定父子、部分成功和故障                                                                                                          |
| 公钥登录/存储     | **55/55**；签名、竞争、迁移、会话与 Cookie/CSRF                                                                                                                                |
| 原认证路径        | **169/169**；注册/审批、三类会话父级、原 Token/配对、台账、Windows 密钥、网络/授权/HTTP                                                                                        |
| 证据/报告工具     | **32/32**；D21 优先，缺维护、原生 CLI、换钥、脱敏、故障或有 skip 时拒绝，不回退 D20                                                                                            |
| 原生 Chrome       | **1/1**，Chrome 156，约 110.9 秒；虚拟认证器真实 get、新 SDK、HTTPS/DPAPI/本机审批、范围/管理拒绝、恢复/续期/注销、重启和关闭注册后登录                                        |
| 严格类型与静态    | 全新 shared/Core 声明、整个 Server 和含新维护夹具的严格测试类型、SDK DOM/browser bundle 边界；限定 lint/格式、文档链接/计数及 diff 检查通过；原 dist 不覆盖                    |

最终定向合计 **332/332**，各组均 0 fail/skip/cancelled/todo。可重复命令为 `pnpm run test:security:maintenance`、原动态/登录/注册专项以及 `node scripts/security-registration-storage-check.mjs`、`node scripts/security-registration-consumer-check.mjs` 和 `node scripts/security-authentication-integration-check.mjs`；本轮具体 Node 直接命令、退出码与原始 TAP 见[检查记录](evidence/SEC-M7-D21/checks.original.json.txt)，[维护 TAP](evidence/SEC-M7-D21/maintenance.original.txt)、[浏览器 TAP](evidence/SEC-M7-D21/browser.original.txt)、[验证汇总](evidence/SEC-M7-D21/verification.json)及[当前/历史绑定](evidence/SEC-M7-D21/acceptance.json)归档。

### 边界与接续

本步三个提交点是异常注入和重开恢复，不能冒充进程硬退出、物理磁盘耗尽或硬件断电。journaled/replaced 后报错也可能已经提交，必须先列表/审计核查，不自动重放。Chrome 虚拟认证器和软件签名不证明 Windows Hello、硬件不可导出或新双机通过。未执行整仓 check、正式页面视觉/i18n、独立性能/生产容量、全新发行包安装/升级降级；依赖与锁未变。本步没有页面或翻译改动，正式 UI 仍在 DR-P3。DR-P2.5 尚未完成，仍需集中验证故障、重启、撤销竞争及原认证兼容矩阵。

**DR-P2.4 完成，新增扩展 10/23、DR-P2 为 4/5、必需工作包 1/4；下一 DR-P2.5。** 同步简介、使用手册第 10 节、公共协议、身份/授权/浏览器契约、总体计划、专项 AGENTS、测试说明与唯一台账。未读取或修改真实配置、certs/、根 security/、凭据/密钥、Vault/业务库或真实 ACL，未连接/重启真实 9091，未提交、推送、部署或发布。

## D22：DR-P2.5 故障恢复、撤销竞争与兼容验收

日期：2026-10-27（America/New_York）。保留接续工作区全部既有改动、四条根 security 索引删除及 D02—D21 证据。本步完成 DR-P2 后端出口，只使用系统临时合成实例和随机回环端口。

### 发现与修复

新增真实签名竞争测试先复现两项失败：管理员在验签期间停用后立即启用凭据或用户，旧在途证明仍可成功。修复为挑战认领后、进入证明队列的首次 await 前解析身份并订阅该凭据失效通知；曾经失效的标记不因重新 enable 清除，验签后再次拒绝，finally 释放监听和队列许可。排队中的两种循环也覆盖。减权保持有效身份，最终事务读取最新 grants；无关更新不误拒绝。不新增配置、持久字段、协议版本或依赖，不改变 write gate、Vault/数据密钥层级及原 Token/配对。

### 实际验证

| 检查           | 本轮结果                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 恢复与竞争专项 | **55/55**：30 个真实子进程退出、10 类签名/排队竞争、刷新/注销与凭据/用户撤销两种顺序、4 个审计满边界、换钥/撤销 CAS 与三类身份兼容；0 fail/skip/cancelled/todo                                                 |
| 真实退出矩阵   | 登录、挑战认领、刷新、注销、凭据禁用/撤销、用户停用、减权、换钥及 V2→V4 迁移各在 staged/journaled/replaced 直接 process.exit，无 finally；重开验证身份/会话/计数器/挑战/审计完整、成功审计恰一次、实例密钥不变 |
| 本机维护       | **33/33**，含原生 Windows DPAPI、Named Pipe 和实际 CLI；约 78.6 秒                                                                                                                                             |
| 动态授权与登录 | 动态 **42/42**；原登录/存储 **55/55**                                                                                                                                                                          |
| 原认证兼容     | **169/169**，含三类会话父级、注册/审批、台账/Windows 密钥、网络/授权/HTTP/原 Token 与配对                                                                                                                      |
| 证据/报告工具  | **37/37**；D22 优先，缺矩阵、原生/维护证据、skip、计数漂移、关键检查失败或虚假硬件/真实环境声明均拒绝，不回退 D21                                                                                              |
| 原生浏览器     | **1/1**，Chrome 156，约 110.5 秒；真实 get、新 SDK、HTTPS/DPAPI/本机批准、Cookie/CSRF、数据范围/管理拒绝、恢复/续期/注销、重启及注册窗口独立                                                                   |
| 类型与静态     | 全新 shared/Core 声明、整个 Server 与新 worker/专项严格类型，SDK DOM/browser bundle 边界；限定源码 lint/格式、文档链接/任务计数、diff 与 Git 材料守卫通过，原 dist 不覆盖                                      |

合计 **392/392，0 fail/skip/cancelled/todo**。主测试/类型使用 Node 24.22.1；原生 Chrome 按此前已确认的执行沙箱限制在正常环境运行，使用 Node 24.15.0，不关闭 Chrome 安全机制或安装系统信任。

重复入口为 `pnpm run test:security:resilience` / `node scripts/security-authentication-resilience-check.mjs`，输出临时脱敏 JSON/TAP，严格要求 55 项和完整矩阵。原生维护/浏览器及其他回归仍单独执行，不将合成保护器的硬退出称为 DPAPI 硬退出。源码/历史绑定见 [acceptance.json](evidence/SEC-M7-D22/acceptance.json)，实际计数和边界见 [verification.json](evidence/SEC-M7-D22/verification.json)；[恢复 TAP](evidence/SEC-M7-D22/resilience.original.txt)、[恢复报告](evidence/SEC-M7-D22/resilience-check.json)、[维护 TAP](evidence/SEC-M7-D22/maintenance.original.txt)、[动态 TAP](evidence/SEC-M7-D22/dynamic.original.txt)、[登录 TAP](evidence/SEC-M7-D22/authentication.original.txt)、[原认证 TAP](evidence/SEC-M7-D22/regression.original.txt)、[工具 TAP](evidence/SEC-M7-D22/tools.original.txt)、[Chrome TAP](evidence/SEC-M7-D22/browser.original.txt)与[原生报告](evidence/SEC-M7-D22/integration-check.json)原字节保留。命令和退出码见[检查记录](evidence/SEC-M7-D22/checks.original.json.txt)。

### 失败事实与边界

保留[修复前两项失败](evidence/SEC-M7-D22/before-fix.original.txt)与首次严格类型失败：IPC 签名回调返回 unknown，改为准确 assertion 返回类型后通过。首轮完整专项 55/55，通过正式 runner 再验 55/55，早期原始记录均保留。一次批量字符串替换因 CRLF 不匹配退出，及一次文档补丁上下文不匹配均未写入文件；随后使用明确换行/准确文本完成，未覆盖用户改动。限定 lint 首次即通过。test/\*\* 沿用既有 lint/格式排除，只声明严格类型和真实测试结果。

真实进程退出不等同物理磁盘耗尽、硬件断电或 OS 突然掉电。journaled/replaced 后可能已提交但未收到成功，登录可能存在未送达 Cookie 的持久会话；不恢复原秘密，不自动重放，用列表/审计核查，有 Cookie 尝试恢复，无 Cookie 新挑战，旧会话按期限或管理员撤销回收。旧认证兼容回归不能替代完整旧发行包安装/降级或真实迁移。未做整仓 check、正式页面/三语言视觉、实际 Hello/新双机、Node 22、独立性能/生产容量、完整发布安装/升级降级。无依赖/锁改动，不重装依赖。

**DR-P2.5 完成，DR-P2 后端工作包完成 5/5；新增扩展 11/23，必需工作包 2/4。下一 DR-P3.1：同源 Designer/API 静态托管、专用回环管理监听器和管理启动器。** 简介、使用手册第 11 节、公共/身份/授权/浏览器契约、总体计划、专项 AGENTS、测试说明与唯一台账同步。本步无页面/i18n 改动。未读取或修改真实配置、certs/、根 security/、凭据/密钥、Vault/业务库或真实 ACL，未连接/重启真实 9091，未提交、推送、部署或发布。

## D23：DR-P3.1 同源托管、专用管理监听器与启动器

日期：2026-10-27（America/New_York）。接续前检查状态并保留全部现有改动、四条根 security 索引删除、真实配置的原有修改与 certs 未跟踪状态。仅使用系统临时合成实例、随机回环端口、新 build 与新 Chrome profile。

### 实现与可用操作

新增显式 `security.hosting`，未配置/false 保持原独立前端模式，legacy 拒绝启用。数据监听器提供 `/designer/` 与同源数据 API，所有管理页/API 即使从回环访问仍拒绝；专用 HTTP 管理监听器固定绑定 `127.0.0.1`，不安装数据/WebSocket 路由，不接受代理头、localhost 别名或错 Host/Origin。服务端核对实际 socket 和准确来源，不依赖前端隐藏按钮。

`security security-open -c <显式配置>` 经原生 OS 身份 Named Pipe 获取当前运行中的准确管理端口，一次性配对码仅放 fragment，消费后清除；不接受 URL/server/databases 覆盖，不在 stdout 输出配对码。新管理凭据无数据授权，空闲 15 分钟、绝对 60 分钟，续期和重启均不延长，旧八小时身份拒绝。正常关服及启动失败释放两个监听器、台账、本机通道和计时器，不自动扩大绑定。

静态目录启动时白名单快照，限制文件类型、数量和大小，拒绝秘密/源码/map/JSON、额外 HTML、链接/联接/硬链接及保护目录重叠；不接受请求路径拼接读盘、目录列表或任意 SPA 回退。CSP self、nosniff、no-store、no-referrer 和嵌入拒绝同时执行。构建脚本只写显式新目录，禁用本地 Vite 配置/env，保留原 dist。

页面复用现有 Designer 与安全中心，新增服务端公开 role 标记仅用于当前 Origin 默认值及隐藏管理端不可用的设计指引，不作为权限证明。未新增可见文案/翻译键；zh/en/ja 已在真实托管页面验收。正式注册/Passkey/待审状态页继续 DR-P3.2，审批维护 UI 继续 DR-P3.3。

### 验证

| 范围                   | 结果                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 托管与报告专项         | **36/36**，静态白名单/快照/路径、Host/Origin/rebinding、六种代理头、角色/一次性配对、Cookie/CSRF、重启、15/60 分钟、旧管理身份和审计失败      |
| 原生 Windows 与 Chrome | **2/2**，实际 DPAPI/Named Pipe、真实主服务双监听器、绑定冲突清理及重启、Cookie 恢复、公开页面/管理权限、实际 Chrome 156、续期/注销/重载       |
| 登录 / 动态授权 / 维护 | **55/55、42/42、33/33**，维护包含原生 Windows CLI                                                                                             |
| 原认证与启动兼容       | **169/169** 原路径、**19/19** 三前端配对及连接凭据                                                                                            |
| 证据工具               | **39/39**，D23 优先，缺原生/浏览器/截图、关键检查、skip、计数漂移或虚假硬件声明拒绝，不回退 D22                                               |
| 类型与静态             | 全新 shared/Core 声明、整个 Server/严格测试、整个 Designer、SDK DOM/browser bundle；限定 lint/格式、文档链接/任务计数、diff、Git 索引材料守卫 |

定向合计 **395/395，0 fail/skip/cancelled/todo**。主回归/Server 类型使用 Node 24.22.1；Designer 类型和原生托管/Chrome 使用正常环境 Node 24.15.0。后者因执行沙箱不能读取已安装 exceljs/dayjs 且限制 Chrome CDP，使用同一隔离流程重跑；未重装依赖、关闭安全机制或安装系统信任。Vite 保留既有大 chunk 警告。

12 张宽窄屏截图覆盖连接页/管理概览、zh/en/ja、1280/390，检查标题翻译、语言标签/键盘焦点、页面宽度和长文案；实际图片检查层次、间距、可读性及导航滚动。本步不代表新注册/审批 UI 的视觉验收。手册第 12 节给出逐行 PowerShell、完整 JSON 示例、启动/关闭/排障与重复验证；简介、契约、总体计划、专项 AGENTS 和唯一台账同步。

可重复入口为 `pnpm run test:security:hosting`、`node scripts/security-hosting-integration-check.mjs`、类型/consumer 工具及 `node scripts/security-release-evidence.mjs`。见 [验证汇总](evidence/SEC-M7-D23/verification.json)、[原生报告](evidence/SEC-M7-D23/integration-check.json)、[托管 TAP](evidence/SEC-M7-D23/hosting.original.txt)、[原生 TAP](evidence/SEC-M7-D23/native.original.txt)与[源码/历史绑定](evidence/SEC-M7-D23/acceptance.json)。D22 历史证据原字节保留，新 receipt 绑定当前源码。

### 失败修复与边界

首轮测试 28/29 的失败为断言调用不存在的方法，改为核对实际凭据空授权；新 WebSocket 用例随后发现拒绝升级后 socket 残留导致关闭等待，改为管理端不安装数据/WS 路由并明确结束升级 socket。原生首轮发现绑定失败清理会重复关闭被信号终止的 Pipe 子进程：该子进程 exitCode 可持续为 null，第二次等待不会收到旧 exit 事件。修为缓存关闭 Promise 并核对 signalCode，原生复验包含绑定失败后立即重新启动。首轮失败和原生超时报告保留；早期 WebSocket 单例调试的终端输出留在会话工具记录中。

首轮严格测试缺 websocket 模块声明，改为准确的插件类型动态加载；Designer 改造首轮 JSX 括号错误由严格类型发现并修正，随后沙箱依赖读取失败在正常环境验证通过。工具夹具一次过宽文本替换误加旧组字段，39 项中 10 项失败，限定到新组后 39/39；保留失败记录。限定 lint 首次格式错误已修正；apps/test 沿用仓库 lint 排除，前端声明严格类型、格式及实际视觉，测试声明严格类型与实际运行，不冒称全仓 lint。

本轮未执行独立性能/容量、整仓 check、Node 22、远程 TLS 托管浏览器、真实 LAN/Hello/新双机、完整新发行安装/升级降级或真实切换。受控浏览器验证 OS 启动链接及消费，未操作用户默认系统浏览器。原合成硬退出证据留 D22，本步不重复声称物理断电/磁盘耗尽。未读取或修改真实配置、certs、根 security、真实凭据/密钥、Vault/业务库或真实 ACL，未连接/重启真实 9091，未提交/推送/部署。

**DR-P3.1 完成：新增扩展 12/23、DR-P3 为 1/6、必需工作包仍 2/4；下一 DR-P3.2：Designer 注册、Passkey/Hello、待审及拒绝/到期/换钥/恢复状态。**

## D24：DR-P3.2 Designer 注册、Passkey 登录与状态页

日期：2026-10-27（America/New_York）。接续前核对 Git 状态、专项和前端/SDK/shared/server 指引，保留所有已有变更、四条根 security 索引删除、真实配置原修改和 certs 未跟踪状态。全程只使用临时合成实例、随机回环端口、新 build 与 Chrome profile。

### 实现与用户可用操作

同源 HTTPS `/designer/` 提供 Passkey / Windows Hello 登录入口，首次申请、待审/批准/拒绝/到期状态、连接描述 JSON 下载/导入、换钥和丢失恢复指引。中英日文、主题样式、长文案、键盘焦点及窄屏同步实现。未支持 WebAuthn、取消、限流、描述不匹配、会话失效及停用/撤销均给出本地化说明；未知错误不展示响应体。原配对/应用 Token 折叠保留，数据权限及固定设计器库/业务库分工仍由原流程和服务端执行。

SDK 新增最小同源注册客户端，注册请求不携带 Cookie，描述严格 JSON/UTF-8 16 KiB，与实时实例/Origin/RP/部署摘要/TLS/期限比较；不执行代码、不改变目标、不向文件中的其他地址发送会话。continuationSecret 仅在内存闭包，状态页只显示申请编号/时间，至少每 5 秒轮询，终态、错误或卸载停止；刷新丢失查询能力但保留服务端申请，不自动重建。批准仍需显式新公钥登录。AbortSignal 中止页面退出后的操作，浏览器证明返回后、提交前再查取消状态。托管默认地址保留 HTTPS 协议，公开身份入口继续开库时固定当前 Origin，不复用兼容表单里编辑的另一地址或配对码。

认证能力接口新增可选公开 `deployment` 绑定，不随注册下载到期移除；原客户端可忽略，新客户端缺绑定拒绝。注册关闭/描述过期时，已有获批 Passkey 仍能从正式页面登录。换钥和恢复页面给出本机管理员核验及 CLI 路径，不提供自动接管；审批维护 UI 接续 DR-P3.3。当前页面使用可发现 Passkey，non-discoverable 的 rawId 提示仅 SDK 嵌入方可用。没有修改持久台账、Vault、数据密钥或依赖锁。

### 验证

| 范围                  | 结果                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 SDK/状态与报告专项 | **24/24**，同源请求、严格导入/大小/错误脱敏、取消和提交前中止、过期/拒绝/批准、旧绑定、五秒轮询与公开能力                                                                                           |
| 原生正式页面          | **1/1**，实际 Chrome/HTTPS/DPAPI/Pipe、按钮注册、JSON 导入拒绝及成功、本机拒绝/批准、待审无权限、批准不自动登录、WebAuthn 登录、准确数据范围、HttpOnly/Secure/Strict、刷新/注销、过期窗口与停用拒绝 |
| 托管与管理兼容        | 专项 **36/36**、原生 Chrome **2/2**，双监听器/生命周期/本机管理权限及旧页面恢复/注销                                                                                                                |
| 登录/动态授权/维护    | **55/55、42/42、33/33**，维护包含原生 Windows CLI                                                                                                                                                   |
| 原路径与三前端凭据    | **169/169、19/19**                                                                                                                                                                                  |
| 证据工具              | **41/41**，D24 优先，缺正式页面/原生记录、截图、检查、准确计数或出现 skip 拒绝，不回退 D23                                                                                                          |
| 类型与静态            | 全新 shared/Core 声明、整个 Server/严格新旧测试、整个 Designer、SDK DOM/browser 边界；限定 lint/格式、文档链接/计数、diff 和 Git 材料守卫                                                           |

定向合计 **422/422，0 fail/skip/cancelled/todo**。主回归/Server 类型使用 Node 24.22.1，Designer 类型及原生 Chrome 使用正常环境 Node 24.15.0；沙箱不能读取既有 exceljs/dayjs，在同一隔离流程中复验，不重装依赖。Chrome 156 为虚拟认证器，不是实际 Hello/硬件绑定。新页面 24 张截图覆盖 login/pending/rejected/approved、zh/en/ja、1280/390；托管兼容另 12 张，实际检查代表图片的层次、状态色、换行、可读性及滚动，自动化检查全部布局宽度、翻译、标签与焦点。

可重复入口：`pnpm run test:security:designer-identity`、`node scripts/security-designer-identity-check.mjs`，旧托管入口继续保留。操作手册第 13 节、简介、公共协议、总体计划、专项 AGENTS、测试说明与唯一台账同步。见[汇总](evidence/SEC-M7-D24/verification.json)、[正式页面报告](evidence/SEC-M7-D24/identity-integration-check.json)、[页面 TAP](evidence/SEC-M7-D24/identity-native.original.txt)和[源码及历史绑定](evidence/SEC-M7-D24/acceptance.json)。D23 原始证据与 receipt 原字节保留。

### 失败修复与边界

首轮 SDK 类型检查发现控制流收窄及 readonly WebAuthn 参数不兼容，改用明确 never 函数和可变参数副本；React ref 补显式初值。沙箱 Designer 依赖读取失败由正常环境复验。首次单测 17/18 的失败来自错误夹具：TLS 变体与原 public-ca 完全相同，改为实际不同 pin，随后通过。限定 lint 发现缺少花括号并修正。上述早期输出留在会话工具记录，摘要随 D24 保存。

首次正式页面链路通过；补导入交互的复验中，虚拟认证器可能自动选中先前被拒申请的 resident key，导致批准后的登录拒绝/等待超时。夹具在第二次申请前明确清除该被拒的合成认证器凭据，复验通过；没有放松服务端验证。保留失败报告/TAP及首次成功报告。三前端兼容首轮只跑到 18 项，补齐凭据测试文件后 19/19，旧日志保留。

本步未执行整仓 check、Node 22、独立性能/容量、真实 LAN/Hello/新双机、完整业务建模保存、完整发行安装/升级降级或生产切换；不以 scope 200 替代这些验收。浏览器过程只为该进程固定合成 SPKI，不安装系统信任。未读取或修改真实配置、certs、根 security、凭据/密钥、Vault/业务库或真实 ACL，未连接/重启真实 9091，未提交、推送、部署或发布。

**DR-P3.2 完成；扩展 13/23，DR-P3 为 2/6，必需工作包仍 2/4。下一 DR-P3.3：本机申请核对、用户/凭证/授权/会话维护及冲突恢复 UI。**

## D25：DR-P3.3 本机审批与身份维护界面

日期：2026-10-27（America/New_York）。接续核对 Git 状态、专项与前端/shared/SDK/server 指引，保留全部已有改动、四条根 security 索引删除、真实配置原修改及 certs 未跟踪状态。只使用全新临时合成实例、随机回环端口、独立 build 和 Chrome profile。

### 实现与可用操作

专用本机安全中心新增“注册身份”：申请/用户/公钥凭证/浏览器会话四类分页列表与详情，申请批准/拒绝，新用户或已有操作员关联，逐项准确授权；用户/公钥停启、授权收缩、永久撤销、原子换钥/丢失恢复和单会话撤销。列表每页 10 条，元数据不返回 rawId、公钥字节、Cookie、查询秘密或密钥。换钥候选仅为前 100 条申请内已验证待审记录，超出使用现有 CLI 分页核查。

所有操作先编辑、预览、独立核对确认，预览锁定编辑区；成功、失败或版本冲突均关闭草稿并锁定旧快照，必须重新加载核对，不自动换版本重试。永久撤销不能重新启用，用户停用影响其全部公钥，单会话撤销不撤销父凭证；撤销当前管理会话后重新运行本机启动器进入。批准和换钥不自动登录。

HTTP 命令仅通过专用 127.0.0.1 管理监听器，公开数据监听器仍 404，旧独立监听模式拒绝 registration.\* 命令。实际 socket、Host/Origin、转发头拒绝、短期 OS 配对管理 Cookie/CSRF、管理预算与后端再次验会话同时执行。复用原严格 parser、准确实例/UUID、CAS/confirm、收缩及规范公钥比较与原子审计，不伪造 SID 或把普通 withManagementActor 当作本机权限。HTTP 审计保留真实配对主体、requestId 和 socket 来源；OS CLI 身份规则保留。补齐 NOT_FOUND、显式确认与本机身份拒绝的 HTTP 状态映射。

中英日文、主题卡片、状态提示、键盘焦点、长文案、窄屏和加载/空/错误/禁用均实现。操作手册第 14 节包含打开入口、独立核验、各类维护范围、冲突/结果不明排障和重复验证；简介、协议、计划、专项 AGENTS、测试说明与台账同步。

### 验证

| 范围                       | 结果                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 新管理后端与报告           | **14/14**，监听器/身份/Cookie/Origin/CSRF/转发头、字段白名单、分页与秘密投影、CAS/确认、审批/减权/换钥/用户维护、会话撤销、HTTP 审计及审计容量失败                       |
| 原生管理 UI                | **1/1**，实际 Chrome、HTTPS、DPAPI/Pipe，真实页面批准/拒绝、准确授权、独立公钥登录、用户与公钥停启、减权/换钥/永久撤销、单会话与当前管理会话撤销、冲突不重放、重启与分页 |
| 原正式注册 UI / 托管       | **1/1、2/2**，原注册登录状态与 Cookie 生命周期、双监听器/生命周期及原安全中心兼容                                                                                        |
| 登录 / 动态授权 / 本机维护 | **55/55、42/42、33/33**；本机维护包含原生 Windows CLI                                                                                                                    |
| 原认证 / 三前端配对凭据    | **169/169、19/19**                                                                                                                                                       |
| 证据工具                   | **43/43**，D25 优先；缺管理 UI、冲突/确认/分页、原生范围、截图或准确计数均拒绝，不回退 D24                                                                               |
| 类型与静态                 | 全新 shared/Core 声明、整个 Server 与严格管理测试、整个 Designer、SDK DOM/browser 边界；限定 lint/格式、文档链接/计数、diff 与 Git 材料守卫                              |

定向合计 **439/439，0 fail/skip/cancelled/todo**。主回归/Server 类型使用 Node 24.22.1；Designer 类型与原生 Chrome 使用正常环境 Node 24.15.0。执行沙箱不能读取已有 exceljs/dayjs，在同一隔离流程复验，未重装依赖。Vite 保留既有大 chunk 警告。实际 Chrome 156 使用虚拟认证器，不是实际 Hello 或物理硬件绑定。

新管理页面 24 张截图覆盖 applications/approval-review/conflict/credentials、zh/en/ja 和 1280/390；旧注册与托管兼容另 36 张。实际检查代表图片的层次、可读性、换行、状态色与窄屏滚动，自动检查全部布局宽度、翻译、标签与焦点。见[验证汇总](evidence/SEC-M7-D25/verification.json)、[管理 UI 报告](evidence/SEC-M7-D25/admin-integration-check.json)、[管理 TAP](evidence/SEC-M7-D25/admin-native.original.txt)和[源码/历史绑定](evidence/SEC-M7-D25/acceptance.json)。D24 receipt 与历史证据原字节保留。

可重复入口：pnpm run test:security:identity-admin、node scripts/security-identity-admin-check.mjs、原托管/注册及严格类型工具，最终 node scripts/security-release-evidence.mjs 核对当前源码与历史证据。

### 失败修复与范围

首次类型检查发现 endpoint 缺 port、联合返回类型失去分页信息及可选 grants 的类型问题，修为当前 Origin+准确端口、按 action 索引结果类型及空授权回退；复验通过。首次单测 8/10，Node fetch 忽略调用方 Host 覆盖，改沿用真实 http.request 托管测试覆盖；另暴露 NOT_FOUND/确认错误的状态映射缺失，已补齐，复验 10/10。新严格测试发现异构头数组类型不匹配，补准确 Record 类型。限定 lint 首轮 17 处缺花括号，修复后复验；apps/test 继续沿用仓库 lint 排除，前端以严格类型、格式和实际视觉验收，测试以严格类型和实际运行验收，不冒称全仓 lint。

原生首轮测试自己拼接的启动链接缺正式 server 字段，改复用正式 hostedSecurityLaunchUrl；第二轮已通过维护主流程，批量创建分页申请触发正常注册限流，改为临时实例停机后添加无公钥容量夹具并重新启动，不放松正式限流。第三轮完整通过，最终候选另作正式复验；原始失败报告/TAP及早期成功记录保留。截图发现窄屏批准预览尚未滚入视口，修为滚动实际预览后取图；未改安全规则。早期控制台类型/lint/测试输出仍留会话工具记录。

本轮未执行整仓 check、Node 22、独立性能/容量、真实 LAN/Hello/新双机、完整业务保存、完整发行安装/升级降级或生产切换。合成 HTTPS SPKI 仅固定于测试 Chrome 进程，不安装系统信任；真实磁盘满/物理断电不在本项。未读取或修改真实配置、certs/、根 security/、凭据/密钥、Vault/业务库或真实 ACL，未连接/重启真实 9091，未提交、推送、部署或发布。

**DR-P3.3 完成；新增扩展 14/23，DR-P3 为 3/6，必需工作包仍 2/4。下一 DR-P3.4：首次部署向导、描述导入/下载、RP/证书预检及注册窗口/网络规则指引。**

## D26：DR-P3.4 首次部署向导与停机提交

日期：2026-10-27（America/New_York）。接续先核对 Git 状态、专项/模块/页面指引、D25 与台账；保留全部已有改动、真实配置原修改、四条根 security 索引删除和 certs 未跟踪状态。只创建临时合成实例、全新 build、随机回环端口和独立 Chrome profile。

### 实现与可用操作

新增 `security deployment-init --target <new-absolute-directory> --designer <absolute-public-build> [--port 9090] --yes`，在普通配置加载前分派，不发现默认配置或网卡。明确新目录、禁止覆盖、公开 build 白名单与路径检查后建立 OS 保护的实例身份；bootstrap 仅绑定 127.0.0.1，注册/公钥登录关闭，无业务库或数据授权。经原 Named Pipe 启动器进入专用本机“首次部署”页面。

向导默认本机；远程必须明确选择 HTTPS LAN，填写准确 Origin/RP/端口、公开证书、文件路径、信任模式/SPKI、明确 CIDR 和有限窗口。后端严格未知字段拒绝，检查 SAN、有效期覆盖窗口、SPKI、来源规则与部署绑定；HTTP 不打开证书/私钥路径、不解析 DNS 或发网络请求。只接受最大 16 KiB 单份公开证书，浏览器先拒绝私钥，后端再独立拒绝。注册默认关闭，1—168 小时窗口到期不撤销已有批准身份。信任、DNS、证书私钥匹配始终标为未验证，不安装系统信任。

预览绑定准确实例与 bootstrap 摘要（同时绑定原公开 build），十分钟有效；候选配置和公开描述只供核对。支持严格公开描述 JSON 导入比较与下载，不执行内容、不自授权限或改变目标。独立三项确认后导出计划；过期禁止导出，编辑关闭旧预览。中英日文、主题卡片、宽窄屏、标签/焦点和表单对比度同步实现。已有配置被修改、存在业务密钥/应用凭据/注册台账或已开始提交的实例仅显示人工合并指引。

停止 bootstrap 后，显式 `security deployment-finalize --target ... --plan ... --digest ... --yes` 再核对期限、摘要、实例、公开证书文件和独占租约。通过原防护 preview/apply/confirm 保存来源规则并保留限流预算，再禁止覆盖地写 `modeldb.deployment.json`，保留原身份和 bootstrap，不自动重启。提交先写一次性标记；跨文件中断/结果不明保留现场并拒绝自动重试，不声称跨配置和台账的硬件断电原子性。已有实例及代理部署按手册人工核对/合并，不能删台账或密钥取得资格。

### 验证

| 范围                       | 结果                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新部署与报告专项           | **22/22**：18 项默认安全/严格字段/绑定/证书/期限/CIDR、目录与链接、独占租约、身份保留/持久规则、单次写入、审计满/中断及 4 项原生报告完整性                 |
| 原生首次部署 UI            | **1/1**：实际 CLI/DPAPI/Pipe/Chrome、公开 PEM、错误 RP/pin 拒绝、预览不写、确认/过期、描述导入下载、停机提交、身份/规则保留、合成 HTTPS 启动及现有实例指引 |
| 原管理 / 注册 / 托管 UI    | **1/1、1/1、2/2**；新原生合计 5 项                                                                                                                         |
| 登录 / 动态授权 / 本机维护 | **55/55、42/42、33/33**，维护包含原生 Windows CLI                                                                                                          |
| 托管 / 身份管理 / 注册 SDK | **36/36、14/14、24/24**                                                                                                                                    |
| 原认证 / 三前端配对凭据    | **169/169、19/19**                                                                                                                                         |
| 证据工具                   | **45/45**；D26 优先，缺部署/停机/规则/截图、计数漂移、虚假信任/硬件或 skip 拒绝，不回退 D25                                                                |
| 类型与静态                 | 全新 shared/Core 声明、整个 Server 与严格新旧测试、整个 Designer、SDK DOM/browser 边界；限定 lint/格式、文档链接/三语言键/任务计数、diff 及 Git 材料守卫   |

定向合计 **464/464，0 fail/skip/cancelled/todo**。主回归及 Server 类型使用 Node 24.22.1，Designer 类型和原生 Chrome/DPAPI 使用正常环境 Node 24.15.0；沙箱不能读取既有 exceljs/dayjs，正常环境同一隔离流程通过，未重装依赖。Vite 保留既有大 chunk 警告。Chrome 156 的认证兼容仍用虚拟认证器，不是实际 Hello/硬件绑定。新向导 24 张截图覆盖 local/lan/review/existing、zh/en/ja、1280/390；兼容 UI 另 60 张。自动检查布局宽度、语言/标签/焦点、表单对比度；实际查看代表图片并修复浅色主题输入背景，核对层次、换行及可读性。

手册第 15 节提供完整隔离 PowerShell、字段解释、停机提交、已有实例合并、结果不明及重复验证；简介、方案/部署契约、专项 AGENTS、测试说明与唯一台账同步。可重复入口 `pnpm run test:security:deployment`、`node scripts/security-deployment-wizard-check.mjs`、原注册/管理/托管和严格类型工具。见[验证汇总](evidence/SEC-M7-D26/verification.json)、[部署原生报告](evidence/SEC-M7-D26/deployment-integration-check.json)、[部署 TAP](evidence/SEC-M7-D26/deployment-native.original.txt)及[源码/历史绑定](evidence/SEC-M7-D26/acceptance.json)。继承 D25 的 556 条历史描述逐字节核对，历史记录和 receipt 不改写。

### 失败修复与范围

首次 Server 类型发现 unknown 字段收窄不足，改为已验证字段的明确类型并复验；限定 lint 的缺花括号/格式已修复。沙箱 consumer/build 因既有依赖访问限制失败，同一隔离入口在正常 Node 通过。证据辅助生成最初调用不可用 Python，未生成文件；改用 Node，旧 writer 从未运行或修改。首次原生主流程已完成，但将 disabled 公开描述下载误断言为 403；修正为检查描述 disabled，且新申请实际 403，再通过。首次成功截图发现浅色主题输入框深色背景，改为既有 surface 变量、增加对比度及过期导出检查后最终复验。原生首轮失败 TAP/报告及修样式前记录保留于 D26，早期类型/lint/工具输出留在会话记录。

候选 LAN 配置保持 0.0.0.0，但全部测试启动显式覆盖 host 为 127.0.0.1，随机端口；不声称真实 LAN、DNS/公共 CA 信任、私钥配对部署或双机验收。未运行整仓 check、Node 22、独立性能/容量、完整业务保存、新发行安装/升级降级、硬件断电/物理磁盘耗尽或生产切换。浏览器合成 SPKI 只作用于该测试进程，不安装系统信任。未读取或修改真实配置、certs/、根 security/、凭据/密钥、Vault/业务库或真实 ACL，未连接/重启真实 9091，未提交、推送、部署或发布。

**DR-P3.4 完成；新增扩展 15/23，DR-P3 为 4/6，必需工作包仍 2/4。下一 DR-P3.5：SDK 公共客户端、三个前端兼容、zh/en/ja 与无障碍交互。**

## D27：DR-P3.5 公共客户端与三前端兼容

日期：2026-10-28（America/New_York）。接续核对专项/模块 AGENTS、台账、D26 与 Git 状态，保留已有修改、真实配置原修改、四条根 security 索引删除及 certs 未跟踪状态。全部验证使用全新临时合成实例、独立输出、随机 127.0.0.1 端口和 Chrome profile。

### 实现与可用操作

SDK 新增 createBrowserIdentityClient：统一公开能力、描述导入/下载、注册状态、Passkey 登录和会话检查/注销。显式 endpoint、HTTPS 同源及实例/部署摘要绑定继续执行；冻结能力绑定，内部复制导入描述。每个视图仅允许一个操作，重复调用拒绝且不自动重放；dispose 传播取消并拒绝迟到结果/后续调用，不等于服务器注销。底层注册/登录/旧配对 API 保留，查询秘密仍只在闭包内。

Designer、Data Studio 与 Web 复用 data-ui 身份面板；展示适配器不引入 SDK/server/core，各应用注入公共客户端和已有翻译器。Studio/Web 的 HTTPS 公共入口固定当前 Origin，继续连接时清除旧 Token/配对码；“其他连接方式”保留原配对及应用凭据。本机 HTTP 配对继续使用，默认服务器仍只托管 Designer；本项不新增 Studio/Web 托管路径、代理/来源配置或系统信任。

申请、批准和登录保持独立。Designer 双库、保存逻辑、catalog 标签和 SDK 返回结构保留。Designer/Data Studio 同步 zh/en/ja，Web 保持既有 en/zh-CN；状态提示、可访问标签/焦点、窄屏和长文案复用同一展示层。运行手册第 16 节、简介、使用手册、协议/计划、专项 AGENTS、测试说明及唯一台账同步。

### 验证

| 范围                        | 结果                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册/公共 SDK 与报告        | **31/31**，含新增 7 项并发、取消/销毁、绑定漂移、描述隔离和闭包状态验证                                                                                               |
| 新三前端浏览器兼容          | **3/3**；Studio/Web 实际注册、拒绝/批准、Passkey、开库、刷新/注销、过期窗口/撤销；原三前端配对与应用凭据控件、授权列表及 Token 不恢复                                 |
| 原生向导/审批/Designer/托管 | **1/1、1/1、1/1、2/2**，新旧原生合计 **8/8**                                                                                                                          |
| 登录/动态授权/维护          | **55/55、42/42、33/33**，维护含原生 Windows CLI                                                                                                                       |
| 托管/身份管理/部署          | **36/36、14/14、22/22**                                                                                                                                               |
| 原认证/配对凭据             | **169/169、19/19**                                                                                                                                                    |
| 证据与新报告工具            | **47/47、4/4**，D27 优先，缺消费者/语言截图/精确计数或出现 skip 均拒绝，不回退 D26                                                                                    |
| 类型与静态                  | 全新 shared/Core 声明、整个 Server、严格新旧测试、三个前端完整类型；SDK DOM 无 Node 消费和 browser bundle；限定 TS/MJS lint、格式、文档/翻译/计数、diff、Git 材料守卫 |

合计 **480/480，0 fail/skip/cancelled/todo**：472 项定向及 8 项原生检查。主回归/Server 类型使用 Node 24.22.1，前端类型与原生 Chrome/DPAPI 使用 Node 24.15.0、Chrome 156。TSX 按既有 lint 配置未覆盖，采用严格类型、格式和实际页面验证，不冒称全仓 lint。保留既有 Vite 大 chunk 警告。

Studio/Web 新页面 40 张截图覆盖 login/pending/approved/rejected 和全部现有支持语言、1280/390；兼容截图另 103 张。自动检查布局宽度、语言、输入标签与焦点；实际查看代表图片，核对主题卡片、状态色、换行、可读性及滚动。第二轮失败截图另行保留，不混入通过计数。

可重复入口 pnpm run test:security:public-clients、node scripts/security-public-clients-check.mjs 及原向导/审批/注册/托管入口。见[验证汇总](evidence/SEC-M7-D27/verification.json)、[公共客户端报告](evidence/SEC-M7-D27/public-integration-check.json)、[原生 TAP](evidence/SEC-M7-D27/public-native.original.txt)和[源码/历史绑定](evidence/SEC-M7-D27/acceptance.json)。继承 D26 的 684 条历史描述逐字节核对，历史 receipt 保留。

### 失败修复与范围

首次 consumer 检查遇沙箱不能读取已有 exceljs/dayjs，同一隔离流程在正常 Node 环境通过，未重装依赖。严格测试发现旧 SDK 声明解析和 readonly 测试赋值问题，改用 SDK 源码路径及 Reflect.set 验证外部变更；整个 Server、严格新旧测试及三个前端通过。文档生成辅助脚本首轮语法错误，未写出文件，修正后生成。

浏览器首轮旧测试因菜单序号漂移超时，新夹具向非回环 HTTPS 主机名申请旧配对码被正常拒绝；改按菜单名称定位，并经本机授权合成应用凭据准备测试库。第二轮旧测试的维护标签写错，Studio 空库没有工作台模型；改为准确的“密钥引用”，为合成业务库注册模型后复验。未放松来源、授权或 WebAuthn 检查。两轮失败 TAP/报告及第二轮截图保留在 D27，早期类型/工具输出保留在会话记录。

未执行整仓 check、Node 22、独立性能/容量、完整业务建模保存、新发行安装/升级降级、真实 LAN/Hello/新双机、物理断电/磁盘耗尽或生产切换。合成 TLS SPKI 只固定于测试 Chrome 进程，不安装系统信任；浏览器为虚拟认证器，不证明物理主机/TPM 绑定。未读取或修改真实配置、certs、根 security、凭据/密钥、Vault/业务库或真实 ACL，未连接/重启真实 9091，未提交、推送、部署或发布。

**DR-P3.5 完成；新增扩展 16/23，DR-P3 为 5/6，必需工作包仍 2/4。下一 DR-P3.6：新候选浏览器综合验收与操作/排障文档。**

## D28：DR-P3.6 浏览器候选综合验收与操作排障

日期：2026-10-28（America/New_York）。接续前读专项 AGENTS、唯一台账与 D27，检查 Git 状态并保留全部现有改动，包括真实配置原修改、四条根 security 索引删除和 certs 未跟踪状态。只使用新临时合成实例、随机 127.0.0.1 端口、独立 build/Chrome profile；未读取或修改真实配置、certs、根 security、凭据/密钥、Vault/业务库或真实 ACL，未连接或重启真实 9091。

### 实现与用户文档

新增可重复入口 `node scripts/security-browser-candidate-check.mjs`（`pnpm run test:security:browser-candidate`）。只构建一次 Designer、Studio、Web，关闭本地 Vite/env，保留原 dist；六组顺序使用相同候选摘要，逐组前后核对清单中的开发源码与新产物，任何漂移、缺组、skip、超时或失败均拒绝。保存逐文件源码/产物清单、原始 TAP、JSON 及截图，每次新建目录并保留失败现场。服务端使用源码入口，当前清单与三端产物绑定不替代七个新发行包或完整第三方依赖安装校验。

综合覆盖正式注册/拒绝/批准/公钥登录、准确本机审批维护、部署预览/停机单次提交、注册到期后的已有登录、禁用、刷新与注销，以及三个前端原配对和应用凭据。新增三端公钥 Cookie 会话的合成行写入与刷新读回，缺 CSRF 写入及跨库请求被拒；Studio/Web 继续实际授权库连接。Designer 保持原双库分工；这里的合成行 RPC smoke 检查不冒充完整业务建模、关系/接口、Pivot/Excel 或备份流程验收。

新恶意页面在实际 Chrome 以同站不同端口发送 fetch、预检、普通表单、opaque sandbox/null Origin 和 iframe，浏览器错误 RP 拒绝；服务端原生 HTTP 控制即使携带有效 Cookie/CSRF，错 Host、localhost 别名和 Forwarded、X-Forwarded-\*、X-Real-IP、Via 仍拒绝。公开数据入口没有管理权限；拒绝有审计，原会话和未消费配对码保留。Host 重绑定是受控错误 Host/socket 验证，非实际公网 DNS 污染。CORS/CORP/嵌入及 Cookie 属性不替代后端身份、来源、CSRF 和授权校验。

本轮无产品页面布局或可见文案改动；用新候选复验已有 Designer/Studio zh/en/ja、Web en/zh-CN、宽窄屏/长文案/标签/焦点。运行手册第 17 节提供普通 PowerShell 一条命令、成功判据、产物说明、A/B 操作顺序和按现象排障；简介、使用手册、协议、方案、专项 AGENTS、测试说明及唯一台账同步，修正当前简介/手册中仍称正式页面未接入的陈旧说明。

### 实际验证

| 范围                                   | 结果                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同一候选原生浏览器                     | **9/9**：托管 2、Designer 1、本机审批 1、部署 1、公共客户端/原三端兼容 3、恶意页面 1                                                                  |
| 登录 / 动态授权 / 原认证               | **55/55、42/42、169/169**                                                                                                                             |
| 维护 / 托管 / 公共客户端 / 审批 / 部署 | **33/33、36/36、31/31、14/14、22/22**；维护含原生 Windows CLI                                                                                         |
| 启动与报告完整性                       | **19/19** 启动兼容、**49/49** 工具、**4/4** 公共报告、**7/7** 候选/恶意页面报告检查                                                                   |
| 类型和边界                             | 新 shared/Core 声明、整个 Server/严格新旧测试、三个前端完整类型、SDK DOM 无 Node 消费及 shared/SDK browser bundle 无 server/core/WebAuthn server 依赖 |
| 静态与文档                             | 限定脚本 lint/格式、文档格式与链接/任务数、diff、Git 材料守卫；历史 D27 及更早 945 条证据逐字节核对                                                   |

合计 **490/490，0 fail/skip/cancelled/todo**（481 项定向和 9 项原生）。主回归/Server 类型 Node 24.22.1；三端类型/原生浏览器 Node 24.15.0、Chrome 156 虚拟认证器。候选摘要：`a39423ce9d819166dde529bdd1ca3862d648f29bac8a6d3461637811ca2b3e4e`。通过候选共 143 张截图；自动检查现有语言、宽度、标签和焦点，实际查看代表页面核对状态层级、主题、换行和可读性。本轮不新增翻译键或样式，test/\*\* 沿用既有 lint/格式排除，测试经过严格类型与实际执行，不声称全仓 lint/check。保留 Vite 既有大 chunk 警告。

见[验证汇总](evidence/SEC-M7-D28/verification.json)、[选择的候选](evidence/SEC-M7-D28/selected-candidate.json)、[当前候选报告](evidence/SEC-M7-D28/run-1793154491080/candidate-check.json)、[候选清单](evidence/SEC-M7-D28/run-1793154491080/candidate-manifest.json)及[源码/历史绑定](evidence/SEC-M7-D28/acceptance.json)。原始 TAP 和截图在同一候选目录；运行记录、命令和失败现场随 D28 保留，不改写 D27 及更早证据。

### 失败修复与限制

恶意页面首轮把 no-cors 被 Chrome CORP 直接拦截误判为必须返回 opaque，改为接受两种均不可读的浏览器结果，仍核对服务器拒绝、审计及会话/配对未改变；失败 TAP 保留。首次综合运行期间验收工具继续变化，源码冻结检查按预期以 CANDIDATE_SOURCE_CHANGED 拒绝；冻结相关代码后重跑。第二次的 Designer seed 夹具多传了 principal.create 不接受的 kind 字段，被严格 parser 正确拒绝；删去无效字段，定向写入/读回复验与完整候选重跑通过，没有放宽生产协议。证据工具早期用例未允许新候选专用 .tap 路径，后限定只允许 D28 固定六组路径并通过 42 项 receipt 测试；初轮工具输出在会话记录，最终原始工具测试完整归档。限定静态检查另发现工具脚本缺少仓库要求的花括号，补齐纯样式后 lint/格式/材料守卫通过，并重跑 49 项工具、7 项候选报告及全部 9 项原生浏览器验收；当前摘要已重新绑定，先前通过和失败记录均保留。

最终证据核对另发现产物白名单漏列合法的 favicon.svg，已补充准确图标文件名，并在 receipt 用例中覆盖该图标及拒绝 server.key；工具检查复验通过。此修复仅涉及证据校验器，不改变已验收的前端或服务端候选。

仍未执行整仓 check、Node 22、独立性能/容量、完整新发行安装/升级降级、完整业务建模保存、实际 LAN/Hello/新双机、物理断电/磁盘耗尽或真实切换。HTTPS pin 仅作用于测试 Chrome，不安装系统信任；虚拟认证器不证明物理主机或 TPM 绑定。本轮默认服务器仍仅托管 Designer，Studio/Web 测试是合成同源静态替换，不新增生产托管路由。无依赖/锁升级，无提交、推送、部署或发布。

**DR-P3.6 完成，DR-P3 工作包完成 6/6；新增扩展 17/23，必需工作包 3/4。下一 DR-P4.1：独立接收方加密公钥关联、版本/指纹/持有证明、替换与恢复契约及本机 UI。** WebAuthn 登录私钥不用于数据解密；先冻结加密公钥与持有证明契约，再实现后续交付能力。

## D29：DR-P4.1 独立接收方公钥与持有证明

日期：2026-10-28（America/New_York）。接续前读取专项 AGENTS、唯一台账、D28、相关模块指引与既有迁移/资产契约，并检查 Git 状态。保留全部现有修改，包括真实配置的原修改、四条根 security 索引删除和 certs 未跟踪状态。只使用临时合成实例、随机 127.0.0.1 端口、全新构建及独立 Chrome profile；未读取或修改真实配置、certs、根 security、凭据/密钥、Vault/业务库或真实 ACL，未连接或重启真实 9091。

### 契约、实现与操作文档

新增[接收方密钥契约](../security-v1/recipient-key-contract.md)，复用独立的 `modeldb.migration-key.v1`、RSA 3072/4096、65537 指数、SPKI SHA-256 指纹和 RSA-OAEP-256。WebAuthn 登录、TLS、资产签名、实例与数据密钥不混用。登录公钥与接收方公钥在后端双向禁止复用，覆盖活动、历史及未到期的待证明接收方；证明只说明对应私钥可用，不证明人员或物理设备归属。

普通 open 或配置开关不自动迁移。仅受保护 OS 本机通道或专用准确 127.0.0.1 管理会话，经明确确认及准确 CAS，才能将 V4 原子升级到 V5；保留原身份、会话、授权和密钥。接入 `registration.recipient.list/initialize/begin/complete/retire` 与公共 shared/SDK 类型，复用现有后端 socket、Host/Origin、CSRF、管理期限、预算及审计边界，没有新匿名或数据面入口。

五分钟单次挑战通过固定顺序 OAEP label 绑定实例、userId、挑战编号、新版本、前活动版本、指纹和时间；接收方离线解开随机 32 字节秘密后返回专用 SHA-256 证明。服务端只保存证明的再哈希，不持久化秘密、挑战密文、私钥、口令或证明原文。完成时重查身份、期限、唯一性和版本，在一个事务内消费挑战、退役旧版、追加新版本及审计；有效格式的错误证明也消费，CAS/格式错误不消费。身份失效的挑战不能因重新启用而复活。

每用户最多 20 个版本、实例最多 10000 个版本、最多 128 条未到期挑战，分页列表不返回公钥原文或秘密摘要。登录停用/撤销、用户停用与换 Passkey 不删除历史；访问重置另退役活动接收方、拒绝待证明挑战并保留历史。新私钥不能解开旧包，旧私钥丢失必须按契约独立核验并保留恢复边界，不能删除历史或手改版本号。

Designer 安全中心新增“接收方密钥”：显式初始化、用户/公钥导入、挑战下载、证明导入、独立确认、替换/退役、分页历史及 CAS 冲突反馈。秘密回执只驻当前页面内存，不写 URL 或 Web Storage。新增 `scripts/security-recipient-key.ts inspect/prove`，只接受有界专用挑战和核对后的绑定摘要；私钥/口令只在接收方本机使用，输出新建且不覆盖，错误不输出输入材料。

简介、使用手册、方案/协议、身份/发布说明、专项及 Designer AGENTS、测试说明和唯一台账同步。[运行手册第 18 节](../security-v1/device-registration-runtime-guide.md#18-接收方加密公钥与离线持有证明dr-p41)提供逐行 PowerShell 命令、权限/期限/容量、替换与丢失恢复、故障后核查和重复验证入口。本轮只登记接收方公钥；按登记对象交付业务包属于 DR-P4.2。

### 实际验证与证据

| 范围             | 结果                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20 文件扩大回归  | **353/353**，含 17 项接收方行为、3 项报告检查及台账/HTTP、注册审批维护、登录/动态授权、原认证、托管、网络防护和会话回归                                         |
| 证据工具         | **46/46**，含 42 项原 receipt 工具及 4 项接收方证据检查                                                                                                         |
| 原生综合验收     | **1/1**，全新 Designer、Windows DPAPI/OS 本机通道、实际文件导入下载及离线 inspect/prove、初始化/登记/替换/退役、确认/CAS、重启历史及无 Web Storage 秘密         |
| 类型与浏览器边界 | 新 shared/Core 声明、整个 Server、严格新旧测试及离线工具；三个前端完整类型、SDK DOM 无 Node 消费、shared/SDK browser bundle 无 server/core/WebAuthn server 依赖 |
| 页面与文档       | zh/en/ja、1280/390 宽度共 18 张截图，核对长文案、标签、焦点、状态层级、主题和指纹换行；17 文档链接/锚点与 23 项任务计数核验                                     |
| 静态与历史       | 限定 lint/格式、diff、Git 材料守卫通过；D28 及更早 **1372 条**历史证据原字节不变                                                                                |

合计 **400/400，0 fail/skip/cancelled/todo**，不重复计算已包含在扩大回归内的专项。扩大回归/原生浏览器/三端类型使用 Node 24.15.0，Server/严格测试类型及静态工具使用 Node 24.22.1；Chrome 156。候选摘要 `c61946b3f966550240a006348d73fd8c52b04c4113c5b5d3e397c422ae00f4ce`，273 项源码摘要与全新产物绑定，保留原 dist，不加载本地 Vite/env。实际查看代表性历史、挑战及日文窄屏确认页面；原生文件选择器文字沿用 OS/浏览器语言。测试及 TSX 沿用既有 lint 排除，通过严格类型及实际执行，不声称全仓 check。

见[验证汇总](evidence/SEC-M7-D29/verification.json)、[原生报告](evidence/SEC-M7-D29/native/integration-check.json)、[候选清单](evidence/SEC-M7-D29/native/candidate-manifest.json)、[扩大回归原始 TAP](evidence/SEC-M7-D29/unit.original.txt)及[源码/历史绑定](evidence/SEC-M7-D29/acceptance.json)。命令、静态原始日志、证据工具 TAP、视觉核对与 18 张截图保留在同目录；只归档开发证据及公开前端产物，未归档私钥、口令、证明回执、挑战运行文件或实例目录。

### 失败修复与边界

原生首轮因夹具在读取列表后未刷新修订，被 CAS 正确拒绝；夹具重新加载后通过，未放宽后端检查。开发期规范 RSA COSE 编码、翻译 namespace 及文档键扫描已修正并复验；中间通过候选随后增加双向用途隔离和确认绑定显示，保留为 pre-final，最终候选重新完整验收。失败与中间报告/截图均保留。

扩大回归最初在工具 Node 24.22.1 的原 TLS 文件停滞，保留原始输出并只终止已核实属于本轮的测试进程；改用正常 Windows Node 24.15.0 后完整跑出 351/353，两项同端口重启测试出现 ECONNRESET。单独托管文件复现后，确认单元 HTTP helper 复用了关闭监听器的池化连接；改为 `agent:false` 建立新连接，未增加重试、跳过或修改安全断言。托管 32/32、严格类型及相同 20 文件完整重跑 353/353 通过，原始失败日志另存。此修复只涉及测试 helper，服务端/前端候选未变。三端类型初次在沙箱不能访问现有依赖，正常 Windows 环境通过，没有重装或升级依赖。

未执行按登记对象交付/导入包、整仓 check、Node 22、完整业务建模/关系/接口/Pivot/Excel/备份总回归、新发行离线安装/升级降级、独立性能/容量、实际 LAN/Hello/新双机、物理断电/磁盘耗尽或真实切换。HTTPS pin 只作用于测试 Chrome，不安装系统信任；本轮不证明硬件或物理主机绑定，也不自动迁移旧 Vault。无依赖/锁升级，无提交、推送、部署或发布。

**DR-P4.1 完成；新增扩展 18/23，DR-P4 为 1/6，必需工作包仍 3/4。下一 DR-P4.2：按已核验接收方复用原迁移/资产封装及离线交付步骤。** 后续仍默认隔离环境，不能把公钥登记当作业务包交付、实际认证器/双机或生产验收。

## D30：DR-P4.2 按已核验接收方离线交付

日期：2026-10-28（Asia/Shanghai）。用户要求继续补完本阶段。保留全部既有工作区改动和 D29 及之前的原字节证据；本轮仅使用临时合成实例、随机回环端口和生成的密钥/口令。未读取或修改真实配置、根 security/certs、真实凭据/密钥、Vault/业务库、系统信任，未连接或重启真实 9091，未提交、推送、部署或发布。

### 实现与兼容

新增停机 `security recipient-list -c <明确配置> --instance <准确实例>`，通过 Windows 当前身份和独占实例租约获取分页元数据/总修订，不初始化、不迁移。`backup-export` / `asset-export` 接入准确接收方 id/userId/版本/指纹及修订五项选择，要求 --yes，禁止混用 PEM；V5 必须选择已核验接收方，V1—V4 保留原 PEM 兼容路径。每次列表/导出推进修订，不自动重放冲突。

从选取、源刷盘、封装到外部发布持续持有实例租约，选取及发布前重查 CAS、活动版本、用户/主体启用及 active 登录凭据。退役、替换、用户/凭据停用或访问重置阻止新交付，历史保留。备份导出补源库存在、路径及大小预检，避免缺库时隐式新建。

外部文件写入前原子记录 `recipient.delivery.sealed`，绑定接收方非秘密元数据、源库、包种类与完整字节 SHA-256；审计容量或提交故障拒绝发布。sealed 只表示封装记账，不能当作外部文件成功。文件新建/同步后沿用原 task.completed，尝试写入后任何异常为 `SECURITY_OUTCOME_UNCONFIRMED`，保留现场核查，不自动重试或覆盖文件。

保持 `modeldb.backup.v2`、`modeldb.asset.v1/v2` 的格式与加密套件。完整迁移仍是无独立发布者签名的全信任交付，资产保留独立 PS256 签名及指纹信任。未增加 HTTP/数据面/公共 SDK 导出或私钥上传入口，私钥与口令只在接收端离线使用。包未新增登记 userId/版本或物理主机绑定；目标独立 DEK 与空访问台账，源用户/权限不导入。退役不撤回已发包，旧私钥仍可解旧包，新私钥不能替代历史私钥。

完整迁移先暂存再 restore，原流程允许发布前重复暂存，目标库存在后拒绝重复迁移。资产旧确认摘要绑定目标现状，重复使用拒绝；重新预览后的同包恢复/幂等沿用原任务协议，不承诺所有包全局一次性接收。

契约、简介、使用手册、方案/协议、发布说明、专项 AGENTS、测试说明和唯一台账同步。[运行手册第 19 节](../security-v1/device-registration-runtime-guide.md#19-按已核验接收方离线交付dr-p42)提供逐行 PowerShell、停机列表、准确接收方选择、导出/导入、历史私钥及结果未知处理。新增 `test:security:delivery` 与 `test:security:delivery:native` 重复入口。

### 验证与证据

25 文件扩大回归 **421/421**，含新增交付行为/报告 17 项及原备份/资产、台账/HTTP、注册审批维护、登录/动态授权、托管、网络防护与会话；证据工具 **57/57**，含新增交付证据完整性 4 项；原生离线交付 **1/1**。合计 **479/479，0 fail/skip/cancelled/todo**，不重复计算先前专项。新 shared/Core 声明、整个 Server、新旧严格测试、三前端类型、SDK DOM 消费及 browser bundle 边界通过；限定 lint/格式、diff、材料守卫和文档/计数核对通过。

最终候选摘要 `b005197a0abf1fd0582419b80fe63abe5e1b1a930e5dd98daddd427702df1e74`，169 项源码绑定；D29 及之前 **1463 条**历史证据原字节保留。[最终原生报告](evidence/SEC-M7-D30/native/integration-check.json)、[源码清单](evidence/SEC-M7-D30/native/source-manifest.json)、[扩大回归原始 TAP](evidence/SEC-M7-D30/unit.original.txt)及命令、类型、静态、文档与证据工具日志归档在同目录；`acceptance.json` 绑定最终开发文件和当前/历史证据。未归档私钥、口令、业务包或实例目录。

本轮无页面或可见文案修改，不声称重新视觉验收。原生验收是在同一 Windows 账号的两隔离实例运行：三种原格式导出后删除合成源，再用接收方私钥导入并读回合成记录、Designer 查询；错误接收方/修订、错私钥、篡改、错误目标及旧确认重复发布拒绝，目标使用独立密钥及空访问台账。

中间成功候选在限定 lint 中发现重复/类型导入和脚本花括号问题，修正后重新冻结源码并完整运行原生交付；原成功报告保留为 native-pre-lint，最终报告另存。没有放宽安全断言、跳过或自动重试。工具沙箱不能解析正常 Windows Node 路径，原生检查改用正常 Windows Node 24.15.0；类型和静态工具使用 Node 24.22.1，未安装/升级依赖或覆盖旧 dist。

最终总核验初次拒绝源码清单中的根 `tsconfig.json`：原读取白名单未含此编译配置。只增加该明确开发路径，并在既有正向用例中核对读取；真实配置、运行材料和路径穿越的拒绝测试保留。原错误、修正前证据和工具结果保留，修正后重跑工具及静态检查；服务端候选和原生结果未改变。

未执行整仓 check、Node 22、完整业务建模/关系/接口/Pivot/Excel 总回归、新发行离线安装/升级降级、独立性能/容量、实际 LAN/Hello/新双机、硬件断电/物理磁盘耗尽或真实切换。它们不由本项离线交付验证替代。

**DR-P4.2 完成；新增扩展 19/23，DR-P4 为 2/6，必需工作包仍 3/4。下一 DR-P4.3：新包/前端候选、实际离线安装、CLI/bin/严格类型消费和合成升级/停用演练。** 剩余 P4.3—P4.6 不因本项通过而提前完成。

## D31：DR-P4.3 新发行安装与合成升级停用验收

日期：2026-10-28（Asia/Shanghai）。继续用户授权的下一步研发，保留全部既有工作区改动及 D30 以前原字节证据。只使用临时目录、合成实例/软件签名密钥、Windows 原生 DPAPI 和随机回环端口；没有读取或修改真实配置、根 security/certs、真实凭据/密钥、Vault/业务库、ACL 或系统信任，没有连接或重启真实 9091。无提交、推送、部署或发布。

### 实现与操作

新增 `node scripts/security-install-check.mjs`（或 `pnpm run test:security:install`）：每次全新构建七包与三前端，按逐文件清单打包，快照已有第三方依赖，实际执行 pnpm offline / ignore-scripts 安装，显式验证 Server 自有安装器、公有 bin/CLI、全部包严格类型及 SDK DOM 无 Node ambient 类型消费。构建不加载本地 Vite/env，不修改旧 dist 或仓库依赖；99 项第三方快照不代表重新从 registry 获取或验证上游发布。

验收只加载实际安装的压缩 JS，使用真实 WebAuthn 库验证合成软件签名与原生 DPAPI：普通打开/关闭认证不迁移，显式 V1→V2→V3→V4→V5 保持实例、IMK/DEK、API Token、会话、配对与原撤销；未知台账/包格式拒绝。注册关闭后已批准身份仍能登录，认证关闭拒绝新登录；停用用户跨重启保持、重新启用须新鲜签名登录且旧会话不复活。访问重置保留用户和接收方历史，但撤销凭据并退役活动接收方。安装后 CLI 可列接收方，安装后 Server 托管全新 Designer 并核对 HTTP 资源字节摘要。

旧程序检查使用固定 SHA-256 的 V1 reader 原源码编译 JS，并配当前安装包底层保护/文件辅助模块：先确认 V1 正常读回，再拒绝 V2—V5 且非租约保护文件原字节不变。此范围不能声称完整历史发行包或任意旧二进制降级已通过。回退使用支持新台账的程序关闭入口，禁止改版本、删字段或回灌旧访问台账。

简介、使用手册和发布指南提供单行入口、前提、成功条件、日志位置和失败保留方式；协议第 23 节、方案、AGENTS、测试说明与唯一台账同步。发布指南第 2 节保留单独全量/性能入口，本轮没有运行那些后续任务。

### 验证与证据

11 文件定向回归 **234/234**，7 文件工具检查 **66/66**，原生新候选离线安装与升级/停用 **1/1**，合计 **301/301，0 fail/skip/cancelled/todo**。原生检查内含 17 项必要检查，不额外重复计入总数。七包全新编译/严格安装类型、三前端新生产构建通过，312 项 zh/en/ja 安全相关键对齐。本轮没有页面或可见文案变化，没有重新视觉/浏览器验收结论；未声称整仓 check 或所有测试严格类型已执行。

最终候选 SHA-256：`6f737648713e86c5049efe343b0f5ea89e3d84a11899a987aae44e4410a07fcc`，绑定 **489 项源码、9 份文档**。原生构建与定向回归 Node 24.15.0，工具/静态 Node 24.22.1，均 Windows；未验证 Node 22。限定 lint/格式、diff、路径材料守卫及文档链接/计数核对通过；混淆脚本保留 4 条既有 console lint 警告。无新增依赖或锁变更。

[原生安装报告](evidence/SEC-M7-D31/native/install-check.json)、[候选清单](evidence/SEC-M7-D31/native/release-candidate.json)、[升级原始结果](evidence/SEC-M7-D31/native/upgrade.original.txt)、[定向回归 TAP](evidence/SEC-M7-D31/unit.original.txt)、[验证汇总](evidence/SEC-M7-D31/verification.json)及[源码与历史绑定](evidence/SEC-M7-D31/acceptance.json)归档在 D31；继承 D30 以前 **1504 条**历史证据原字节。没有归档实例目录、私钥、口令、挑战或业务包。完整 tgz/安装目录留本机临时位置，位置及保留范围单独记录；总证据工具只核对记录和当前开发摘要，不重跑安装，也不承诺临时制品持续存在。

### 失败修复与范围

首轮候选通过但升级脚本缺少箭头函数闭合，完整执行按失败保留。修正解析后，实际 import 安装的 Server 暴露原候选/普通混淆脚本共享 Terser 变量缓存的缺陷：一个模块局部 Buffer 名被缓存后，另一模块全局 Buffer 误改为未定义的 aa。新增独立模块压缩 helper，两条流程共用，保留导出名/属性和 shebang；回归实际加载两模块，确认局部名不会污染全局。没有通过禁用压缩或放宽断言绕过。

另一次候选通过但测试脚本从 pnpm 顶层链接建立 createRequire，无法找到真实依赖，完整执行仍按失败保留；改从已核验安装包真实目录解析。调试通过后重新冻结源码并完整重跑单命令，才产生最终成功。失败 candidate/upgrade 日志和错误模块原字节保留。工具证据增加静态必需项后重新跑 66 项，先前成功记录另存。无重试掩盖失败、无跳过或改写 D30 历史。

未执行 DR-P4.4 全量安全/模型/关系/接口/Pivot/Excel/备份及故障总回归，DR-P4.5 独立性能/容量/洪泛，DR-P4.6 实际 Windows Hello/两台设备；没有完整历史包降级、生产容量、硬件断电/物理磁盘耗尽、真实升级/切换或旧 Vault 迁移结论。

**DR-P4.3 完成；新增扩展 20/23，DR-P4 为 3/6，必需工作包仍 3/4。下一 DR-P4.4：全量安全及模型/关系/接口/Pivot/Excel/备份回归与认证故障恢复。** 真实环境继续按用户明确授权边界执行。

## D32：DR-P4.4 全量安全与业务回归

日期：2026-10-28（Asia/Shanghai）。继续下一步研发，保留工作区原改动和 D31 以前的原字节证据。所有实例、数据、签名密钥和口令均为临时合成材料，网络仅使用随机回环端口。没有读取或修改真实配置、根 security/certs、真实凭据/密钥、Vault/业务库、ACL 或系统信任，没有连接或重启真实 9091；未提交、推送、部署或发布。

### 实现与重复操作

新增 `node scripts/security-full-check.mjs` / `pnpm run test:security:full` 单命令入口：自动枚举全部单元测试、六个引擎流程，新建三前端产物并按同一候选运行九项浏览器及十三项额外原生集成，随后执行 Server/限定测试、三前端、SDK DOM 消费和 browser bundle 边界检查。原全量回归入口改为可导入函数；TAP 统计缺失、重复、失败、跳过、取消、待办、超时或源码变化均拒绝成功，不沿用历史结果。

新增两项恢复测试，使用真实软件 WebAuthn 签名及合成 AES-GCM 保护器：普通数据备份恢复保持 V5 用户停用状态、旧会话拒绝和接收方历史；从活动 V5 源生成独立恢复包后停用源用户，目标恢复合成数据但访问台账为空，旧会话及旧公钥的新挑战证明均不能恢复访问。公开审计/状态不包含动态数据 canary、口令、会话、rawId 或 COSE；它们不等于双机或实际 Hello 验证。

完整认证故障矩阵从本轮全部单元原始 TAP 提取并验证：30 个实际子进程硬退出、10 个签名撤销竞争、4 个审计故障及兼容检查。六引擎另记录流程与 82 项断言；模型、关系、发布接口、Pivot、Excel、备份与资产用例均由全量枚举执行。公开页面与原始日志执行有界的私钥/Bearer/URL 秘密模式扫描，结合认证/恢复用例的动态材料断言；不声称能够识别任意秘密。

源码清单、浏览器产物摘要、原始 TAP、命令元数据、严格类型、静态检查与文档报告共同绑定；归档工具只复制明确公开报告/产物，不复制实例、业务包、私钥或口令目录。证据负例覆盖缺日志/矩阵、源码漂移、命令不一致、含糊/跳过统计、页面字节改变及夸大硬件/性能/任务完成。D32 TAP 读取只增加六个明确浏览器日志路径，真实材料和路径穿越仍拒绝。简介、使用手册、发布指南、方案、AGENTS、测试说明和唯一台账同步。

### 验收状态

最终完整入口通过：**106 文件、1008/1008 单元、22/22 同候选浏览器/原生**，合计 **1030/1030，0 fail/skip/cancelled/todo**；六引擎另有 **82 项断言、0 失败**。认证 55 项故障/恢复与新增两项登记恢复已经计入单元，不重复相加。整个 Server、严格新旧测试（含新增恢复）、三个前端、SDK DOM 无 Node 类型消费和 browser bundle 边界通过。运行使用 Windows / Node 24.15.0、Chrome 156；先前工具/限定静态使用 Node 24.22.1，不代表 Node 22 验收。

最终源码清单 SHA-256 为 `e54c9c92b994407c8fe9bf9e4f2e3c8960ffdbb002f39621491a49d7fd9294aa`，绑定 **663 项源码**；同一浏览器候选摘要为 `0d994165d843131cab9ab5b7931852c7511ffc0d6e0f9756182b63e4a8dff6cc`，归档 **18 份公开页面产物**。报告、七组回归原始日志、六组浏览器 TAP、五组额外原生 TAP、类型输出及命令元数据均保留。D31 以前 **1543 条历史证据**原字节继承核对，不改写旧结果；实例、业务包、私钥与口令不归档。限定 lint/格式、diff、Git 材料守卫、源码产物和 SDK 边界及 17 文档链接/任务计数检查通过。

见[最终总报告](evidence/SEC-M7-D32/native/full-check.json)、[最终源码清单](evidence/SEC-M7-D32/native/source-manifest.json)、[浏览器候选](evidence/SEC-M7-D32/browser/candidate-manifest.json)及[全量原始 TAP](evidence/SEC-M7-D32/regression/unit.original.txt)。同目录的 `verification.json` 汇总验收，`acceptance.json` 绑定当前与历史证据。总证据工具只核对记录、开发摘要与历史原字节，不重新运行实例或证明临时实例持续存在。

第一轮 **1004/1004 单元、22/22 浏览器/原生、六引擎 82 断言**通过，0 skip；[原始总报告](evidence/SEC-M7-D32/pre-final/full-check.json)与[源码清单](evidence/SEC-M7-D32/pre-final/source-manifest.json)保留。归档审查随后补充明确 TAP 读取、命令元数据一致性、四项证据负例以及恢复用例严格类型；限定八项工具测试和新严格类型通过，再冻结源码完整重跑，才得到上述最终结果。开发期提取共享报告夹具曾因边界匹配遗漏产生缺模块失败，修正夹具后八项通过，最终全量重新包含这些测试；未放宽断言或跳过。

第二轮完整功能验收也是 1030/1030，但最终总证据读取白名单漏列 `test/fixtures/security-tls/localhost.crt` 和 `localhost.key` 两份仓库公开测试夹具，归档被正确拒绝。只补这两个明确路径，并补真实 certs/其他密钥路径拒绝断言；42 项工具通过。另用当前核验器在隔离副本核对第二轮原字节证据的 2306 个文件并通过，两份开发源按原摘要重建，只作元数据核验，不冒充当前源码功能验收。随后再次冻结源码，第三轮完整重跑 1030/1030 通过，才采用本节最终摘要；[第二轮报告](evidence/SEC-M7-D32/pre-final-2/full-check.json)、[原错误](evidence/SEC-M7-D32/pre-final-2/evidence-error.original.txt)、原始日志副本与元数据预检报告保留，不回写旧摘要。

本轮没有页面或可见文案改造，不声称重新人工视觉验收；浏览器自动化复用三端既有布局/语言断言。本轮不运行会覆盖原 dist 的根 check，执行上述限定类型与静态检查；未验证 Node 22、真实 LAN/Hello/新双机、独立性能/容量、物理磁盘耗尽/硬件断电、真实迁移/升级切换或旧 Vault 自动转换。后续 DR-P4.5、DR-P4.6 保持未完成。

**DR-P4.4 完成；新增扩展 21/23，DR-P4 为 4/6，必需工作包仍 3/4。下一 DR-P4.5：独立性能/容量、注册洪泛与本机修复资源保障。** 仍需 DR-P4.6 实际 Windows 认证器/两台设备验收，不能由原两台恢复报告替代。

## D33：DR-P4.5 独立性能与本机修复资源保障

日期：2026-10-28（Asia/Shanghai）。状态：完成。接续前读专项 AGENTS、唯一台账和 D32，检查 Git 状态，保留全部已有修改；全部使用新临时合成实例、随机回环 HTTPS、真实 Windows DPAPI/Named Pipe 和公开测试 TLS 夹具。真实配置、根 security/certs、9091、Vault/业务库、信任、发布及切换均未操作。

已实现独立双进程 AB-BA 工具、探索/门槛登记/独立确认和公开证据检查。原生满 1000 条待审申请、48 并发拒绝的开发试跑发现连续同步审计拖延本机维护约 34.95 秒；增加每实例注册/登录共用的 64 项公共拒绝审计 FIFO，每项仍持久提交后响应，逐项让出事件循环。队列满和写入失败拒绝，存储故障关闭台账；没有关闭审计、提高原准入限额或跳过证明验证。修复后合成维护创建约 3.80 秒，48 次审计计数完整；正式验收进一步要求真实本机来源规则的预览/应用/确认/回滚。

修复后 191/191 受影响安全测试、原生 Chrome 认证 1/1、最终工具/证据 61/61，共 253/253、0 fail/skip/cancelled/todo；新声明下整个 Server/限定测试严格类型、lint/格式/源码守卫通过。没有重跑 D32 的整个全量/六引擎和新安装验收。修复后重新冻结源码、完成 108 样本探索、独立登记门槛，再以全新实例完成 504 样本确认，全部预登记门槛通过。实际 Hello/新双机仍待 DR-P4.6。

功能简介、使用手册、发布说明及[独立性能手册](../security-v1/performance-guide.md)同步，记录固定样本、正常审计、资源范围、成功判据与失败保留方式。本轮没有页面或可见翻译文案修改，不宣称新增视觉/i18n 验收。DPAPI 子进程 CPU/RSS 未测，软件签名不代表物理设备、PIN/生物识别或生产并发容量。

首轮独立确认完整收集 504 个样本，但注册开始客户端 p95 为 1685.810ms、服务端 1681.671ms，超过已登记的 1500ms；静态服务客户端 p95 772.282ms 也超过 500ms，服务端约 0.494ms，主要等待发生在 TLS 握手。原生洪泛维护 3813.217ms、48 次拒绝审计及确认/回滚通过，仍不能抵消性能失败。原探索、登记、失败确认及公开产物完整保留在 `evidence/SEC-M7-D33/pre-expiry-repair/`，原门槛没有改写。

定位到期挑战的两次同步提交及无待处理申请时后台垃圾清理阻塞 TLS。修复将注册开始的合法清理与新申请合为一个持久事务，仍保存清理/注册两条审计并核验全部审计容量；写入失败整体关闭。每 30 秒仍检查并持久处理未完成申请到期；已完成挑战的有界垃圾随后续请求或重启回收，截止时间不延长。新增单事务/双审计、后台到期、写入失败及仅一审计槽的原子拒绝测试。修复后必须重新冻结、探索、登记和独立确认，不能把原失败改为成功。

### 最终独立确认与证据

Windows / Node v24.15.0，A→B→B→A 四个独立实例，固定1000行、正常并发1、每块2次查询预热；A为registry API凭据、B为软件WebAuthn真实签名及Cookie/CSRF。Server由独立Node/tsx加载冻结源码、Designer全新构建，不表示安装后压缩包性能。全部504样本业务结果成功，失败率0；另有48个预期拒绝，不计作业务失败。下面为毫秒，门槛顺序为客户端/服务端；完整TLS/队列/保护器/验签/资源分布及max在原JSON。

| 场景                | 样本 | 客户端 p50 | 客户端 p95 | 服务端 p95 | 登记 p95 门槛 |
| ------------------- | ---- | ---------- | ---------- | ---------- | ------------- |
| A.credentialIssue   | 30   | 761.077    | 905.266    | 899.579    | 1250/1250     |
| A.query1000         | 60   | 1517.168   | 1623.071   | 1618.966   | 2750/2750     |
| A.batchSave         | 12   | 1526.585   | 1720.847   | 1717.454   | 2500/2500     |
| A.static            | 30   | 3.061      | 4.263      | 0.638      | 500/500       |
| A.revoke            | 30   | 758.933    | 878.438    | 874.553    | 1250/1250     |
| A.revocationProbe   | 30   | 756.968    | 834.182    | 831.258    | 1500/1500     |
| B.registrationStart | 30   | 779.678    | 845.057    | 842.236    | 1250/1250     |
| B.registrationProof | 30   | 1563.922   | 2333.778   | 2331.190   | 2500/2500     |
| B.login             | 60   | 2343.744   | 2532.776   | 2526.359   | 3750/3750     |
| B.refresh           | 30   | 785.497    | 865.602    | 862.573    | 1500/1500     |
| B.query1000         | 60   | 1574.516   | 1686.956   | 1683.405   | 2750/2750     |
| B.batchSave         | 12   | 1515.757   | 1592.331   | 1589.379   | 2750/2750     |
| B.static            | 30   | 3.187      | 6.446      | 0.568      | 500/500       |
| B.revoke            | 30   | 783.322    | 831.348    | 825.493    | 1500/1500     |
| B.revocationProbe   | 30   | 785.309    | 848.636    | 845.736    | 1250/1250     |

服务端Node RSS高水位 185.805MiB，单样本Node CPU最大 250.000ms，正常证明队列最大 0.107ms，均低于1024MiB/10000ms/1000ms。保护器子进程墙钟已计入请求，子进程CPU/RSS未测，不声称整机资源容量。

原生满1000待审、48单来源并发拒绝，至少一个已响应且其余仍在途时经真实Named Pipe应用预览的回环来源规则，耗时 3948.876ms（上限15000ms）；48次拒绝审计计数准确，全部完成、无意外响应；最长请求 47339.611ms（上限60000ms），Node RSS 247.078MiB，之后确认并回滚，配置与原值一致。4执行/32排队/第37拒绝另用明确标注合成AES-GCM保护器及受控验签检查，不冒称原生36认证器性能。

最终源码 SHA-256 `825e9c69e211dc89edf34e03554b185b2e784cffe312d1435476cdd17934c9e4`；[探索报告](evidence/SEC-M7-D33/exploration/performance.json)、[门槛登记](evidence/SEC-M7-D33/registration.json)、[最终确认](evidence/SEC-M7-D33/confirmation/performance.json)、源码/公开页面清单、四块样本与原日志同目录归档，接续D32以前1666条历史证据原字节；`verification.json`/`acceptance.json`绑定最终开发与公开证据，总核验不重跑实例。不归档实例/私钥/口令，限定文档/链接/任务计数/格式/diff及材料守卫通过。

首次正式确认失败后没有提高其门槛、删慢样本或重试原失败；修复到期事务后从新源码探索重新登记。旧registrationStart门槛1500ms、static门槛500ms保留于pre-expiry-repair，最终数值独立按固定规则由新探索生成。早期开发工具问题包括DNS回调、plan trailing、保存授权、begin状态码、IPC观测等待及审计选择器，均修正并保留失败报告；IPC观测等待不混入HTTP计时。限定lint发现单行if缺花括号，修正后通过，未改变行为。

没有运行D32全量1030项/六引擎、新七包安装、Node22、实际LAN/Hello/新双机、物理磁盘耗尽/硬件断电、真实迁移/切换或旧Vault转换；不以本轮秒级结果宣称低延迟、高并发、分布式攻击或生产SLA。实际设备与浏览器用户确认时间未测。本轮无页面或可见翻译修改，不声称新增视觉/i18n验收。

**DR-P4.5 完成；新增扩展22/23、DR-P4为5/6、必需工作包仍3/4。下一DR-P4.6：实际Windows Hello/两台设备注册—批准—登录—刷新—保存—停用—重启拒绝及丢失/断网/恢复验收与最终文档。** 默认隔离环境，真实材料、信任、发布与切换须明确授权。

## D34：DR-P4.6 双机演练工具与实际设备验收准备

日期：2026-10-29。状态：**进行中，工具准备通过，实际 Hello/两台设备及恢复策略实操待验证**。用户反馈 B 尚未设置或不确定 Windows Hello，先在 B 的设置→账户→登录选项检查或设置 PIN；本人完成注册/登录时的 Windows 安全确认。工具不能代输PIN或把虚拟认证器当实际设备。

已先检查 Git 状态、读取专项规则/唯一台账及D33，保留全部原改动、根security四项索引删除、真实配置和原历史证据。仅新建临时合成实例、随机回环TLS和独立可见Chrome完成本机工具验证；没有读取或修改真实配置、根security/certs、凭据/密钥、Vault/业务库、真实ACL/系统信任，不连接或重启9091，不提交、发布或切换。源码/全新Designer运行方式不等于安装发行包验收。

### 本轮实现与操作文档

新增 `scripts/security-device-drill.ps1` 与 Node/tsx 工具，提供 Prepare、Serve、Client、Smoke。Prepare仅接受A/B准确私网地址或明确回环烟测，创建保护目录、合成库、全新Designer和本次唯一TLS密钥，冻结LF归一化源码及页面摘要；不加载本地Vite/env、不覆盖dist、不安装依赖。证书使用锁定的传递依赖@peculiar/x509生成，不使用仓库公开私钥做LAN演练。

只传transfer内的公开connection.json/server.crt，B必须独立核对完整SPKI pin。新可见Chrome/Edge进程仅映射本次域名和校验本次公钥，不改hosts或系统信任；不启用虚拟认证器、不读取Cookie/证明或私钥。B在正式Designer本人注册/Hello登录，脚本仅提取非敏感状态并检查合成RPC保存/读回、CSRF/跨库拒绝、刷新和网络仿真。A经真实Windows管道对准确UUID与当前修订审批/停用；报告记录摘要及顺序。内置restart为同进程重建，手册另外要求stop后新Serve的独立进程重启及B新证明拒绝。

两端报告始终保留taskComplete=false，主机名加本次runId散列仅辅助区分环境，不是硬件身份。attestation none不能证明私钥物理不可导出；真实Hello操作需操作者确认。恢复策略明确区分普通备份保留停用、独立恢复空访问台账、接收方解密私钥独立；本工具不执行实际双机恢复导入，仍列待验证。

[双机逐步手册](../security-v1/windows-device-drill-guide.md)提供Hello准备、两端逐条PowerShell、准确ID批准/停用、两种重启、取消/丢失/断网、只回传脱敏JSON、成功条件和故障处理。简介、用户/发布/运行手册、方案、AGENTS、测试说明与唯一台账同步。复用正式页面，无产品页面或可见翻译改造，本轮不新增视觉/i18n结论。

### 验证与剩余门槛

定向工具及原总证据核验回归 **59/59**（新增17项、既有42项），0 fail/skip/cancelled/todo。覆盖严格ticket/私网/RP/期限/端口、路径穿越/junction、配置重定向、真实新证书TLS及错误信任拒绝、合成保存断言和不完整/跳过/夸大硬件证据拒绝。原生Windows/Node24.15.0的全新回环TLS、真实DPAPI/Named Pipe、可见Chrome安全上下文和正式注册页、匿名/公共管理拒绝及同进程服务重建烟测通过；它不计作一次实际Hello/双机测试。限定lint/格式/源码材料守卫、PowerShell参数和文档检查记录于本目录公开证据，不冒称重新执行全量1030、性能504样本、七包安装或整仓严格类型。

开发过程中首次TLS测试因Node多地址lookup回调形状失败，显式IPv4后通过。首轮原生烟测将mkdtemp已创建目录交给保护器，按现有DACL规则正确拒绝VAULT_PROTECTION_UNAVAILABLE；改为由保护器直接创建新的保护目录，没有放宽原生保护。修复后的初轮烟测报告另存pre-final；随后补充固定配置/源码证据约束、审批前后状态和独立进程重启指引，再冻结当前源码采集最终结果。另补PowerShell中文路径真实传参检查：首轮因为AssertionError附带实际/期望值被整体脱敏成通用错误，预期错误码检查失败；改为仅保留符号首行，仍去掉路径和实际值，增加脱敏回归并重新冻结检查，原58项通过及失败静态日志保留于before-error-code-repair。不回写D33或将失败标成通过。

当前[准备验证](evidence/SEC-M7-D34/verification.json)、[原始定向TAP](evidence/SEC-M7-D34/unit.original.txt)、[原生烟测](evidence/SEC-M7-D34/smoke-report.json)、命令元数据、源码清单与历史绑定留存D34。总证据仅返回preparation-passed-device-pending与taskComplete=false，不因工具成功或缺少设备证据回退到D33“完成”。实际LAN/Edge/Hello、B本人操作、完整撤销/进程重启拒绝及取消/丢失/恢复实操仍待报告，不使用旧S6.1双机恢复报告替代。

**DR-P4.6保持进行中；新增扩展22/23、DR-P4为5/6、必需工作包3/4。下一步为按双机手册在B确认/设置Hello并执行A/B隔离验收，核对脱敏报告后再决定能否关闭最后一项。** 真实服务、信任安装、发布/迁移切换仍须明确授权。

## D35：提交检查与归档证据边界修复

日期：2026-10-30。用户提交时，D32 公开浏览器构建中的 `export-model-map-CKtdAv1p.js` 和 `index-NHQl-PY-.js` 被 ESLint 的 TypeScript project service 当成源码解析，因不属于项目而失败。归档目录还包含其他构建及冻结工具快照，不能通过加入 `allowDefaultProject` 或格式化归档来修复。

在 `eslint.config.js` 的全局忽略中明确排除 `docs/security-v1-deliveries/evidence/**`；`lint-staged.config.mjs` 在生成 ESLint/Prettier 命令之前过滤同一目录，`.prettierignore` 同步排除，保证手动格式检查和提交钩子的边界一致。普通源码、配置及用户文档仍按现有规则检查，原 `test/`、`templates/` 边界保留。没有修改或删除历史归档文件，没有扩大到忽略全部 docs。

随后全仓只读 ESLint 复验发现36条工具脚本错误，均因新增 `.mjs` 已超过旧默认项目18文件上限。为配置和明确工具目录增加 `projectService: false` 的 JS 解析覆盖，保留推荐规则、未用变量和格式规则；只给 TS 配置保留默认项目许可，不提高容量或排除工具源码。业务 TS 仍使用项目服务。初次失败与后续复验分开记录，不宣称首次全仓检查通过。

验证覆盖1821个已暂存归档路径、其中120个可解析源码/脚本扩展名、报告中的两个精确路径、混合提交列表与非归档近似目录；确认归档被排除、正常源码和文档保留、JS覆盖与TS规则一致。修复后全仓只读 ESLint API 检查280个文件，0错误、44条警告；`node scripts/check-format.mjs` 检查678个开发文件通过。三个源码守卫 `assert-no-security-material.mjs`、`assert-no-build-artifacts-in-src.mjs`、`assert-sdk-client-only.mjs`、限定配置格式及本次文件的 `git diff --check` 通过。本轮未执行完整 pre-commit、提交或业务测试，不运行 `eslint --fix`、`prettier --write` 或 lint-staged 对用户暂存文件进行批量改写，不代用户提交或重新暂存。原暂存改动、历史证据与失败报告全部保留；本轮开发配置变化不回写 D34 以前的源码/候选摘要。

这是提交工具修复，不修改产品逻辑、页面或翻译，不宣称新增浏览器/视觉验收。未重跑全量业务、安全回归、性能、安装或真实Hello/双机；不触及真实服务、配置、凭据、密钥、Vault、ACL 或系统信任。DR-P4.6 状态、22/23与3/4工作包计数保持。

### D35 后续反馈：暂存版本与工作区不一致

用户再次提交仍报告 `Too many files (>18)`。核对 `git show :eslint.config.js` 确认暂存区仍是旧配置，三个修复文件的改动尚未暂存。lint-staged 默认在运行任务前隐藏部分暂存文件的未暂存改动，因此子进程 ESLint 会重新加载18文件上限的旧版本。首轮仅验证工作区，未验证此暂存路径，是首轮验证的遗漏；上文“不重新暂存”和全仓结果描述首轮操作。

本次仅将已核对属于该修复的 `eslint.config.js`、`lint-staged.config.mjs`、`.prettierignore` 加入暂存区，保留用户原有暂存内容，不暂存其他文件或代为提交。三个配置的暂存内容与工作区一致；不存在部分暂存的检查配置，提交时不会再隐藏该修复。

按当前2051个已暂存新增/修改路径进行只读验证：1802个归档路径从提交任务中过滤，归档脚本的ESLint与可格式化文件的Prettier忽略规则均命中；从Git暂存blob读取实际提交文本，ESLint检查98个源码文件，0错误、4条`no-console`警告；Prettier检查160个文件全部通过。验证前后Git索引条目摘要一致。三个源码守卫再次通过。未实际运行会自动改写文件的完整pre-commit/lint-staged，不重跑业务/安全或设备验收；本次没有新增产品源码改动。

## D36：DR-P4.6 登录后开库与数据发现边界修复

日期：2026-10-30。状态：**开库缺陷修复，实际双机完整验收仍进行中**。B 用户回报 Windows 11、本机操作、平台认证器能力 true，并给出 `state: approved`、`ready: true`、`issue: null`，确认申请审批和登录会话成功；截图的 `SECURITY_SOURCE_DENIED` 出现在继续访问模型库时。这些现场信息不能替代后续保存、刷新、停用、独立进程重启与丢失/恢复验收，也不能证明 TPM 或私钥不可导出。

开始时 Git 工作区干净，读取专项规则/唯一台账/最新交付和相关 Server、SDK、前端规则。发现 SDK 列库/catalog 使用 management URL，而双机演练只允许 B 访问 data 来源；另演练仅授予业务库读写，缺少独立设计器库的初始化/导入权限。没有修改 management 来源规则、授予安全管理员或全部数据库权限。

新增 registry 数据面 `GET /api/v1/databases` 和 `GET /api/v1/databases/:dbName/catalog`，复用认证、CSRF 会话读取、来源/限流和实时授权；列表仅返回有准确库名、全资源 `model.read` 的库，未授权 catalog 在打开引擎前拒绝，异步加载后重查来源/授权及停用状态。响应保留原显示名、字段标签/类型和自环策略。SDK registry Token/浏览器会话用新路径，legacy Token 保留原管理路径，无失败后跨平面回退。旧管理别名仍受 management 来源策略，旧管理列库继续包含准确授予的 callable-only 库；创建、删除、清除、备份和安全管理边界不变，专用本机管理监听器不暴露数据发现。

演练 Prepare 本机预建 `synthetic_business` 和 `model_designer_workspace`，审批仅给前者模型读写、后者模型读写/schema 管理/导入；没有库生命周期、备份或安全管理权限。`sys_*` 独立保存在设计器库。Client `status` 增加 `editorReady`，记录 `formalLibraryOpened`，必须本人继续并打开库后才能执行 `save`。管理拒绝断言仅接受 404/`SECURITY_NOT_FOUND` 或 403/`SECURITY_SOURCE_DENIED`，拒绝把任意403/服务故障计作成功。简介、手册、协议、发布说明、AGENTS、测试说明及唯一台账同步；正式产品无页面布局或可见翻译修改，不新增人工视觉结论。

受影响的九个测试文件 **151/151** 通过，0 fail/skip/cancelled/todo：数据发现、双机工具、托管隔离、动态授权、网络、原浏览器会话/授权及 Designer 身份/报告。新测试覆盖匿名/跨库/仅备份或发布权限不可读、管理路径仍拒、异步减权/停用与 SDK legacy 兼容。原生 Windows/Node24.15.0、全新 Designer/Chrome156 profile、随机回环 HTTPS、真实 DPAPI/Named Pipe 的正式页面 **1/1** 通过：实际点击继续→打开库→编辑器，重载恢复编辑器、合成保存读回、业务库无 sys 元模型、停用后会话/新登录拒绝；认证器为虚拟，非实际 Hello。原有 zh/en/ja、1280/390 共24张截图和标签/溢出断言通过。双库 Prepare/Serve、唯一 TLS、公钥 pin、可见独立 Chrome、安全上下文、本机管道及服务重建 smoke 另外通过，不计作实际双机。

新 shared/Core 声明、整个 Server/限定测试严格类型，SDK 严格 DOM 消费、三个前端类型及 browser 依赖边界通过，不覆盖 dist。默认受限运行时首次消费者类型检查无法解析已安装 exceljs/dayjs，原生 Node 使用现有依赖复验通过，没有安装依赖或改类型规则。开发期新合成 Cookie 测试最初用了 HTTP scope，改为所用 proxy/TLS 的 HTTPS scope 后通过；新增管理列库过滤曾使原 callable-only 兼容测试失败，恢复旧管理语义后151项通过，保留失败日志。浏览器首次断言误期望已隐藏管理路由403、其次误选隐藏的连接按钮、第三次误等待开库重载后的登录页，分别修正测试选择/预期；第三次已实际进入编辑器，最终从新实例完整重跑1/1。失败报告/TAP与最终结果分开保存，没有放宽权限或删负例。

本轮公开日志/报告及修复源码摘要位于 [D36证据目录](evidence/SEC-M7-D36/verification.json)。D34/D35及以前归档原字节保留，不更新旧 receipt 或把旧源码摘要改成当前结果；原总证据核验器最新 receipt 仍为 D34，其源码约束不能作为 D36 当前功能核验，使用本节明确列出的定向证据。未重新执行 D32 全量/六引擎、七包安装、性能容量、Node22、Edge 或完整实际 A/B；不宣称当前发行候选已通过最终总验收。

只使用新临时合成实例与随机回环端口；未读取/修改真实配置、根 security/certs、真实凭据/密钥/Vault/业务库/ACL/系统信任，没有连接重启9091、提交、推送、发布或切换。A/B 旧轮保留；两端同步修复后从全新 Prepare 开始，使用新 ticket/证书/独立核对 pin 并重新注册审批，依[双机手册](../security-v1/windows-device-drill-guide.md)实际打开编辑器，再检查 status/save/refresh/offline、停用后旧会话及新证明、同进程和独立进程重启拒绝及取消/丢失/恢复策略。

**DR-P4.6 保持进行中，新增扩展22/23、DR-P4为5/6、必需工作包3/4。下一步为用户完成修复后新轮 A/B 实际认证器验收并交回脱敏报告，不能以本机虚拟认证器回归关闭最后一项。**
