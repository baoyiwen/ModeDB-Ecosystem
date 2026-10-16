import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ModeManager,
  isQueryDesignerMode,
} from '../../apps/model-designer/src/managers/mode-manager.js';

describe('Designer editor selection', () => {
  it('keeps repeated query editor selection idempotent and notifies panel subscribers', () => {
    const modes = new ModeManager();
    let events = 0;
    modes.subscribe(() => events++);
    modes.activateQueryDesigner();
    modes.activateQueryDesigner();
    assert.equal(modes.mode, 'query-select');
    assert.equal(events, 2);
    assert.equal(isQueryDesignerMode(modes.mode), true);
  });

  it('only leaves the query editor through an explicit model mode selection', () => {
    const modes = new ModeManager();
    modes.setMode('query-preview');
    modes.activateQueryDesigner();
    assert.equal(modes.mode, 'query-select');
    modes.setMode('select');
    assert.equal(isQueryDesignerMode(modes.mode), false);
  });
});
