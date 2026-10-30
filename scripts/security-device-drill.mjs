/** Small Node/tsx dispatcher; no builds or live configuration loading. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (/^(?:MODELDB_|MODEL_DB_|VITE_MODE_DB_|STORAGE_ROOT$|NODE_OPTIONS$)/i.test(name)) {
    delete environment[name];
  }
}
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('./security-device-drill-runner.mjs', import.meta.url)),
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', windowsHide: true, env: environment },
);
child.once('error', () => {
  process.stderr.write('DEVICE_RUNNER_UNAVAILABLE\n');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
