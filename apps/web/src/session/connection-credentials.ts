import { takeBrowserPairingLink } from '@mode-db/sdk';
let activeToken = '';
let pairingLaunch = takeBrowserPairingLink();
let browserSessionMode: boolean | undefined;
// A validated launcher link takes precedence over an earlier service-token preference.
if (pairingLaunch) persistBrowserSessionMode(true);
export function getPairingLaunch(): typeof pairingLaunch {
  return pairingLaunch;
}
export function clearPairingLaunch(): void {
  pairingLaunch = undefined;
}
export function isBrowserSessionMode(): boolean {
  if (browserSessionMode !== undefined) return browserSessionMode;
  try {
    return localStorage.getItem('modedb.playground.authMode') !== 'token';
  } catch {
    return true;
  }
}
export function persistBrowserSessionMode(browser: boolean): void {
  browserSessionMode = browser;
  try {
    localStorage.setItem('modedb.playground.authMode', browser ? 'browser' : 'token');
  } catch {
    /* unavailable */
  }
}

/** Drop credentials saved by older versions; keep current credentials only in memory. */
export function getConnectionToken(): string {
  try {
    localStorage.removeItem('modedb.playground.token');
  } catch {
    /* Browser storage may be disabled. */
  }
  return activeToken;
}

/** Does not write to Web Storage or embed credentials into the application build. */
export function setConnectionToken(token: string): void {
  getConnectionToken();
  activeToken = token;
}
