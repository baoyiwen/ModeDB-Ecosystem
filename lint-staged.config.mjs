import path from 'node:path';

/** Staged paths relative to repo root: skip test/ and templates/. */
function keepForLintFormat(file) {
  const rel = path.relative(process.cwd(), path.resolve(file)).replace(/\\/g, '/');
  if (rel === 'test' || rel.startsWith('test/')) {
    return false;
  }
  if (rel === 'templates' || rel.startsWith('templates/')) {
    return false;
  }
  return true;
}

/** One shell token; quote when path has spaces or quotes. */
function shellArg(f) {
  const s = String(f);
  if (/[\s"'`]/.test(s)) {
    return `"${s.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
  }
  return s;
}

export default {
  '*.{js,ts,mjs,mts}': (files) => {
    const kept = files.filter(keepForLintFormat);
    if (!kept.length) {
      return [];
    }
    const args = kept.map(shellArg).join(' ');
    return [`eslint --fix --no-warn-ignored ${args}`, `prettier --write ${args}`];
  },
  '*.{json,md}': (files) => {
    const kept = files.filter(keepForLintFormat);
    if (!kept.length) {
      return [];
    }
    return [`prettier --write ${kept.map(shellArg).join(' ')}`];
  },
};
