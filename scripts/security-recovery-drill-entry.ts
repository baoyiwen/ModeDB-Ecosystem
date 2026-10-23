import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve only the code entry identity; recovery data paths keep their stricter validation. */
export function isRecoveryDrillEntry(moduleUrl: string, argument = process.argv[1]): boolean {
  if (!argument) {
    return false;
  }
  const modulePath = realpathSync(fileURLToPath(moduleUrl));
  const entryPath = realpathSync(resolve(argument));
  return process.platform === 'win32'
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}
