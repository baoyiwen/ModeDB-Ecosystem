import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as designer from '../../apps/model-designer/src/config/connection-prefs.js';
import * as studio from '../../apps/data-studio/src/config/connection-prefs.js';
import * as web from '../../apps/web/src/session/connection-credentials.js';

it('all three browser applications purge legacy secrets and keep credentials only in memory', () => {
  class TestStorage {
    readonly values = new Map<string, string>();
    getItem(key: string): string | null {
      return this.values.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
      this.values.set(key, value);
    }
    removeItem(key: string): void {
      this.values.delete(key);
    }
  }
  const previousLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const local = new TestStorage();
  const session = new TestStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: session, configurable: true });
  try {
    local.setItem('model-designer:token', 'old-designer-secret');
    session.setItem('model-designer:token', 'old-designer-session-secret');
    local.setItem('model-designer:rememberToken', '1');
    local.setItem('data-studio:token', 'old-studio-secret');
    local.setItem('modedb.playground.token', 'old-web-secret');
    assert.equal(designer.getStoredToken('build-time-secret'), '');
    assert.equal(studio.getStoredToken('build-time-secret'), '');
    assert.equal(web.getConnectionToken(), '');
    designer.persistSessionToken('memory-designer');
    studio.persistConnection('127.0.0.1', 9091, 'memory-studio');
    web.setConnectionToken('memory-web');
    assert.equal(designer.getSessionToken(), 'memory-designer');
    assert.equal(studio.getStoredToken(''), 'memory-studio');
    assert.equal(web.getConnectionToken(), 'memory-web');
    assert.ok(!JSON.stringify([...local.values, ...session.values]).includes('secret'));
    assert.ok(!JSON.stringify([...local.values, ...session.values]).includes('memory-'));
    assert.equal(local.getItem('data-studio:host'), '127.0.0.1');
    designer.persistPublicBaseUrl('https://first.example.com/');
    assert.equal(designer.getStoredPublicBaseUrl(), 'https://first.example.com');
    designer.persistPublicBaseUrl('https://second.example.com/');
    assert.equal(designer.getStoredPublicBaseUrl(), 'https://second.example.com');
    designer.persistPublicBaseUrl('');
    assert.equal(designer.getStoredPublicBaseUrl(), '');
    designer.persistPublicBaseUrl('https://user:secret@example.com/');
    assert.equal(designer.getStoredPublicBaseUrl(), '');
    designer.clearSessionToken();
    studio.clearActiveSession();
    web.setConnectionToken('');
    assert.equal(designer.getSessionToken(), null);
    assert.equal(studio.getStoredToken(''), '');
    assert.equal(web.getConnectionToken(), '');
  } finally {
    if (previousLocal) Object.defineProperty(globalThis, 'localStorage', previousLocal);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    if (previousSession) Object.defineProperty(globalThis, 'sessionStorage', previousSession);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});
