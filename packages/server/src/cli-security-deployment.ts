import { initializeDeployment, finalizeDeployment } from './security/deployment-files.js';
import { SecurityError } from './security/security-errors.js';

/** Dispatched before the ordinary config loader; no implicit current-instance access. */
export function runDeploymentCli(argv: string[]): void {
  const init = argv[0] === 'deployment-init';
  if (!init && argv[0] !== 'deployment-finalize') {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const values = new Map<string, string>();
  let yes = false;
  const allowed = init ? ['--target', '--designer', '--port'] : ['--target', '--plan', '--digest'];
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--yes' && !yes) {
      yes = true;
      continue;
    }
    if (!allowed.includes(key) || values.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    values.set(key, argv[++i]);
  }
  if (!yes) {
    throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
  }
  if (
    !values.has('--target') ||
    (init ? !values.has('--designer') : !values.has('--plan') || !values.has('--digest'))
  ) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const result = init
    ? initializeDeployment(
        values.get('--target')!,
        values.get('--designer')!,
        Number(values.get('--port') ?? '9090'),
      )
    : finalizeDeployment(values.get('--target')!, values.get('--plan')!, values.get('--digest')!);
  process.stdout.write(JSON.stringify({ ok: true, action: argv[0], ...result }) + '\n');
}
