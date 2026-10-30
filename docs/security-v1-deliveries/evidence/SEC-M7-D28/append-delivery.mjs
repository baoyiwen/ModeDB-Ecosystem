/** Append actual D28 delivery only after native and regression completion; no history rewrites. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D28/';
const selected = JSON.parse(readFileSync(base + 'selected-candidate.json', 'utf8'));
const report = JSON.parse(readFileSync(selected.directory + '/candidate-check.json', 'utf8')); assert.equal(report.ok, true);
assert.ok(JSON.parse(readFileSync(base + 'regression-commands.json', 'utf8')).every(r => r.exitCode === 0));
const images = dir => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? images(join(dir, e.name)) : e.name.endsWith('.png') ? 1 : 0), 0);
const screenshots = images(selected.directory + '/screenshots');
const text = `

## D28：DR-P3.6 浏览器候选综合验收与操作排障

日期：2026-10-28（America/New_York）。接续前读专项 AGENTS、唯一台账与 D27，检查 Git 状态并保留全部现有改动，包括真实配置原修改、四条根 security 索引删除和 certs 未跟踪状态。只使用新临时合成实例、随机 127.0.0.1 端口、独立 build/Chrome profile；未读取或修改真实配置、certs、根 security、凭据/密钥、Vault/业务库或真实 ACL，未连接或重启真实 9091。

### 实现与用户文档

新增可重复入口 \`node scripts/security-browser-candidate-check.mjs\`（\`pnpm run test:security:browser-candidate\`）。只构建一次 Designer、Studio、Web，关闭本地 Vite/env，保留原 dist；六组顺序使用相同候选摘要，逐组前后核对清单中的开发源码与新产物，任何漂移、缺组、skip、超时或失败均拒绝。保存逐文件源码/产物清单、原始 TAP、JSON 及截图，每次新建目录并保留失败现场。服务端使用源码入口，当前清单与三端产物绑定不替代七个新发行包或完整第三方依赖安装校验。

综合覆盖正式注册/拒绝/批准/公钥登录、准确本机审批维护、部署预览/停机单次提交、注册到期后的已有登录、禁用、刷新与注销，以及三个前端原配对和应用凭据。新增三端公钥 Cookie 会话的合成行写入与刷新读回，缺 CSRF 写入及跨库请求被拒；Studio/Web 继续实际授权库连接。Designer 保持原双库分工；这里的合成行 RPC smoke 检查不冒充完整业务建模、关系/接口、Pivot/Excel 或备份流程验收。

新恶意页面在实际 Chrome 以同站不同端口发送 fetch、预检、普通表单、opaque sandbox/null Origin 和 iframe，浏览器错误 RP 拒绝；服务端原生 HTTP 控制即使携带有效 Cookie/CSRF，错 Host、localhost 别名和 Forwarded、X-Forwarded-*、X-Real-IP、Via 仍拒绝。公开数据入口没有管理权限；拒绝有审计，原会话和未消费配对码保留。Host 重绑定是受控错误 Host/socket 验证，非实际公网 DNS 污染。CORS/CORP/嵌入及 Cookie 属性不替代后端身份、来源、CSRF 和授权校验。

本轮无产品页面布局或可见文案改动；用新候选复验已有 Designer/Studio zh/en/ja、Web en/zh-CN、宽窄屏/长文案/标签/焦点。运行手册第 17 节提供普通 PowerShell 一条命令、成功判据、产物说明、A/B 操作顺序和按现象排障；简介、使用手册、协议、方案、专项 AGENTS、测试说明及唯一台账同步，修正当前简介/手册中仍称正式页面未接入的陈旧说明。

### 实际验证

| 范围 | 结果 |
| --- | --- |
| 同一候选原生浏览器 | **9/9**：托管 2、Designer 1、本机审批 1、部署 1、公共客户端/原三端兼容 3、恶意页面 1 |
| 登录 / 动态授权 / 原认证 | **55/55、42/42、169/169** |
| 维护 / 托管 / 公共客户端 / 审批 / 部署 | **33/33、36/36、31/31、14/14、22/22**；维护含原生 Windows CLI |
| 启动与报告完整性 | **19/19** 启动兼容、**49/49** 工具、**4/4** 公共报告、**7/7** 候选/恶意页面报告检查 |
| 类型和边界 | 新 shared/Core 声明、整个 Server/严格新旧测试、三个前端完整类型、SDK DOM 无 Node 消费及 shared/SDK browser bundle 无 server/core/WebAuthn server 依赖 |
| 静态与文档 | 限定脚本 lint/格式、文档格式与链接/任务数、diff、Git 材料守卫；历史 D27 及更早 945 条证据逐字节核对 |

合计 **490/490，0 fail/skip/cancelled/todo**（481 项定向和 9 项原生）。主回归/Server 类型 Node 24.22.1；三端类型/原生浏览器 Node 24.15.0、Chrome 156 虚拟认证器。候选摘要：\`${report.candidateSha256}\`。通过候选共 ${screenshots} 张截图；自动检查现有语言、宽度、标签和焦点，实际查看代表页面核对状态层级、主题、换行和可读性。本轮不新增翻译键或样式，test/** 沿用既有 lint/格式排除，测试经过严格类型与实际执行，不声称全仓 lint/check。保留 Vite 既有大 chunk 警告。

见[验证汇总](evidence/SEC-M7-D28/verification.json)、[选择的候选](evidence/SEC-M7-D28/selected-candidate.json)、[当前候选报告](${selected.directory.slice('docs/security-v1-deliveries/'.length)}/candidate-check.json)、[候选清单](${selected.directory.slice('docs/security-v1-deliveries/'.length)}/candidate-manifest.json)及[源码/历史绑定](evidence/SEC-M7-D28/acceptance.json)。原始 TAP 和截图在同一候选目录；运行记录、命令和失败现场随 D28 保留，不改写 D27 及更早证据。

### 失败修复与限制

恶意页面首轮把 no-cors 被 Chrome CORP 直接拦截误判为必须返回 opaque，改为接受两种均不可读的浏览器结果，仍核对服务器拒绝、审计及会话/配对未改变；失败 TAP 保留。首次综合运行期间验收工具继续变化，源码冻结检查按预期以 CANDIDATE_SOURCE_CHANGED 拒绝；冻结相关代码后重跑。第二次的 Designer seed 夹具多传了 principal.create 不接受的 kind 字段，被严格 parser 正确拒绝；删去无效字段，定向写入/读回复验与完整候选重跑通过，没有放宽生产协议。证据工具早期用例未允许新候选专用 .tap 路径，后限定只允许 D28 固定六组路径并通过 42 项 receipt 测试；初轮工具输出在会话记录，最终原始工具测试完整归档。

仍未执行整仓 check、Node 22、独立性能/容量、完整新发行安装/升级降级、完整业务建模保存、实际 LAN/Hello/新双机、物理断电/磁盘耗尽或真实切换。HTTPS pin 仅作用于测试 Chrome，不安装系统信任；虚拟认证器不证明物理主机或 TPM 绑定。本轮默认服务器仍仅托管 Designer，Studio/Web 测试是合成同源静态替换，不新增生产托管路由。无依赖/锁升级，无提交、推送、部署或发布。

**DR-P3.6 完成，DR-P3 工作包完成 6/6；新增扩展 17/23，必需工作包 3/4。下一 DR-P4.1：独立接收方加密公钥关联、版本/指纹/持有证明、替换与恢复契约及本机 UI。** WebAuthn 登录私钥不用于数据解密；先冻结加密公钥与持有证明契约，再实现后续交付能力。
`;
const path = 'docs/security-v1-deliveries/SEC-M7.md', previous = readFileSync(path, 'utf8'); assert.ok(!previous.includes('## D28：'));
writeFileSync(path, previous + text);
console.log(JSON.stringify({ ok: true, screenshots, candidateSha256: report.candidateSha256 }));
