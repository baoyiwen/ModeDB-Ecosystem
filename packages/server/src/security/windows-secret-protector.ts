import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { VaultSecurityError } from '@mode-db/common';

/** OS protection boundary. Alternate implementations must not silently persist plaintext. */
export interface SecretProtector {
  readonly id: string;
  ensureDirectory(path: string): void;
  protect(bytes: Uint8Array, purpose: string): string;
  unprotect(ciphertext: string, purpose: string): Buffer;
}

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $r = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  if ($r.action -eq 'identity') {
    @{data=$sid.Value} | ConvertTo-Json -Compress
  } elseif ($r.action -eq 'directory') {
    if (-not [IO.Directory]::Exists($r.path)) {
      $acl = [Security.AccessControl.DirectorySecurity]::new()
      $acl.SetOwner($sid)
      $acl.SetAccessRuleProtection($true, $false)
      $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
      foreach ($who in @($sid, $system)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($who, 'FullControl', $inherit, 'None', 'Allow')
        $acl.AddAccessRule($rule)
      }
      [IO.Directory]::CreateDirectory($r.path, $acl) | Out-Null
    }
    if (([IO.File]::GetAttributes($r.path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    $acl = [IO.Directory]::GetAccessControl($r.path)
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value -and $rule.IdentityReference.Value -ne $system.Value) { throw 'permissions' }
    }
    if ($r.verifyFiles -ne 'false') { foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($r.path)) {
      $attributes = [IO.File]::GetAttributes($entry)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attributes -band [IO.FileAttributes]::Directory) -ne 0) { throw 'entry' }
      $fileAcl = [IO.File]::GetAccessControl($entry)
      if ($fileAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'file-owner' }
      foreach ($rule in $fileAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value -and $rule.IdentityReference.Value -ne $system.Value) { throw 'file-permissions' }
      }
    } }
    @{ok=$true} | ConvertTo-Json -Compress
  } else {
    [Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a') | Out-Null
    $entropy = [Text.Encoding]::UTF8.GetBytes($r.purpose)
    $bytes = [Convert]::FromBase64String($r.data)
    if ($r.action -eq 'protect') {
      $out = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    } elseif ($r.action -eq 'unprotect') {
      $out = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    } else { throw 'action' }
    @{data=[Convert]::ToBase64String($out)} | ConvertTo-Json -Compress
    [Array]::Clear($bytes, 0, $bytes.Length)
    [Array]::Clear($out, 0, $out.Length)
  }
} catch { [Console]::Error.Write('VAULT_PROTECTION_UNAVAILABLE'); exit 1 }
`;

/** Windows CurrentUser DPAPI and owner/SYSTEM-only directory DACL. */
export class WindowsSecretProtector implements SecretProtector {
  readonly id = 'windows-dpapi-current-user-v1';

  /** Verified process OS SID, used for attribution of local maintenance. */
  currentIdentity(): string {
    const sid = this.invoke({ action: 'identity' }).data!;
    if (!/^S-1-[0-9-]{1,180}$/.test(sid)) {
      throw new VaultSecurityError('VAULT_PROTECTION_UNAVAILABLE');
    }
    return sid;
  }

  ensureDirectory(path: string, verifyFiles = true): void {
    this.invoke({ action: 'directory', path, verifyFiles: String(verifyFiles) });
  }

  protect(bytes: Uint8Array, purpose: string): string {
    return this.invoke({ action: 'protect', data: Buffer.from(bytes).toString('base64'), purpose })
      .data!;
  }

  unprotect(ciphertext: string, purpose: string): Buffer {
    return Buffer.from(
      this.invoke({ action: 'unprotect', data: ciphertext, purpose }).data!,
      'base64',
    );
  }

  private invoke(request: Record<string, string>): { data?: string } {
    if (process.platform !== 'win32') {
      throw new VaultSecurityError('VAULT_PROTECTION_UNAVAILABLE');
    }
    const executable = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const result = spawnSync(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(SCRIPT, 'utf16le').toString('base64'),
      ],
      {
        input: JSON.stringify(request),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
        // The registry accepts protected files up to 32 MiB. DPAPI unprotect returns
        // base64 JSON, so its bounded stdio buffer must also cover that encoding.
        // A 1 MiB bridge buffer failed closed well below the registration limits.
        maxBuffer: 48 * 1024 * 1024,
      },
    );
    if (result.status !== 0 || result.error) {
      throw new VaultSecurityError('VAULT_PROTECTION_UNAVAILABLE');
    }
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { data?: string; ok?: boolean };
      if (request.action === 'directory' ? parsed.ok !== true : typeof parsed.data !== 'string') {
        throw new Error();
      }
      return parsed;
    } catch {
      throw new VaultSecurityError('VAULT_PROTECTION_UNAVAILABLE');
    }
  }
}
