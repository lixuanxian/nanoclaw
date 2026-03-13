/**
 * Copilot CLI authentication helper.
 * On Windows, extracts the OAuth token from Windows Credential Manager
 * so it can be passed to Linux containers via environment variables.
 */

import { execFile } from 'child_process';
import os from 'os';
import { logger } from './logger.js';

const PS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredManager {
    [DllImport("advapi32", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
    [DllImport("advapi32")]
    public static extern void CredFree(IntPtr cred);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags; public int Type;
        public string TargetName; public string Comment;
        public long LastWritten; public int CredentialBlobSize;
        public IntPtr CredentialBlob; public int Persist;
        public int AttributeCount; public IntPtr Attributes;
        public string TargetAlias; public string UserName;
    }
}
"@
$ptr = [IntPtr]::Zero
# Enumerate credentials matching the copilot-cli prefix
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredEnum {
    [DllImport("advapi32", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool CredEnumerateW(string filter, int flags, out int count, out IntPtr creds);
    [DllImport("advapi32")]
    public static extern void CredFree(IntPtr cred);
}
"@
$count = 0
$credsPtr = [IntPtr]::Zero
$found = [CredEnum]::CredEnumerateW("copilot-cli/*", 0, [ref]$count, [ref]$credsPtr)
if (-not $found -or $count -eq 0) {
    Write-Output "NOT_FOUND"
    exit 0
}
# Read the first matching credential
$ptrSize = [IntPtr]::Size
$firstCredPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($credsPtr)
$cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($firstCredPtr, [Type][CredManager+CREDENTIAL])
$bytes = [byte[]]::new($cred.CredentialBlobSize)
[System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
$token = [System.Text.Encoding]::UTF8.GetString($bytes)
Write-Output $token
[CredEnum]::CredFree($credsPtr)
`;

/**
 * Try to extract the Copilot CLI OAuth token from Windows Credential Manager.
 * Returns the token string or null if not found / not on Windows.
 */
export function extractCopilotToken(): Promise<string | null> {
  if (os.platform() !== 'win32') return Promise.resolve(null);

  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { timeout: 10_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          logger.debug({ err, stderr }, 'Failed to extract Copilot token from Credential Manager');
          resolve(null);
          return;
        }
        const token = stdout.trim();
        if (!token || token === 'NOT_FOUND') {
          logger.debug('No Copilot CLI credential found in Windows Credential Manager');
          resolve(null);
          return;
        }
        resolve(token);
      },
    );
  });
}

/**
 * Load Copilot CLI authentication into process.env.
 * Checks (in order): COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN env vars,
 * then falls back to extracting from Windows Credential Manager.
 */
export async function loadCopilotAuth(): Promise<void> {
  // Already have a token via env var — nothing to do
  if (
    process.env.COPILOT_GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN
  ) {
    logger.debug('Copilot auth: using existing environment variable');
    return;
  }

  const token = await extractCopilotToken();
  if (token) {
    process.env.COPILOT_GITHUB_TOKEN = token;
    logger.info(
      `Copilot auth: extracted OAuth token from Windows Credential Manager (${token.slice(0, 4)}...${token.length} chars)`,
    );
  }
}
