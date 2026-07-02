import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendPivotDrill,
  buildPivotSnapshot,
  popPivotDrill,
  csvIngestAdapter,
} from '@mode-db/data-kit';

describe('buildPivotSnapshot', () => {
  const config = {
    originModel: 'Country',
    dimensions: ['region', 'name'],
    compute: { count: 'count' as const },
  };

  it('builds analysis snapshot at top level', () => {
    const built = buildPivotSnapshot(config, []);
    assert.equal(built.isLeafGrain, false);
    assert.equal(built.snapshot.plan.trailing.type, 'group');
    assert.deepEqual(built.snapshot.analysis.groupBy, ['region', 'name']);
    assert.equal(built.snapshot.analysis.compute?.count, 'count');
  });

  it('switches to tabular leaf after full drill path', () => {
    let path = appendPivotDrill([], config, 'EU');
    path = appendPivotDrill(path, config, 'France');
    const built = buildPivotSnapshot(config, path);
    assert.equal(built.isLeafGrain, true);
    assert.equal(built.snapshot.analysis.groupBy, null);
    assert.equal(built.snapshot.plan.trailing.type, 'group');
  });

  it('popPivotDrill removes last step', () => {
    let path = appendPivotDrill([], config, 'EU');
    path = appendPivotDrill(path, config, 'France');
    assert.equal(popPivotDrill(path).length, 1);
  });
});

describe('CsvIngestAdapter', () => {
  it('streams rows from inline CSV content', async () => {
    const handle = await csvIngestAdapter.open({
      format: 'csv',
      locator: 'inline',
      options: {
        content: 'id,name\n1,Alpha\n2,Beta\n',
      },
    });
    const schema = await handle.sniffSchema(2);
    assert.equal(schema.columns.length, 2);
    const chunk1 = await handle.readChunk(1);
    assert.deepEqual(chunk1?.[0], { id: 1, name: 'Alpha' });
    const chunk2 = await handle.readChunk(5);
    assert.deepEqual(chunk2?.[0], { id: 2, name: 'Beta' });
    assert.equal(await handle.readChunk(1), null);
    handle.close();
  });
});
