# 项目说明

## 项目目标

- 项目名称：ModelDB 安全改造 V1。
- 目标：为 ModelDB 建立默认安全可用、最小权限、可审计、可维护并支持备份恢复与资产交付的安全机制；安全改造不能以牺牲现有业务数据完整性为代价。
- 当前范围：按 `docs/security-v1-milestones.md` 补齐 SEC-M6 的 S6.1 异机恢复验收，继续 S6.3 的继承虚拟关系/复杂链引用兼容与导入后浏览器审核/重新发布/授权验收，之后进入 SEC-M7。D05 已有 v2 Designer 子集和双库分阶段发布，不能以本地中断证据替代异机证据。用户已允许在 S6.1 待验证时推进其余开发。
- S6.1 演练入口：D06—D08 的 `scripts/security-recovery-drill.ps1` 提供 Prepare/Receive/Verify、未提升令牌预检、UTF-8 输出解析和脱敏报告，步骤见使用手册 §4.1；完整同步三个演练 TS 文件及 `.ps1`。用户确认旧 `prepare.recovery-package` 失败发生在管理员窗口，不能把可能的文件所有者问题记为已证明根因。B 已回传直接 runner 的接收成功/退出码 0，包装层中文路径/CP936 故障已在本地复现修复；B 实际控制台编码未采集，不能将所有故障归于编码。下一核对新版 A Prepare/B Verify 报告与摘要；工具、本机测试和 B 接收成功不能替代异机恢复成功证据。
- 当前基线：SEC-M1 至 SEC-M5 已交付，累计 5/7 里程碑、16/20 开发任务；SEC-M6 进行中，S6.1 异机 Windows 实机验收待验证；S6.2 备份/完整受信迁移完成；S6.3 / D05 已有 v2 Designer 接口/固定版本依赖、I18N/基础布局映射和离线双库日志/启动阻断/续跑，完整兼容与浏览器验收未完成，最新测试以 D05 为准；SEC-M7 未开始。同机同账号演练明确拒绝异机成功，不能作为独立灾备证据。SEC-M5 / D05 的 reset 中断后无续跑/归档恢复工具限制仍在。不能据此宣称安全 V1 已整体完成。每次接续工作以进度台账和最新交付报告为准，不以本段静态文字覆盖较新的记录。

## 关键资料

以下路径均相对于项目根目录。此安全改造目前沿用现有资料，不另建重复的 `brief.md`、`decisions.md` 或 `progress.md`：

- 项目需求与总体方案：`docs/security-v1-plan.md`
- 面向用户的功能简介：`docs/security-v1/overview.md`；操作使用手册：`docs/security-v1/user-guide.md`
- 已确认的方案与技术契约：
  - `docs/security-v1-vault-contract.md`
  - `docs/security-v1-identity-contract.md`
  - `docs/security-v1-authorization-contract.md`
  - `docs/security-browser-sessions.md`
  - `docs/security-http-invocation.md`
- 当前进度、任务状态、验收门槛和后续任务：`docs/security-v1-milestones.md`（唯一进度台账）
- 阶段交付记录：`docs/security-v1-deliveries/SEC-M1.md` 至 `SEC-M6.md`；接续工作先读当前阶段报告的最新修订
- 本文件：`docs/security-v1/AGENTS.md`，只作为安全改造专项的会话指南
- 代码交付位置：按任务涉及 `packages/common`、`packages/core`、`packages/server`、`packages/shared`、`packages/sdk`、`apps/model-designer` 及相关测试目录；不是集中输出到 `outputs/`

## 开始工作前

- 接续之前的工作时，先阅读 `docs/security-v1-milestones.md` 和当前阶段最新交付报告；当前应先读 `docs/security-v1-deliveries/SEC-M6.md`，必要时回看 `SEC-M5.md` 的维护边界。
- 阅读与本次任务直接相关的总体方案、契约和代码，并检查相关目录中的现有 `AGENTS.md`。本文件不替代这些模块规则。
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
- 默认拒绝并最小授权；不得把来源 IP、Origin、声明的用户标识或网络白名单当作身份认证。不得将凭证原文、密钥材料、恢复材料、业务明文或敏感请求体写入日志、测试快照或交付文档。
- 管理面与数据面权限边界、撤销即时性、来源归因、审计失败策略、磁盘满行为、并发写入和崩溃恢复都要按受影响范围检查。
- 不把隔离测试通过表述为真实服务已切换或生产验收通过；不声称未执行的验证已经通过。
- 本文件只用于 ModelDB 安全改造 V1 的新会话。它不修改、不覆盖、不取代根级或其他软件子项目的 `AGENTS.md`，也不表示本仓库通用/全自动化工作流发生变化。新会话若继续安全改造，应明确要求先阅读本文件；其他软件任务继续遵循其所在目录的既有 agent 规则。

## 验证与交付

- 代码验证：根据改动范围运行已有且适用的安全测试；根 `package.json` 当前提供：
  - `pnpm run test:security:vault`
  - `pnpm run test:security:registry`
  - `pnpm run test:security:authorization`
  - `pnpm run test:security:network`
  - `pnpm run test:security:browser`
  - `pnpm run test:security:protection`
  - `pnpm run test:security:recovery`
  - `pnpm run test:security:backup`
  - `pnpm run test:security:asset`
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
