/** Offline holder tool. No configuration, instance directory, network, or WebAuthn access. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import {
  recipientChallengeLabel,
  type RecipientChallenge,
} from '../packages/shared/src/recipient-keys.js';
import { answerRecipientChallenge } from '../packages/server/src/security/recipient-keys.js';
import { openMigrationKey } from '../packages/server/src/security/migration-key.js';
import { WindowsSecretProtector } from '../packages/server/src/security/windows-secret-protector.js';
import { isRecoveryDrillEntry } from './security-recovery-drill-entry.js';

function input(path: string, max: number): Buffer {
  const full = resolve(path);
  let current = parse(full).root;
  for (const part of full.slice(current.length).split(/[\\/]/)) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      throw Error();
    }
  }
  const stat = lstatSync(full);
  if (!stat.isFile() || stat.size > max) {
    throw Error();
  }
  return readFileSync(full);
}
export function recipientKeyTool(args: string[]): unknown {
  const [action, ...options] = args,
    values = new Map<string, string>();
  for (let i = 0; i < options.length; i += 2) {
    const name = options[i]!,
      value = options[i + 1];
    if (
      ![
        '--challenge',
        '--private-key',
        '--passphrase-file',
        '--output',
        '--binding-digest',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw Error();
    }
    values.set(name, value);
  }
  const file = values.get('--challenge');
  if (!file) {
    throw Error();
  }
  const challenge = JSON.parse(input(file, 4096).toString('utf8')) as RecipientChallenge;
  // Inspect only the public, bounded challenge; strict validation is repeated before decrypting.
  if (challenge.format !== 'modeldb.recipient-challenge.v1') {
    throw Error();
  }
  const binding = recipientChallengeLabel(challenge),
    digest = createHash('sha256').update(binding).digest('hex');
  if (action === 'inspect' && values.size === 1) {
    return { binding: JSON.parse(binding), bindingDigest: digest };
  }
  if (action !== 'prove' || values.size !== 5 || values.get('--binding-digest') !== digest) {
    throw Error();
  }
  const privateFile = values.get('--private-key')!,
    phraseFile = values.get('--passphrase-file')!,
    output = resolve(values.get('--output')!);
  const protector = new WindowsSecretProtector();
  protector.ensureDirectory(dirname(resolve(privateFile)));
  protector.ensureDirectory(dirname(resolve(phraseFile)));
  const phrase = input(phraseFile, 4096),
    encrypted = input(privateFile, 16384);
  try {
    const key = openMigrationKey(
      encrypted,
      phrase
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .replace(/\r?\n$/, ''),
    );
    const proof = answerRecipientChallenge(challenge, key);
    protector.ensureDirectory(dirname(output));
    writeFileSync(output, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { ok: true, output };
  } finally {
    phrase.fill(0);
    encrypted.fill(0);
  }
}
if (isRecoveryDrillEntry(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(recipientKeyTool(process.argv.slice(2)), null, 2) + '\n');
  } catch {
    process.stderr.write('SECURITY_RECIPIENT_TOOL_FAILED\n');
    process.exitCode = 1;
  }
}
