import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { SecurityAuditQuery, SecurityGrant } from '@mode-db/shared';
import { SecurityError, type SecurityErrorCode } from './security-errors.js';
import { dispatchSecurityControl, type SecurityControl } from './security-control.js';
import type { SecurityRegistry } from './security-registry.js';
import { WindowsSecretProtector } from './windows-secret-protector.js';

// This fixed Windows broker enforces the pipe DACL and the impersonated OS
// identity before forwarding any operation to the Node parent over stdio.
const BROKER = String.raw`
$ErrorActionPreference = 'Stop'
try {
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class ModelDBLocalBroker {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int Length; public IntPtr Descriptor; public int Inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafePipeHandle CreateNamedPipe(string name, uint mode, uint pipeMode, uint count, uint output, uint input, uint timeout, ref SA sa);
  static string ReadLineBounded(Stream stream) {
    var data = new MemoryStream(); var one = new byte[1];
    while (data.Length < 65536) {
      var read = stream.ReadAsync(one, 0, 1);
      if (!read.Wait(5000) || read.Result != 1) throw new IOException();
      if (one[0] == 10) return new UTF8Encoding(false, true).GetString(data.ToArray());
      data.WriteByte(one[0]);
    }
    throw new IOException();
  }
  public static void Run(string name) {
    string owner = WindowsIdentity.GetCurrent().User.Value;
    var sd = new RawSecurityDescriptor("O:" + owner + "D:P(A;;GA;;;" + owner + ")(A;;GA;;;SY)");
    var descriptor = new byte[sd.BinaryLength]; sd.GetBinaryForm(descriptor, 0);
    var pin = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      while (true) {
        var sa = new SA { Length=Marshal.SizeOf(typeof(SA)), Descriptor=pin.AddrOfPinnedObject(), Inherit=0 };
        // FIRST_PIPE_INSTANCE prevents adopting a name held by another server;
        // PIPE_REJECT_REMOTE_CLIENTS rejects SMB access before impersonation.
        var handle = CreateNamedPipe(@"\\.\pipe\" + name, 0x40080003, 8, 1, 65536, 65536, 0, ref sa);
        if (handle.IsInvalid) throw new IOException();
        using (var pipe = new NamedPipeServerStream(PipeDirection.InOut, true, false, handle)) {
          Console.WriteLine("READY"); Console.Out.Flush();
          pipe.WaitForConnection();
          try {
            string request = ReadLineBounded(pipe);
            string caller = null;
            pipe.RunAsClient(() => {
              using (var identity = WindowsIdentity.GetCurrent(true)) {
                if (identity != null && identity.IsAuthenticated) caller = identity.User.Value;
              }
            });
            if (caller != owner && caller != "S-1-5-18") throw new UnauthorizedAccessException();
            Console.WriteLine(caller + ":" + Convert.ToBase64String(Encoding.UTF8.GetBytes(request))); Console.Out.Flush();
            string response = Console.ReadLine();
            if (response == null || response.Length > 131072) return;
            byte[] bytes = Encoding.UTF8.GetBytes(response + "\n");
            var write = pipe.WriteAsync(bytes, 0, bytes.Length);
            if (!write.Wait(5000)) throw new IOException();
          } catch { /* rejected client cannot reach the parent handler */ }
        }
      }
    } finally { pin.Free(); }
  }
}
'@
$config = [Console]::In.ReadLine() | ConvertFrom-Json
[ModelDBLocalBroker]::Run($config.name)
} catch { [Console]::Error.Write('SECURITY_LOCAL_CHANNEL_UNAVAILABLE'); exit 1 }
`;

/** Local-only endpoint name, stable for the configured instance directory. */
export function localManagementPipe(directory: string): string {
  const name = createHash('sha256')
    .update(resolve(directory).toLowerCase())
    .digest('hex')
    .slice(0, 32);
  return String.raw`\\.\pipe\modeldb-security-${name}`;
}

/** Defense in depth after the broker's DACL and impersonation; never accepts a SID from JSON. */
export function assertLocalSecurityCaller(caller: string, owner: string): void {
  if (!/^S-1-[0-9-]{1,180}$/.test(caller) || (caller !== owner && caller !== 'S-1-5-18')) {
    throw new SecurityError('SECURITY_LOCAL_IDENTITY_DENIED');
  }
}

/** Dispatch only supported maintenance actions; no arbitrary engine or filesystem access. */
export function dispatchLocalSecurity(
  registry: SecurityRegistry,
  input: unknown,
  browserDatabases: readonly string[] = [],
  control?: SecurityControl,
  hostedManagement?: () => string | undefined,
): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const r = input as Record<string, unknown>;
  if (typeof r.action === 'string' && r.action.startsWith('registration.')) {
    return registry.manageRegistration(input);
  }
  if (typeof r.action === 'string' && /^(network\.|maintenance\.|master\.)/.test(r.action)) {
    if (!control) {
      throw new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE');
    }
    return dispatchSecurityControl(control, input);
  }
  switch (r.action) {
    case 'browser.hosted.security.launch': {
      const origin = hostedManagement?.();
      if (!origin || Object.keys(r).some((k) => k !== 'action')) {
        throw new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE');
      }
      const paired = registry.createLocalBrowserPairing(origin, [], true, 60);
      return {
        ...paired,
        origin,
        url: origin + '/security/',
        instanceId: registry.status().instanceId,
      };
    }
    case 'browser.launch':
      if (
        r.databases !== undefined &&
        (!Array.isArray(r.databases) || r.databases.some((v) => typeof v !== 'string'))
      ) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      return registry.createLocalBrowserPairing(r.origin as string, [
        ...browserDatabases,
        ...((r.databases ?? []) as string[]),
      ]);
    case 'browser.security.launch':
      if (hostedManagement) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      if (
        r.databases !== undefined &&
        (!Array.isArray(r.databases) || r.databases.some((v) => typeof v !== 'string'))
      ) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      return registry.createLocalBrowserPairing(
        r.origin as string,
        [...browserDatabases, ...((r.databases ?? []) as string[])],
        true,
      );
    case 'status':
      return registry.status();
    case 'credentials.list': {
      const offset = r.offset ?? 0;
      const limit = r.limit ?? 25;
      if (
        !Number.isSafeInteger(offset) ||
        (offset as number) < 0 ||
        !Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > 100
      ) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      const entries = registry.listCredentials();
      const end = (offset as number) + (limit as number);
      return {
        credentials: entries.slice(offset as number, end),
        total: entries.length,
        offset,
        nextOffset: end < entries.length ? end : null,
      };
    }
    case 'audit.page':
      return registry.auditPage((r.query ?? {}) as SecurityAuditQuery);
    case 'audit.export': {
      const query = (r.query ?? {}) as SecurityAuditQuery;
      registry.recordAuditExport({ query, transport: 'local-ipc' });
      return {
        version: 1,
        exportedEvents: registry.auditPage({ ...query, offset: 0, limit: 1 }).total,
      };
    }
    case 'principal.create':
      return registry.createPrincipal(
        r.name as string,
        r.kind as 'application' | 'operator' | undefined,
      );
    case 'credential.create':
      return registry.createCredential(
        r.principalId as string,
        r.name as string,
        r.grants as readonly SecurityGrant[] | undefined,
        r.expiresInDays as number | undefined,
      );
    case 'credential.rotate':
      return registry.rotateCredential(r.id as string, r.graceMinutes as number | undefined);
    case 'credential.revoke':
      registry.revokeCredential(r.id as string);
      return { revoked: true };
    case 'session.pair':
      return registry.createPairingForCredential(
        r.credentialId as string,
        (r.lifetimeMinutes as number | undefined) ?? 10,
        r.origin as string,
      );
    case 'access.reset':
      if (r.confirm !== true) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      registry.resetAccess();
      return { reset: true };
    default:
      throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
}

/** Start a Windows OS-authenticated pipe. No TCP/loopback administrator fallback. */
export async function startLocalSecurityChannel(
  directory: string,
  registry: SecurityRegistry,
  browserDatabases: () => readonly string[] = () => [],
  control?: SecurityControl,
  hostedManagement?: () => string | undefined,
): Promise<{ close(): Promise<void> }> {
  if (process.platform !== 'win32') {
    throw new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE');
  }
  const owner = new WindowsSecretProtector().currentIdentity();
  const child = spawn(
    join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(BROKER, 'utf16le').toString('base64'),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  let closing = false;
  let ready = false;
  const startup = new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      reject(new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE'));
      child.kill();
    }, 20000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE'));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      if (!ready) {
        reject(new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE'));
      } else if (!closing) {
        registry.close();
        console.error('[ModelDB] SECURITY_LOCAL_CHANNEL_UNAVAILABLE');
      }
    });
    lines.on('line', (line) => {
      if (line === 'READY') {
        ready = true;
        clearTimeout(timer);
        done();
        return;
      }
      let response: unknown;
      const separator = line.indexOf(':');
      const caller = line.slice(0, separator);
      try {
        if (!ready || line.length > 90000 || separator < 0 || !/^S-1-[0-9-]{1,180}$/.test(caller)) {
          throw new SecurityError('SECURITY_INVALID_REQUEST');
        }
        assertLocalSecurityCaller(caller, owner);
        response = {
          ok: true,
          result: registry.withLocalActor(caller, () =>
            dispatchLocalSecurity(
              registry,
              JSON.parse(Buffer.from(line.slice(separator + 1), 'base64').toString('utf8')),
              browserDatabases(),
              control,
              hostedManagement,
            ),
          ),
        };
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          (error instanceof SecurityError &&
            ['SECURITY_INVALID_REQUEST', 'SECURITY_NOT_FOUND'].includes(error.code))
        ) {
          try {
            registry.withLocalActor(caller, () => registry.recordRejectedMaintenance());
          } catch {
            response = { ok: false, error: 'SECURITY_STORE_WRITE_FAILED' };
            child.stdin.write(JSON.stringify(response) + '\n');
            return;
          }
        }
        response = {
          ok: false,
          error: error instanceof SecurityError ? error.code : 'SECURITY_INVALID_REQUEST',
        };
      }
      const encoded = JSON.stringify(response);
      // An oversized metadata page must not terminate the maintenance broker.
      child.stdin.write(
        (Buffer.byteLength(encoded, 'utf8') > 120000
          ? JSON.stringify({ ok: false, error: 'SECURITY_RESPONSE_LIMIT' })
          : encoded) + '\n',
      );
    });
  });
  child.stdin.on('error', () => {
    /* process exit is handled above */
  });
  child.stdin.write(
    JSON.stringify({ name: localManagementPipe(directory).split('\\').at(-1) }) + '\n',
  );
  await startup;
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      if (closePromise) {
        return closePromise;
      }
      closing = true;
      lines.close();
      if (child.exitCode !== null || child.signalCode !== null) {
        closePromise = Promise.resolve();
        return closePromise;
      }
      closePromise = new Promise<void>((done) => {
        child.once('exit', () => done());
        child.kill();
      });
      return closePromise;
    },
  };
}

/** Call the OS-authenticated maintenance channel; never puts secrets in command arguments. */
export async function callLocalSecurity(directory: string, request: unknown): Promise<unknown> {
  if (process.platform !== 'win32') {
    throw new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE');
  }
  let requestLine: string;
  try {
    const encoded = JSON.stringify(request);
    if (!encoded || Buffer.byteLength(encoded, 'utf8') > 65535) {
      throw new Error();
    }
    requestLine = encoded + '\n';
  } catch {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  return new Promise((done, reject) => {
    const deadline = Date.now() + 2000;
    const attempt = (): void => {
      const socket = connect(localManagementPipe(directory));
      socket.setEncoding('utf8');
      let connected = false;
      let response = '';
      const fail = (): void => {
        socket.destroy();
        reject(new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE'));
      };
      socket.setTimeout(20000, fail);
      socket.on('error', (error: NodeJS.ErrnoException) => {
        socket.destroy();
        // The broker recreates its sole pipe instance between commands. Retry
        // only before connection; a sent mutation must never be replayed.
        if (!connected && ['ENOENT', 'EBUSY'].includes(error.code ?? '') && Date.now() < deadline) {
          setTimeout(attempt, 25);
          return;
        }
        reject(new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE'));
      });
      socket.on('connect', () => {
        connected = true;
        socket.write(requestLine);
      });
      socket.on('data', (chunk: string) => {
        response += chunk;
        if (response.length > 131072) {
          fail();
          return;
        }
        if (!response.includes('\n')) {
          return;
        }
        socket.destroy();
        try {
          const reply = JSON.parse(response) as { ok?: boolean; result?: unknown; error?: string };
          if (!reply.ok) {
            reject(new SecurityError(reply.error as SecurityErrorCode));
            return;
          }
          done(reply.result);
        } catch {
          reject(new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE'));
        }
      });
      socket.on('end', () => {
        if (!response.includes('\n')) {
          fail();
        }
      });
    };
    attempt();
  });
}
