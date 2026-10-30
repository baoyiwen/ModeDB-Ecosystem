/** Visible isolated Chrome/Edge. Never enables a virtual WebAuthn authenticator. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function deviceBrowser(root, ticket, browser) {
  assert.ok(['chrome', 'edge'].includes(browser));
  const locations =
    browser === 'chrome'
      ? [
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        ]
      : [
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        ];
  const executable = locations.find(existsSync);
  assert.ok(executable, 'DEVICE_BROWSER_NOT_INSTALLED');
  const profile = join(root, 'profile');
  const child = spawn(
    executable,
    [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--no-proxy-server',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      `--host-resolver-rules=MAP ${ticket.rpId} ${ticket.serverAddress}`,
      `--ignore-certificate-errors-spki-list=${Buffer.from(ticket.spkiSha256, 'hex').toString('base64')}`,
      'about:blank',
    ],
    { windowsHide: false, stdio: 'ignore' },
  );
  let failed = false;
  child.on('error', () => {
    failed = true;
  });
  let socket;
  let counter = 0;
  const pending = new Map();
  try {
    const ready = join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 20000;
    while (!existsSync(ready)) {
      assert.ok(
        !failed && child.exitCode === null && Date.now() < deadline,
        'DEVICE_BROWSER_START_FAILED',
      );
      await delay(100);
    }
    const port = Number(readFileSync(ready, 'utf8').split(/\r?\n/)[0]);
    assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535 && port !== 9091);
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: 'PUT',
      signal: AbortSignal.timeout(10000),
    }).then((r) => r.json());
    const endpoint = new URL(target.webSocketDebuggerUrl);
    assert.equal(endpoint.hostname, '127.0.0.1');
    assert.equal(endpoint.port, String(port));
    socket = new WebSocket(endpoint);
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(Error('DEVICE_DEBUGGER_TIMEOUT')), 10000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          done();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          fail(Error('DEVICE_DEBUGGER_UNAVAILABLE'));
        },
        { once: true },
      );
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const item = pending.get(message.id);
      if (!item) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        item.fail(Error('DEVICE_BROWSER_COMMAND_FAILED'));
      } else {
        item.done(message.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const item of pending.values()) {
        item.fail(Error('DEVICE_BROWSER_CLOSED'));
      }
      pending.clear();
    });
    const call = (method, params = {}) =>
      new Promise((done, fail) => {
        const id = ++counter;
        const timer = setTimeout(() => {
          pending.delete(id);
          fail(Error('DEVICE_BROWSER_COMMAND_TIMEOUT'));
        }, 20000);
        pending.set(id, {
          done: (value) => {
            clearTimeout(timer);
            done(value);
          },
          fail: (error) => {
            clearTimeout(timer);
            fail(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const location = await call('Runtime.evaluate', {
        expression: 'location.origin',
        returnByValue: true,
      });
      assert.equal(location.result.value, ticket.origin, 'DEVICE_SYNTHETIC_ORIGIN_REQUIRED');
      const result = await call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      assert.ok(!result.exceptionDetails, 'DEVICE_PAGE_OPERATION_FAILED');
      return result.result.value;
    };
    await call('Runtime.enable');
    await call('Page.enable');
    const version = (await call('Browser.getVersion')).product;
    await call('Page.navigate', { url: ticket.origin + '/designer/' });
    const pageDeadline = Date.now() + 30000;
    while (true) {
      const location = await call('Runtime.evaluate', {
        expression: 'location.origin',
        returnByValue: true,
      });
      if (location.result.value === ticket.origin) {
        break;
      }
      assert.ok(Date.now() < pageDeadline, 'DEVICE_PAGE_UNAVAILABLE_CHECK_NETWORK');
      await delay(100);
    }
    assert.equal(await evaluate('isSecureContext'), true, 'DEVICE_SECURE_CONTEXT_REQUIRED');
    return {
      version,
      call,
      evaluate,
      async close() {
        try {
          await call('Browser.close');
        } catch {
          /* The operator may have closed this isolated browser. */
        }
        socket.close();
        if (child.exitCode === null) {
          child.kill();
        }
      },
    };
  } catch (error) {
    socket?.close();
    if (child.exitCode === null) {
      child.kill();
    }
    throw error;
  }
}
