/** Preserve original checks and verify the expiry-transaction repair before refreezing. */
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D33/';
const original = JSON.parse(readFileSync(base + 'checks.json'));
writeFileSync(base + 'pre-expiry-repair-checks.json', JSON.stringify(original, null, 2) + '\n', {
  flag: 'wx',
});
const results = [...original];
for (const name of [
  'tools-final',
  'affected',
  'browser',
  'types',
  'lint',
  'format',
  'final-lint',
]) {
  const previous = results.find((row) => row.name === name);
  const args = previous.command.slice(1);
  if (['lint', 'final-lint', 'format'].includes(name))
    args.push('packages/server/src/security/security-registry.ts');
  const log = 'expiry-repair-' + name + '.original.txt';
  const stream = createWriteStream(base + log, { flags: 'wx' });
  const child = spawn(process.execPath, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 600000);
  const exitCode = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  }).finally(() => clearTimeout(timer));
  await new Promise((done) => stream.end(done));
  results.splice(
    results.findIndex((row) => row.name === name),
    1,
    { name, command: [process.execPath, ...args], exitCode, timedOut, log },
  );
  writeFileSync(base + 'checks.json', JSON.stringify(results, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ name, exitCode, timedOut }) + '\n');
  if (exitCode !== 0 || timedOut) {
    process.exitCode = 1;
    break;
  }
}
