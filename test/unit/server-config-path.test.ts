import assert from 'node:assert/strict';
import { it } from 'node:test';

import { resolveModelDbConfigPathFromCli } from '../../packages/server/src/modeldb-default-home.ts';

it('reports a useful error when a shell strips separators from a Windows path', () => {
  assert.throws(
    () => resolveModelDbConfigPathFromCli('C:workspaceweb_codeModeDB-Ecosystemmodeldb.config.json'),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('invalid Windows config path') &&
      error.message.includes('use forward slashes'),
  );
});
