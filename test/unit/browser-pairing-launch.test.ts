import assert from 'node:assert/strict';
import { it } from 'node:test';

const applications = [
  ['model-designer', '../../apps/model-designer/src/config/connection-prefs.ts', 'model-designer:authMode'],
  ['data-studio', '../../apps/data-studio/src/config/connection-prefs.ts', 'data-studio:authMode'],
  ['web', '../../apps/web/src/session/connection-credentials.ts', 'modedb.playground.authMode'],
] as const;
const code = 'mdbp_v1_00000000-0000-4000-8000-000000000000_' + 'a'.repeat(43);
const endpoint = 'https://db.example.test:9443';
let importId = 0;

class TestStorage {
  readonly values = new Map<string, string>();
  readBlocked = false;
  writeBlocked = false;
  getItem(key: string): string | null {
    if (this.readBlocked) throw new Error('STORAGE_UNAVAILABLE');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.writeBlocked) throw new Error('STORAGE_UNAVAILABLE');
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    if (this.writeBlocked) throw new Error('STORAGE_UNAVAILABLE');
    this.values.delete(key);
  }
}

type Preferences = typeof import('../../apps/web/src/session/connection-credentials.js');

async function withLaunch(
  path: string,
  key: string,
  hash: string,
  blocked: 'none' | 'write' | 'all',
  check: (prefs: Preferences, local: TestStorage, location: URL) => void,
): Promise<void> {
  const names = ['localStorage', 'sessionStorage', 'location', 'history'] as const;
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const local = new TestStorage();
  local.values.set(key, 'token');
  local.writeBlocked = blocked !== 'none';
  local.readBlocked = blocked === 'all';
  const location = new URL('https://designer.example.test/connect?lang=en' + hash);
  const values = [local, new TestStorage(), location, {
    state: null,
    replaceState(_state: unknown, _title: string, next: string) {
      location.href = new URL(next, location).href;
    },
  }];
  names.forEach((name, index) => Object.defineProperty(globalThis, name, {
    value: values[index], configurable: true,
  }));
  try {
    const moduleUrl = new URL(path, import.meta.url);
    moduleUrl.searchParams.set('launcher-test', String(++importId));
    const prefs = await import(moduleUrl.href) as Preferences;
    check(prefs, local, location);
  } finally {
    names.forEach((name, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

function fragment(pairingCode = code, server = endpoint): string {
  return '#' + new URLSearchParams({ 'modeldb-pair': pairingCode, 'modeldb-server': server });
}

for (const [app, path, key] of applications) {
  it(`${app}: a valid launcher overrides saved Token mode without persisting its secret`, async () => {
    await withLaunch(path, key, fragment(), 'none', (prefs, local, location) => {
      assert.equal(prefs.isBrowserSessionMode(), true);
      assert.equal(local.getItem(key), 'browser');
      assert.deepEqual(prefs.getPairingLaunch(), { code, host: endpoint, port: 9443 });
      assert.equal(location.href, 'https://designer.example.test/connect?lang=en');
      assert.ok(!JSON.stringify([...local.values]).includes(code));
      prefs.clearPairingLaunch();
      assert.equal(prefs.getPairingLaunch(), undefined);
      assert.equal(prefs.isBrowserSessionMode(), true);
      prefs.persistBrowserSessionMode(false);
      assert.equal(prefs.isBrowserSessionMode(), false);
      prefs.persistBrowserSessionMode(true);
      assert.equal(prefs.isBrowserSessionMode(), true);
    });
  });

  for (const blocked of ['write', 'all'] as const) {
    it(`${app}: launcher and explicit mode selection work with ${blocked} storage blocked`, async () => {
      await withLaunch(path, key, fragment(), blocked, (prefs, local, location) => {
        assert.equal(prefs.isBrowserSessionMode(), true);
        assert.equal(prefs.getPairingLaunch()?.code, code);
        assert.equal(location.hash, '');
        assert.equal(local.values.get(key), 'token');
        prefs.clearPairingLaunch();
        assert.equal(prefs.isBrowserSessionMode(), true);
        prefs.persistBrowserSessionMode(false);
        assert.equal(prefs.isBrowserSessionMode(), false);
        prefs.persistBrowserSessionMode(true);
        assert.equal(prefs.isBrowserSessionMode(), true);
      });
    });
  }

  for (const [name, hash] of [
    ['no launcher', ''],
    ['malformed code', fragment('invalid-pairing-code')],
    ['remote plaintext endpoint', fragment(code, 'http://db.example.test:9443')],
  ]) {
    it(`${app}: ${name} leaves the saved Token preference in place`, async () => {
      await withLaunch(path, key, hash, 'none', (prefs, local, location) => {
        assert.equal(prefs.getPairingLaunch(), undefined);
        assert.equal(prefs.isBrowserSessionMode(), false);
        assert.equal(local.getItem(key), 'token');
        assert.equal(location.hash, '');
      });
    });
  }
}
