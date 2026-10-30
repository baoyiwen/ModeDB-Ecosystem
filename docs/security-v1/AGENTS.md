# 项目说明

D36 当前接续（2026-10-30）：用户 B 已回报申请 approved、ready=true，表示审批/登录成功，不能关闭完整双机验收。修复后普通列库/catalog 走 `/api/v1/databases` 数据面，旧 management 别名及管理写入保持原来源规则；SDK/Server/托管页面一起更新，不做跨平面拒绝回退。演练预建业务/设计器双库，准确授予元数据库初始化/保存权限；B 必须本人点击继续→打开库，编辑器出现后 status 记录 editorReady/formalLibraryOpened，再 save。旧轮保留，两端同步后全新 Prepare，重新核对新 ticket/pin 并注册审批。先读 SEC-M7/D36 与双机手册；DR-P4.6 仍进行中，22/23、5/6、3/4 不变，真实材料边界不变。

D35 后续：lint-staged会隐藏部分暂存配置的未暂存修复，不能用工作区lint通过推断提交钩子通过。此次再次报18文件上限已确认暂存配置仍旧，已仅同步三个检查配置修复到暂存区，暂存blob复验98源码0错误/4警告、160格式通过。后续检查提交问题时同时核对工作区和 `git show :eslint.config.js`，保留其他暂存/未暂存改动，不通过关闭stash或跳过钩子绕过。详见SEC-M7/D35后续反馈；DR-P4.6状态不变。

D35（2026-10-30）：提交工具修复不改变D34验收状态。归档 `docs/security-v1-deliveries/evidence/` 在ESLint、Prettier及lint-staged中统一排除，历史报告/构建/工具快照原字节不得自动重排；常规JS工具保留规则并使用非项目解析，业务TS仍走项目服务。见SEC-M7/D35；不要为通过提交而把归档加入TS项目或更新历史摘要。

D34 当前接续：DR-P4.6 进行中，双机隔离演练脚本/逐步手册已准备，实际 Windows Hello/两台设备仍待用户执行。新增扩展保持22/23、DR-P4为5/6、必需工作包3/4。先读 SEC-M7/D34、唯一台账与[Windows双机手册](windows-device-drill-guide.md)。B 用户确认“尚未设置或不确定 Hello”，先指导设置→账户→登录选项，不索取PIN/生物特征。Prepare/Smoke不算双机验收；内置restart为同进程重建服务，还需stop后新Serve的进程重启拒绝。仅transfer公开ticket/证书可交B，pin独立核对，不传私钥/实例/profile。两端冻结LF源码摘要，默认新临时合成目录，可信私网仅显式Prepare地址后由用户Serve；不安装系统信任或改hosts。总证据D34只报告preparation-passed-device-pending，不能回填硬件完成。D33及以前结果/下一任务为各自历史，原字节不回写；真实服务与材料边界不变。

## 项目目标

- 项目名称：ModelDB 安全改造 V1。
- 目标：为 ModelDB 建立默认安全可用、最小权限、可审计、可维护并支持备份恢复与资产交付的安全机制；安全改造不能以牺牲现有业务数据完整性为代价。
- 当前范围：D06 重开的 S4.2、S5.1、S7.2 已分别在 SEC-M7 / D09—D11 修复并复验，SEC-M4、SEC-M5、SEC-M7 恢复完成，基础 V1 当前为 7/7、20/20。D11 当前候选的 70 文件 471/471、六引擎流程、Chrome 2/2、根/三前端类型、七包离线安装及单独生命周期/性能通过；修复候选加载本地配置、data-ui 漏带样式、旧快照核对及 TAP skipped 解析，保留原失败报告和 D02—D10 历史证据。D12/D13 已冻结 DR-P1.1/P1.2 部署及公共协议/依赖契约，D14 完成 DR-P1.3 持久台账与显式原子迁移，D15 完成 DR-P1.4 默认关闭的注册 HTTP、单次挑战、限流与到期回收；D16 完成 DR-P1.5 本机审批 CLI、准确授权和原子审计，D17 完成 DR-P1.6 注册—待审—批准纵向、恢复与故障报告，并修复 DPAPI 输出缓冲提前限制；D18 完成 DR-P2.1 三类会话父级与显式 V3 内部 CAS 迁移，修复停机跨期回收的终态提交顺序；D19 完成 DR-P2.2 公钥登录/短会话、显式 V4 迁移和浏览器验收；D20 完成 DR-P2.3 动态授权及执行边界；D21 完成 DR-P2.4 本机凭据/用户维护、减权与原子换钥，修复同公钥重新编码替换。D22 已完成 DR-P2.5 故障、重启与撤销竞争兼容验收，D23 完成 DR-P3.1 同源托管、专用 127.0.0.1 管理监听器/启动器及三语言宽窄屏验证；D24 完成 DR-P3.2 注册/Passkey/状态与恢复指引，D25 完成 DR-P3.3 本机审批/身份维护 UI，D26 完成 DR-P3.4 首次部署向导、公开证书/RP 预检及停机一次性提交，D27 完成 DR-P3.5 公共客户端与三前端兼容，D28 完成 DR-P3.6 同一候选综合浏览器验收与操作/排障文档，D29 完成 DR-P4.1 独立接收方公钥、单次持有证明、版本/恢复契约及本机 UI，D30 完成 DR-P4.2 按准确接收方离线迁移/资产交付与独立密钥恢复，D31 完成 DR-P4.3 新候选/七包离线安装、严格消费及合成升级/停用验收，301/301、0 skip，D32 完成 DR-P4.4 全量安全/业务及认证故障恢复，1030/1030、六引擎 82 断言和限定严格类型通过，D33 完成 DR-P4.5 独立性能/容量及洪泛维护确认，下一 DR-P4.6。新增扩展当前完成 22/23，未实施真实切换或旧库迁移。S6.1 两台 Windows 恢复实测沿用 SEC-M6 / D09—D11，不能替代未来新注册/认证双机验收。D04 已从当前 Git 索引取消跟踪四条根 security/ 引用，磁盘材料未读取或修改，历史材料未清理。
- S6.1 证据：D09 用户 A/B 报告 runId/源码一致、恢复五项成功；D11 完整 B 清单确认当前源码对应的 136 JS、六份编译配置、TypeScript 版本全部一致，137 个共有路径无内容变化。原始 dist 摘要不同仅因 A 独有 1/B 独有 19 个未引用旧输出；原摘要/旧文件保留，不改算法。A 及恢复报告在 `evidence/SEC-M6-D09/`，B 原报告和逐文件结果在 `evidence/SEC-M6-D11/`。S7.2 已使用隔离全新输出及逐文件包清单完成验收，旧 dist 保留；后续候选继续采用该方法，不能把恢复实现一致性替代发布安装验收。
- 历史基线：D02 的63文件424/424单元、六个引擎流程82断言、Chrome2/2均通过，0 skip；七个新包/三前端、真实离线安装、bin/CLI与严格类型消费、157项zh/en/ja对齐、整仓check和独立四项性能通过，保留44条既有lint警告。D06 不改写这些结果；用户随后进行了真实部署尝试，本机安全页成功、LAN 阶段遇旧 Vault 拒绝，不能沿用“从未接触真实实例”概括整个后续会话，也不能宣称完整业务验收通过。registry查询/同步写入中位约1.6秒，因同步审计/OS保护有明显开销；不得声称低延迟/高并发或生产容量已通过。物理磁盘耗尽/硬件断电未验证。清除归档依赖原Windows账号，恢复空访问台账；资产/约束/跨库存储限制沿用D12。正式发布、完整旧库迁移与升级切换未验收。

D27：公共 SDK 客户端与 data-ui 展示适配器已接入三个前端，480/480 定向及原生检查、0 skip。Designer/Data Studio 为 zh/en/ja，Web 保持 en/zh-CN；不新增 Studio/Web 托管路径。其后 D28 已完成 DR-P3.6 综合验收，当前下一 DR-P4.1，入口及排障见运行手册第 17 节。

## 关键资料

以下路径均相对于项目根目录。此安全改造目前沿用现有资料，不另建重复的 `brief.md`、`decisions.md` 或 `progress.md`：

- 项目需求与总体方案：`docs/security-v1-plan.md`
- 面向用户的功能简介：`docs/security-v1/overview.md`；操作使用手册：`docs/security-v1/user-guide.md`；构建/安装/切换/回退：`docs/security-v1/release-guide.md`
- Windows 本机/局域网配置及逐字段说明：`docs/security-v1/windows-lan-config.md`，可复制 JSON 位于 `docs/security-v1/examples/`；已有实例的来源策略以保存的防护状态为准，不通过删除台账或重建密钥应用配置。
- 本机安全管理、局域网配对与排障实操：`docs/security-v1/windows-lan-walkthrough.md`；包含本次实际证据边界，不能把旧格式拒绝当作完整开图通过。
- 新增扩展设计：`docs/security-v1/device-registration-proposal.md`；可信部署契约：`docs/security-v1/device-registration-deployment-contract.md`；公共协议/依赖及持久台账契约：`docs/security-v1/device-registration-protocol-contract.md`；接口使用说明：`docs/security-v1/device-registration-runtime-guide.md`；D08 的详细开发计划在唯一台账第 11 节。阶段 0 和 DR-P1.1—P1.6 已完成，DR-P1—P4 共 23 个新增子任务当前完成 22/23；DR-H1 是单独可选增强。DR-P1 已完成 6/6、DR-P2 为 5/5、必需工作包 3/4、DR-P3 为 6/6；DR-P4 当前 5/6，下一 DR-P4.6。D19 已实现显式 V4 登录、真实签名验证和 30 分钟/8 小时 Cookie/CSRF 会话，登录独立于注册窗口；三类会话父级和 V3 显式内部迁移已完成；普通 open 不升级；显式 authentication.enabled 与迁移许可开放公钥登录，现有 Token/配对保留。兼容边界见公共协议第 12 节。DR-P1.6 已用实际 Chrome 虚拟认证器及原生 DPAPI/CLI 验证纵向注册审批、容量、重启与故障；合成 AES-GCM 链路另覆盖三个真实进程硬退出点，不冒充实际 Hello/新双机。DR-P1.5 已提供受保护本机列表/批准/拒绝、准确授权及原子审计，批准不签发会话或 Token。注册默认关闭，仅显式有效窗口及迁移许可才升级 V1；HTTP 服务验证同源/来源和 WebAuthn none 响应，保存待审候选，不发放权限或会话。WebAuthn 14.0.3 的相同 25 包图已接入 Server 根锁，隔离离线安装和运行时验证通过；D31 已做七包实际离线安装（含 99 项第三方快照），未做公开发布。公钥登录后端和 SDK 已完成；D24 已完成正式注册/Passkey 状态页；D25 审批维护 UI、D26 首次部署向导与 D27 公共客户端/三前端兼容已实现，TPM 助手未实现。新批准的 grants 明确落盘；旧 V2 缺该字段视为空授权，不能继承其他凭据权限。none 不证明硬件或私钥持有；不得将浏览器 Passkey 说成物理主机绑定。
- 接收方公钥与离线证明：`docs/security-v1/recipient-key-contract.md`，操作见运行手册第 18 节；普通打开不自动 V4→V5，WebAuthn/TLS/资产签名密钥不能复用为接收方。
- 已确认的方案与技术契约：
  - `docs/security-v1-vault-contract.md`
  - `docs/security-v1-identity-contract.md`
  - `docs/security-v1-authorization-contract.md`
  - `docs/security-browser-sessions.md`
  - `docs/security-http-invocation.md`
- 当前进度、任务状态、验收门槛和后续任务：`docs/security-v1-milestones.md`（唯一进度台账）
- 阶段交付记录：`docs/security-v1-deliveries/SEC-M1.md` 至 `SEC-M7.md`；接续工作先读当前阶段报告的最新修订
- 本文件：`docs/security-v1/AGENTS.md`，只作为安全改造专项的会话指南
- 代码交付位置：按任务涉及 `packages/common`、`packages/core`、`packages/server`、`packages/shared`、`packages/sdk`、`apps/model-designer` 及相关测试目录；不是集中输出到 `outputs/`

## 开始工作前

- 接续之前的工作时，先阅读 `docs/security-v1-milestones.md` 和当前阶段最新交付报告；当前应先读 `docs/security-v1-deliveries/SEC-M7.md` 的 D36，并保留 SEC-M6 / D09—D12、SEC-M7 / D02—D35 证据及 SEC-M5 的历史记录。
- 阅读与本次任务直接相关的总体方案、契约和代码，并检查相关目录中的现有 `AGENTS.md`。本文件不替代这些模块规则。
- 每次涉及新页面开发或旧页面改造时，先读 `apps/AGENTS.md` 和所在应用的指引；页面美观与 i18n 均为必需交付要求，后续接续会话也必须读取。
- 检查 `git status --short`，识别并保留用户已有改动。不要覆盖或清理与当前任务无关的工作区变更。
- 如果本文件引用的资料不存在，明确报告缺失；不要假定其内容，也不要为了补齐模板而创建重复的需求或进度台账。
- 区分设计目标、已实现代码、隔离测试结果和真实部署状态。只有台账与交付报告中的实际证据可支持任务完成状态。
- 没有用户明确授权时，不连接、重启或切换真实服务；不修改真实 `modeldb.config.json`、凭据、密钥、Vault 或业务库；不执行凭证/密钥轮换、出厂清除、库删除、真实环境恢复或外部发布。使用隔离目录、合成数据和随机端口验证。

## 长期工作约定

- 使用中文沟通，代码标识符、协议名、命令和错误码保留原文。
- 修改前先了解涉及模块的现有实现、入口和权限边界；安全规则不得只在 UI 隐藏按钮，必须在服务端执行并有测试覆盖。
- 修改应围绕当前安全任务，避免无关重构、格式化或批量改写。
- 用户本次明确提出的新要求优先；若与已确认方案或里程碑范围冲突，先指出冲突及影响，并在实施前同步更新方案/契约和里程碑台账。
- 从 S6.2 开始，每次功能开发同步维护功能简介和使用手册，提供已实现操作、命令、权限、限制和故障处理；不等最后阶段才补文档，不将设计目标写成可用功能。它们是用户文档，不另立进度台账。
- 新页面和旧页面改造都要兼顾美观与 i18n：保持主题/组件、布局层级、间距、状态反馈和窄屏一致性；可见文案及无障碍标签使用现有翻译机制并同步支持语言（Designer/Data Studio 的 `zh/en/ja`）。验收覆盖相关语言、长文案和实际视觉；纯逻辑修改无界面/文案变化时在交付中说明，不能把类型检查当视觉验收。
- 默认拒绝并最小授权；不得把来源 IP、Origin、声明的用户标识或网络白名单当作身份认证。不得将凭证原文、密钥材料、恢复材料、业务明文或敏感请求体写入日志、测试快照或交付文档。
- 管理面与数据面权限边界、撤销即时性、来源归因、审计失败策略、磁盘满行为、并发写入和崩溃恢复都要按受影响范围检查。
- 不把隔离测试通过表述为真实服务已切换或生产验收通过；不声称未执行的验证已经通过。
- 本文件只用于 ModelDB 安全改造 V1 的新会话。它不修改、不覆盖、不取代根级或其他软件子项目的 `AGENTS.md`，也不表示本仓库通用/全自动化工作流发生变化。新会话若继续安全改造，应明确要求先阅读本文件；其他软件任务继续遵循其所在目录的既有 agent 规则。

## 验证与交付

- 代码验证：根据改动范围运行已有且适用的安全测试；根 `package.json` 当前提供：
  - `pnpm run test:security:vault`
  - `pnpm run test:security:registry`
  - `pnpm run test:security:resilience`（DR-P2.5 合成保护器实际进程硬退出、排队/验签撤销竞争、审计满与原认证兼容；不替代原生/硬件验证）
  - `pnpm run test:security:maintenance`（DR-P2.4 本机身份/CAS/分页、单凭据与全用户、减权、换钥/丢失审批、规范公钥比较、故障及原生 DPAPI/CLI）
  - `pnpm run test:security:dynamic`（公钥会话 HTTP/RPC/WS、减权/停用、空闲到期、队列/异步守卫、发布父子/批量与原子故障；内部收缩原语不是正式维护 CLI）
  - `pnpm run test:security:authentication`（公钥签名/持久迁移/竞争/限流/队列与故障）；`pnpm run test:security:authentication:integration`（原生隔离 Chrome/HTTPS/DPAPI/本机批准、SDK 与 Cookie 生命周期，不验证正式页面或硬件）
  - `pnpm run test:security:session`（DR-P2.1 三类会话父级、显式迁移、隔离 DPAPI、故障与旧认证兼容；不是公钥登录）
  - `pnpm run test:security:registration`（DR-P1.1—P1.5 部署/协议、台账/迁移、注册 HTTP 和本机审批，共五个测试文件；Windows DPAPI/CLI 必需，完整纵向集成单独运行下项；不代表登录或实际硬件认证器验收）
  - `pnpm run test:security:registration:integration` 或 `node scripts/security-registration-integration-check.mjs`（9 项纵向/恢复测试，Chrome 虚拟认证器和原生 DPAPI/CLI 必需；自动生成脱敏 JSON/TAP，仅临时实例）
  - `node scripts/security-registration-consumer-check.mjs`（临时新 shared 声明、SDK 严格消费和 browser bundle 边界）
  - `node scripts/security-registration-storage-check.mjs`（临时新 shared 声明、全新 Core 声明、整个 Server、存储、运行时、审批与集成测试严格类型，不修改原 dist）
  - `pnpm run test:security:authorization`
  - `pnpm run test:security:network`
  - `pnpm run test:security:browser`
  - `pnpm run test:security:protection`
  - `pnpm run test:security:recovery`
  - `pnpm run test:security:backup`
  - `pnpm run test:security:asset`
  - `pnpm run test:security:asset:browser`（先构建 Designer；真实 Windows/Chrome，隔离 profile/实例）
  - `pnpm run test:security:fault`（清除恢复、匿名审计洪泛/容量与注入故障）
  - `pnpm run check`（源代码检查、类型检查、lint 与格式检查）
- 运行前核对脚本和环境是否可用；若包管理器、依赖或环境导致命令无法运行，记录原始失败及替代验证，不能静默省略。新加安全行为应添加定向单测/集成测试，覆盖允许、拒绝、撤销/到期、错误输入和故障路径。
- 文档验证：核对任务编号与里程碑、状态计数、相对链接、配置/命令准确性及中英文术语；确认没有秘密、真实业务数据或未经验证的结论。只格式检查本次修改的文档，不重排用户已有文件。
- 交付时说明完成内容、涉及文件、实际执行的命令和结果、未执行的检查、隔离/真实环境边界、未解决事项及下一任务编号。
- 任何验收项未验证或失败时，保留为待验证/受阻/失败，不将里程碑标为完成。

## 会话衔接

- 完成阶段性工作后更新 `docs/security-v1-milestones.md`，并在对应的 `docs/security-v1-deliveries/SEC-Mx.md` 追加修订记录；不要另建第二份进度台账。
- 记录：已完成与未完成任务、验收结果及证据、阻塞条件与恢复方式、涉及文件、测试环境和数据影响、是否触及真实服务。
- 方案发生变化时，更新 `docs/security-v1-plan.md` 或相关契约，并在台账中记录结论、原因、影响的任务/验收项，以及替代的旧方案。
- 下一会话的起始提示应注明：继续 ModelDB 安全改造 V1，先读本文件、进度台账与当前阶段交付报告；本次目标任务及是否允许接触真实实例。

D20 接续边界：权限收缩需可信本机上下文和准确 CAS，只能减权；通用存储仍禁止改 grants。凭据订阅及用户反向影响索引、状态/用户变更同事务撤销旧会话，重新启用必须重新登录。HTTP/RPC 等待 gate/引擎/异步授权后最终重查整组权限；绑定面父级传入子调用及批量每项；Core 原始 batchUpdate/batchDelete 逐项守卫。insertMany/upsertMany/关系导入是已进入的整体操作，不承诺中途取消。单项已提交和部分批量如实返回，自动刷新失败不伪称回滚。D21 已完成正式 OS 本机维护、全用户停用/启用、终态撤销与换钥；D22 已完成 DR-P2.5 故障、重启与撤销竞争兼容验收；D23 已补同源托管、专用回环管理/启动器与新配置，D24 已完成注册/Passkey 状态页，下一 DR-P4.1 独立接收方加密公钥关联与持有证明；未做真实切换。

D22 接续边界：停用/撤销一旦持久生效，排队和验签中的证明不可因随后 enable 复活；监听在首次 await 前安装、所有退出路径释放，减权按最终最新 grants。30 个合成真实进程退出和原生 DPAPI/CLI/Chrome 分开记录；55 项恢复专项与既有回归、37 项工具合计 392/392。后端 DR-P2 完成，D23 已完成 DR-P3.1，D24 已完成 DR-P3.2，下一 DR-P4.1；进入页面改造前必须读 apps/AGENTS.md 及 Designer 规则，交付美观、zh/en/ja、无障碍和实际视觉验证。

DR-P3.1 重复验证：`pnpm run test:security:hosting`、`node scripts/security-hosting-integration-check.mjs`；托管构建用 `node scripts/security-hosting-build.mjs --output <new-directory>`，不加载本地 Vite/env。新管理空闲 15/绝对 60 分钟，无数据授权；旧独立前端仅 hosting 缺省/false 兼容。下一步先读运行手册第 13 节和 D24，仍只使用隔离环境。

D24 接续边界：DR-P3.2 正式 Designer 注册/Passkey 页面完成，中英日文、宽窄屏和真实页面/原生 DPAPI/Pipe 验收通过；公开 auth capabilities.deployment 独立于注册下载期限。注册只走当前 HTTPS Origin；描述 JSON 严格限 16 KiB，continuationSecret 只在内存闭包，刷新丢失查询但不撤销申请；批准仍需新鲜登录。SDK 支持取消并在提交证明前再查 AbortSignal。页面换钥/丢失恢复为管理员核验指引，无自动接管。仅浏览器可发现 Passkey；非可发现凭据 rawId 提示目前只供 SDK 嵌入方。下一 DR-P4.1 新候选浏览器验收与操作/排障文档，仍先读 apps 及 Designer 规则，满足美观/i18n/实际视觉。命令 `pnpm run test:security:designer-identity`、`node scripts/security-designer-identity-check.mjs`；完整步骤见手册第 13 节。保留 D24 原始失败、D23 历史及本机真实材料；未做真实切换、实际 Hello/新双机、完整业务保存、生产性能或发行安装。

D26 接续边界：DR-P3.4 全新目录初始化、默认回环/注册关闭、本机公开证书/RP/来源预检、十分钟计划与公开描述导入下载、明确停机单次 CLI 已完成。HTTP 只预览，不打开证书/私钥路径；提交保留身份，更新持久规则并写新配置，原 bootstrap 保留。一次性提交标记出现后结果不明禁止盲目重试或删除标记，现有实例人工合并；不安装信任、不自动重启。手册第 15 节、D26 证据及唯一台账同步；464/464，0 skip，包含 5 项原生托管/注册/维护/向导。下一 DR-P4.1，先读本文件、D26、台账及 apps/Designer 指引。仍不授权真实配置、9091、凭据/密钥、Vault/业务库或切换。

D28 接续边界：DR-P3.6 完成，同一份源码及全新三端产物按摘要绑定；九项原生浏览器与 481 项定向检查，合计 490/490、0 skip。三端浏览器会话可写入合成行并刷新读回，但不等于完整业务建模保存。恶意页面/表单、同站不同端口 CSRF、null Origin、嵌入、错 RP、Host 重绑定和代理头拒绝通过；继续后端校验，不把 Cookie 属性或 UI 当权限边界。入口 `node scripts/security-browser-candidate-check.mjs`，操作与排障见运行手册第 17 节；下一 DR-P4.1，先冻结独立接收方加密公钥与持有证明/恢复契约，再实现本机 UI。WebAuthn 私钥不用于数据解密；不自动迁移旧 Vault，不删除历史解密材料。实际 Hello/双机、独立性能和新发行安装仍待 DR-P4。保留 D28 失败和 D27 及之前的原字节证据；默认隔离环境，真实配置、9091、凭据/密钥、Vault/业务库、信任安装和发布切换仍须明确授权。

D29 接续边界：DR-P4.1 完成，新增扩展 18/23、DR-P4 为 1/6、必需工作包仍 3/4。下一 DR-P4.2 按已核验接收方接入原迁移/资产封装，不能把本轮公钥登记说成已完成包交付。先读本文件、D29、台账、接收方密钥契约及运行手册第 18 节。仅显式本机 initialize 才从 V4 原子升级 V5；旧版本不得手改降级。RSA OAEP label 绑定实例/用户/指纹/版本/前版本及五分钟挑战，证明单次消费，审计与历史原子提交，失效挑战不能因重新启用复活。登录与接收方公钥双向禁止复用；禁用登录不删历史公钥，访问重置另退役活动接收方。私钥/口令只由接收方离线工具使用，勿归档其输入或证明。丢失旧私钥后新版本不能解旧包。下一步仍仅临时合成环境；真实 9091/配置/密钥/Vault/业务库/信任与切换未获授权。D22—D28 的旧“下一任务”为当时历史，当前以此 D29 和唯一台账为准。

D30 接续边界：DR-P4.2 完成，479/479、0 skip；新增扩展 19/23、DR-P4 为 2/6、必需工作包仍 3/4。下一 DR-P4.3 新包/前端候选、实际离线安装、CLI/bin/严格类型消费及合成升级/停用演练。先读本文件、D30、唯一台账、接收方契约及运行手册第 19 节。V5 离线导出强制准确接收方/用户/版本/指纹和总修订；V1—V4 原 PEM 兼容保留，禁止降级版本绕过。列表也推进修订，导出前重新核对。sealed 审计绑定密文摘要但不证明文件成功；写入结果未知时保留现场核查，不自动重发。三种原包格式与导入/恢复协议不变，私钥不上传，旧包仍须对应历史私钥。目标新 DEK/空访问台账，停用不能撤回已发包。重复入口为 pnpm run test:security:delivery 和 node scripts/security-recipient-delivery-check.mjs；无页面/i18n 改动，不代替后续发行安装、性能或实际 Hello/双机。D29 及之前旧“下一任务”为历史，当前以 D30 与唯一台账为准；真实材料、9091、信任/发布/切换仍未获本轮授权。

D31 接续边界：DR-P4.3 完成，234 项定向回归 + 66 项工具 + 1 项原生安装，合计 301/301、0 skip。七包/三前端全新候选、99 项第三方本机快照实际离线安装、bin/CLI、严格 Node 与无 Node 环境 DOM 消费通过；489 项源码、9 份文档、312 项三语言键绑定。安装后压缩 JS 逐级 V1→V5、签名登录、跨重启停用、重新启用须新登录、接收方历史及访问重置通过。修复跨文件共享 Terser 缓存误改全局 Buffer，普通混淆和候选共用独立模块压缩；保留失败与旧证据。旧兼容仅固定 V1 reader 编译体配当前安装辅助模块，不冒称完整历史发行包降级。无页面改动或视觉结论，候选文件留本机临时目录，归档清单/原日志/报告而非实例和秘密。重复入口 node scripts/security-install-check.mjs / pnpm run test:security:install。新增扩展 20/23、DR-P4 3/6、工作包 3/4；下一 DR-P4.4 全量安全及模型/关系/接口/Pivot/Excel/备份与认证故障恢复。真实环境、发布/切换、实际 Hello/双机、独立性能未执行且未获本轮授权；D30 及之前的“下一任务”为历史。

D32 接续边界：DR-P4.4 完成，106 文件 1008/1008 单元、22/22 同候选浏览器/原生及六引擎 82 断言通过，0 fail/skip/cancelled/todo；新增扩展 21/23、DR-P4 4/6、工作包 3/4，下一 DR-P4.5 独立性能/容量、注册洪泛及本机修复资源保障。入口 node scripts/security-full-check.mjs / pnpm run test:security:full，先读 D32 和使用手册 DR-P4.4。普通数据备份保持 V5 用户停用和接收方历史；独立恢复建立空访问台账，旧会话/旧公钥不能恢复权限。663 项源码、18 份公开页面产物、原始 TAP、认证故障矩阵及命令元数据绑定；缺统计、skip、超时、漂移或证据缺失拒绝成功。完整运行期间不改源码/测试/工具/包配置。公开产物/日志有界模式扫描结合动态秘密断言，不保证识别任意秘密；不归档实例、私钥或口令。保留第一轮与 D31 以前 1543 条历史原字节证据。无页面改动和人工视觉结论；严格类型含新增恢复用例，不冒称根 check。下一性能确认须先冻结方法和门槛，再独立测量，不能用本轮测试耗时替代性能。实际 Hello/新双机仍待 DR-P4.6；真实服务/配置/密钥/Vault/业务库、信任、发布及切换边界不变。D31 及之前的下一任务为历史。

D33 接续边界：DR-P4.5 完成，253/253 定向安全/工具/原生 Chrome、独立 AB-BA 504 样本与原生满容量洪泛确认通过，0 skip。22/23、DR-P4 5/6、工作包 3/4，下一 DR-P4.6 实际 Windows Hello/两台设备与最终文档/证据。入口 node scripts/security-performance-check.mjs explore → register <report> → confirm <registration.json>；先读独立性能手册。原失败 p95、旧门槛和公开产物保留；修复到期事务后新源码重新探索/登记/确认，没有提高原失败门槛。每实例公共拒绝审计共用64项FIFO、逐项持久后响应；注册清理/新申请共用一次事务但保留两条审计，审计不足或写失败整体拒绝。后台仍及时处理未完成申请到期，已完成挑战垃圾随后续请求/重启回收，截止时间不延长。Server Node/tsx 源码路径及新Designer字节是本轮性能对象，CPU/RSS仅Server Node、DPAPI子进程资源未测；正常并发1、单来源洪泛48，不冒称生产/分布式或安装后压缩包性能。源码变化必须新探索，运行确认时不得并行其他验收。不重跑D32全量、六引擎或D31新安装，无页面/i18n改动及新视觉结论。下一实际双机不能用软件签名、虚拟认证器或旧恢复报告替代；真实9091/配置/密钥/Vault/业务库、信任安装、发布/切换仍需明确授权。D32及以前的下一任务为当时历史。
