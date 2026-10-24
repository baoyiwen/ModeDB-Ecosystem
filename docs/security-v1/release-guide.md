# 安全 V1 构建、安装与切换指南

本文面向 Windows 实例所有者与发布维护者，配套[功能简介](overview.md)、[使用手册](user-guide.md)和[唯一验收台账](../security-v1-milestones.md)。研发验收与实际发布、实际服务切换分别记录。

## 1. 生成可检查的本地候选

在已安装仓库依赖的普通 PowerShell、项目根目录执行。命令每次创建新的系统临时目录，保留原 dist、真实实例及此前演练材料。

```powershell
node .\scripts\security-release-candidate.mjs
```

工具复制明确允许的开发文件，将七个包编译到新的输出目录，并对 shared/common/core/server 按现有发布规则使用 Terser 压缩。它生成 tgz，逐文件核对编译输出、包入口、声明文件、依赖版本和包内路径，拒绝 Vault、清除归档、实例配置及根运行安全目录。不会执行现有 `publish-workspaces.mjs`，也不会删除旧构建。

随后从这些 tgz 安装临时消费项目，检查 CLI、包管理器生成的 `modeldb-server` 入口和 TypeScript 消费入口。第三方依赖来自本机已安装代码的独立离线包，记录版本与摘要；这验证本地安装与运行，不代表 npm registry 可用性或一次联网依赖解析。安装使用 `--ignore-scripts`，再单独运行本包的 workspace 指南安装器；第三方安装脚本保持禁用。操作不会安装全局 CLI。

Designer、Data Studio、Web 均生成新的生产页面。浏览器实际依赖的 SDK/data-kit/data-ui 构建必须与本次全新编译内容一致；出现 `RELEASE_BROWSER_DEPENDENCY_STALE` 时先运行对应包的构建，再重新生成候选。原目录中未引用的历史输出不会复制进候选包。编译只发生在临时目录。

成功输出 `ReleaseRoot` 和 `release-candidate.json`。该 JSON 记录包、页面、文档、源码、第三方依赖的清单与 SHA-256。工具需要本地 TypeScript、Terser、三个前端的 Vite、tar 和 pnpm；未自动发现 pnpm 时，可通过 `MODELDB_PNPM_CLI` 指向本机已有的 `pnpm.cjs` / `pnpm.mjs`。不会联网下载缺失工具。

## 2. 复验候选

把下面路径替换为上一步实际输出的报告，保留引号。无需运行真实实例。

```powershell
node .\node_modules\tsx\dist\cli.mjs .\scripts\security-release-verify.ts "<ReleaseRoot>\release-candidate.json"
node .\scripts\security-release-regression.mjs
$env:MODELDB_TEST_APP_ROOT = "<ReleaseRoot>\apps"
node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 .\test\integration\security-browser-apps.test.ts .\test\integration\security-asset-browser.test.ts
Remove-Item Env:MODELDB_TEST_APP_ROOT
```

候选验证先核对 tgz 及实际安装文件摘要，再用真实 Windows DPAPI、随机端口和合成库检查独占启动、配对码消费、HttpOnly、限权拒绝、本机网络修复、备份恢复、主密钥维护和撤销。所有凭据均在临时实例中创建，验证报告只保存检查结果与时间，不保存秘密或合成记录正文。

回归入口运行全部 `test/unit/*.test.ts(x)` 和六个引擎集成脚本。单元测试在代码根解析子进程入口，各实例由测试创建独立临时目录；引擎集成脚本的工作目录固定为新临时目录，其相对 `data/` 因而位于临时目录内。浏览器复验使用上述三个新页面、独立 Chrome profile 和随机端口。缺 Windows/Chrome 时的 skip 不算验收通过。失败时保留报告与现场，按退出码和日志解决，不手删锁或阻断标记。两台 Windows 已完成的独立恢复证据沿用 SEC-M6 / D09—D11；这些本地命令不再声称产生第二台设备的成功证明。

性能比较包含已初始化实例启动、1000 行查询、同步持久化单行写入，以及 1010 行真实 Excel 导出。三轮交替 legacy/registry 顺序，查询预热后采样；先停止其他测试再测量。两组均使用当前候选、新加密 Vault、同一 SDK 和数据。legacy 组仅用于测量授权/同步审计增加的成本；该组不作为安全部署配置。它不是旧版本二进制与新版本的历史对比，也不能代表真实业务容量、远程 TLS、并发或硬件断电性能。具体测量和研发门槛见最新交付报告，首次基线不用于承诺生产 SLA。

首轮 Windows 探索性测量显示，registry 的同步审计/OS 保护带来明显成本：查询与持久写入约为秒级，不能宣称与 legacy 延迟相近。本轮在该基线之后、独立确认之前登记本机回归的 p95 上限：启动 10000ms、1000 行查询 4000ms、持久单行写入 4000ms、1010 行 Excel 导出 5000ms。超限会保存报告并返回失败；更换硬件或工作负载需要重新评估基线。这些宽限仅用于检测当前 Windows 实现的回归，不代表低延迟、高并发或生产容量验收。当前每次台账提交仍调用 OS 保护并同步落盘，后续吞吐优化需独立设计和安全复验。

## 3. 隔离新实例安装与配置

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
