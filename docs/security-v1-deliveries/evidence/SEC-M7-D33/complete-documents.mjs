/** Update only current documentation after the independent report passes its fixed gates. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { assertPerformanceReport } from '../../../../scripts/security-performance-contract.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D33/';
const read = (path) => readFileSync(path, 'utf8');
const report = JSON.parse(read(base + 'confirmation/performance.json'));
const registration = JSON.parse(read(base + 'registration.json'));
assertPerformanceReport(report, registration);
const n = (v) => v.toFixed(3);
const edit = (path, fn) => {
  const before = read(path),
    after = fn(before);
  assert.notEqual(after, before, 'DOCUMENT_EDIT_REQUIRED: ' + path);
  writeFileSync(path, after);
};
const next = 'DR-P4.6 实际 Windows Hello/两台设备验收、最终手册与脱敏证据';
edit('docs/security-v1-milestones.md', (text) => {
  text = text.replace(
    '；新增扩展完成 21/23',
    '；D33 完成 DR-P4.5 独立性能/容量、洪泛及本机维护；新增扩展完成 22/23',
  );
  text = text.replace('；下一为 DR-P4.5。历史', '；下一为 DR-P4.6。历史');
  text = text.replace(
    '\nSEC-M7 / D32（',
    '\nSEC-M7 / D33（2026-10-28）：完成 DR-P4.5，独立 AB-BA 504 样本及满 1000 待审/48 并发拒绝确认通过；维护应用 ' +
      n(report.flood.localMutationMs) +
      'ms，48 次审计及规则确认/回滚完整。修复拒绝审计阻塞及注册到期重复提交，保留首轮 p95 超限失败和原门槛，新源码重新探索/登记/确认。253/253 定向安全、工具及原生 Chrome 通过，0 skip；限定类型、静态及文档证据同步。新增扩展 22/23、DR-P4 5/6、工作包 3/4，下一 DR-P4.6 实际 Hello/新双机。无真实环境操作或生产容量结论，见 [D33](security-v1-deliveries/SEC-M7.md#d33dr-p45-独立性能与本机修复资源保障)。\n\nSEC-M7 / D32（',
  );
  text = text.replace(/(\| 下一项开发任务 \|)[^\r\n]+/, '$1 ' + next + '；新增扩展 22/23 |');
  text = text.replace(
    '[SEC-M7 / D28](security-v1-deliveries/SEC-M7.md#d28dr-p36-浏览器候选综合验收与操作排障) |',
    '[SEC-M7 / D33](security-v1-deliveries/SEC-M7.md#d33dr-p45-独立性能与本机修复资源保障) |',
  );
  text = text.replace('进行中（4/6，D32）', '进行中（5/6，D33）');
  text = text.replace('D32 时基础 V1', 'D33 时基础 V1');
  text = text.replace('当前完成 21/23、DR-P4 为 4/6', '当前完成 22/23、DR-P4 为 5/6');
  text = text.replace(
    'D32 完成 DR-P4.4，下一 DR-P4.5。原',
    'D32 完成 DR-P4.4，D33 完成 DR-P4.5，下一 DR-P4.6。原',
  );
  text = text.replace(/(\| DR-P4\.5[^\r\n]+)进行中（D33）/, '$1完成（D33）');
  text = text.replace(
    '下一 DR-P4.5；P4.5—P4.6 未开始。',
    'D33 已完成 DR-P4.5 独立性能/容量及洪泛维护确认；下一 DR-P4.6 实际 Windows Hello/两台设备验收，仍未开始。',
  );
  text = text.replace(
    'D32 完成 DR-P4.4；下一开发任务为 DR-P4.5 独立性能/容量、注册洪泛与本机修复资源保障。',
    'D32 完成 DR-P4.4，D33 完成 DR-P4.5；下一开发任务为 ' + next + '。',
  );
  text = text.replace(
    'D32 完成 DR-P4.4，新增扩展为 21/23',
    'D32 完成 DR-P4.4，D33 完成 DR-P4.5，新增扩展为 22/23',
  );
  return text;
});
edit('docs/security-v1-plan.md', (text) =>
  text.replace(
    '新增扩展 21/23、DR-P4 4/6、必需工作包 3/4，下一 DR-P4.5 独立性能/容量、注册洪泛与本机修复资源保障。',
    'D33 完成 DR-P4.5，253/253 定向检查及独立 504 样本/洪泛维护确认通过；新增扩展 22/23、DR-P4 5/6、必需工作包 3/4，下一 ' +
      next +
      '。',
  ),
);
edit('docs/security-v1/AGENTS.md', (text) => {
  text = text.replace(
    '通过，下一 DR-P4.5。新增扩展当前完成 21/23',
    '通过，D33 完成 DR-P4.5 独立性能/容量及洪泛维护确认，下一 DR-P4.6。新增扩展当前完成 22/23',
  );
  text = text.replace('当前完成 21/23；DR-H1', '当前完成 22/23；DR-H1');
  text = text.replace('DR-P4 当前 4/6，下一 DR-P4.5。', 'DR-P4 当前 5/6，下一 DR-P4.6。');
  text = text.replace('SEC-M7.md` 的 D32，并保留', 'SEC-M7.md` 的 D33，并保留');
  return (
    text +
    '\nD33 接续边界：DR-P4.5 完成，253/253 定向安全/工具/原生 Chrome、独立 AB-BA 504 样本与原生满容量洪泛确认通过，0 skip。22/23、DR-P4 5/6、工作包 3/4，下一 DR-P4.6 实际 Windows Hello/两台设备与最终文档/证据。入口 node scripts/security-performance-check.mjs explore → register <report> → confirm <registration.json>；先读独立性能手册。原失败 p95、旧门槛和公开产物保留；修复到期事务后新源码重新探索/登记/确认，没有提高原失败门槛。每实例公共拒绝审计共用64项FIFO、逐项持久后响应；注册清理/新申请共用一次事务但保留两条审计，审计不足或写失败整体拒绝。后台仍及时处理未完成申请到期，已完成挑战垃圾随后续请求/重启回收，截止时间不延长。Server Node/tsx 源码路径及新Designer字节是本轮性能对象，CPU/RSS仅Server Node、DPAPI子进程资源未测；正常并发1、单来源洪泛48，不冒称生产/分布式或安装后压缩包性能。源码变化必须新探索，运行确认时不得并行其他验收。不重跑D32全量、六引擎或D31新安装，无页面/i18n改动及新视觉结论。下一实际双机不能用软件签名、虚拟认证器或旧恢复报告替代；真实9091/配置/密钥/Vault/业务库、信任安装、发布/切换仍需明确授权。D32及以前的下一任务为当时历史。\n'
  );
});
edit('docs/security-v1/device-registration-deployment-contract.md', (text) =>
  text.replace(
    '注册 HTTP 已实现，但尚未独立测量注册性能，也未确定最终验收门槛。',
    'DR-P4.5 / SEC-M7-D33 已完成独立性能确认，实际门槛见[登记原件](../security-v1-deliveries/evidence/SEC-M7-D33/registration.json)，结果见[确认报告](../security-v1-deliveries/evidence/SEC-M7-D33/confirmation/performance.json)。',
  ),
);
edit('docs/security-v1/overview.md', (text) =>
  text.replace(
    '新增[独立性能验证工具及操作说明]',
    'DR-P4.5 已完成 504 样本隔离独立确认及洪泛下本机维护验证，实际指标与边界见最新交付报告。新增[独立性能验证工具及操作说明]',
  ),
);
edit(
  'docs/security-v1/performance-guide.md',
  (text) =>
    text +
    '\n本轮隔离结果与原门槛见 [SEC-M7 / D33](../security-v1-deliveries/SEC-M7.md#d33dr-p45-独立性能与本机修复资源保障)；原失败及修复后探索/登记/独立确认均保留。后续设备和源码须重新探索，本轮通过不能替代目标部署测量。\n',
);
const path = 'docs/security-v1-deliveries/SEC-M7.md';
edit(path, (text) => {
  const index = text.indexOf('## D33：');
  assert.ok(index > 0);
  let section = text.slice(index);
  section = section.replace('状态：进行中，尚未据此增加完成数。', '状态：完成。');
  section = section.replace(
    '187/187 受影响安全测试、原生 Chrome 认证 1/1、最终工具/证据 61/61，共 249/249',
    '修复后 191/191 受影响安全测试、原生 Chrome 认证 1/1、最终工具/证据 61/61，共 253/253',
  );
  section = section.replace(
    '性能代码已冻结，正式探索 108 个样本和原生洪泛检查通过，已生成不可覆盖的门槛登记，正在全新实例进行 504 样本独立确认；确认未结束前不判定 DR-P4.5 完成。',
    '修复后重新冻结源码、完成 108 样本探索、独立登记门槛，再以全新实例完成 504 样本确认，全部预登记门槛通过。',
  );
  section += '\n### 最终独立确认与证据\n\n';
  section +=
    'Windows / Node ' +
    report.nodeVersion +
    '，A→B→B→A 四个独立实例，固定1000行、正常并发1、每块2次查询预热；A为registry API凭据、B为软件WebAuthn真实签名及Cookie/CSRF。Server由独立Node/tsx加载冻结源码、Designer全新构建，不表示安装后压缩包性能。全部504样本业务结果成功，失败率0；另有48个预期拒绝，不计作业务失败。下面为毫秒，门槛顺序为客户端/服务端；完整TLS/队列/保护器/验签/资源分布及max在原JSON。\n\n';
  section +=
    '| 场景 | 样本 | 客户端 p50 | 客户端 p95 | 服务端 p95 | 登记 p95 门槛 |\n| --- | --- | --- | --- | --- | --- |\n';
  for (const [key, row] of Object.entries(report.summary))
    section +=
      '| ' +
      key +
      ' | ' +
      row.count +
      ' | ' +
      n(row.clientMs.p50) +
      ' | ' +
      n(row.clientMs.p95) +
      ' | ' +
      n(row.serverMs.p95) +
      ' | ' +
      registration.limits[key].clientP95Ms +
      '/' +
      registration.limits[key].serverP95Ms +
      ' |\n';
  const max = (key) => Math.max(...report.samples.map((s) => s[key]));
  section +=
    '\n服务端Node RSS高水位 ' +
    n(max('nodeRssMiB')) +
    'MiB，单样本Node CPU最大 ' +
    n(max('nodeCpuMs')) +
    'ms，正常证明队列最大 ' +
    n(max('queueMs')) +
    'ms，均低于1024MiB/10000ms/1000ms。保护器子进程墙钟已计入请求，子进程CPU/RSS未测，不声称整机资源容量。\n\n';
  section +=
    '原生满1000待审、48单来源并发拒绝，至少一个已响应且其余仍在途时经真实Named Pipe应用预览的回环来源规则，耗时 ' +
    n(report.flood.localMutationMs) +
    'ms（上限15000ms）；48次拒绝审计计数准确，全部完成、无意外响应；最长请求 ' +
    n(report.flood.maxRequestMs) +
    'ms（上限60000ms），Node RSS ' +
    n(report.flood.nodeRssMiB) +
    'MiB，之后确认并回滚，配置与原值一致。4执行/32排队/第37拒绝另用明确标注合成AES-GCM保护器及受控验签检查，不冒称原生36认证器性能。\n\n';
  section +=
    '最终源码 SHA-256 `' +
    report.sourceSha256 +
    '`；[探索报告](evidence/SEC-M7-D33/exploration/performance.json)、[门槛登记](evidence/SEC-M7-D33/registration.json)、[最终确认](evidence/SEC-M7-D33/confirmation/performance.json)、源码/公开页面清单、四块样本与原日志同目录归档，接续D32以前1666条历史证据原字节；`verification.json`/`acceptance.json`绑定最终开发与公开证据，总核验不重跑实例。不归档实例/私钥/口令，限定文档/链接/任务计数/格式/diff及材料守卫通过。\n\n';
  section +=
    '首次正式确认失败后没有提高其门槛、删慢样本或重试原失败；修复到期事务后从新源码探索重新登记。旧registrationStart门槛1500ms、static门槛500ms保留于pre-expiry-repair，最终数值独立按固定规则由新探索生成。早期开发工具问题包括DNS回调、plan trailing、保存授权、begin状态码、IPC观测等待及审计选择器，均修正并保留失败报告；IPC观测等待不混入HTTP计时。限定lint发现单行if缺花括号，修正后通过，未改变行为。\n\n';
  section +=
    '没有运行D32全量1030项/六引擎、新七包安装、Node22、实际LAN/Hello/新双机、物理磁盘耗尽/硬件断电、真实迁移/切换或旧Vault转换；不以本轮秒级结果宣称低延迟、高并发、分布式攻击或生产SLA。实际设备与浏览器用户确认时间未测。本轮无页面或可见翻译修改，不声称新增视觉/i18n验收。\n\n';
  section +=
    '**DR-P4.5 完成；新增扩展22/23、DR-P4为5/6、必需工作包仍3/4。下一DR-P4.6：实际Windows Hello/两台设备注册—批准—登录—刷新—保存—停用—重启拒绝及丢失/断网/恢复验收与最终文档。** 默认隔离环境，真实材料、信任、发布与切换须明确授权。\n';
  return text.slice(0, index) + section;
});
process.stdout.write(JSON.stringify({ ok: true, completed: '22/23', next: 'DR-P4.6' }) + '\n');
