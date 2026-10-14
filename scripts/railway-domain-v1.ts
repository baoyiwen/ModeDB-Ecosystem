#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DataType, type FieldDefsRecord } from '@mode-db/common';
import { ModelDB, type RemoteHydratedEntity } from '@mode-db/sdk';
import {
  SYS_MODEL,
  SYS_PROPS,
  SYS_RELATION_DEF,
} from '../apps/model-designer/src/bootstrap/designer-storage-init.js';
import { importEngineCatalogIntoDesignerDb } from '../apps/model-designer/src/sync/engine-catalog-import.js';
import {
  ensureLibraryRecord,
  updateLibraryMetadata,
} from '../apps/model-designer/src/sync/library-registry.js';
import { dataTypeToEngineCode } from '../apps/model-designer/src/config/engine-prop-types.js';

type I18nText = Readonly<{ zh: string; en: string; ja: string }>;
type ServerFileConfig = {
  readonly host?: string;
  readonly port?: number;
  readonly workspace?: string;
  readonly connectToken?: string;
};
type ModelSeed = {
  readonly model: string;
  readonly keyField: string;
  readonly rows: readonly Record<string, unknown>[];
};
type DataSplitMetadata = {
  readonly model: string;
  readonly grain: string;
  readonly identity: string;
  readonly lifecycle: string;
  readonly ownership: string;
  readonly partitionKey: string;
  readonly valueObjectFields?: readonly string[];
};
type RelationDef = {
  readonly source: string;
  readonly target: string;
  readonly forward: string;
  readonly reverse: string;
  readonly logic: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
  readonly matchOn: { readonly sourceField: string; readonly targetField: string };
  readonly selfLoopPolicy?: 'deny' | 'allow';
};

const argv = process.argv.slice(2);
function option(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Validation failed: ${message}`);
  }
}
function i18n(zh: string, en: string, ja: string): I18nText {
  return { zh, en, ja };
}
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}
function iso(dayOffset: number, hour = 8): string {
  return new Date(Date.UTC(2026, 0, 1 + dayOffset, hour, 0, 0)).toISOString();
}

const configPath = resolve(option('--config') ?? 'modeldb.config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as ServerFileConfig;
const host = option('--host') ?? config.host ?? '127.0.0.1';
const port = Number(option('--port') ?? config.port ?? 9090);
const database = option('--database') ?? 'railway_domain_v1';
const reset = argv.includes('--reset');
const designerOnly = argv.includes('--designer-only');
const connectToken =
  config.connectToken?.trim() || process.env.MODEL_DB_CONNECT_TOKEN?.trim() || '';
const workspaceSetting = config.workspace?.trim() || 'vault';
const workspaceRoot = isAbsolute(workspaceSetting)
  ? workspaceSetting
  : resolve(dirname(configPath), workspaceSetting);
const reportPath = resolve(workspaceRoot, database, 'build-report.json');

const schemas: ReadonlyArray<{ readonly name: string; readonly schema: FieldDefsRecord }> = [
  {
    name: 'RailwayLine',
    schema: {
      railwayLineCode: { type: DataType.String, required: true },
      name: { type: DataType.I18N, required: true },
      statusCode: { type: DataType.String, required: true },
      categoryCode: { type: DataType.String, required: true },
      measurementValue: { type: DataType.Number, required: true },
      measurementUnitCode: { type: DataType.String, required: true },
      geometry: DataType.JSON,
      commissionedAt: DataType.DateTime,
    },
  },
  {
    name: 'LineSection',
    schema: {
      lineSectionCode: { type: DataType.String, required: true },
      name: { type: DataType.I18N, required: true },
      statusCode: { type: DataType.String, required: true },
      categoryCode: { type: DataType.String, required: true },
      measurementValue: { type: DataType.Number, required: true },
      measurementUnitCode: { type: DataType.String, required: true },
      startKm: { type: DataType.Number, required: true },
      endKm: { type: DataType.Number, required: true },
      geometry: DataType.JSON,
    },
  },
  {
    name: 'TrackSegment',
    schema: {
      trackSegmentCode: { type: DataType.String, required: true },
      name: { type: DataType.I18N, required: true },
      statusCode: { type: DataType.String, required: true },
      categoryCode: { type: DataType.String, required: true },
      measurementValue: { type: DataType.Number, required: true },
      measurementUnitCode: { type: DataType.String, required: true },
      safetyClassCode: { type: DataType.String, required: true },
      geometry: DataType.JSON,
    },
  },
  {
    name: 'Station',
    schema: {
      stationCode: { type: DataType.String, required: true },
      name: { type: DataType.I18N, required: true },
      statusCode: { type: DataType.String, required: true },
      categoryCode: { type: DataType.String, required: true },
      divisionCode: { type: DataType.String, required: true },
      geometry: DataType.JSON,
      platformCount: DataType.Int,
    },
  },
  {
    name: 'AdministrativeDivision',
    schema: {
      divisionCode: { type: DataType.String, required: true },
      name: { type: DataType.I18N, required: true },
      level: { type: DataType.String, required: true },
      parentDivisionCode: DataType.String,
      boundaryVersion: { type: DataType.String, required: true },
      geometry: DataType.JSON,
      validFrom: DataType.DateTime,
      validTo: DataType.DateTime,
    },
  },
  {
    name: 'UnitDefinition',
    schema: {
      unitCode: { type: DataType.String, required: true },
      name: { type: DataType.I18N, required: true },
      symbol: { type: DataType.String, required: true },
      dimensionCode: { type: DataType.String, required: true },
      conversionFactor: { type: DataType.Number, required: true },
      active: { type: DataType.Boolean, required: true },
    },
  },
  {
    name: 'ServiceStatus',
    schema: {
      statusCode: { type: DataType.String, required: true },
      name: { type: DataType.I18N, required: true },
      domainCode: { type: DataType.String, required: true },
      active: { type: DataType.Boolean, required: true },
    },
  },
  {
    name: 'AssetCategory',
    schema: {
      categoryCode: { type: DataType.String, required: true },
      name: { type: DataType.I18N, required: true },
      domainCode: { type: DataType.String, required: true },
      active: { type: DataType.Boolean, required: true },
    },
  },
  {
    name: 'LineSectionAssignment',
    schema: {
      assignmentCode: { type: DataType.String, required: true },
      lineCode: { type: DataType.String, required: true },
      sectionCode: { type: DataType.String, required: true },
      sequenceNo: { type: DataType.Int, required: true },
      direction: { type: DataType.String, required: true },
      fromKm: { type: DataType.Number, required: true },
      toKm: { type: DataType.Number, required: true },
      validFrom: DataType.DateTime,
      validTo: DataType.DateTime,
    },
  },
  {
    name: 'SectionTrackAssignment',
    schema: {
      assignmentCode: { type: DataType.String, required: true },
      sectionCode: { type: DataType.String, required: true },
      trackSegmentCode: { type: DataType.String, required: true },
      sequenceNo: { type: DataType.Int, required: true },
      direction: { type: DataType.String, required: true },
      fromKm: { type: DataType.Number, required: true },
      toKm: { type: DataType.Number, required: true },
    },
  },
  {
    name: 'LineStationAssignment',
    schema: {
      assignmentCode: { type: DataType.String, required: true },
      lineCode: { type: DataType.String, required: true },
      stationCode: { type: DataType.String, required: true },
      sequenceNo: { type: DataType.Int, required: true },
      arrivalDirection: { type: DataType.String, required: true },
      fromKm: { type: DataType.Number, required: true },
      toKm: { type: DataType.Number, required: true },
      validFrom: DataType.DateTime,
      validTo: DataType.DateTime,
    },
  },
  {
    name: 'SectionDivisionAssignment',
    schema: {
      assignmentCode: { type: DataType.String, required: true },
      sectionCode: { type: DataType.String, required: true },
      divisionCode: { type: DataType.String, required: true },
      coverageType: { type: DataType.String, required: true },
      coverageRatio: { type: DataType.Number, required: true },
      fromKm: { type: DataType.Number, required: true },
      toKm: { type: DataType.Number, required: true },
      boundaryVersion: { type: DataType.String, required: true },
      validFrom: DataType.DateTime,
      validTo: DataType.DateTime,
    },
  },
];

const dataSplitMetadata: readonly DataSplitMetadata[] = [
  {
    model: 'RailwayLine',
    grain: '一条具有稳定编号和独立运营属性的铁路线路',
    identity: 'railwayLineCode',
    lifecycle: 'independent',
    ownership: 'root',
    partitionKey: 'railwayLineCode',
    valueObjectFields: ['geometry'],
  },
  {
    model: 'LineSection',
    grain: '一个可以独立识别、维护或查询的线路区间',
    identity: 'lineSectionCode',
    lifecycle: 'independent',
    ownership: 'domain',
    partitionKey: 'lineSectionCode',
    valueObjectFields: ['geometry'],
  },
  {
    model: 'TrackSegment',
    grain: '一个可独立检测、调度或维护的轨道区段',
    identity: 'trackSegmentCode',
    lifecycle: 'independent',
    ownership: 'domain',
    partitionKey: 'trackSegmentCode',
    valueObjectFields: ['geometry'],
  },
  {
    model: 'Station',
    grain: '一个具有稳定站点编码和独立运营信息的车站',
    identity: 'stationCode',
    lifecycle: 'independent',
    ownership: 'root',
    partitionKey: 'stationCode',
    valueObjectFields: ['geometry'],
  },
  {
    model: 'AdministrativeDivision',
    grain: '一个行政区划版本中的行政单元',
    identity: 'divisionCode',
    lifecycle: 'versioned_reference',
    ownership: 'reference',
    partitionKey: 'boundaryVersion',
  },
  {
    model: 'UnitDefinition',
    grain: '一个可被测量值引用的单位定义',
    identity: 'unitCode',
    lifecycle: 'versioned_reference',
    ownership: 'reference',
    partitionKey: 'unitCode',
  },
  {
    model: 'ServiceStatus',
    grain: '一个可复用的服务状态定义',
    identity: 'statusCode',
    lifecycle: 'managed_reference',
    ownership: 'reference',
    partitionKey: 'domainCode',
  },
  {
    model: 'AssetCategory',
    grain: '一个可复用的铁路资产分类定义',
    identity: 'categoryCode',
    lifecycle: 'managed_reference',
    ownership: 'reference',
    partitionKey: 'domainCode',
  },
  {
    model: 'LineSectionAssignment',
    grain: '一条线路与一个线路区间的带顺序组成关系',
    identity: 'assignmentCode',
    lifecycle: 'independent',
    ownership: 'relationship',
    partitionKey: 'lineCode',
  },
  {
    model: 'SectionTrackAssignment',
    grain: '一个线路区间与一个轨道区段的带顺序组成关系',
    identity: 'assignmentCode',
    lifecycle: 'independent',
    ownership: 'relationship',
    partitionKey: 'sectionCode',
  },
  {
    model: 'LineStationAssignment',
    grain: '一条线路与一个车站的带顺序服务关系',
    identity: 'assignmentCode',
    lifecycle: 'independent',
    ownership: 'relationship',
    partitionKey: 'lineCode',
  },
  {
    model: 'SectionDivisionAssignment',
    grain: '一个线路区间与一个行政区划的空间覆盖关系',
    identity: 'assignmentCode',
    lifecycle: 'independent',
    ownership: 'relationship',
    partitionKey: 'sectionCode',
  },
];

const relationDefs: readonly RelationDef[] = [
  {
    source: 'RailwayLine',
    target: 'LineSectionAssignment',
    forward: 'lineSectionAssignments',
    reverse: 'assignmentLine',
    logic: 'one-to-many',
    matchOn: { sourceField: 'railwayLineCode', targetField: 'lineCode' },
  },
  {
    source: 'LineSectionAssignment',
    target: 'LineSection',
    forward: 'assignedSection',
    reverse: 'sectionAssignment',
    logic: 'many-to-one',
    matchOn: { sourceField: 'sectionCode', targetField: 'lineSectionCode' },
  },
  {
    source: 'LineSection',
    target: 'SectionTrackAssignment',
    forward: 'sectionTrackAssignments',
    reverse: 'assignmentSection',
    logic: 'one-to-many',
    matchOn: { sourceField: 'lineSectionCode', targetField: 'sectionCode' },
  },
  {
    source: 'SectionTrackAssignment',
    target: 'TrackSegment',
    forward: 'assignedTrackSegment',
    reverse: 'trackAssignment',
    logic: 'many-to-one',
    matchOn: { sourceField: 'trackSegmentCode', targetField: 'trackSegmentCode' },
  },
  {
    source: 'RailwayLine',
    target: 'LineStationAssignment',
    forward: 'lineStationAssignments',
    reverse: 'stationAssignmentLine',
    logic: 'one-to-many',
    matchOn: { sourceField: 'railwayLineCode', targetField: 'lineCode' },
  },
  {
    source: 'LineStationAssignment',
    target: 'Station',
    forward: 'assignedStation',
    reverse: 'stationAssignment',
    logic: 'many-to-one',
    matchOn: { sourceField: 'stationCode', targetField: 'stationCode' },
  },
  {
    source: 'LineSection',
    target: 'SectionDivisionAssignment',
    forward: 'sectionDivisionAssignments',
    reverse: 'divisionAssignmentSection',
    logic: 'one-to-many',
    matchOn: { sourceField: 'lineSectionCode', targetField: 'sectionCode' },
  },
  {
    source: 'SectionDivisionAssignment',
    target: 'AdministrativeDivision',
    forward: 'coveredDivision',
    reverse: 'divisionCoverageAssignments',
    logic: 'many-to-one',
    matchOn: { sourceField: 'divisionCode', targetField: 'divisionCode' },
  },
  {
    source: 'Station',
    target: 'AdministrativeDivision',
    forward: 'stationDivision',
    reverse: 'divisionStations',
    logic: 'many-to-one',
    matchOn: { sourceField: 'divisionCode', targetField: 'divisionCode' },
  },
  {
    source: 'AdministrativeDivision',
    target: 'AdministrativeDivision',
    forward: 'childDivisions',
    reverse: 'parentDivision',
    logic: 'one-to-many',
    matchOn: { sourceField: 'divisionCode', targetField: 'parentDivisionCode' },
    selfLoopPolicy: 'deny',
  },
  {
    source: 'RailwayLine',
    target: 'ServiceStatus',
    forward: 'lineStatus',
    reverse: 'statusLines',
    logic: 'many-to-one',
    matchOn: { sourceField: 'statusCode', targetField: 'statusCode' },
  },
  {
    source: 'LineSection',
    target: 'ServiceStatus',
    forward: 'sectionStatus',
    reverse: 'statusSections',
    logic: 'many-to-one',
    matchOn: { sourceField: 'statusCode', targetField: 'statusCode' },
  },
  {
    source: 'TrackSegment',
    target: 'ServiceStatus',
    forward: 'trackStatus',
    reverse: 'statusTrackSegments',
    logic: 'many-to-one',
    matchOn: { sourceField: 'statusCode', targetField: 'statusCode' },
  },
  {
    source: 'Station',
    target: 'ServiceStatus',
    forward: 'stationStatus',
    reverse: 'statusStations',
    logic: 'many-to-one',
    matchOn: { sourceField: 'statusCode', targetField: 'statusCode' },
  },
  {
    source: 'RailwayLine',
    target: 'AssetCategory',
    forward: 'lineCategory',
    reverse: 'categoryLines',
    logic: 'many-to-one',
    matchOn: { sourceField: 'categoryCode', targetField: 'categoryCode' },
  },
  {
    source: 'LineSection',
    target: 'AssetCategory',
    forward: 'sectionCategory',
    reverse: 'categorySections',
    logic: 'many-to-one',
    matchOn: { sourceField: 'categoryCode', targetField: 'categoryCode' },
  },
  {
    source: 'TrackSegment',
    target: 'AssetCategory',
    forward: 'trackCategory',
    reverse: 'categoryTrackSegments',
    logic: 'many-to-one',
    matchOn: { sourceField: 'categoryCode', targetField: 'categoryCode' },
  },
  {
    source: 'Station',
    target: 'AssetCategory',
    forward: 'stationCategory',
    reverse: 'categoryStations',
    logic: 'many-to-one',
    matchOn: { sourceField: 'categoryCode', targetField: 'categoryCode' },
  },
  {
    source: 'RailwayLine',
    target: 'UnitDefinition',
    forward: 'lineMeasurementUnit',
    reverse: 'unitLines',
    logic: 'many-to-one',
    matchOn: { sourceField: 'measurementUnitCode', targetField: 'unitCode' },
  },
  {
    source: 'LineSection',
    target: 'UnitDefinition',
    forward: 'sectionMeasurementUnit',
    reverse: 'unitSections',
    logic: 'many-to-one',
    matchOn: { sourceField: 'measurementUnitCode', targetField: 'unitCode' },
  },
  {
    source: 'TrackSegment',
    target: 'UnitDefinition',
    forward: 'trackMeasurementUnit',
    reverse: 'unitTrackSegments',
    logic: 'many-to-one',
    matchOn: { sourceField: 'measurementUnitCode', targetField: 'unitCode' },
  },
];

const modelLabels: Readonly<Record<string, I18nText>> = {
  RailwayLine: i18n('铁路线路', 'Railway Line', '鉄道路線'),
  LineSection: i18n('线路区间', 'Line Section', '線区間'),
  TrackSegment: i18n('轨道区段', 'Track Segment', '軌道区間'),
  Station: i18n('车站', 'Railway Station', '鉄道駅'),
  AdministrativeDivision: i18n('行政区划', 'Administrative Division', '行政区画'),
  UnitDefinition: i18n('单位定义', 'Unit Definition', '単位定義'),
  ServiceStatus: i18n('服务状态', 'Service Status', 'サービス状態'),
  AssetCategory: i18n('资产分类', 'Asset Category', '資産分類'),
  LineSectionAssignment: i18n('线路区间组成关系', 'Line Section Assignment', '線区間構成関係'),
  SectionTrackAssignment: i18n('轨道区段组成关系', 'Section Track Assignment', '軌道区間構成関係'),
  LineStationAssignment: i18n('线路车站关系', 'Line Station Assignment', '路線駅関係'),
  SectionDivisionAssignment: i18n('区划覆盖关系', 'Section Division Assignment', '区画カバー関係'),
};
type RelationLabels = Readonly<{ forward: I18nText; reverse: I18nText }>;
const relationLabels: Readonly<Record<string, RelationLabels>> = {
  lineSectionAssignments: {
    forward: i18n('线路区间组成', 'Line sections', '線区間構成'),
    reverse: i18n('所属线路', 'Assignment line', '所属路線'),
  },
  assignedSection: {
    forward: i18n('对应线路区间', 'Assigned section', '対応線区間'),
    reverse: i18n('线路区间关联', 'Section assignment', '線区間関連'),
  },
  sectionTrackAssignments: {
    forward: i18n('轨道区段组成', 'Track segments', '軌道区間構成'),
    reverse: i18n('所属线路区间', 'Assignment section', '所属線区間'),
  },
  assignedTrackSegment: {
    forward: i18n('对应轨道区段', 'Assigned track segment', '対応軌道区間'),
    reverse: i18n('轨道区段关联', 'Track assignment', '軌道区間関連'),
  },
  lineStationAssignments: {
    forward: i18n('线路车站顺序', 'Line stations', '路線駅順序'),
    reverse: i18n('所属线路', 'Assignment line', '所属路線'),
  },
  assignedStation: {
    forward: i18n('对应车站', 'Assigned station', '対応駅'),
    reverse: i18n('车站关联', 'Station assignment', '駅関連'),
  },
  sectionDivisionAssignments: {
    forward: i18n('行政区划覆盖', 'Division coverage', '行政区画カバー'),
    reverse: i18n('所属线路区间', 'Assignment section', '所属線区間'),
  },
  coveredDivision: {
    forward: i18n('覆盖行政区划', 'Covered division', 'カバー行政区画'),
    reverse: i18n('区划覆盖关系', 'Division coverage assignment', '区画カバー関係'),
  },
  stationDivision: {
    forward: i18n('车站所属行政区划', 'Station division', '駅行政区画'),
    reverse: i18n('行政区划车站', 'Division stations', '行政区画駅'),
  },
  childDivisions: {
    forward: i18n('下级行政区划', 'Child divisions', '下位行政区画'),
    reverse: i18n('上级行政区划', 'Parent division', '上位行政区画'),
  },
  lineStatus: {
    forward: i18n('线路服务状态', 'Line service status', '路線サービス状態'),
    reverse: i18n('状态线路', 'Status lines', '状態路線'),
  },
  sectionStatus: {
    forward: i18n('区间服务状态', 'Section service status', '区間サービス状態'),
    reverse: i18n('状态区间', 'Status sections', '状態区間'),
  },
  trackStatus: {
    forward: i18n('轨道区段状态', 'Track segment status', '軌道区間状態'),
    reverse: i18n('状态轨道区段', 'Status track segments', '状態軌道区間'),
  },
  stationStatus: {
    forward: i18n('车站服务状态', 'Station service status', '駅サービス状態'),
    reverse: i18n('状态车站', 'Status stations', '状態駅'),
  },
  lineCategory: {
    forward: i18n('线路资产分类', 'Line asset category', '路線資産分類'),
    reverse: i18n('分类线路', 'Category lines', '分類路線'),
  },
  sectionCategory: {
    forward: i18n('区间资产分类', 'Section asset category', '区間資産分類'),
    reverse: i18n('分类区间', 'Category sections', '分類区間'),
  },
  trackCategory: {
    forward: i18n('轨道区段分类', 'Track segment category', '軌道区間分類'),
    reverse: i18n('分类轨道区段', 'Category track segments', '分類軌道区間'),
  },
  stationCategory: {
    forward: i18n('车站资产分类', 'Station asset category', '駅資産分類'),
    reverse: i18n('分类车站', 'Category stations', '分類駅'),
  },
  lineMeasurementUnit: {
    forward: i18n('线路测量单位', 'Line measurement unit', '路線測定単位'),
    reverse: i18n('使用线路的单位', 'Unit lines', '使用路線単位'),
  },
  sectionMeasurementUnit: {
    forward: i18n('区间测量单位', 'Section measurement unit', '区間測定単位'),
    reverse: i18n('使用区间的单位', 'Unit sections', '使用区間単位'),
  },
  trackMeasurementUnit: {
    forward: i18n('轨道区段测量单位', 'Track segment measurement unit', '軌道区間測定単位'),
    reverse: i18n('使用轨道区段的单位', 'Unit track segments', '使用軌道区間単位'),
  },
};
const modelLayout: Readonly<Record<string, { readonly x: number; readonly y: number }>> = {
  RailwayLine: { x: 900, y: 260 },
  LineSection: { x: 900, y: 760 },
  TrackSegment: { x: 900, y: 1260 },
  Station: { x: 1650, y: 260 },
  AdministrativeDivision: { x: 2500, y: 760 },
  UnitDefinition: { x: 3400, y: 760 },
  ServiceStatus: { x: 4300, y: 260 },
  AssetCategory: { x: 4300, y: 760 },
  LineSectionAssignment: { x: 1700, y: 760 },
  SectionTrackAssignment: { x: 1700, y: 1260 },
  LineStationAssignment: { x: 2500, y: 260 },
  SectionDivisionAssignment: { x: 2500, y: 1260 },
};

function validateMetadata(): void {
  const schemaNames = new Set(schemas.map((entry) => entry.name));
  assert(dataSplitMetadata.length === schemas.length, 'metadata must cover every model');
  for (const entry of dataSplitMetadata) {
    assert(schemaNames.has(entry.model), `metadata references unknown model ${entry.model}`);
    assert(
      entry.grain && entry.identity && entry.lifecycle && entry.ownership && entry.partitionKey,
      `metadata is incomplete for ${entry.model}`,
    );
  }
  const modelNames = new Set(schemas.map((entry) => entry.name));
  for (const relation of relationDefs) {
    assert(
      modelNames.has(relation.source) && modelNames.has(relation.target),
      `relation endpoint missing for ${relation.forward}`,
    );
  }
  assert(
    new Set(relationDefs.map((relation) => relation.forward)).size === relationDefs.length,
    'relation names must be unique',
  );
  for (const schema of schemas) {
    const label = modelLabels[schema.name];
    assert(label && label.zh && label.en && label.ja, `missing model i18n for ${schema.name}`);
  }
  for (const relation of relationDefs) {
    const labels = relationLabels[relation.forward];
    assert(
      labels &&
        labels.forward.zh &&
        labels.forward.en &&
        labels.forward.ja &&
        labels.reverse.zh &&
        labels.reverse.en &&
        labels.reverse.ja,
      `missing relation i18n for ${relation.forward}`,
    );
  }
}

function buildSeeds(): readonly ModelSeed[] {
  return [
    {
      model: 'UnitDefinition',
      keyField: 'unitCode',
      rows: [
        {
          unitCode: 'KM',
          name: i18n('千米', 'Kilometre', 'キロメートル'),
          symbol: 'km',
          dimensionCode: 'LENGTH',
          conversionFactor: 1,
          active: true,
        },
        {
          unitCode: 'KPH',
          name: i18n('千米每小时', 'Kilometre per hour', 'キロメートル毎時'),
          symbol: 'km/h',
          dimensionCode: 'SPEED',
          conversionFactor: 1,
          active: true,
        },
      ],
    },
    {
      model: 'ServiceStatus',
      keyField: 'statusCode',
      rows: [
        {
          statusCode: 'PLANNED',
          name: i18n('规划中', 'Planned', '計画中'),
          domainCode: 'RAILWAY',
          active: true,
        },
        {
          statusCode: 'ACTIVE',
          name: i18n('运营中', 'Active', '運用中'),
          domainCode: 'RAILWAY',
          active: true,
        },
        {
          statusCode: 'MAINTENANCE',
          name: i18n('维护中', 'Maintenance', '保守中'),
          domainCode: 'RAILWAY',
          active: true,
        },
        {
          statusCode: 'RETIRED',
          name: i18n('已停用', 'Retired', '廃止'),
          domainCode: 'RAILWAY',
          active: true,
        },
      ],
    },
    {
      model: 'AssetCategory',
      keyField: 'categoryCode',
      rows: [
        {
          categoryCode: 'LINE',
          name: i18n('线路', 'Line', '路線'),
          domainCode: 'RAILWAY_ASSET',
          active: true,
        },
        {
          categoryCode: 'SECTION',
          name: i18n('线路区间', 'Section', '線区間'),
          domainCode: 'RAILWAY_ASSET',
          active: true,
        },
        {
          categoryCode: 'TRACK',
          name: i18n('轨道区段', 'Track', '軌道'),
          domainCode: 'RAILWAY_ASSET',
          active: true,
        },
        {
          categoryCode: 'STATION',
          name: i18n('车站', 'Station', '駅'),
          domainCode: 'RAILWAY_ASSET',
          active: true,
        },
      ],
    },
    {
      model: 'AdministrativeDivision',
      keyField: 'divisionCode',
      rows: [
        {
          divisionCode: 'CN',
          name: i18n('中国', 'China', '中国'),
          level: 'COUNTRY',
          boundaryVersion: '2026',
          geometry: { type: 'Polygon', coordinates: [] },
          validFrom: iso(-365),
        },
        {
          divisionCode: 'BJ',
          name: i18n('北京市', 'Beijing', '北京市'),
          level: 'PROVINCE',
          parentDivisionCode: 'CN',
          boundaryVersion: '2026',
          geometry: { type: 'Polygon', coordinates: [] },
          validFrom: iso(-365),
        },
        {
          divisionCode: 'HB',
          name: i18n('河北省', 'Hebei', '河北省'),
          level: 'PROVINCE',
          parentDivisionCode: 'CN',
          boundaryVersion: '2026',
          geometry: { type: 'Polygon', coordinates: [] },
          validFrom: iso(-365),
        },
        {
          divisionCode: 'TJ',
          name: i18n('天津市', 'Tianjin', '天津市'),
          level: 'PROVINCE',
          parentDivisionCode: 'CN',
          boundaryVersion: '2026',
          geometry: { type: 'Polygon', coordinates: [] },
          validFrom: iso(-365),
        },
        {
          divisionCode: 'SJZ',
          name: i18n('石家庄市', 'Shijiazhuang', '石家荘市'),
          level: 'CITY',
          parentDivisionCode: 'HB',
          boundaryVersion: '2026',
          geometry: { type: 'Polygon', coordinates: [] },
          validFrom: iso(-365),
        },
        {
          divisionCode: 'TS',
          name: i18n('唐山市', 'Tangshan', '唐山市'),
          level: 'CITY',
          parentDivisionCode: 'HB',
          boundaryVersion: '2026',
          geometry: { type: 'Polygon', coordinates: [] },
          validFrom: iso(-365),
        },
      ],
    },
    {
      model: 'RailwayLine',
      keyField: 'railwayLineCode',
      rows: [
        {
          railwayLineCode: 'RL-001',
          name: i18n('京津城际线', 'Beijing-Tianjin Intercity Line', '京津都市間線'),
          statusCode: 'ACTIVE',
          categoryCode: 'LINE',
          measurementValue: 120,
          measurementUnitCode: 'KM',
          geometry: { type: 'LineString', coordinates: [] },
          commissionedAt: iso(-3000),
        },
        {
          railwayLineCode: 'RL-002',
          name: i18n('京石客运专线', 'Beijing-Shijiazhuang Passenger Line', '北京石家荘旅客線'),
          statusCode: 'ACTIVE',
          categoryCode: 'LINE',
          measurementValue: 280,
          measurementUnitCode: 'KM',
          geometry: { type: 'LineString', coordinates: [] },
          commissionedAt: iso(-2400),
        },
      ],
    },
    {
      model: 'LineSection',
      keyField: 'lineSectionCode',
      rows: [
        {
          lineSectionCode: 'SEC-001',
          name: i18n('北京至廊坊段', 'Beijing-Langfang Section', '北京-廊坊区間'),
          statusCode: 'ACTIVE',
          categoryCode: 'SECTION',
          measurementValue: 55,
          measurementUnitCode: 'KM',
          startKm: 0,
          endKm: 55,
          geometry: { type: 'LineString', coordinates: [] },
        },
        {
          lineSectionCode: 'SEC-002',
          name: i18n('廊坊至天津段', 'Langfang-Tianjin Section', '廊坊-天津区間'),
          statusCode: 'ACTIVE',
          categoryCode: 'SECTION',
          measurementValue: 65,
          measurementUnitCode: 'KM',
          startKm: 55,
          endKm: 120,
          geometry: { type: 'LineString', coordinates: [] },
        },
        {
          lineSectionCode: 'SEC-003',
          name: i18n('北京至保定段', 'Beijing-Baoding Section', '北京-保定区間'),
          statusCode: 'ACTIVE',
          categoryCode: 'SECTION',
          measurementValue: 145,
          measurementUnitCode: 'KM',
          startKm: 0,
          endKm: 145,
          geometry: { type: 'LineString', coordinates: [] },
        },
        {
          lineSectionCode: 'SEC-004',
          name: i18n('保定至石家庄段', 'Baoding-Shijiazhuang Section', '保定-石家荘区間'),
          statusCode: 'MAINTENANCE',
          categoryCode: 'SECTION',
          measurementValue: 135,
          measurementUnitCode: 'KM',
          startKm: 145,
          endKm: 280,
          geometry: { type: 'LineString', coordinates: [] },
        },
      ],
    },
    {
      model: 'TrackSegment',
      keyField: 'trackSegmentCode',
      rows: Array.from({ length: 6 }, (_, index) => ({
        trackSegmentCode: `TRK-${pad(index + 1, 3)}`,
        name: i18n(`轨道区段${index + 1}`, `Track Segment ${index + 1}`, `軌道区間${index + 1}`),
        statusCode: index === 5 ? 'MAINTENANCE' : 'ACTIVE',
        categoryCode: 'TRACK',
        measurementValue: 18 + index * 7,
        measurementUnitCode: 'KM',
        safetyClassCode: index % 2 === 0 ? 'S1' : 'S2',
        geometry: { type: 'LineString', coordinates: [] },
      })),
    },
    {
      model: 'Station',
      keyField: 'stationCode',
      rows: [
        {
          stationCode: 'STA-BJ',
          name: i18n('北京南站', 'Beijing South', '北京南駅'),
          statusCode: 'ACTIVE',
          categoryCode: 'STATION',
          divisionCode: 'BJ',
          geometry: { type: 'Point', coordinates: [116.38, 39.87] },
          platformCount: 24,
        },
        {
          stationCode: 'STA-LF',
          name: i18n('廊坊站', 'Langfang', '廊坊駅'),
          statusCode: 'ACTIVE',
          categoryCode: 'STATION',
          divisionCode: 'HB',
          geometry: { type: 'Point', coordinates: [116.7, 39.52] },
          platformCount: 8,
        },
        {
          stationCode: 'STA-TJ',
          name: i18n('天津站', 'Tianjin', '天津駅'),
          statusCode: 'ACTIVE',
          categoryCode: 'STATION',
          divisionCode: 'TJ',
          geometry: { type: 'Point', coordinates: [117.2, 39.13] },
          platformCount: 12,
        },
        {
          stationCode: 'STA-BD',
          name: i18n('保定东站', 'Baoding East', '保定東駅'),
          statusCode: 'ACTIVE',
          categoryCode: 'STATION',
          divisionCode: 'HB',
          geometry: { type: 'Point', coordinates: [115.5, 38.85] },
          platformCount: 10,
        },
        {
          stationCode: 'STA-SJZ',
          name: i18n('石家庄站', 'Shijiazhuang', '石家荘駅'),
          statusCode: 'ACTIVE',
          categoryCode: 'STATION',
          divisionCode: 'SJZ',
          geometry: { type: 'Point', coordinates: [114.48, 38.0] },
          platformCount: 13,
        },
      ],
    },
    {
      model: 'LineSectionAssignment',
      keyField: 'assignmentCode',
      rows: [
        {
          assignmentCode: 'LSA-001',
          lineCode: 'RL-001',
          sectionCode: 'SEC-001',
          sequenceNo: 1,
          direction: 'UP',
          fromKm: 0,
          toKm: 55,
          validFrom: iso(-3000),
        },
        {
          assignmentCode: 'LSA-002',
          lineCode: 'RL-001',
          sectionCode: 'SEC-002',
          sequenceNo: 2,
          direction: 'UP',
          fromKm: 55,
          toKm: 120,
          validFrom: iso(-3000),
        },
        {
          assignmentCode: 'LSA-003',
          lineCode: 'RL-002',
          sectionCode: 'SEC-003',
          sequenceNo: 1,
          direction: 'UP',
          fromKm: 0,
          toKm: 145,
          validFrom: iso(-2400),
        },
        {
          assignmentCode: 'LSA-004',
          lineCode: 'RL-002',
          sectionCode: 'SEC-004',
          sequenceNo: 2,
          direction: 'UP',
          fromKm: 145,
          toKm: 280,
          validFrom: iso(-2400),
        },
      ],
    },
    {
      model: 'SectionTrackAssignment',
      keyField: 'assignmentCode',
      rows: Array.from({ length: 6 }, (_, index) => ({
        assignmentCode: `STA-${pad(index + 1, 3)}`,
        sectionCode: `SEC-${pad(Math.floor(index / 2) + 1, 3)}`,
        trackSegmentCode: `TRK-${pad(index + 1, 3)}`,
        sequenceNo: (index % 2) + 1,
        direction: index % 2 === 0 ? 'UP' : 'DOWN',
        fromKm: (index % 2) * 20,
        toKm: (index % 2) * 20 + 20,
      })),
    },
    {
      model: 'LineStationAssignment',
      keyField: 'assignmentCode',
      rows: [
        {
          assignmentCode: 'LTA-001',
          lineCode: 'RL-001',
          stationCode: 'STA-BJ',
          sequenceNo: 1,
          arrivalDirection: 'UP',
          fromKm: 0,
          toKm: 0,
          validFrom: iso(-3000),
        },
        {
          assignmentCode: 'LTA-002',
          lineCode: 'RL-001',
          stationCode: 'STA-LF',
          sequenceNo: 2,
          arrivalDirection: 'UP',
          fromKm: 55,
          toKm: 55,
          validFrom: iso(-3000),
        },
        {
          assignmentCode: 'LTA-003',
          lineCode: 'RL-001',
          stationCode: 'STA-TJ',
          sequenceNo: 3,
          arrivalDirection: 'UP',
          fromKm: 120,
          toKm: 120,
          validFrom: iso(-3000),
        },
        {
          assignmentCode: 'LTA-004',
          lineCode: 'RL-002',
          stationCode: 'STA-BJ',
          sequenceNo: 1,
          arrivalDirection: 'UP',
          fromKm: 0,
          toKm: 0,
          validFrom: iso(-2400),
        },
        {
          assignmentCode: 'LTA-005',
          lineCode: 'RL-002',
          stationCode: 'STA-BD',
          sequenceNo: 2,
          arrivalDirection: 'UP',
          fromKm: 145,
          toKm: 145,
          validFrom: iso(-2400),
        },
        {
          assignmentCode: 'LTA-006',
          lineCode: 'RL-002',
          stationCode: 'STA-SJZ',
          sequenceNo: 3,
          arrivalDirection: 'UP',
          fromKm: 280,
          toKm: 280,
          validFrom: iso(-2400),
        },
      ],
    },
    {
      model: 'SectionDivisionAssignment',
      keyField: 'assignmentCode',
      rows: [
        {
          assignmentCode: 'SDA-001',
          sectionCode: 'SEC-001',
          divisionCode: 'BJ',
          coverageType: 'CROSSES',
          coverageRatio: 0.45,
          fromKm: 0,
          toKm: 25,
          boundaryVersion: '2026',
          validFrom: iso(-365),
        },
        {
          assignmentCode: 'SDA-002',
          sectionCode: 'SEC-001',
          divisionCode: 'HB',
          coverageType: 'CROSSES',
          coverageRatio: 0.55,
          fromKm: 25,
          toKm: 55,
          boundaryVersion: '2026',
          validFrom: iso(-365),
        },
        {
          assignmentCode: 'SDA-003',
          sectionCode: 'SEC-002',
          divisionCode: 'HB',
          coverageType: 'CROSSES',
          coverageRatio: 0.35,
          fromKm: 55,
          toKm: 77,
          boundaryVersion: '2026',
          validFrom: iso(-365),
        },
        {
          assignmentCode: 'SDA-004',
          sectionCode: 'SEC-002',
          divisionCode: 'TJ',
          coverageType: 'CROSSES',
          coverageRatio: 0.65,
          fromKm: 77,
          toKm: 120,
          boundaryVersion: '2026',
          validFrom: iso(-365),
        },
        {
          assignmentCode: 'SDA-005',
          sectionCode: 'SEC-003',
          divisionCode: 'BJ',
          coverageType: 'CROSSES',
          coverageRatio: 0.3,
          fromKm: 0,
          toKm: 42,
          boundaryVersion: '2026',
          validFrom: iso(-365),
        },
        {
          assignmentCode: 'SDA-006',
          sectionCode: 'SEC-003',
          divisionCode: 'HB',
          coverageType: 'CROSSES',
          coverageRatio: 0.7,
          fromKm: 42,
          toKm: 145,
          boundaryVersion: '2026',
          validFrom: iso(-365),
        },
        {
          assignmentCode: 'SDA-007',
          sectionCode: 'SEC-004',
          divisionCode: 'HB',
          coverageType: 'WITHIN',
          coverageRatio: 1,
          fromKm: 145,
          toKm: 280,
          boundaryVersion: '2026',
          validFrom: iso(-365),
        },
      ],
    },
  ];
}

async function insertSeed(
  client: Awaited<ReturnType<ModelDB['use']>>,
  seed: ModelSeed,
): Promise<Map<string, string>> {
  const result = await client
    .model(seed.model)
    .insertMany(seed.rows, { sync: true, returning: true });
  assert(
    result.failureCount === 0 &&
      result.successCount === seed.rows.length &&
      result.records?.length === seed.rows.length,
    `${seed.model} insert failed`,
  );
  const ids = new Map<string, string>();
  for (const entity of result.records) {
    ids.set(String(entity.getData()[seed.keyField]), entity.id);
  }
  return ids;
}
function rowData(rows: unknown): Record<string, unknown>[] {
  assert(Array.isArray(rows), 'query result must be an array');
  return rows.map((row) => {
    assert(row && typeof row === 'object' && 'getData' in row, 'query row must be hydrated');
    return (row as RemoteHydratedEntity).getData();
  });
}
function typeOfField(field: unknown): string {
  if (typeof field === 'string') {
    return field;
  }
  if (field && typeof field === 'object' && 'type' in field) {
    return String((field as { type: unknown }).type);
  }
  return DataType.String;
}
function labelForField(field: string): I18nText {
  const labels: Record<string, I18nText> = {
    railwayLineCode: i18n('线路编码', 'Railway line code', '路線コード'),
    lineSectionCode: i18n('线路区间编码', 'Line section code', '線区間コード'),
    trackSegmentCode: i18n('轨道区段编码', 'Track segment code', '軌道区間コード'),
    stationCode: i18n('车站编码', 'Station code', '駅コード'),
    divisionCode: i18n('行政区划编码', 'Division code', '行政区画コード'),
    unitCode: i18n('单位编码', 'Unit code', '単位コード'),
    statusCode: i18n('状态编码', 'Status code', '状態コード'),
    categoryCode: i18n('分类编码', 'Category code', '分類コード'),
    name: i18n('名称', 'Name', '名称'),
    measurementValue: i18n('测量值', 'Measurement value', '測定値'),
    measurementUnitCode: i18n('测量单位编码', 'Measurement unit code', '測定単位コード'),
    geometry: i18n('地理几何', 'Geometry', 'ジオメトリ'),
    assignmentCode: i18n('关联编码', 'Assignment code', '関連コード'),
    sequenceNo: i18n('顺序号', 'Sequence', '順序'),
    fromKm: i18n('起始里程', 'From kilometre', '起点キロ'),
    toKm: i18n('结束里程', 'To kilometre', '終点キロ'),
    coverageRatio: i18n('覆盖比例', 'Coverage ratio', 'カバー率'),
    coverageType: i18n('覆盖类型', 'Coverage type', 'カバー種別'),
    parentDivisionCode: i18n('上级行政区划编码', 'Parent division code', '親行政区画コード'),
    boundaryVersion: i18n('边界版本', 'Boundary version', '境界バージョン'),
    platformCount: i18n('站台数量', 'Platform count', 'ホーム数'),
    active: i18n('是否有效', 'Active', '有効'),
    symbol: i18n('符号', 'Symbol', '記号'),
    dimensionCode: i18n('量纲编码', 'Dimension code', '次元コード'),
    conversionFactor: i18n('换算系数', 'Conversion factor', '換算係数'),
    domainCode: i18n('字典域编码', 'Domain code', 'ドメインコード'),
    level: i18n('层级', 'Level', 'レベル'),
    safetyClassCode: i18n('安全等级编码', 'Safety class code', '安全等級コード'),
    direction: i18n('方向', 'Direction', '方向'),
    arrivalDirection: i18n('到达方向', 'Arrival direction', '到着方向'),
    lineCode: i18n('线路编码', 'Line code', '路線コード'),
    sectionCode: i18n('区间编码', 'Section code', '区間コード'),
    validFrom: i18n('生效时间', 'Valid from', '有効開始'),
    validTo: i18n('失效时间', 'Valid to', '有効終了'),
    commissionedAt: i18n('投运时间', 'Commissioned at', '供用開始'),
    startKm: i18n('起始里程', 'Start kilometre', '開始キロ'),
    endKm: i18n('结束里程', 'End kilometre', '終了キロ'),
  };
  const label = labels[field];
  assert(label, `missing field i18n for ${field}`);
  return label;
}
function modelDescription(value: I18nText): I18nText {
  return i18n(`${value.zh}数据模型`, `${value.en} data model`, `${value.ja}データモデル`);
}
function fieldDescription(value: I18nText): I18nText {
  return i18n(`${value.zh}字段`, `${value.en} field`, `${value.ja}フィールド`);
}
function relationDescription(value: I18nText): I18nText {
  return i18n(`${value.zh}关系`, `${value.en} relationship`, `${value.ja}関係`);
}

async function retryDesignerWrite<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('atlas.mld') || attempt === 4) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 250));
    }
  }
  throw lastError;
}

async function syncDesignerMetadata(
  modeldb: ModelDB,
  catalog: Awaited<ReturnType<ModelDB['getDatabaseCatalog']>>,
) {
  const designer = await modeldb.use('model_designer_workspace');
  const libraryName = i18n(
    '铁路领域基础图谱',
    'Railway Domain Foundation Graph',
    '鉄道領域基盤グラフ',
  );
  const libraryDescription = i18n(
    '按照 Agent 建模规范建立的线路、路段、轨道区段、地理归属和公共字典图谱。',
    'A railway graph built from the Agent modeling specification for lines, sections, track segments, spatial ownership, and shared dictionaries.',
    'Agent モデリング仕様に基づく鉄道路線、区間、軌道区間、空間帰属、共有辞書のグラフです。',
  );
  const library = await ensureLibraryRecord(designer, {
    code: database,
    name: libraryName,
    description: libraryDescription,
  });
  await updateLibraryMetadata(designer, library, {
    name: libraryName,
    description: libraryDescription,
  });
  await importEngineCatalogIntoDesignerDb(designer, database, catalog);

  const modelRows = (await designer.model(SYS_MODEL).query().execute()) as unknown[];
  const propRows = (await designer.model(SYS_PROPS).query().execute()) as unknown[];
  const relationRows = (await designer.model(SYS_RELATION_DEF).query().execute()) as unknown[];
  const modelRowsWithProps = (await designer
    .model(SYS_MODEL)
    .query()
    .group('modelOwnsProps')
    .execute({ includeRelates: true })) as unknown[];
  const updates: Array<{ model: string; id: string; partial: Record<string, unknown> }> = [];
  const schemaByModel = new Map(schemas.map((entry) => [entry.name, entry.schema]));
  const propModelById = new Map<string, string>();
  for (const raw of modelRowsWithProps) {
    const row = (raw as RemoteHydratedEntity).getData(true);
    if (row.library_code !== database || typeof row.engine_name !== 'string') {
      continue;
    }
    const relates = row.relates as Record<string, unknown> | undefined;
    const props = relates?.modelOwnsProps;
    if (!Array.isArray(props)) {
      continue;
    }
    for (const prop of props) {
      if (prop && typeof prop === 'object' && typeof (prop as { _id?: unknown })._id === 'string') {
        propModelById.set(String((prop as { _id: string })._id), row.engine_name);
      }
    }
  }
  for (const raw of modelRows as unknown[]) {
    const row = (raw as RemoteHydratedEntity).getData();
    if (row.library_code !== database || typeof row._id !== 'string') {
      continue;
    }
    const name = String(row.engine_name ?? '');
    const label = modelLabels[name];
    const position = modelLayout[name];
    if (!label || !position) {
      continue;
    }
    updates.push({
      model: SYS_MODEL,
      id: row._id,
      partial: {
        name: label,
        description: modelDescription(label),
        posX: position.x,
        posY: position.y,
      },
    });
  }
  for (const raw of propRows as unknown[]) {
    const row = (raw as RemoteHydratedEntity).getData();
    if (row.library_code !== database || typeof row._id !== 'string') {
      continue;
    }
    const modelName = propModelById.get(String(row._id)) ?? String(row.model_engine_name ?? '');
    const fieldName = String(row.engine_name ?? '');
    const schema = schemaByModel.get(modelName);
    if (!schema || !(fieldName in schema)) {
      continue;
    }
    const label = labelForField(fieldName);
    updates.push({
      model: SYS_PROPS,
      id: row._id,
      partial: {
        name: label,
        description: fieldDescription(label),
        engineType: dataTypeToEngineCode(typeOfField(schema[fieldName])),
        sort: Object.keys(schema).indexOf(fieldName),
        isRequired:
          typeof schema[fieldName] === 'object' &&
          schema[fieldName] !== null &&
          'required' in schema[fieldName]
            ? Boolean((schema[fieldName] as { required?: unknown }).required)
            : false,
      },
    });
  }
  for (const raw of relationRows as unknown[]) {
    const row = (raw as RemoteHydratedEntity).getData();
    if (row.library_code !== database || typeof row._id !== 'string') {
      continue;
    }
    const relation = relationDefs.find((entry) => entry.forward === row.engine_name);
    if (!relation) {
      continue;
    }
    const labels = relationLabels[relation.forward];
    assert(labels, `missing relation i18n for ${relation.forward}`);
    const label = labels.forward;
    const reverseLabel = labels.reverse;
    const forwardDescription = relationDescription(label);
    const reverseDescription = relationDescription(reverseLabel);
    const logic = relation.logic.split('-to-') as ['one' | 'many', 'one' | 'many'];
    updates.push({
      model: SYS_RELATION_DEF,
      id: row._id,
      partial: {
        name: label,
        description: forwardDescription,
        forwardDescription,
        reverseDescription,
        sourceCardinality: logic[0],
        targetCardinality: logic[1],
        selfLoopPolicy: relation.selfLoopPolicy ?? 'deny',
        canvas_meta: JSON.stringify({
          forward: relation.forward,
          reverse: relation.reverse,
          source: relation.source,
          target: relation.target,
          engineForward: relation.forward,
          engineReverse: relation.reverse,
          forwardNameI18n: label,
          reverseNameI18n: reverseLabel,
          forwardDescriptionI18n: forwardDescription,
          reverseDescriptionI18n: reverseDescription,
        }),
      },
    });
  }
  if (updates.length > 0) {
    const result = await retryDesignerWrite(() => designer.batchUpdate(updates, { sync: true }));
    assert(result.failureCount === 0, 'designer metadata update failed');
  }
  return {
    models: modelRows.filter(
      (raw) => (raw as RemoteHydratedEntity).getData().library_code === database,
    ).length,
    fields: propRows.filter(
      (raw) => (raw as RemoteHydratedEntity).getData().library_code === database,
    ).length,
    relations: relationRows.filter(
      (raw) => (raw as RemoteHydratedEntity).getData().library_code === database,
    ).length,
  };
}

async function main(): Promise<void> {
  assert(connectToken, `connectToken is missing in ${configPath} and MODEL_DB_CONNECT_TOKEN`);
  assert(Number.isInteger(port) && port > 0, 'invalid port');
  validateMetadata();
  const modeldb = new ModelDB({ host, port, token: connectToken, mode: 'short' });
  try {
    const existing = await modeldb.listDatabases();
    if (designerOnly) {
      assert(existing.includes(database), `database "${database}" does not exist`);
      const catalog = await modeldb.getDatabaseCatalog(database);
      const designerMetadata = await syncDesignerMetadata(modeldb, catalog);
      process.stdout.write(
        `${JSON.stringify({ database, designerOnly: true, designerMetadata }, null, 2)}\n`,
      );
      return;
    }
    if (existing.includes(database)) {
      if (!reset) {
        throw new Error(
          `Database "${database}" already exists. Re-run with --reset to regenerate it.`,
        );
      }
      await modeldb.createBackup(database, 'pre-railway-domain-v1-regenerate');
      await modeldb.deleteDatabase(database);
    }
    await modeldb.createDatabase(database);
    const client = await modeldb.use(database);
    const ddl = await client.batchRegister({
      models: schemas.map((entry) => ({ name: entry.name, schema: entry.schema })),
      relations: relationDefs,
    });
    assert(
      ddl.created.models.length === schemas.length,
      'not all new graph models were registered',
    );
    assert(
      ddl.created.relations.length === relationDefs.length,
      'not all new graph relations were registered',
    );

    const idsByModel = new Map<string, Map<string, string>>();
    for (const seed of buildSeeds()) {
      idsByModel.set(seed.model, await insertSeed(client, seed));
    }
    const relationStats: Record<string, unknown> = {};
    for (const relation of relationDefs) {
      const result = await client.bind(relation.forward, 'PROTOCOL', {
        matchOn: relation.matchOn,
        sync: true,
      });
      relationStats[relation.forward] = result.stats;
    }

    const counts: Record<string, number> = {};
    for (const schema of schemas) {
      const rows = await client.model(schema.name).query().execute();
      assert(Array.isArray(rows), `${schema.name} count result is invalid`);
      counts[schema.name] = rows.length;
      assert(rows.length > 0, `${schema.name} has no seeded data`);
    }
    const lineId = idsByModel.get('RailwayLine')!.get('RL-001')!;
    const lineSections = rowData(
      await client.model('RailwayLine').query([lineId]).relate('lineSectionAssignments').execute(),
    );
    assert(lineSections.length === 2, 'line to section assignment query');
    const assignmentId = idsByModel.get('LineSectionAssignment')!.get('LSA-001')!;
    const assignedSection = rowData(
      await client
        .model('LineSectionAssignment')
        .query([assignmentId])
        .relate('assignedSection')
        .execute(),
    );
    assert(assignedSection[0]?.lineSectionCode === 'SEC-001', 'assignment to section query');
    const sectionId = idsByModel.get('LineSection')!.get('SEC-001')!;
    const divisionAssignments = rowData(
      await client
        .model('LineSection')
        .query([sectionId])
        .relate('sectionDivisionAssignments')
        .execute(),
    );
    assert(divisionAssignments.length === 2, 'section to division assignment query');
    const stationId = idsByModel.get('Station')!.get('STA-BJ')!;
    const stationDivision = rowData(
      await client.model('Station').query([stationId]).relate('stationDivision').execute(),
    );
    assert(stationDivision[0]?.divisionCode === 'BJ', 'station to division query');
    const adminId = idsByModel.get('AdministrativeDivision')!.get('CN')!;
    const childDivisions = rowData(
      await client
        .model('AdministrativeDivision')
        .query([adminId])
        .relate('childDivisions')
        .execute(),
    );
    assert(childDivisions.length === 3, 'administrative division hierarchy query');
    const lineStatus = rowData(
      await client.model('RailwayLine').query([lineId]).relate('lineStatus').execute(),
    );
    assert(lineStatus[0]?.statusCode === 'ACTIVE', 'public status dictionary query');
    const lineUnit = rowData(
      await client.model('RailwayLine').query([lineId]).relate('lineMeasurementUnit').execute(),
    );
    assert(lineUnit[0]?.unitCode === 'KM', 'public unit dictionary query');
    const catalog = await modeldb.getDatabaseCatalog(database);
    assert(
      catalog.models.length === schemas.length && catalog.relations.length === relationDefs.length,
      'new graph catalog size',
    );
    const designerMetadata = await syncDesignerMetadata(modeldb, catalog);
    const localizedCatalog = await modeldb.getDatabaseCatalog(database);
    assert(localizedCatalog.displayName?.zh === '铁路领域基础图谱', 'database display name');
    assert(
      localizedCatalog.models.every((model) => Object.keys(model.displayName ?? {}).length > 0),
      'model display names',
    );
    const report = {
      generatedAt: new Date().toISOString(),
      database,
      server: `${host}:${port}`,
      graphSpec: 'railway_domain_v1',
      models: schemas.length,
      relations: relationDefs.length,
      totalRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
      counts,
      dataSplitMetadata,
      relationStats,
      designerMetadata,
      queryChecks: {
        lineSectionAssignments: lineSections.length,
        assignedSection: assignedSection[0]?.lineSectionCode,
        sectionDivisionAssignments: divisionAssignments.length,
        stationDivision: stationDivision[0]?.divisionCode,
        childDivisions: childDivisions.length,
        lineStatus: lineStatus[0]?.statusCode,
        lineMeasurementUnit: lineUnit[0]?.unitCode,
      },
    };
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    modeldb.releaseClient(database);
    modeldb.releaseClient('model_designer_workspace');
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
