/** Finish the pending document revision only after the final frozen run succeeds. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  assertFullCheckReport,
  fullSourceSnapshot,
} from '../../../../scripts/security-full-contract.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D32/';
const full = JSON.parse(readFileSync(base + 'native/full-check.json'));
assertFullCheckReport(full);
assert.equal(full.sourceSha256, 'e54c9c92b994407c8fe9bf9e4f2e3c8960ffdbb002f39621491a49d7fd9294aa');
assert.equal(full.totalPass, 1030);
assert.deepEqual(
  fullSourceSnapshot(process.cwd()),
  JSON.parse(readFileSync(base + 'native/source-manifest.json')).sources,
);
const path = 'docs/security-v1-deliveries/SEC-M7.md';
let source = readFileSync(path, 'utf8');
const start = source.indexOf('## D32：');
assert.ok(start > 0);
const previous = source.slice(0, start);
let current = source.slice(start);
assert.ok(current.includes('64dd1ddab6bebfe732e348d9eed37d8c6aaa7cd4571492e35779319c4aeb51f8'));
current = current.replace(
  '64dd1ddab6bebfe732e348d9eed37d8c6aaa7cd4571492e35779319c4aeb51f8',
  full.sourceSha256,
);
const marker = '本轮没有页面或可见文案改造';
assert.ok(current.includes(marker));
current = current.replace(
  marker,
  '第二轮完整功能验收也是 1030/1030，但最终总证据读取白名单漏列 `test/fixtures/security-tls/localhost.crt` 和 `localhost.key` 两份仓库公开测试夹具，归档被正确拒绝。只补这两个明确路径，并补真实 certs/其他密钥路径拒绝断言；42 项工具通过。另用当前核验器在隔离副本核对第二轮原字节证据的 2306 个文件并通过，两份开发源按原摘要重建，只作元数据核验，不冒充当前源码功能验收。随后再次冻结源码，第三轮完整重跑 1030/1030 通过，才采用本节最终摘要；[第二轮报告](evidence/SEC-M7-D32/pre-final-2/full-check.json)、[原错误](evidence/SEC-M7-D32/pre-final-2/evidence-error.original.txt)、原始日志副本与元数据预检报告保留，不回写旧摘要。\n\n' +
    marker,
);
writeFileSync(path, previous + current);
const milestones = 'docs/security-v1-milestones.md';
source = readFileSync(milestones, 'utf8');
const note =
  'D32 归档复验中：1030 项功能测试已通过，但总证据工具漏列两份公开 TLS 测试夹具，已修正并重新冻结源码完整验收。最终 receipt 暂为 pending，DR-P4.4 暂不视作最终完成；当前确认计数仍为 20/23、DR-P4 3/6。下文 D32 的 21/23 为归档复验成功后的交付目标，最终通过后删除本提示。';
assert.ok(source.includes(note));
writeFileSync(milestones, source.replace(note, ''));
process.stdout.write(
  JSON.stringify({
    ok: true,
    task: full.task,
    sourceSha256: full.sourceSha256,
    totalPass: full.totalPass,
  }) + '\n',
);
