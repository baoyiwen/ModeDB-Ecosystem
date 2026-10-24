import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket as WebSocketType } from 'ws';
const { WebSocket } = (await import(
  new URL('../../packages/server/node_modules/ws/wrapper.mjs', import.meta.url).href
)) as typeof import('ws');

export const browserPath =
  process.env.MODELDB_TEST_BROWSER ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 30000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(100);
  }
  throw new Error('ASSET_BROWSER_TIMEOUT');
}
export async function serveDesigner() {
  const root = process.env.MODELDB_TEST_APP_ROOT
    ? resolve(process.env.MODELDB_TEST_APP_ROOT, 'model-designer')
    : fileURLToPath(new URL('../../apps/model-designer/dist/', import.meta.url));
  assert.ok(existsSync(join(root, 'index.html')));
  const server = createServer((request, response) => {
    void (async () => {
      const path = resolve(root, '.' + new URL(request.url ?? '/', 'http://local').pathname);
      const target = path === resolve(root) ? join(root, 'index.html') : path;
      if (!target.startsWith(resolve(root) + sep)) {
        response.writeHead(403).end();
        return;
      }
      try {
        const body = await readFile(target);
        response
          .writeHead(200, {
            'content-type':
              (
                { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' } as Record<
                  string,
                  string
                >
              )[extname(target)] ?? 'application/octet-stream',
          })
          .end(body);
      } catch {
        response.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
export class BrowserPage {
  private counter = 0;
  private pending = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
  readonly exceptions: string[] = [];
  constructor(private socket: WebSocketType) {
    socket.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.id) {
        const item = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) item?.fail(new Error('ASSET_BROWSER_PROTOCOL_ERROR'));
        else item?.done(message.result);
      } else if (message.method === 'Runtime.exceptionThrown')
        this.exceptions.push(message.params.exceptionDetails.text);
    });
  }
  call(method: string, params: object = {}): Promise<any> {
    const id = ++this.counter;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error('ASSET_BROWSER_COMMAND_TIMEOUT:' + method));
      }, 15000);
      this.pending.set(id, {
        done: (value) => {
          clearTimeout(timer);
          done(value);
        },
        fail: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(response.exceptionDetails, undefined, 'Browser evaluation failed');
    return response.result.value as T;
  }
  close() {
    this.socket.close();
  }
}
export async function startBrowser(root: string) {
  const profile = join(root, 'browser-profile');
  const chrome = spawn(
    browserPath,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  try {
    await waitFor(async () => existsSync(join(profile, 'DevToolsActivePort')), Boolean, 15000);
    const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
    const target = (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: 'PUT',
    }).then((r) => r.json())) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((done, fail) => {
      socket.once('open', done);
      socket.once('error', fail);
    });
    const page = new BrowserPage(socket);
    await page.call('Runtime.enable');
    await page.call('Page.enable');
    return { page, chrome };
  } catch (error) {
    chrome.kill();
    throw error;
  }
}
