/** DR-P4.6 client steps shared by the interactive runner and browser acceptance. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { assertProbe, saveExpression, uuidPattern } from './security-device-drill-contract.mjs';

export async function readDeviceClientStatus(page, check) {
  // The identity panel unmounts after opening a library. Only the server can
  // establish current authentication; the canvas merely identifies the editor.
  const state = await page.evaluate(`(async()=>({
    sessionStatus:(await fetch('/api/v1/security/session')).status,
    state:document.querySelector('[data-identity-state]')?.getAttribute('data-identity-state')??null,
    applicationId:document.querySelector('[data-identity-state] dd')?.textContent??null,
    editorReady:!document.querySelector('.designer-connection-flow')&&!!document.querySelector('canvas'),
    issue:document.querySelector('[data-identity-issue]')?.getAttribute('data-identity-issue')??null
  }))()`);
  if (state.applicationId && !uuidPattern.test(state.applicationId)) {
    state.applicationId = null;
  }
  state.ready = state.sessionStatus === 200;
  if (state.sessionStatus === 401) {
    if (state.state === 'pending') {
      check('formalPending');
    }
    if (state.state === 'approved') {
      check('approvalRequiresFreshLogin');
    }
  }
  if (state.ready) {
    check('formalLogin');
    if (state.editorReady) {
      check('formalLibraryOpened');
    }
  }
  return state;
}

async function probe(page, write) {
  const result = await page.evaluate(saveExpression(write));
  try {
    assertProbe(result);
  } catch {
    throw Error('DEVICE_SAVE_READBACK_OR_BOUNDARY_FAILED');
  }
}

export async function saveDeviceClient(page, check) {
  // Recheck now, even when status was never entered or an earlier login passed.
  const state = await readDeviceClientStatus(page, check);
  assert.equal(state.ready, true, 'DEVICE_LOGIN_REQUIRED_BEFORE_SAVE');
  assert.equal(state.editorReady, true, 'DEVICE_OPEN_LIBRARY_BEFORE_SAVE');
  await probe(page, true);
  check('syntheticSaveReadbackAndBoundaries');
}

export async function refreshDeviceClient(page, checks, check) {
  assert.equal(checks.syntheticSaveReadbackAndBoundaries, true, 'DEVICE_SAVE_BEFORE_REFRESH');
  const previousDocument = await page.evaluate('performance.timeOrigin');
  await page.call('Page.reload');
  // Match the formal editor's existing restore budget; synchronous registry
  // audit/OS protection and metadata loading can exceed the session-only 20s.
  const deadline = Date.now() + 120000;
  while (true) {
    let state;
    try {
      // Page.reload can return before navigation. Never accept the old document;
      // execution contexts can also disappear briefly during the real reload.
      if ((await page.evaluate('performance.timeOrigin')) !== previousDocument) {
        state = await readDeviceClientStatus(page, check);
      }
    } catch {
      // Transient navigation/network failures cannot record reloadReadback.
    }
    if (state?.ready && state.editorReady) {
      break;
    }
    assert.ok(Date.now() < deadline, 'DEVICE_EDITOR_SESSION_NOT_RESTORED');
    await delay(100);
  }
  await probe(page, false);
  check('reloadReadback');
}
