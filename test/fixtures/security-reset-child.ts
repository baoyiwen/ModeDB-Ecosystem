import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { SecurityMaintenance } from '../../packages/server/src/security/security-maintenance.js';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import { resumeFactoryReset } from '../../packages/server/src/security/reset-recovery.js';

const [action, root, point] = process.argv.slice(2);
const protector = {
  id: 'synthetic-test-only',
  ensureDirectory(path: string) {
    mkdirSync(path, { recursive: true });
  },
  protect(bytes: Uint8Array) {
    return Buffer.from(bytes).toString('base64');
  },
  unprotect(text: string) {
    return Buffer.from(text, 'base64');
  },
};
if (action === 'reset') {
  const directory = join(root, 'security'),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'synthetic.txt'), 'synthetic recovery data');
  const registry = SecurityRegistry.open(directory, { protector });
  const maintenance = new SecurityMaintenance(
    registry,
    new LocalVaultKeyProvider(directory, protector),
    directory,
    workspace,
    protector,
  );
  maintenance.factoryReset(
    { instanceId: registry.status().instanceId, target: workspace, yes: true },
    (at) => {
      if (at === point) process.exit(47);
    },
  );
} else if (action === 'resume') {
  const input = JSON.parse(point);
  resumeFactoryReset(input, protector, (at) => {
    if (at === process.argv[5]) process.exit(48);
  });
} else throw new Error('INVALID_SYNTHETIC_ACTION');
