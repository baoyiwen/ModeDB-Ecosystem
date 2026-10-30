/** Independent ESM scopes must not share Terser's variable name cache. */
import assert from 'node:assert/strict';
import { minify } from 'terser';
export async function minifyModule(source) {
  const result = await minify(source, {
    module: true,
    ecma: 2022,
    compress: { passes: 3, pure_getters: true, unsafe: false },
    mangle: { module: true, toplevel: true },
    format: { comments: false, ecma: 2022 },
  });
  assert.ok(result.code, 'RELEASE_MINIFY_FAILED');
  return result.code;
}
