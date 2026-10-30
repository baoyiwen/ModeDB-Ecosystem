/** Update current guidance only after all candidate and regression groups pass; preserve delivery history. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D28/';
const read = path => readFileSync(path, 'utf8'), save = (path, text) => writeFileSync(path, text);
const selected = JSON.parse(read(base + 'selected-candidate.json'));
assert.equal(JSON.parse(read(selected.directory + '/candidate-check.json')).ok, true);
assert.ok(JSON.parse(read(base + 'regression-commands.json')).every(result => result.exitCode === 0));
let path = 'docs/security-v1-milestones.md', source = read(path);
source = source.split(/\r?\n/).map((line, index) => {
  if (index === 6) return line.replace('；新增扩展完成 16/23', '；D28 完成 DR-P3.6 同一候选浏览器综合验收及操作排障文档；新增扩展完成 17/23').replace('必需工作包 2/4；下一为 DR-P3.6', '必需工作包 3/4；下一为 DR-P4.1');
  if (line.startsWith('| 下一项开发任务')) return '| 下一项开发任务 | DR-P4.1：独立接收方加密公钥关联、持有证明与恢复契约及本机 UI；新增扩展 17/23 |';
  if (line.startsWith('| 已登记研发交付')) return line.replace('SEC-M7 / D27', 'SEC-M7 / D28').replace('#d27dr-p35-公共客户端与三前端兼容', '#d28dr-p36-浏览器候选综合验收与操作排障');
  if (line.startsWith('| DR-P3      |')) return line.replace('进行中（5/6）', '完成（6/6，D28）');
  if (line.startsWith('| DR-P3.6 ')) return line.replace('未开始', '完成（D28）');
  if (line.startsWith('D27 时基础')) return line.replace('D27 时', 'D28 时').replace('16/23', '17/23').replace('必需工作包完成 2/4', '必需工作包完成 3/4');
  if (line.startsWith('D09/D10 完成')) return line.replace('D27 完成 DR-P3.5，下一 DR-P3.6', 'D27 完成 DR-P3.5，D28 完成 DR-P3.6，下一 DR-P4.1');
  if (line.startsWith('S4.2、S5.1、S7.2 已分别')) return line.replace('；下一开发任务为 DR-P3.6 新候选浏览器验收与操作/排障文档', '，D28 完成 DR-P3.6；下一开发任务为 DR-P4.1 独立接收方加密公钥关联与持有证明');
  if (line.startsWith('D08 完成计划')) return line.replace('D23—D27 完成 DR-P3.1—P3.5，新增扩展为 16/23', 'D23—D28 完成 DR-P3.1—P3.6，新增扩展为 17/23');
  return line;
}).join('\n');
const milestoneNote = 'SEC-M7 / D28（2026-10-28）：完成 DR-P3.6，同一份全新三端构建通过九项原生浏览器验收，覆盖本机管理/部署/注册、公钥会话合成行写入和刷新读回、原配对/应用凭据，以及恶意页面、CSRF、null Origin、嵌入、错误 RP、Host 重绑定和代理头伪造。定向回归与原生合计 490/490、0 skip；源码/构建、类型、browser 边界和文档证据同步。新增扩展 17/23、DR-P3 6/6、必需工作包 3/4；下一 DR-P4.1。实际 Hello/新双机、完整发行安装/业务回归和独立性能仍待 DR-P4。见 [D28](security-v1-deliveries/SEC-M7.md#d28dr-p36-浏览器候选综合验收与操作排障)。\n\n';
assert.ok(!source.includes('SEC-M7 / D28（'));
source = source.replace('SEC-M7 / D27（', milestoneNote + 'SEC-M7 / D27（'); save(path, source);

path = 'docs/security-v1/AGENTS.md'; source = read(path);
source = source.replace('D27 完成 DR-P3.5 公共客户端与三前端兼容，下一 DR-P3.6 新候选浏览器验收与操作/排障文档。新增扩展当前完成 16/23', 'D27 完成 DR-P3.5 公共客户端与三前端兼容，D28 完成 DR-P3.6 同一候选综合浏览器验收与操作/排障文档，下一 DR-P4.1 独立接收方加密公钥关联、持有证明与恢复契约。新增扩展当前完成 17/23');
source = source.replace('当前完成 16/23；DR-H1', '当前完成 17/23；DR-H1').replace('必需工作包 2/4、DR-P3 为 5/6；下一 DR-P3.6', '必需工作包 3/4、DR-P3 为 6/6；下一 DR-P4.1');
source = source.replace('当前应先读 `docs/security-v1-deliveries/SEC-M7.md` 的 D27', '当前应先读 `docs/security-v1-deliveries/SEC-M7.md` 的 D28').replace('SEC-M7 / D02—D26 证据', 'SEC-M7 / D02—D27 证据');
source = source.replace('下一 DR-P3.6 新候选浏览器验收与操作/排障文档', '下一 DR-P4.1 独立接收方加密公钥关联与持有证明').replaceAll('下一 DR-P3.6', '下一 DR-P4.1');
source += '\nD28 接续边界：DR-P3.6 完成，同一份源码及全新三端产物按摘要绑定；九项原生浏览器与 481 项定向检查，合计 490/490、0 skip。三端浏览器会话可写入合成行并刷新读回，但不等于完整业务建模保存。恶意页面/表单、同站不同端口 CSRF、null Origin、嵌入、错 RP、Host 重绑定和代理头拒绝通过；继续后端校验，不把 Cookie 属性或 UI 当权限边界。入口 `node scripts/security-browser-candidate-check.mjs`，操作与排障见运行手册第 17 节；下一 DR-P4.1，先冻结独立接收方加密公钥与持有证明/恢复契约，再实现本机 UI。WebAuthn 私钥不用于数据解密；不自动迁移旧 Vault，不删除历史解密材料。实际 Hello/双机、独立性能和新发行安装仍待 DR-P4。保留 D28 失败和 D27 及之前的原字节证据；默认隔离环境，真实配置、9091、凭据/密钥、Vault/业务库、信任安装和发布切换仍须明确授权。\n'; save(path, source);

path = 'docs/security-v1/overview.md'; source = read(path).replace('更新日期：2026-10-27', '更新日期：2026-10-28');
source = source.replace('正式页面仍待开发；现有设计连接继续配对。', '正式同源页面已提供注册、Passkey 登录、申请状态及本机审批/维护；原配对和应用凭据兼容。');
source = source.replace('## 可以做什么', '当前浏览器体验已通过同一份新构建的综合验收，包括三端合成数据写入/刷新读回和恶意页面防护。用户操作与故障处理见[运行手册第 17 节](device-registration-runtime-guide.md#17-浏览器候选验收与操作排障dr-p36)。默认仅托管 Designer，Studio/Web 需管理员提供准确 HTTPS 同源部署；本轮不代表真实 Hello、局域网双机、完整业务保存或新发行安装验收。下一步独立接收方加密公钥关联，登录 Passkey 不用于数据解密。\n\n## 可以做什么'); save(path, source);
path = 'docs/security-v1/user-guide.md'; source = read(path).replace('更新日期：2026-10-27', '更新日期：2026-10-28');
source = source.replace('正式页面尚未接入。现有 Designer 操作继续按本文配对/限权凭据流程进行。', '正式同源注册/Passkey、申请状态、本机审批/维护和首次部署向导已接入，原配对/限权应用凭据兼容。综合验收命令、管理员/连接者顺序和排障见[运行手册第 17 节](device-registration-runtime-guide.md#17-浏览器候选验收与操作排障dr-p36)。'); save(path, source);
path = 'docs/security-v1-plan.md'; source = read(path); source = source.replace(/^状态：.+$/m, '状态：基础 V1 已在 D09—D11 复验恢复完成；DR-P1 注册审批、DR-P2 会话授权和 DR-P3 页面/本机管理/部署体验已完成。D28 通过同一候选浏览器综合验收与操作排障文档，新增扩展 17/23、必需工作包 3/4；下一 DR-P4.1 独立接收方加密公钥关联、持有证明与恢复契约及本机 UI。实际状态以唯一台账和最新交付证据为准；历史结果保留，不授权操作真实实例。'); save(path, source);
path = 'test/README.md'; source = read(path); source += '\n`pnpm run test:security:browser-candidate` (or `node scripts/security-browser-candidate-check.mjs`) verifies DR-P3.6 on one freshly built Designer/Studio/Web candidate. Six sequential groups contain nine required native tests for hosting, formal identity and approval, deployment, old pairing/application credentials and hostile browser origins. All three public-key sessions insert a synthetic row, reject missing CSRF/cross-database requests and read it after reload. The manifest binds development inputs and new frontend outputs, checked before and after every group; no local Vite/env, old dist, live instance or installed OS trust is used. Raw TAP, manifest, JSON and screenshots remain in a new temporary directory. Missing prerequisites, changed source/build, failures, skip, cancel or timeout fail acceptance. The hostile case uses actual Chrome fetch/forms/sandbox/frames and wrong-RP checks, plus raw socket Host/proxy controls against the native server; it is not real DNS poisoning or LAN/Hello hardware evidence. Default hosting still serves Designer only; the other apps are synthetic same-origin substitutions in this test. See [operations and troubleshooting](../docs/security-v1/device-registration-runtime-guide.md#17-浏览器候选验收与操作排障dr-p36).\n'; save(path, source);
path = 'docs/security-v1/device-registration-protocol-contract.md'; source = read(path); source += '\n## 20. DR-P3.6 候选验收与浏览器攻击边界\n\n综合验收冻结一份开发源码和三个全新前端产物，所有原生测试组使用同一候选摘要，运行期间变更拒绝。正式页面覆盖注册、明确审批、公钥登录、合成行写入与刷新读回；它不增加生产协议、页面字段、权限或托管路由。完整业务建模/保存、发行安装和实际双机认证器仍按 DR-P4 验收。\n\n恶意页面用例特意采用同站不同端口，证明 SameSite Cookie 不是唯一防线：浏览器 fetch、预检、普通表单、null Origin sandbox 和嵌入受限，后端继续校验准确 Host/Origin、Fetch Metadata、CSRF 及真实管理 socket。原生 HTTP 控制请求即使携带有效 Cookie/CSRF，也不能靠错 Host、localhost 别名或 Forwarded/X-Forwarded/X-Real-IP/Via 升为管理员。浏览器错误 RP 不产生可用证明；拒绝有审计，原会话和未消费配对码保留。Host 重绑定是受控错误 Host/socket 请求验证，不声称实际公网 DNS 污染、代理部署或硬件攻击已实测。\n'; save(path, source);
console.log(JSON.stringify({ ok: true, completedRegistrationTasks: 17, next: 'DR-P4.1' }));
