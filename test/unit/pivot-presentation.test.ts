import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_PIVOT_VIEW,
  DEFAULT_PIVOT_LANGUAGE,
  buildInterfacePivotSchema,
  buildModelPivotSchema,
  buildPivotModelFieldPolicy,
  buildPivotTable,
  formatPivotValue,
  normalizePivotResult,
  queryModelPivot,
  resolvePivotLabel,
  resolvePivotPathLabel,
} from '../../apps/model-designer/src/pivot/index.js';
import { customerOrdersQueryFixture } from '../../apps/model-designer/src/query-designer/fixtures.js';
import {
  collectPivotExpandableRowIds,
  resolvePivotColumnAlignment,
  type PivotTableData,
} from '../../apps/model-designer/src/pivot/presentation.js';
import type { QueryInterfaceRelease } from '../../apps/model-designer/src/query-designer/query-interface-publication.js';
import type {
  EngineModelNode,
  EngineRelationEdge,
} from '../../apps/model-designer/src/types/engine-schema.js';

const models: EngineModelNode[] = [
  {
    id: 'division',
    model_name: 'AdministrativeDivision',
    parent_id: null,
    name_i18n: { zh: '行政区', en: 'Division', ja: '行政区画' },
    props_objects_array: [
      {
        id: 'name',
        name: 'name',
        name_i18n: { zh: '名称', en: 'Name', ja: '名前' },
        type: 'I18N',
        is_primary: false,
        encrypt_level: 0,
        metadata: {},
      },
      {
        id: 'code',
        name: 'code',
        name_i18n: { zh: '代码', en: 'Code', ja: 'コード' },
        type: 'String',
        is_primary: false,
        encrypt_level: 0,
        metadata: {},
      },
    ],
  },
  {
    id: 'station',
    model_name: 'Station',
    parent_id: null,
    name_i18n: { zh: '车站', en: 'Station', ja: '駅' },
    props_objects_array: [
      {
        id: 'station_name',
        name: 'name',
        name_i18n: { zh: '站名', en: 'Station name', ja: '駅名' },
        type: 'I18N',
        is_primary: false,
        encrypt_level: 0,
        metadata: {},
      },
    ],
  },
];
const relations: EngineRelationEdge[] = [
  {
    id: 'division_children',
    source_model_id: 'division',
    target_model_id: 'division',
    kind: 'modelLinksOut',
    forward_name: 'children',
    reverse_name: 'parent',
    forward_name_i18n: { zh: '下级行政区', en: 'Child divisions', ja: '下位行政区画' },
    reverse_name_i18n: { zh: '上级行政区', en: 'Parent division', ja: '上位行政区画' },
  },
  {
    id: 'station_division',
    source_model_id: 'station',
    target_model_id: 'division',
    kind: 'modelLinksOut',
    forward_name: 'division',
    reverse_name: 'stations',
    forward_name_i18n: { zh: '所属行政区', en: 'Division', ja: '所属行政区画' },
    reverse_name_i18n: { zh: '所属车站', en: 'Stations', ja: '所属駅' },
  },
];

function releaseFixture(): QueryInterfaceRelease {
  const asset = structuredClone(customerOrdersQueryFixture);
  asset.designGraph = {
    rootNodeId: 'root',
    nodes: [
      { id: 'root', modelId: 'division', alias: 'root', role: 'root' },
      { id: 'child', modelId: 'division', alias: 'child', role: 'joined' },
      { id: 'grandchild', modelId: 'division', alias: 'grandchild', role: 'joined' },
      { id: 'station', modelId: 'station', alias: 'station', role: 'joined' },
      { id: 'parent', modelId: 'division', alias: 'parent', role: 'joined' },
    ],
    edges: [
      {
        id: 'child-edge',
        relationId: 'division_children',
        fromNodeId: 'root',
        toNodeId: 'child',
        alias: 'subregions',
        required: false,
        cardinality: 'many',
        traversal: 'forward',
      },
      {
        id: 'grandchild-edge',
        relationId: 'division_children',
        fromNodeId: 'child',
        toNodeId: 'grandchild',
        alias: 'descendants',
        required: false,
        cardinality: 'many',
        traversal: 'forward',
      },
      {
        id: 'station-edge',
        relationId: 'station_division',
        fromNodeId: 'grandchild',
        toNodeId: 'station',
        alias: 'stops',
        required: false,
        cardinality: 'many',
        traversal: 'reverse',
      },
      {
        id: 'parent-edge',
        relationId: 'division_children',
        fromNodeId: 'root',
        toNodeId: 'parent',
        alias: 'ancestor',
        required: false,
        cardinality: 'one',
        traversal: 'reverse',
      },
    ],
  };
  asset.query.rootNodeId = 'root';
  asset.query.projection.fields = [
    {
      id: 'root-name',
      source: { nodeId: 'root', modelId: 'division', fieldId: 'name' },
      outputName: 'divisionTitle',
      visible: true,
    },
    {
      id: 'child-code',
      source: { nodeId: 'child', modelId: 'division', fieldId: 'code' },
      outputName: 'childCode',
      visible: true,
    },
    {
      id: 'grandchild-name',
      source: { nodeId: 'grandchild', modelId: 'division', fieldId: 'name' },
      outputName: 'title',
      visible: true,
    },
    {
      id: 'station-name',
      source: { nodeId: 'station', modelId: 'station', fieldId: 'station_name' },
      outputName: 'title',
      visible: true,
    },
    {
      id: 'parent-code',
      source: { nodeId: 'parent', modelId: 'division', fieldId: 'code' },
      outputName: 'parentCode',
      visible: true,
    },
    {
      id: 'hidden-code',
      source: { nodeId: 'root', modelId: 'division', fieldId: 'code' },
      outputName: 'hiddenCode',
      visible: false,
    },
  ];
  return {
    version: '1.0.0',
    publishedAt: '2026-10-14T00:00:00.000Z',
    callableName: 'divisions',
    signature: 'test',
    queryInterface: asset,
    executionTemplate: {
      format: 1,
      snapshot: {} as QueryInterfaceRelease['executionTemplate']['snapshot'],
      parameters: [],
      pagination: { mode: 'none' },
      resultAdapter: {
        kind: 'rows',
        rootNodeId: 'root',
        fieldsByNode: {
          root: [{ sourceField: 'name', outputName: 'divisionTitle' }],
          child: [{ sourceField: 'code', outputName: 'childCode' }],
          grandchild: [{ sourceField: 'name', outputName: 'title' }],
          station: [{ sourceField: 'name', outputName: 'title' }],
          parent: [{ sourceField: 'code', outputName: 'parentCode' }],
        },
        edgesBySource: {
          root: [
            { toNodeId: 'child', relationName: 'subregions', outputName: 'subregions' },
            { toNodeId: 'parent', relationName: 'ancestor', outputName: 'ancestor' },
          ],
          child: [
            { toNodeId: 'grandchild', relationName: 'descendants', outputName: 'descendants' },
          ],
          grandchild: [{ toNodeId: 'station', relationName: 'stops', outputName: 'stops' }],
        },
      },
    },
  };
}

function nestedDocument() {
  return normalizePivotResult({
    source: { kind: 'interface', callableName: 'divisions', version: '1.0.0' },
    rows: [
      {
        divisionTitle: { zh: '中国', en: 'China', ja: '中国' },
        hiddenCode: 'hidden',
        $recordRef: { id: 'private' },
        subregions: [
          {
            childCode: 'CN-31',
            descendants: [
              {
                title: { zh: '浦东', en: 'Pudong', ja: '浦東' },
                stops: [{ title: { zh: '北站', en: 'North', ja: '北駅' }, _id: 'internal' }],
              },
            ],
          },
        ],
        ancestor: { parentCode: 'WORLD' },
      },
    ],
  });
}

describe('Pivot composite table presentation', () => {
  it('aligns numeric headers and empty cells by column without treating codes as numbers', () => {
    const table: PivotTableData = {
      id: 'alignment',
      node: {
        id: 'root',
        modelId: 'root',
        label: { name: 'Root' },
        relations: [],
        columns: [
          { id: 'code', outputName: 'code', label: { name: 'Code' }, type: 'String' },
          { id: 'order', outputName: 'order', label: { name: 'Order' }, type: 'Int' },
          { id: 'start', outputName: 'start', label: { name: 'Start' }, type: 'Number' },
          { id: 'end', outputName: 'end', label: { name: 'End' }, type: 'number' },
          { id: 'count', outputName: 'count', label: { name: 'Count' } },
          { id: 'mixed', outputName: 'mixed', label: { name: 'Mixed' } },
          { id: 'empty', outputName: 'empty', label: { name: 'Empty' } },
        ],
      },
      rows: [
        { id: 'a', raw: {}, children: [], values: ['001', 1, null, 0, null, 'UP', null] },
        { id: 'b', raw: {}, children: [], values: ['002', 2, undefined, 55, 6, 3, undefined] },
      ],
    };
    assert.deepEqual(
      table.node.columns.map((_, index) => resolvePivotColumnAlignment(table, index)),
      ['left', 'right', 'right', 'right', 'right', 'left', 'left'],
    );
    assert.equal(resolvePivotColumnAlignment({ ...table, rows: [] }, 1), 'right');
    assert.equal(resolvePivotColumnAlignment({ ...table, rows: [] }, 4), 'left');
  });

  it('collects only relation-bearing rows for expand/collapse controls across all levels', () => {
    const schema = buildInterfacePivotSchema(releaseFixture(), models, relations);
    const table = buildPivotTable(nestedDocument(), schema)!;
    const ids = collectPivotExpandableRowIds(table);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids[0], table.rows[0]!.id);
    assert.equal(ids[2], table.rows[0]!.children[0]!.rows[0]!.children[0]!.rows[0]!.id);
    assert.deepEqual(collectPivotExpandableRowIds(table.rows[0]!.children[1]!), []);
  });
  it('defaults to table and current language', () => {
    assert.equal(DEFAULT_PIVOT_VIEW, 'table');
    assert.equal(DEFAULT_PIVOT_LANGUAGE, 'current');
  });

  it('keeps independent projections for repeated models, self-relations, and later joins', () => {
    const document = nestedDocument();
    const schema = buildInterfacePivotSchema(releaseFixture(), models, relations);
    const table = buildPivotTable(document, schema)!;
    assert.deepEqual(
      table.node.columns.map((column) => column.outputName),
      ['divisionTitle'],
    );
    const child = table.rows[0]!.children[0]!;
    const grandchild = child.rows[0]!.children[0]!;
    const station = grandchild.rows[0]!.children[0]!;
    assert.deepEqual(
      child.node.columns.map((column) => column.outputName),
      ['childCode'],
    );
    assert.deepEqual(
      grandchild.node.columns.map((column) => column.outputName),
      ['title'],
    );
    assert.equal(resolvePivotLabel(grandchild.node.columns[0]!.label, 'zh'), '名称');
    assert.equal(resolvePivotLabel(station.node.columns[0]!.label, 'zh'), '站名');
    assert.equal(resolvePivotLabel(station.relation!.label, 'zh'), '所属车站');
    assert.equal(
      resolvePivotLabel(table.rows[0]!.children[1]!.relation!.label, 'zh'),
      '上级行政区',
    );
    assert.deepEqual(table.rows[0]!.children[1]!.rows[0]!.values, ['WORLD']);
    assert.strictEqual(table.rows[0]!.raw, document.rawRows[0]);
    assert.strictEqual(station.rows[0]!.values[0], station.rows[0]!.raw.title);
  });

  it('resolves localized hierarchy labels by node path and ignores array indexes', () => {
    const schema = buildInterfacePivotSchema(releaseFixture(), models, relations);
    const path = ['subregions', '0', 'descendants', '0', 'stops', '0', 'title'].map((key) => ({
      key,
      kind: key === '0' ? ('index' as const) : ('field' as const),
    }));
    assert.equal(resolvePivotPathLabel(schema, path, 'zh'), '站名');
    assert.equal(resolvePivotPathLabel(schema, path.slice(0, -2), 'ja'), '所属駅');
  });

  it('retains empty relationships and nodes without selected fields', () => {
    const release = releaseFixture();
    if (release.executionTemplate.resultAdapter.kind !== 'rows') throw new Error('Expected rows');
    const schema = buildInterfacePivotSchema(
      {
        ...release,
        executionTemplate: {
          ...release.executionTemplate,
          resultAdapter: {
            ...release.executionTemplate.resultAdapter,
            fieldsByNode: { root: release.executionTemplate.resultAdapter.fieldsByNode.root! },
          },
        },
      },
      models,
      relations,
    );
    const doc = normalizePivotResult({
      source: { kind: 'interface', callableName: 'divisions', version: '1' },
      rows: [{ divisionTitle: 'A', subregions: [{}], ancestor: [] }],
    });
    const table = buildPivotTable(doc, schema)!;
    assert.equal(table.rows[0]!.children[0]!.node.columns.length, 0);
    assert.equal(table.rows[0]!.children[0]!.rows.length, 1);
    assert.equal(table.rows[0]!.children[1]!.rows.length, 0);
  });

  it('localizes i18n as one cell and preserves raw/all values and structured JSON', () => {
    const value = { zh: '名称', en: 'Name', ja: '名前' };
    assert.equal(formatPivotValue(value, 'en', 'current', 'I18N'), 'Name');
    assert.equal(
      formatPivotValue({ 'zh-CN': '名称', en: 'Name' }, 'zh', 'current', 'I18N'),
      '名称',
    );
    assert.equal(formatPivotValue(value, 'ja', 'current', 'JSON'), JSON.stringify(value, null, 2));
    assert.equal(formatPivotValue(value, 'zh', 'raw', 'I18N'), JSON.stringify(value, null, 2));
    assert.equal(formatPivotValue(value, 'zh', 'all', 'I18N'), JSON.stringify(value, null, 2));
    assert.equal(formatPivotValue({}, 'zh', 'current', 'I18N'), '');
    assert.equal(formatPivotValue(null, 'zh', 'current'), 'null');
    assert.equal(formatPivotValue(undefined, 'zh', 'current'), 'undefined');
    assert.equal(value.en, 'Name');
  });

  it('uses the published adapter output keys and falls back when model metadata is missing', () => {
    const release = releaseFixture();
    const schema = buildInterfacePivotSchema(release, [], []);
    const table = buildPivotTable(nestedDocument(), schema)!;
    assert.equal(table.node.columns[0]!.outputName, 'divisionTitle');
    assert.equal(resolvePivotLabel(table.node.columns[0]!.label, 'zh'), 'divisionTitle');
    assert.equal(table.rows[0]!.children[0]!.relation!.path[0], 'subregions');
    assert.equal(
      resolvePivotLabel(table.rows[0]!.children[0]!.relation!.label, 'zh'),
      'subregions',
    );
  });

  it('keeps aggregation outputs as columns without confusing metrics and field names', () => {
    const release = releaseFixture();
    release.queryInterface.query.result.schema = [
      {
        name: 'region',
        type: 'string',
        nullable: false,
        source: { nodeId: 'root', modelId: 'division', fieldId: 'name' },
      },
      { name: 'stationCount', type: 'number', nullable: false },
    ];
    const schema = buildInterfacePivotSchema(
      {
        ...release,
        executionTemplate: {
          ...release.executionTemplate,
          resultAdapter: {
            kind: 'aggregation',
            dimensions: [{ sourceField: 'name', outputName: 'region' }],
            metrics: [{ wireKey: 'count_1', outputName: 'stationCount' }],
          },
        },
      },
      models,
      relations,
    );
    const document = normalizePivotResult({
      source: { kind: 'interface', callableName: 'counts', version: '1' },
      rows: [{ region: { zh: '上海', en: 'Shanghai' }, stationCount: 12 }],
    });
    const table = buildPivotTable(document, schema)!;
    assert.equal(resolvePivotLabel(table.node.columns[0]!.label, 'zh'), '名称');
    assert.equal(resolvePivotLabel(table.node.columns[1]!.label, 'zh'), 'stationCount');
    assert.equal(table.rows[0]!.values[1], 12);
    assert.equal(table.rows[0]!.children.length, 0);
  });

  it('uses directional model policies at every nested level without leaking hidden properties', async () => {
    const schema = buildModelPivotSchema('division', models, relations);
    const document = await queryModelPivot({
      source: { kind: 'model', modelId: 'division', modelName: 'AdministrativeDivision' },
      fieldPolicy: buildPivotModelFieldPolicy(schema),
      client: {
        model: () => ({
          query: () => ({
            is() { return this; },
            contains() { return this; },
            gt() { return this; },
            lt() { return this; },
            execute: async () => [
              {
                name: 'Root',
                _id: 'internal',
                relates: {
                  children: [
                    {
                      name: 'Child',
                      code: 'C',
                      relates: {
                        stations: [
                          {
                            name: 'Station',
                            _id: 'internal-child',
                            relates: {
                              division: [{ name: 'Joined division', code: 'D', hidden: 'secret' }],
                            },
                          },
                        ],
                      },
                    },
                  ],
                  parent: [{ code: 'P', hidden: 'secret' }],
                },
              },
            ],
          }),
        }),
      },
    });
    const serialized = JSON.stringify(document.rawRows);
    assert.doesNotMatch(serialized, /internal|secret|hidden|_id/);
    const table = buildPivotTable(document, schema)!;
    const child = table.rows[0]!.children.find((entry) => entry.relation!.path[1] === 'children')!;
    const station = child.rows[0]!.children[0]!;
    const joined = station.rows[0]!.children[0]!;
    assert.equal(station.node.modelId, 'station');
    assert.equal(joined.rows[0]!.values[0], 'Joined division');
    assert.equal(resolvePivotLabel(station.relation!.label, 'zh'), '所属车站');
  });
});
