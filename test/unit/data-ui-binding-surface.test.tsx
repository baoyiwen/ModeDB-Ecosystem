import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import {
  createBindingSurfaceSession,
  type BindingSurfaceExecutor,
  type PublishedBindingSurfaceContract,
} from '@mode-db/data-kit';
import type { WireBindingSurfaceResult } from '@mode-db/shared';
import { BindingSurfaceForm } from '../../packages/data-ui/dist/components/binding-surface-form.js';
import { BindingSurfaceRelationEditor } from '../../packages/data-ui/dist/components/binding-surface-relation-editor.js';
import { BindingSurfaceTable } from '../../packages/data-ui/dist/components/binding-surface-table.js';
import { BindingSurfaceProvider } from '../../packages/data-ui/dist/context/binding-surface-context.js';

const require = createRequire(import.meta.url);
const { createElement } = require('../../packages/data-ui/node_modules/react') as {
  createElement(type: unknown, props: unknown, ...children: unknown[]): unknown;
};
const { renderToStaticMarkup } = require('../../packages/data-ui/node_modules/react-dom/server') as {
  renderToStaticMarkup(node: unknown): string;
};

describe('Data UI Binding Surface components', () => {
  it('renders explicit table, form, delete, and relation routes from the contract', () => {
    const markup = renderSurface(bindingSurfaceContract());

    assert.match(markup, /name row 1/);
    assert.match(markup, />Save</);
    assert.match(markup, />Delete</);
    assert.match(markup, /Service line/);
    assert.match(markup, />Bind</);
    assert.match(markup, /Related record/);
  });

  it('does not expose mutation controls for a readonly contract', () => {
    const contract: PublishedBindingSurfaceContract = {
      ...bindingSurfaceContract(),
      writeback: { mode: 'readonly', refresh: 'manual', mutations: [] },
    };
    const markup = renderSurface(contract);

    assert.match(markup, />First</);
    assert.doesNotMatch(markup, />Save</);
    assert.doesNotMatch(markup, />Delete</);
    assert.match(markup, /No relationship operations/);
  });
});

function renderSurface(contract: PublishedBindingSurfaceContract): string {
  const executor: BindingSurfaceExecutor = {
    async invokeBindingSurface() {
      return readResult();
    },
  };
  const session = createBindingSurfaceSession({
    surfaceId: contract.surfaceId,
    executor,
    initialResult: readResult(),
  });
  return renderToStaticMarkup(
    createElement(
      BindingSurfaceProvider,
      { contract, session, autoRefresh: false },
      createElement(BindingSurfaceTable, {
        labels: { remove: 'Delete' },
      }),
      createElement(BindingSurfaceForm, {
        fieldLabels: { name: 'Name' },
        labels: { remove: 'Delete record' },
      }),
      createElement(BindingSurfaceRelationEditor, {
        edgeLabels: { edge_service_line: 'Service line' },
      }),
    ),
  );
}

function bindingSurfaceContract(): PublishedBindingSurfaceContract {
  const operation = {
    interfaceId: 'operation_item',
    callableName: 'mutateItem',
    version: '1.0.0',
  };
  return {
    format: 1,
    surfaceId: 'item-editor',
    name: 'Item editor',
    version: '1.0.0',
    parameters: [],
    query: {
      interfaceId: 'query_items',
      callableName: 'items',
      version: '1.0.0',
      parameterBindings: [],
    },
    writeback: {
      mode: 'explicit',
      refresh: 'afterMutation',
      mutations: [
        {
          id: 'update-name',
          trigger: { kind: 'update', fieldPath: 'name' },
          operation: { ...operation, operationType: 'update' },
          parameterBindings: [
            { parameterId: 'id', source: { kind: 'rowRecordRef', nodeId: 'node_item' } },
            { parameterId: 'name', source: { kind: 'editedValue' } },
          ],
        },
        {
          id: 'delete-item',
          trigger: { kind: 'delete', nodeId: 'node_item' },
          operation: { ...operation, operationType: 'delete' },
          parameterBindings: [
            { parameterId: 'id', source: { kind: 'rowRecordRef', nodeId: 'node_item' } },
          ],
        },
        {
          id: 'bind-line',
          trigger: { kind: 'bind', edgeId: 'edge_service_line' },
          operation: { ...operation, operationType: 'bind' },
          parameterBindings: [
            { parameterId: 'item', source: { kind: 'rowRecordRef', nodeId: 'node_item' } },
            { parameterId: 'line', source: { kind: 'editedValue' } },
          ],
        },
      ],
    },
  };
}

function readResult(): WireBindingSurfaceResult {
  return {
    kind: 'bindingSurface',
    surfaceId: 'item-editor',
    version: '1.0.0',
    action: 'read',
    status: 'success',
    query: {
      kind: 'interface',
      callableName: 'items',
      version: '1.0.0',
      rows: [
        {
          $recordRef: { nodeId: 'node_item', model: 'Item', id: 'item-1' },
          name: 'First',
        },
      ],
    },
  };
}
