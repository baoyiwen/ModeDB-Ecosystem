# SEC-M1 交付报告

- 交付日期：2026-10-20（Asia/Shanghai）
- 里程碑：SEC-M1 / 密钥与 Vault 基础
- 修订：D01
- 技术状态：完成（Windows；验证边界见下文）
- 用户反馈：待反馈
- 代码定位：基于 Git `07e5393` 的工作区变更，尚未提交或发布；可按下列文件与测试定位，不以当前 HEAD 声称变更已提交
- 本次任务：S1.1、S1.2、S1.3

## 交付内容

网络凭证与磁盘数据密钥已经解耦：新库使用独立随机 DEK，Windows 通过 DPAPI 和 ACL 保护实例主密钥，主密钥封装每库 DEK。更换网络 Token 不重写或重新加密同一 Vault。Server 自动在配置文件目录的 `security/` 维护数据密钥，本地 Core API 显式要求 `keyProvider`。

Vault V2 增加认证头部、实例/数据库/密钥引用和版本，使用 AES-256-GCM。提交采用候选文件、同步意图日志、同目录 rename、陈旧写者检查和恢复验证；失败不按空库处理。旧 `MDB4SVLT` 明确拒绝并保留源文件。

同时修复 Engine 退出/驱逐生命周期：旧对象释放定时器和退出回调，避免将旧内存写回恢复后的文件；统一进程退出监听，回归不再出现本次发现的重复监听警告。后台刷盘失败输出固定错误码并停止自动重试，显式关闭仍向调用方报告失败。

| 任务 | 产物                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| S1.1 | [格式与入口契约](../security-v1-vault-contract.md)、`common/src/vault-keys.ts`、`shared/src/security-contracts.ts`（审计和恢复外层类型预留） |
| S1.2 | `server/src/security/`、Core/Server/CLI 显式 provider 接入、删除旧 Token 派生函数                                                            |
| S1.3 | `common/src/atomic-file.ts`、`core/authoring/atlas-single-vault.ts`、Engine/Bridge 生命周期处理、故障及实机验证                              |

## 验收结果

环境：Windows、Node.js `v24.15.0`、TypeScript `5.9.3`；全部数据测试在系统临时目录运行，Windows OS 验证未跳过。

| 验收 ID | 结果                       | 实际证据                                                                                                                                                                                                          |
| ------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1-A1   | 通过                       | `security-vault-v2` 将网络 Token 改值后由 Engine 重开、删除 Token 后由 Runtime 读取；`security-windows-keys` 用两种网络凭证分别启动隔离 Server 读取同库，断言 Vault 字节保持一致                                  |
| M1-A2   | 通过                       | 真实 CurrentUser DPAPI 解封、fresh provider 重开、错误 purpose 拒绝；匿名 Windows OS token 读取密钥文件被 ACL 拒绝；子文件增加 Everyone 读权限后拒绝打开；缺 DEK、损坏/缺 IMK、错误密钥和实例引用明确失败且不重建 |
| M1-A3   | 通过                       | Engine → flush/close → Runtime/重开读取；嵌套/扁平库均覆盖；目录测试四种布局各执行两次独立进程启动；旧文件拒绝前不请求新密钥，并断言文件内容不变                                                                  |
| M1-A4   | 通过（进程与注入故障范围） | 独立子进程分别在 staged/journaled/replaced 退出后恢复；模拟 ENOSPC 与部分候选、首次建库中断、认证标签/头部/密文篡改、陈旧写者及异常恢复材料均有断言。未执行物理磁盘耗尽或硬件断电实验                             |
| M1-A5   | 通过                       | V2 头部与 key reference/版本、固定错误码、审计事件及恢复外层契约已实现/文档化；随机数据密钥不写入配置，DPAPI 通过 stdin 接收秘密，OS 原始异常不向调用方传播                                                       |

M1-A5 的“秘密不进入配置”针对本阶段新增的数据加密秘密；现有网络 Token 配置仍存在，移除其长期明文持久化属于 SEC-M2—M4，不能用本次结果宣称已经完成。

## 验证命令与结果

支持的后续复验入口：

```powershell
pnpm run test:security:vault
```

本机使用已有工作区二进制执行以下等价构建与测试，避免引入依赖或重新安装工具：

```powershell
.\node_modules\.bin\tsc.cmd -p packages/shared/tsconfig.build.json
.\node_modules\.bin\tsc.cmd -p packages/common/tsconfig.json
.\node_modules\.bin\tsc.cmd -p packages/core/tsconfig.build.json
.\node_modules\.bin\tsc.cmd -p packages/server/tsconfig.json
.\node_modules\.bin\tsx.cmd --test test/unit/security-vault-v2.test.ts test/unit/security-windows-keys.test.ts test/unit/server-directory-layout.test.ts
```

结果：四个包构建通过；安全/目录测试 **16/16 通过、0 跳过**。其中 Vault 10 项、Windows 2 项、目录重启 4 项；后续补充头部/tag 篡改和子文件 ACL 用例后，相关测试分别复验通过。

相关回归：

```powershell
.\node_modules\.bin\tsx.cmd --test test/unit/core-query-filter.test.ts test/unit/query-having.test.ts test/unit/query-ordering.test.ts test/unit/operation-interface-compiler.test.ts test/unit/published-interface-runtime.test.ts test/unit/published-operation-interface-runtime.test.ts test/unit/published-binding-surface-runtime.test.ts test/unit/backup-management-http.test.ts test/unit/data-transfer-http.test.ts test/unit/pivot-interface-http.test.ts
```

结果：**52/52 通过**，覆盖查询、关系、已发布 Query/Operation/Binding Surface、备份管理、数据传输和 Pivot 接口。未针对用户现有库运行集成脚本；这不是整个 V1 的全流程验收。

源码边界检查、改动生产 TypeScript 的 ESLint 和格式检查均执行。ESLint 无错误；原 `cli-backup.ts` 仍有 12 项 `console.log` 警告。仓库配置忽略 `test/` 的 ESLint，不能把这些测试文件称为已通过 ESLint 校验。

全仓类型检查 `tsc --noEmit -p tsconfig.json` **未通过**：28 项错误，涉及 Designer 的 `ImportMeta.env` 类型、旧测试未使用项、数据传输/Pivot 测试夹具的 `modelId`/属性元数据缺失及 readonly 赋值。通过 TypeScript CompilerHost 只读覆盖：将本次修改的源码还原为 `git show HEAD:<path>` 的内容、排除新增文件，再运行同一根配置，改造前基线同样产生 **28 项、相同类别诊断**。这些已有错误未纳入本次扩展修改；相关包的生产构建和 M1 必需用例通过，不声称全仓 `check` 已通过。

开发中真实遇到并修复的问题：Windows PowerShell 安全模块加载失败，改用 .NET ACL API；System.Security 短程序集名无法解析，改为完整强名称。最终 DPAPI/ACL 实机验证通过，没有增加明文回退。

## 限制与后续验收

- Windows 支持范围：当前运行账号 + SYSTEM ACL、CurrentUser DPAPI。换机或丢失 Windows 用户配置后的独立恢复工具尚未实现；其他 OS 默认明确失败。
- Windows 的 Node API 不提供 POSIX 目录 fsync。已验证进程退出恢复及模拟写入失败，未证明所有硬件/文件系统的突然断电行为；真实断电和性能报告属于 SEC-M7。
- 文件级排他和陈旧写者检测已经存在，完整实例并发初始化/独占启动在 SEC-M2。回收锁本身中断时保留现场并拒绝猜测，不自动按超时抢占。
- 旧格式存在明确不兼容；没有透明迁移、自动删除旧库或 Token 解密回退。旧备份仍依赖旧环境，本阶段备份文件也不单独构成异机恢复材料。
- 新审计/恢复类型只是契约；事件持久化从 SEC-M2 接入，日志 UI 在 SEC-M5，独立恢复/加密交付在 SEC-M6。
- 数据密钥保护不等于主机完全失陷防护；当前受信账号、SYSTEM 或控制进程的攻击者仍可能取得解密能力。

上述边界不代替后续里程碑，不把 SEC-M1 描述为整个安全改造交付完成。

## 环境与数据影响

源码、文档和本地构建产物已更新。测试使用 `%TEMP%/modedb-*` 临时目录、随机本机端口和测试密钥，结束后清理；没有修改默认安装目录的实例安全材料。

仓库原有 `vault/model_designer_workspace/atlas.mld` 的用户改动保留，本次未对该文件进行读写验证、恢复或重建。未重启/切换当前 9091 服务，未轮换真实网络凭据，未发布 npm 或推送 Git。后续用户使用新构建时，旧 Vault 会收到明确拒绝，需要单独执行已有授权范围内的切换计划。

## 后续任务

SEC-M2 / S2.1—S2.3：独立安全台账与早期审计、本机受控管理通道/独占初始化、凭证创建/到期/轮换/撤销。浏览器配对、完整安全中心及便携恢复继续按后续里程碑交付。

## 修订与反馈

| 日期       | 修订 | 记录                                                                         |
| ---------- | ---- | ---------------------------------------------------------------------------- |
| 2026-10-20 | D01  | 完成 SEC-M1 技术验收；记录实机修复、基线类型错误和恢复验证边界；等待用户反馈 |
