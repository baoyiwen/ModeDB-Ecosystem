#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DataType, type FieldDefsRecord } from '@mode-db/common';
import { ModelDB, type RemoteHydratedEntity } from '@mode-db/sdk';
import { importEngineCatalogIntoDesignerDb } from '../apps/model-designer/src/sync/engine-catalog-import.js';
import {
  ensureLibraryRecord,
  updateLibraryMetadata,
} from '../apps/model-designer/src/sync/library-registry.js';

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

type RelationSeed = {
  readonly forward: string;
  readonly strategy: 'PROTOCOL' | 'MANUAL';
  readonly matchOn?: { readonly sourceField: string; readonly targetField: string };
  readonly pairs?: ReadonlyArray<readonly [string, string]>;
};

type MetaEntry = {
  readonly code: string;
  readonly name: I18nText;
  readonly description?: I18nText;
  readonly extras?: Readonly<Record<string, unknown>>;
};

type MetaCatalog = {
  readonly model: string;
  readonly prefix: string;
  readonly entries: readonly MetaEntry[];
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

const configPath = resolve(option('--config') ?? 'modeldb.config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as ServerFileConfig;
const host = option('--host') ?? config.host ?? '127.0.0.1';
const port = Number(option('--port') ?? config.port ?? 9090);
const database = option('--database') ?? 'railway_operations_demo';
const rowCount = Math.max(20, Number(option('--rows') ?? 100));
const reset = argv.includes('--reset');
const designerOnly = argv.includes('--designer-only');
const connectToken =
  config.connectToken?.trim() || process.env.MODEL_DB_CONNECT_TOKEN?.trim() || '';

assert(connectToken, `connectToken is missing in ${configPath} and MODEL_DB_CONNECT_TOKEN`);
assert(Number.isInteger(port) && port > 0, `invalid server port: ${String(port)}`);
assert(Number.isInteger(rowCount), `--rows must be an integer: ${String(rowCount)}`);

const workspaceSetting = config.workspace?.trim() || 'vault';
const workspaceRoot = isAbsolute(workspaceSetting)
  ? workspaceSetting
  : resolve(dirname(configPath), workspaceSetting);
const reportPath = resolve(workspaceRoot, database, 'validation-report.json');

const i18n = (zh: string, en: string, ja: string): I18nText => ({ zh, en, ja });
const pad = (value: number, width = 3): string => String(value).padStart(width, '0');
const iso = (dayOffset: number, hour = 8, minute = 0): string => {
  const value = new Date(Date.UTC(2026, 0, 1 + dayOffset, hour, minute, 0));
  return value.toISOString();
};

const metaEntry = (
  code: string,
  zh: string,
  en: string,
  ja: string,
  extras?: Readonly<Record<string, unknown>>,
): MetaEntry => ({ code, name: i18n(zh, en, ja), ...(extras ? { extras } : {}) });

const metaSchema: FieldDefsRecord = {
  metaCode: { type: DataType.String, required: true },
  name: { type: DataType.I18N, required: true },
  description: DataType.I18N,
  active: { type: DataType.Boolean, required: true, default: true },
  sortOrder: DataType.Int,
};

const assetSchema: FieldDefsRecord = {
  assetCode: { type: DataType.String, required: true },
  assetName: { type: DataType.I18N, required: true },
  assetTypeCode: { type: DataType.String, required: true },
  inService: { type: DataType.Boolean, required: true, default: true },
  commissionedAt: DataType.DateTime,
  color: DataType.Color,
  location: DataType.JSON,
};

const schemas: ReadonlyArray<{
  readonly name: string;
  readonly schema: FieldDefsRecord;
  readonly parentId?: string;
}> = [
  { name: 'MetaDefinition', schema: metaSchema },
  {
    name: 'UnitDefinition',
    parentId: 'MetaDefinition',
    schema: {
      ...metaSchema,
      symbol: { type: DataType.String, required: true },
      quantityKind: { type: DataType.String, required: true },
      decimalScale: DataType.Int,
    },
  },
  {
    name: 'Region',
    parentId: 'MetaDefinition',
    schema: { ...metaSchema, countryCode: DataType.String, timezone: DataType.String },
  },
  ...[
    'AssetType',
    'StationLevel',
    'LineClass',
    'TrainType',
    'ServiceStatus',
    'CarriageType',
    'EmployeeRole',
    'ShiftType',
    'WorkOrderCategory',
    'WorkOrderPriority',
    'WorkOrderStatus',
    'IncidentType',
    'IncidentSeverity',
    'TravelClass',
    'SalesChannel',
    'TicketStatus',
  ].map((name) => ({ name, parentId: 'MetaDefinition', schema: metaSchema })),
  { name: 'RailwayAsset', schema: assetSchema },
  {
    name: 'Station',
    parentId: 'RailwayAsset',
    schema: {
      ...assetSchema,
      stationCode: { type: DataType.String, required: true },
      regionCode: { type: DataType.String, required: true },
      stationLevelCode: { type: DataType.String, required: true },
      platformCount: DataType.Int,
      dailyPassengers: DataType.Int,
      longitude: DataType.Number,
      latitude: DataType.Number,
    },
  },
  {
    name: 'RailwayLine',
    parentId: 'RailwayAsset',
    schema: {
      ...assetSchema,
      lineCode: { type: DataType.String, required: true },
      operatorCode: { type: DataType.String, required: true },
      lineClassCode: { type: DataType.String, required: true },
      lengthValue: DataType.Number,
      lengthUnitCode: { type: DataType.String, required: true },
      maxSpeedValue: DataType.Number,
      speedUnitCode: { type: DataType.String, required: true },
      electrified: DataType.Boolean,
    },
  },
  {
    name: 'Train',
    parentId: 'RailwayAsset',
    schema: {
      ...assetSchema,
      trainCode: { type: DataType.String, required: true },
      operatorCode: { type: DataType.String, required: true },
      trainTypeCode: { type: DataType.String, required: true },
      maxSpeedValue: DataType.Number,
      speedUnitCode: { type: DataType.String, required: true },
      seatCapacity: DataType.Int,
      mileageValue: DataType.Number,
      mileageUnitCode: { type: DataType.String, required: true },
    },
  },
  {
    name: 'Operator',
    schema: {
      operatorCode: { type: DataType.String, required: true },
      name: { type: DataType.I18N, required: true },
      headquarters: DataType.String,
      foundedAt: DataType.DateTime,
      active: DataType.Boolean,
      serviceRating: DataType.Number,
    },
  },
  {
    name: 'TrainService',
    schema: {
      serviceNo: { type: DataType.String, required: true },
      lineCode: { type: DataType.String, required: true },
      trainCode: { type: DataType.String, required: true },
      businessDate: DataType.DateTime,
      plannedDeparture: DataType.DateTime,
      plannedArrival: DataType.DateTime,
      statusCode: { type: DataType.String, required: true },
      delayMinutes: DataType.Int,
      passengerLoad: DataType.Number,
      energyValue: DataType.Number,
      energyUnitCode: { type: DataType.String, required: true },
    },
  },
  {
    name: 'ServiceStop',
    schema: {
      stopCode: { type: DataType.String, required: true },
      serviceNo: { type: DataType.String, required: true },
      stationCode: { type: DataType.String, required: true },
      sequence: DataType.Int,
      arrivalAt: DataType.DateTime,
      departureAt: DataType.DateTime,
      platform: DataType.String,
      dwellMinutes: DataType.Int,
    },
  },
  {
    name: 'Carriage',
    schema: {
      carriageCode: { type: DataType.String, required: true },
      trainCode: { type: DataType.String, required: true },
      position: DataType.Int,
      carriageTypeCode: { type: DataType.String, required: true },
      seatCapacity: DataType.Int,
      accessible: DataType.Boolean,
      occupancyRate: DataType.Number,
    },
  },
  {
    name: 'Employee',
    schema: {
      employeeCode: { type: DataType.String, required: true },
      operatorCode: { type: DataType.String, required: true },
      name: { type: DataType.I18N, required: true },
      roleCode: { type: DataType.String, required: true },
      certification: DataType.JSON,
      yearsOfService: DataType.Int,
      onDuty: DataType.Boolean,
    },
  },
  {
    name: 'Shift',
    schema: {
      shiftCode: { type: DataType.String, required: true },
      stationCode: { type: DataType.String, required: true },
      shiftTypeCode: { type: DataType.String, required: true },
      startsAt: DataType.DateTime,
      endsAt: DataType.DateTime,
      requiredStaff: DataType.Int,
      emergency: DataType.Boolean,
    },
  },
  {
    name: 'WorkOrder',
    schema: {
      orderCode: { type: DataType.String, required: true },
      assetCode: { type: DataType.String, required: true },
      categoryCode: { type: DataType.String, required: true },
      priorityCode: { type: DataType.String, required: true },
      statusCode: { type: DataType.String, required: true },
      openedAt: DataType.DateTime,
      dueAt: DataType.DateTime,
      estimatedCostValue: DataType.Number,
      currencyUnitCode: { type: DataType.String, required: true },
      description: DataType.I18N,
    },
  },
  {
    name: 'Incident',
    schema: {
      incidentCode: { type: DataType.String, required: true },
      serviceNo: { type: DataType.String, required: true },
      stationCode: { type: DataType.String, required: true },
      incidentTypeCode: { type: DataType.String, required: true },
      severityCode: { type: DataType.String, required: true },
      occurredAt: DataType.DateTime,
      resolved: DataType.Boolean,
      impactMinutes: DataType.Int,
      description: DataType.I18N,
      evidence: DataType.JSON,
    },
  },
  {
    name: 'Ticket',
    schema: {
      ticketNo: { type: DataType.String, required: true },
      serviceNo: { type: DataType.String, required: true },
      travelClassCode: { type: DataType.String, required: true },
      originStationCode: DataType.String,
      destinationStationCode: DataType.String,
      fareValue: DataType.Number,
      currencyUnitCode: { type: DataType.String, required: true },
      soldAt: DataType.DateTime,
      salesChannelCode: { type: DataType.String, required: true },
      ticketStatusCode: { type: DataType.String, required: true },
    },
  },
];

const relationDefs = [
  {
    source: 'RailwayAsset',
    target: 'AssetType',
    forward: 'assetTypeRef',
    reverse: 'typedAssets',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'assetTypeCode', targetField: 'metaCode' },
  },
  {
    source: 'Station',
    target: 'Region',
    forward: 'stationRegionRef',
    reverse: 'stationsInRegion',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'regionCode', targetField: 'metaCode' },
  },
  {
    source: 'Station',
    target: 'StationLevel',
    forward: 'stationLevelRef',
    reverse: 'stationsAtLevel',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'stationLevelCode', targetField: 'metaCode' },
  },
  {
    source: 'RailwayLine',
    target: 'LineClass',
    forward: 'lineClassRef',
    reverse: 'linesAtClass',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'lineClassCode', targetField: 'metaCode' },
  },
  {
    source: 'RailwayLine',
    target: 'UnitDefinition',
    forward: 'lineLengthUnit',
    reverse: 'lineLengthValues',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'lengthUnitCode', targetField: 'metaCode' },
  },
  {
    source: 'RailwayLine',
    target: 'UnitDefinition',
    forward: 'lineSpeedUnit',
    reverse: 'lineSpeedValues',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'speedUnitCode', targetField: 'metaCode' },
  },
  {
    source: 'Train',
    target: 'TrainType',
    forward: 'trainTypeRef',
    reverse: 'typedTrains',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'trainTypeCode', targetField: 'metaCode' },
  },
  {
    source: 'Train',
    target: 'UnitDefinition',
    forward: 'trainSpeedUnit',
    reverse: 'trainSpeedValues',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'speedUnitCode', targetField: 'metaCode' },
  },
  {
    source: 'Train',
    target: 'UnitDefinition',
    forward: 'trainMileageUnit',
    reverse: 'trainMileageValues',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'mileageUnitCode', targetField: 'metaCode' },
  },
  {
    source: 'TrainService',
    target: 'ServiceStatus',
    forward: 'serviceStatusRef',
    reverse: 'servicesAtStatus',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'statusCode', targetField: 'metaCode' },
  },
  {
    source: 'TrainService',
    target: 'UnitDefinition',
    forward: 'serviceEnergyUnit',
    reverse: 'serviceEnergyValues',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'energyUnitCode', targetField: 'metaCode' },
  },
  {
    source: 'Carriage',
    target: 'CarriageType',
    forward: 'carriageTypeRef',
    reverse: 'typedCarriages',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'carriageTypeCode', targetField: 'metaCode' },
  },
  {
    source: 'Employee',
    target: 'EmployeeRole',
    forward: 'employeeRoleRef',
    reverse: 'employeesAtRole',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'roleCode', targetField: 'metaCode' },
  },
  {
    source: 'Shift',
    target: 'ShiftType',
    forward: 'shiftTypeRef',
    reverse: 'shiftsAtType',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'shiftTypeCode', targetField: 'metaCode' },
  },
  {
    source: 'WorkOrder',
    target: 'WorkOrderCategory',
    forward: 'workOrderCategoryRef',
    reverse: 'workOrdersAtCategory',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'categoryCode', targetField: 'metaCode' },
  },
  {
    source: 'WorkOrder',
    target: 'WorkOrderPriority',
    forward: 'workOrderPriorityRef',
    reverse: 'workOrdersAtPriority',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'priorityCode', targetField: 'metaCode' },
  },
  {
    source: 'WorkOrder',
    target: 'WorkOrderStatus',
    forward: 'workOrderStatusRef',
    reverse: 'workOrdersAtStatus',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'statusCode', targetField: 'metaCode' },
  },
  {
    source: 'WorkOrder',
    target: 'UnitDefinition',
    forward: 'workOrderCurrencyUnit',
    reverse: 'workOrderCostValues',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'currencyUnitCode', targetField: 'metaCode' },
  },
  {
    source: 'Incident',
    target: 'IncidentType',
    forward: 'incidentTypeRef',
    reverse: 'incidentsAtType',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'incidentTypeCode', targetField: 'metaCode' },
  },
  {
    source: 'Incident',
    target: 'IncidentSeverity',
    forward: 'incidentSeverityRef',
    reverse: 'incidentsAtSeverity',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'severityCode', targetField: 'metaCode' },
  },
  {
    source: 'Ticket',
    target: 'TravelClass',
    forward: 'travelClassRef',
    reverse: 'ticketsAtClass',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'travelClassCode', targetField: 'metaCode' },
  },
  {
    source: 'Ticket',
    target: 'SalesChannel',
    forward: 'salesChannelRef',
    reverse: 'ticketsFromChannel',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'salesChannelCode', targetField: 'metaCode' },
  },
  {
    source: 'Ticket',
    target: 'TicketStatus',
    forward: 'ticketStatusRef',
    reverse: 'ticketsAtStatus',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'ticketStatusCode', targetField: 'metaCode' },
  },
  {
    source: 'Ticket',
    target: 'UnitDefinition',
    forward: 'ticketCurrencyUnit',
    reverse: 'ticketFareValues',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'currencyUnitCode', targetField: 'metaCode' },
  },
  {
    source: 'Ticket',
    target: 'Station',
    forward: 'originStationRef',
    reverse: 'originatingTickets',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'originStationCode', targetField: 'stationCode' },
  },
  {
    source: 'Ticket',
    target: 'Station',
    forward: 'destinationStationRef',
    reverse: 'destinationTickets',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'destinationStationCode', targetField: 'stationCode' },
  },
  {
    source: 'Station',
    target: 'Station',
    forward: 'subStations',
    reverse: 'parentStation',
    logic: 'one-to-many' as const,
    selfLoopPolicy: 'deny' as const,
  },
  {
    source: 'RailwayLine',
    target: 'Station',
    forward: 'stations',
    reverse: 'lines',
    logic: 'many-to-many' as const,
  },
  {
    source: 'RailwayLine',
    target: 'Operator',
    forward: 'lineOperator',
    reverse: 'operatedLines',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'operatorCode', targetField: 'operatorCode' },
  },
  {
    source: 'Train',
    target: 'Operator',
    forward: 'trainOperator',
    reverse: 'operatedTrains',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'operatorCode', targetField: 'operatorCode' },
  },
  {
    source: 'TrainService',
    target: 'RailwayLine',
    forward: 'line',
    reverse: 'scheduledServices',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'lineCode', targetField: 'lineCode' },
  },
  {
    source: 'TrainService',
    target: 'Train',
    forward: 'assignedTrain',
    reverse: 'trainServices',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'trainCode', targetField: 'trainCode' },
  },
  {
    source: 'ServiceStop',
    target: 'TrainService',
    forward: 'stopService',
    reverse: 'stops',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'serviceNo', targetField: 'serviceNo' },
  },
  {
    source: 'ServiceStop',
    target: 'Station',
    forward: 'stopStation',
    reverse: 'scheduledStops',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'stationCode', targetField: 'stationCode' },
  },
  {
    source: 'Carriage',
    target: 'Train',
    forward: 'train',
    reverse: 'carriages',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'trainCode', targetField: 'trainCode' },
  },
  {
    source: 'Employee',
    target: 'Operator',
    forward: 'employer',
    reverse: 'employees',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'operatorCode', targetField: 'operatorCode' },
  },
  {
    source: 'Shift',
    target: 'Station',
    forward: 'shiftStation',
    reverse: 'shifts',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'stationCode', targetField: 'stationCode' },
  },
  {
    source: 'Employee',
    target: 'Shift',
    forward: 'assignedShifts',
    reverse: 'assignedEmployees',
    logic: 'many-to-many' as const,
  },
  {
    source: 'WorkOrder',
    target: 'RailwayAsset',
    forward: 'asset',
    reverse: 'workOrders',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'assetCode', targetField: 'assetCode' },
  },
  {
    source: 'Incident',
    target: 'TrainService',
    forward: 'incidentService',
    reverse: 'incidents',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'serviceNo', targetField: 'serviceNo' },
  },
  {
    source: 'Incident',
    target: 'Station',
    forward: 'incidentStation',
    reverse: 'incidentsAt',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'stationCode', targetField: 'stationCode' },
  },
  {
    source: 'Ticket',
    target: 'TrainService',
    forward: 'ticketService',
    reverse: 'tickets',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'serviceNo', targetField: 'serviceNo' },
  },
] as const;

const modelLabels: Readonly<Record<string, I18nText>> = {
  MetaDefinition: i18n('元数据定义', 'Metadata Definition', 'メタデータ定義'),
  UnitDefinition: i18n('计量单位', 'Unit Definition', '計量単位'),
  Region: i18n('运营区域', 'Region', '運行地域'),
  AssetType: i18n('资产类型', 'Asset Type', '資産種別'),
  StationLevel: i18n('车站等级', 'Station Level', '駅等級'),
  LineClass: i18n('线路等级', 'Line Class', '路線区分'),
  TrainType: i18n('列车类型', 'Train Type', '列車種別'),
  ServiceStatus: i18n('车次状态', 'Service Status', '列車運行状態'),
  CarriageType: i18n('车厢类型', 'Carriage Type', '車両種別'),
  EmployeeRole: i18n('员工岗位', 'Employee Role', '従業員職務'),
  ShiftType: i18n('班次类型', 'Shift Type', '勤務種別'),
  WorkOrderCategory: i18n('工单类别', 'Work Order Category', '作業分類'),
  WorkOrderPriority: i18n('工单优先级', 'Work Order Priority', '作業優先度'),
  WorkOrderStatus: i18n('工单状态', 'Work Order Status', '作業状態'),
  IncidentType: i18n('事件类型', 'Incident Type', '事象種別'),
  IncidentSeverity: i18n('事件严重度', 'Incident Severity', '事象重大度'),
  TravelClass: i18n('席别', 'Travel Class', '座席等級'),
  SalesChannel: i18n('销售渠道', 'Sales Channel', '販売チャネル'),
  TicketStatus: i18n('客票状态', 'Ticket Status', '乗車券状態'),
  RailwayAsset: i18n('铁路资产', 'Railway Asset', '鉄道資産'),
  Station: i18n('车站', 'Station', '駅'),
  RailwayLine: i18n('铁路线路', 'Railway Line', '鉄道路線'),
  Train: i18n('列车', 'Train', '列車'),
  Operator: i18n('运营商', 'Operator', '鉄道事業者'),
  TrainService: i18n('车次运行', 'Train Service', '列車運行'),
  ServiceStop: i18n('车次停靠', 'Service Stop', '列車停車'),
  Carriage: i18n('车厢', 'Carriage', '車両'),
  Employee: i18n('员工', 'Employee', '従業員'),
  Shift: i18n('班次', 'Shift', '勤務シフト'),
  WorkOrder: i18n('维修工单', 'Work Order', '保守作業指示'),
  Incident: i18n('运营事件', 'Incident', '運行事象'),
  Ticket: i18n('客票', 'Ticket', '乗車券'),
};

const fieldLabelParts: Readonly<Record<string, readonly [zh: string, ja: string]>> = {
  metaCode: ['元数据编码', 'メタデータコード'],
  description: ['描述', '説明'],
  sortOrder: ['排序序号', '表示順'],
  symbol: ['单位符号', '単位記号'],
  quantityKind: ['量纲类型', '量の種類'],
  decimalScale: ['小数精度', '小数精度'],
  countryCode: ['国家代码', '国コード'],
  timezone: ['时区', 'タイムゾーン'],
  assetCode: ['资产编码', '資産コード'],
  assetName: ['资产名称', '資産名'],
  assetTypeCode: ['资产类型编码', '資産種別コード'],
  assetType: ['资产类型', '資産種別'],
  inService: ['是否在役', '稼働中'],
  commissionedAt: ['投运时间', '供用開始日時'],
  color: ['标识颜色', '識別色'],
  location: ['位置信息', '位置情報'],
  stationCode: ['车站编码', '駅コード'],
  regionCode: ['区域编码', '地域コード'],
  stationLevelCode: ['车站等级编码', '駅等級コード'],
  stationLevel: ['车站等级', '駅等級'],
  platformCount: ['站台数量', 'ホーム数'],
  dailyPassengers: ['日均客流', '一日平均利用者数'],
  longitude: ['经度', '経度'],
  latitude: ['纬度', '緯度'],
  lineCode: ['线路编码', '路線コード'],
  operatorCode: ['运营商编码', '事業者コード'],
  lineClassCode: ['线路等级编码', '路線区分コード'],
  lengthValue: ['线路长度值', '路線長値'],
  lengthUnitCode: ['长度单位编码', '長さ単位コード'],
  maxSpeedValue: ['最高速度值', '最高速度値'],
  speedUnitCode: ['速度单位编码', '速度単位コード'],
  lineClass: ['线路等级', '路線区分'],
  length: ['线路长度', '路線長'],
  maxSpeed: ['最高速度', '最高速度'],
  electrified: ['是否电气化', '電化済み'],
  trainCode: ['列车编码', '列車コード'],
  trainTypeCode: ['列车类型编码', '列車種別コード'],
  mileageValue: ['累计里程值', '累積走行距離値'],
  mileageUnitCode: ['里程单位编码', '走行距離単位コード'],
  trainType: ['列车类型', '列車種別'],
  seatCapacity: ['座席容量', '座席定員'],
  mileage: ['累计里程', '累積走行距離'],
  name: ['名称', '名称'],
  headquarters: ['总部所在地', '本社所在地'],
  foundedAt: ['成立时间', '設立日時'],
  active: ['是否有效', '有効'],
  serviceRating: ['服务评分', 'サービス評価'],
  serviceNo: ['车次编号', '列車番号'],
  businessDate: ['运营日期', '運行日'],
  plannedDeparture: ['计划发车时间', '発車予定時刻'],
  plannedArrival: ['计划到达时间', '到着予定時刻'],
  statusCode: ['状态编码', '状態コード'],
  status: ['状态', '状態'],
  delayMinutes: ['延误分钟', '遅延分数'],
  passengerLoad: ['客座率', '乗車率'],
  energyValue: ['能源消耗值', 'エネルギー使用量値'],
  energyUnitCode: ['能源单位编码', 'エネルギー単位コード'],
  energyUsed: ['能源消耗', 'エネルギー使用量'],
  stopCode: ['停靠编码', '停車コード'],
  sequence: ['停靠顺序', '停車順序'],
  arrivalAt: ['到达时间', '到着時刻'],
  departureAt: ['发车时间', '発車時刻'],
  platform: ['站台', 'ホーム'],
  dwellMinutes: ['停站分钟', '停車分数'],
  carriageCode: ['车厢编码', '車両コード'],
  carriageTypeCode: ['车厢类型编码', '車両種別コード'],
  position: ['编组位置', '編成位置'],
  carriageType: ['车厢类型', '車両種別'],
  accessible: ['无障碍设施', 'バリアフリー対応'],
  occupancyRate: ['车厢占用率', '車両占有率'],
  employeeCode: ['员工编码', '従業員コード'],
  roleCode: ['岗位角色编码', '職務コード'],
  role: ['岗位角色', '職務'],
  certification: ['资质证书', '資格情報'],
  yearsOfService: ['从业年限', '勤続年数'],
  onDuty: ['是否在岗', '勤務中'],
  shiftCode: ['班次编码', 'シフトコード'],
  shiftTypeCode: ['班次类型编码', 'シフト種別コード'],
  shiftType: ['班次类型', 'シフト種別'],
  startsAt: ['开始时间', '開始時刻'],
  endsAt: ['结束时间', '終了時刻'],
  requiredStaff: ['所需人数', '必要人数'],
  emergency: ['应急班次', '緊急シフト'],
  orderCode: ['工单编码', '作業指示コード'],
  categoryCode: ['类别编码', 'カテゴリコード'],
  priorityCode: ['优先级编码', '優先度コード'],
  category: ['类别', 'カテゴリ'],
  priority: ['优先级', '優先度'],
  openedAt: ['创建时间', '作成日時'],
  dueAt: ['截止时间', '期限日時'],
  estimatedCostValue: ['预计成本值', '見積費用値'],
  currencyUnitCode: ['货币单位编码', '通貨単位コード'],
  estimatedCost: ['预计成本', '見積費用'],
  incidentCode: ['事件编码', '事象コード'],
  incidentTypeCode: ['事件类型编码', '事象種別コード'],
  severityCode: ['严重程度编码', '重大度コード'],
  severity: ['严重程度', '重大度'],
  occurredAt: ['发生时间', '発生日時'],
  resolved: ['是否解决', '解決済み'],
  impactMinutes: ['影响分钟', '影響分数'],
  evidence: ['证据信息', '証拠情報'],
  ticketNo: ['客票编号', '乗車券番号'],
  travelClassCode: ['席别编码', '座席等級コード'],
  travelClass: ['席别', '座席等級'],
  originStationCode: ['出发站编码', '出発駅コード'],
  destinationStationCode: ['到达站编码', '到着駅コード'],
  fareValue: ['票价值', '運賃値'],
  fare: ['票价', '運賃'],
  soldAt: ['售票时间', '発売日時'],
  salesChannelCode: ['销售渠道编码', '販売チャネルコード'],
  ticketStatusCode: ['客票状态编码', '乗車券状態コード'],
  salesChannel: ['销售渠道', '販売チャネル'],
  refunded: ['是否退票', '払戻済み'],
};

const relationLabelParts: Readonly<
  Record<
    string,
    { readonly forward: readonly [string, string]; readonly reverse: readonly [string, string] }
  >
> = {
  assetTypeRef: { forward: ['资产类型', '資産種別'], reverse: ['该类型资产', '当該種別の資産'] },
  stationRegionRef: { forward: ['所属区域', '所属地域'], reverse: ['区域内车站', '地域内の駅'] },
  stationLevelRef: { forward: ['车站等级', '駅等級'], reverse: ['该等级车站', '当該等級の駅'] },
  lineClassRef: { forward: ['线路等级', '路線区分'], reverse: ['该等级线路', '当該区分の路線'] },
  lineLengthUnit: { forward: ['长度单位', '長さ単位'], reverse: ['线路长度量值', '路線長の値'] },
  lineSpeedUnit: {
    forward: ['线路速度单位', '路線速度単位'],
    reverse: ['线路速度量值', '路線速度の値'],
  },
  trainTypeRef: { forward: ['列车类型', '列車種別'], reverse: ['该类型列车', '当該種別の列車'] },
  trainSpeedUnit: {
    forward: ['列车速度单位', '列車速度単位'],
    reverse: ['列车速度量值', '列車速度の値'],
  },
  trainMileageUnit: {
    forward: ['里程单位', '走行距離単位'],
    reverse: ['列车里程量值', '列車走行距離の値'],
  },
  serviceStatusRef: {
    forward: ['运行状态', '運行状態'],
    reverse: ['该状态车次', '当該状態の運行'],
  },
  serviceEnergyUnit: {
    forward: ['能源单位', 'エネルギー単位'],
    reverse: ['车次能源量值', '運行エネルギーの値'],
  },
  carriageTypeRef: { forward: ['车厢类型', '車両種別'], reverse: ['该类型车厢', '当該種別の車両'] },
  employeeRoleRef: {
    forward: ['员工岗位', '従業員職務'],
    reverse: ['该岗位员工', '当該職務の従業員'],
  },
  shiftTypeRef: { forward: ['班次类型', '勤務種別'], reverse: ['该类型班次', '当該種別の勤務'] },
  workOrderCategoryRef: {
    forward: ['工单类别', '作業分類'],
    reverse: ['该类别工单', '当該分類の作業'],
  },
  workOrderPriorityRef: {
    forward: ['工单优先级', '作業優先度'],
    reverse: ['该优先级工单', '当該優先度の作業'],
  },
  workOrderStatusRef: {
    forward: ['工单状态', '作業状態'],
    reverse: ['该状态工单', '当該状態の作業'],
  },
  workOrderCurrencyUnit: {
    forward: ['成本货币单位', '費用通貨単位'],
    reverse: ['工单成本量值', '作業費用の値'],
  },
  incidentTypeRef: { forward: ['事件类型', '事象種別'], reverse: ['该类型事件', '当該種別の事象'] },
  incidentSeverityRef: {
    forward: ['严重程度', '重大度'],
    reverse: ['该程度事件', '当該重大度の事象'],
  },
  travelClassRef: {
    forward: ['席别', '座席等級'],
    reverse: ['该席别客票', '当該座席等級の乗車券'],
  },
  salesChannelRef: {
    forward: ['销售渠道', '販売チャネル'],
    reverse: ['渠道客票', 'チャネル別乗車券'],
  },
  ticketStatusRef: {
    forward: ['客票状态', '乗車券状態'],
    reverse: ['该状态客票', '当該状態の乗車券'],
  },
  ticketCurrencyUnit: {
    forward: ['票价货币单位', '運賃通貨単位'],
    reverse: ['客票票价量值', '乗車券運賃の値'],
  },
  originStationRef: { forward: ['出发车站', '出発駅'], reverse: ['始发客票', '出発乗車券'] },
  destinationStationRef: { forward: ['到达车站', '到着駅'], reverse: ['到达客票', '到着乗車券'] },
  subStations: { forward: ['下属车站', '子駅'], reverse: ['上级车站', '親駅'] },
  stations: { forward: ['途经车站', '停車駅'], reverse: ['途经线路', '経由路線'] },
  lineOperator: { forward: ['线路运营商', '路線事業者'], reverse: ['运营线路', '運営路線'] },
  trainOperator: { forward: ['列车运营商', '列車事業者'], reverse: ['运营列车', '運営列車'] },
  line: { forward: ['所属线路', '所属路線'], reverse: ['开行车次', '運行列車'] },
  assignedTrain: { forward: ['担当列车', '担当列車'], reverse: ['执行车次', '担当運行'] },
  stopService: { forward: ['所属车次', '所属列車'], reverse: ['停靠记录', '停車記録'] },
  stopStation: { forward: ['停靠车站', '停車駅'], reverse: ['到发记录', '発着記録'] },
  train: { forward: ['所属列车', '所属列車'], reverse: ['编组车厢', '編成車両'] },
  employer: { forward: ['所属运营商', '所属事業者'], reverse: ['所属员工', '所属従業員'] },
  shiftStation: { forward: ['值守车站', '勤務駅'], reverse: ['车站班次', '駅シフト'] },
  assignedShifts: { forward: ['分配班次', '割当シフト'], reverse: ['值班员工', '勤務従業員'] },
  asset: { forward: ['维护资产', '保守資産'], reverse: ['维修工单', '保守作業指示'] },
  incidentService: { forward: ['涉及车次', '関連列車'], reverse: ['运营事件', '運行事象'] },
  incidentStation: { forward: ['发生车站', '発生駅'], reverse: ['车站事件', '駅事象'] },
  ticketService: { forward: ['乘坐车次', '乗車列車'], reverse: ['关联客票', '関連乗車券'] },
};

function humanizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fieldLabel(field: string): I18nText {
  const parts = fieldLabelParts[field];
  assert(parts, `missing field i18n for ${field}`);
  return i18n(parts[0], humanizeIdentifier(field), parts[1]);
}

function relationLabel(engineName: string, direction: 'forward' | 'reverse'): I18nText {
  const labels = relationLabelParts[engineName];
  assert(labels, `missing relation i18n for ${engineName}`);
  const relation = relationDefs.find((item) => item.forward === engineName);
  assert(relation, `missing relation definition for ${engineName}`);
  const uniqueName = direction === 'forward' ? relation.forward : relation.reverse;
  const parts = labels[direction];
  return i18n(parts[0], humanizeIdentifier(uniqueName), parts[1]);
}

function hydrateRows(rows: unknown): Record<string, unknown>[] {
  assert(Array.isArray(rows), 'designer metadata query must return an array');
  return rows.map((row) => {
    assert(row && typeof row === 'object' && 'getData' in row, 'designer row must be hydrated');
    return (row as RemoteHydratedEntity).getData(true);
  });
}

async function retryDesignerImport<T>(operation: () => Promise<T>): Promise<T> {
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

const modelLayout: Readonly<Record<string, Readonly<{ x: number; y: number }>>> = {
  MetaDefinition: { x: 2_700, y: 80 },
  UnitDefinition: { x: 120, y: 680 },
  Region: { x: 720, y: 680 },
  AssetType: { x: 1_320, y: 680 },
  StationLevel: { x: 1_920, y: 680 },
  LineClass: { x: 2_520, y: 680 },
  TrainType: { x: 3_120, y: 680 },
  ServiceStatus: { x: 3_720, y: 680 },
  CarriageType: { x: 4_320, y: 680 },
  EmployeeRole: { x: 4_920, y: 680 },
  ShiftType: { x: 120, y: 1_300 },
  WorkOrderCategory: { x: 720, y: 1_300 },
  WorkOrderPriority: { x: 1_320, y: 1_300 },
  WorkOrderStatus: { x: 1_920, y: 1_300 },
  IncidentType: { x: 2_520, y: 1_300 },
  IncidentSeverity: { x: 3_120, y: 1_300 },
  TravelClass: { x: 3_720, y: 1_300 },
  SalesChannel: { x: 4_320, y: 1_300 },
  TicketStatus: { x: 4_920, y: 1_300 },
  RailwayAsset: { x: 2_520, y: 2_050 },
  Station: { x: 900, y: 2_720 },
  RailwayLine: { x: 1_900, y: 2_720 },
  Train: { x: 3_100, y: 2_720 },
  Operator: { x: 4_500, y: 2_720 },
  TrainService: { x: 2_500, y: 3_650 },
  ServiceStop: { x: 1_500, y: 4_650 },
  Carriage: { x: 3_650, y: 3_650 },
  Employee: { x: 4_850, y: 3_650 },
  Shift: { x: 4_850, y: 4_650 },
  WorkOrder: { x: 3_650, y: 4_650 },
  Incident: { x: 2_550, y: 4_650 },
  Ticket: { x: 350, y: 4_650 },
};

async function syncDesignerMetadata(
  modeldb: ModelDB,
  catalog: Awaited<ReturnType<ModelDB['getDatabaseCatalog']>>,
): Promise<{ readonly models: number; readonly fields: number; readonly relations: number }> {
  const designer = await modeldb.use('model_designer_workspace');
  const libraryName = i18n(
    '铁路运营验证库',
    'Railway Operations Validation',
    '鉄道運行検証データベース',
  );
  const libraryDescription = i18n(
    '用于验证铁路模型、关系、过滤、分页、递归与聚合查询。',
    'Validates railway models, relations, filters, pagination, recursion, and aggregation.',
    '鉄道モデル、関係、フィルタ、ページング、再帰、集計クエリの検証用です。',
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
  await retryDesignerImport(() => importEngineCatalogIntoDesignerDb(designer, database, catalog));

  const modelRows = hydrateRows(await designer.model('sys_model').query().execute()).filter(
    (row) => row.library_code === database,
  );
  const propRows = hydrateRows(await designer.model('sys_props').query().execute()).filter(
    (row) => row.library_code === database,
  );
  const relationRows = hydrateRows(await designer.model('sys_relation').query().execute()).filter(
    (row) => row.library_code === database,
  );

  const currentModels = new Set(catalog.models.map((model) => model.name));
  const currentFields = new Set(catalog.models.flatMap((model) => model.fields ?? []));
  const currentRelations = new Set(catalog.relations.map((relation) => relation.forward));
  const seenModels = new Set<string>();
  const canonicalModelRows: Record<string, unknown>[] = [];
  const staleModelRows: Record<string, unknown>[] = [];
  for (const row of modelRows) {
    const engineName = String(row.engine_name ?? '');
    if (!currentModels.has(engineName) || seenModels.has(engineName)) {
      staleModelRows.push(row);
      continue;
    }
    seenModels.add(engineName);
    canonicalModelRows.push(row);
  }
  const staleRows = [
    ...staleModelRows.map((row) => ({ model: 'sys_model', id: String(row._id ?? '') })),
    ...relationRows
      .filter((row) => !currentRelations.has(String(row.engine_name ?? '')))
      .map((row) => ({ model: 'sys_relation', id: String(row._id ?? '') })),
  ].filter((row) => row.id);
  if (staleRows.length > 0) {
    const result = await retryDesignerImport(() => designer.batchDelete(staleRows, { sync: true }));
    assert(
      result.failureCount === 0,
      `stale designer metadata delete failures: ${result.failureCount}`,
    );
  }

  const activeModelRows = canonicalModelRows;
  const activePropRows = propRows.filter((row) => currentFields.has(String(row.engine_name ?? '')));
  const activeRelationRows = relationRows.filter((row) =>
    currentRelations.has(String(row.engine_name ?? '')),
  );

  const updates: Array<{ model: string; id: string; partial: Record<string, unknown> }> = [];
  for (const row of activeModelRows) {
    const id = String(row._id ?? '');
    const engineName = String(row.engine_name ?? '');
    const label = modelLabels[engineName];
    const position = modelLayout[engineName];
    assert(id && label && position, `invalid designer model metadata for ${engineName}`);
    updates.push({
      model: 'sys_model',
      id,
      partial: {
        name: label,
        description: i18n(
          `${label.zh}数据模型`,
          `${label.en} data model`,
          `${label.ja}データモデル`,
        ),
        posX: position.x,
        posY: position.y,
      },
    });
  }

  for (const row of activePropRows) {
    const id = String(row._id ?? '');
    const engineName = String(row.engine_name ?? '');
    const label = fieldLabel(engineName);
    assert(id, `invalid designer field metadata for ${engineName}`);
    updates.push({
      model: 'sys_props',
      id,
      partial: {
        name: label,
        description: i18n(`${label.zh}字段`, `${label.en} field`, `${label.ja}フィールド`),
      },
    });
  }

  for (const row of activeRelationRows) {
    const id = String(row._id ?? '');
    const engineName = String(row.engine_name ?? '');
    const relation = relationDefs.find((item) => item.forward === engineName);
    assert(id && relation, `invalid designer relation metadata for ${engineName}`);
    const forwardName = relationLabel(engineName, 'forward');
    const reverseName = relationLabel(engineName, 'reverse');
    const logic = relation.logic.split('-to-') as ['one' | 'many', 'one' | 'many'];
    const forwardDescription = i18n(
      `${modelLabels[relation.source]!.zh}到${modelLabels[relation.target]!.zh}的${forwardName.zh}关系`,
      `${forwardName.en} relation from ${modelLabels[relation.source]!.en} to ${modelLabels[relation.target]!.en}`,
      `${modelLabels[relation.source]!.ja}から${modelLabels[relation.target]!.ja}への${forwardName.ja}関係`,
    );
    const reverseDescription = i18n(
      `${modelLabels[relation.target]!.zh}到${modelLabels[relation.source]!.zh}的${reverseName.zh}关系`,
      `${reverseName.en} relation from ${modelLabels[relation.target]!.en} to ${modelLabels[relation.source]!.en}`,
      `${modelLabels[relation.target]!.ja}から${modelLabels[relation.source]!.ja}への${reverseName.ja}関係`,
    );
    const currentMeta =
      typeof row.canvas_meta === 'string' && row.canvas_meta.trim()
        ? (JSON.parse(row.canvas_meta) as Record<string, unknown>)
        : {};
    updates.push({
      model: 'sys_relation',
      id,
      partial: {
        name: forwardName,
        description: forwardDescription,
        forwardDescription,
        reverseDescription,
        sourceCardinality: logic[0],
        targetCardinality: logic[1],
        selfLoopPolicy: 'selfLoopPolicy' in relation ? (relation.selfLoopPolicy ?? 'deny') : 'deny',
        canvas_meta: JSON.stringify({
          ...currentMeta,
          engineForward: relation.forward,
          engineReverse: relation.reverse,
          forwardNameI18n: forwardName,
          reverseNameI18n: reverseName,
          forwardDescription,
          reverseDescription,
        }),
      },
    });
  }

  const result = await designer.batchUpdate(updates, { sync: true });
  assert(result.failureCount === 0, `designer i18n update failures: ${result.failureCount}`);
  return {
    models: activeModelRows.length,
    fields: activePropRows.length,
    relations: activeRelationRows.length,
  };
}

const metaCatalogs: readonly MetaCatalog[] = [
  {
    model: 'UnitDefinition',
    prefix: 'UNIT',
    entries: [
      metaEntry('KM', '千米', 'Kilometre', 'キロメートル', {
        symbol: 'km',
        quantityKind: 'Length',
        decimalScale: 3,
      }),
      metaEntry('KMH', '千米每小时', 'Kilometres per hour', 'キロメートル毎時', {
        symbol: 'km/h',
        quantityKind: 'Speed',
        decimalScale: 1,
      }),
      metaEntry('KWH', '千瓦时', 'Kilowatt hour', 'キロワット時', {
        symbol: 'kWh',
        quantityKind: 'Energy',
        decimalScale: 2,
      }),
      metaEntry('CNY', '人民币', 'Chinese yuan', '人民元', {
        symbol: 'CNY',
        quantityKind: 'Currency',
        decimalScale: 2,
      }),
      metaEntry('MIN', '分钟', 'Minute', '分', {
        symbol: 'min',
        quantityKind: 'Duration',
        decimalScale: 0,
      }),
      metaEntry('PERCENT', '百分比', 'Percent', 'パーセント', {
        symbol: '%',
        quantityKind: 'Ratio',
        decimalScale: 2,
      }),
    ],
  },
  {
    model: 'Region',
    prefix: 'REG',
    entries: Array.from({ length: 10 }, (_, index) =>
      metaEntry(
        `REG${pad(index + 1, 2)}`,
        `铁路运营区域${index + 1}`,
        `Railway Region ${index + 1}`,
        `鉄道運行地域${index + 1}`,
        { countryCode: 'CN', timezone: 'Asia/Shanghai' },
      ),
    ),
  },
  {
    model: 'AssetType',
    prefix: 'AST_TYPE',
    entries: [
      metaEntry('SIGNAL', '信号设备', 'Signal', '信号設備'),
      metaEntry('SWITCH', '道岔', 'Switch', '分岐器'),
      metaEntry('BRIDGE', '桥梁', 'Bridge', '橋梁'),
      metaEntry('CROSSING', '道口', 'Crossing', '踏切'),
      metaEntry('POWER', '供电设备', 'Power equipment', '電力設備'),
      metaEntry('STATION', '车站', 'Station', '駅'),
      metaEntry('RAILWAY_LINE', '铁路线路', 'Railway line', '鉄道路線'),
      metaEntry('TRAIN', '列车', 'Train', '列車'),
    ],
  },
  {
    model: 'StationLevel',
    prefix: 'STATION_LEVEL',
    entries: Array.from({ length: 5 }, (_, index) =>
      metaEntry(
        `LEVEL_${index + 1}`,
        `${index + 1}级车站`,
        `Station Level ${index + 1}`,
        `駅等級${index + 1}`,
      ),
    ),
  },
  {
    model: 'LineClass',
    prefix: 'LINE_CLASS',
    entries: [
      metaEntry('HIGH_SPEED', '高速铁路', 'High-speed', '高速鉄道'),
      metaEntry('INTERCITY', '城际铁路', 'Intercity', '都市間鉄道'),
      metaEntry('REGIONAL', '区域铁路', 'Regional', '地域鉄道'),
      metaEntry('FREIGHT', '货运铁路', 'Freight', '貨物鉄道'),
    ],
  },
  {
    model: 'TrainType',
    prefix: 'TRAIN_TYPE',
    entries: [
      metaEntry('EMU', '动车组', 'EMU', '電車列車'),
      metaEntry('INTERCITY', '城际列车', 'Intercity train', '都市間列車'),
      metaEntry('REGIONAL', '区域列车', 'Regional train', '地域列車'),
      metaEntry('FREIGHT', '货运列车', 'Freight train', '貨物列車'),
    ],
  },
  {
    model: 'ServiceStatus',
    prefix: 'SERVICE_STATUS',
    entries: [
      metaEntry('ON_TIME', '正点', 'On time', '定刻'),
      metaEntry('DELAYED', '晚点', 'Delayed', '遅延'),
      metaEntry('COMPLETED', '已完成', 'Completed', '完了'),
      metaEntry('CANCELLED', '已取消', 'Cancelled', '運休'),
    ],
  },
  {
    model: 'CarriageType',
    prefix: 'CARRIAGE_TYPE',
    entries: [
      metaEntry('FIRST', '一等座车厢', 'First class', '一等車'),
      metaEntry('SECOND', '二等座车厢', 'Second class', '二等車'),
      metaEntry('DINING', '餐车', 'Dining car', '食堂車'),
      metaEntry('SLEEPER', '卧铺车厢', 'Sleeper', '寝台車'),
    ],
  },
  {
    model: 'EmployeeRole',
    prefix: 'EMPLOYEE_ROLE',
    entries: [
      metaEntry('DRIVER', '司机', 'Driver', '運転士'),
      metaEntry('DISPATCHER', '调度员', 'Dispatcher', '指令員'),
      metaEntry('CONDUCTOR', '列车长', 'Conductor', '車掌'),
      metaEntry('MAINTAINER', '检修员', 'Maintainer', '保守員'),
      metaEntry('STATION_MANAGER', '站长', 'Station manager', '駅長'),
    ],
  },
  {
    model: 'ShiftType',
    prefix: 'SHIFT_TYPE',
    entries: [
      metaEntry('MORNING', '早班', 'Morning', '早番'),
      metaEntry('DAY', '日班', 'Day', '日勤'),
      metaEntry('EVENING', '晚班', 'Evening', '遅番'),
      metaEntry('NIGHT', '夜班', 'Night', '夜勤'),
    ],
  },
  {
    model: 'WorkOrderCategory',
    prefix: 'WO_CATEGORY',
    entries: [
      metaEntry('INSPECTION', '巡检', 'Inspection', '点検'),
      metaEntry('REPAIR', '维修', 'Repair', '修理'),
      metaEntry('CALIBRATION', '校准', 'Calibration', '校正'),
      metaEntry('REPLACEMENT', '更换', 'Replacement', '交換'),
    ],
  },
  {
    model: 'WorkOrderPriority',
    prefix: 'WO_PRIORITY',
    entries: Array.from({ length: 5 }, (_, index) =>
      metaEntry(
        `P${index + 1}`,
        `${index + 1}级优先级`,
        `Priority ${index + 1}`,
        `優先度${index + 1}`,
      ),
    ),
  },
  {
    model: 'WorkOrderStatus',
    prefix: 'WO_STATUS',
    entries: [
      metaEntry('OPEN', '待处理', 'Open', '未処理'),
      metaEntry('ASSIGNED', '已分派', 'Assigned', '割当済み'),
      metaEntry('IN_PROGRESS', '处理中', 'In progress', '処理中'),
      metaEntry('CLOSED', '已关闭', 'Closed', '完了'),
    ],
  },
  {
    model: 'IncidentType',
    prefix: 'INCIDENT_TYPE',
    entries: [
      metaEntry('SIGNAL_FAILURE', '信号故障', 'Signal failure', '信号故障'),
      metaEntry('ROLLING_STOCK', '车辆故障', 'Rolling stock failure', '車両故障'),
      metaEntry('WEATHER', '天气影响', 'Weather disruption', '気象障害'),
      metaEntry('PASSENGER', '旅客事件', 'Passenger incident', '旅客事象'),
    ],
  },
  {
    model: 'IncidentSeverity',
    prefix: 'INCIDENT_SEVERITY',
    entries: Array.from({ length: 5 }, (_, index) =>
      metaEntry(
        `SEV${index + 1}`,
        `${index + 1}级严重度`,
        `Severity ${index + 1}`,
        `重大度${index + 1}`,
      ),
    ),
  },
  {
    model: 'TravelClass',
    prefix: 'TRAVEL_CLASS',
    entries: [
      metaEntry('FIRST', '一等座', 'First class', '一等席'),
      metaEntry('SECOND', '二等座', 'Second class', '二等席'),
      metaEntry('BUSINESS', '商务座', 'Business class', 'ビジネス席'),
    ],
  },
  {
    model: 'SalesChannel',
    prefix: 'SALES_CHANNEL',
    entries: [
      metaEntry('APP', '移动应用', 'Mobile app', 'モバイルアプリ'),
      metaEntry('WEB', '网站', 'Website', 'ウェブサイト'),
      metaEntry('COUNTER', '售票窗口', 'Ticket counter', '窓口'),
      metaEntry('AGENCY', '代理渠道', 'Agency', '代理店'),
    ],
  },
  {
    model: 'TicketStatus',
    prefix: 'TICKET_STATUS',
    entries: [
      metaEntry('ISSUED', '已出票', 'Issued', '発券済み'),
      metaEntry('REFUNDED', '已退票', 'Refunded', '払戻済み'),
      metaEntry('USED', '已使用', 'Used', '使用済み'),
      metaEntry('CANCELLED', '已取消', 'Cancelled', '取消済み'),
    ],
  },
];

function metaCodes(model: string): readonly string[] {
  const catalog = metaCatalogs.find((item) => item.model === model);
  assert(catalog, `missing metadata catalog for ${model}`);
  return catalog.entries.map((entry) => entry.code);
}

function metadataRows(catalog: MetaCatalog, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => {
    const entry = catalog.entries[index];
    if (entry) {
      return {
        metaCode: entry.code,
        name: entry.name,
        description:
          entry.description ??
          i18n(
            `${entry.name.zh}标准定义`,
            `Standard definition for ${entry.name.en}`,
            `${entry.name.ja}の標準定義`,
          ),
        active: true,
        sortOrder: index + 1,
        ...entry.extras,
      };
    }
    const reservedIndex = index - catalog.entries.length + 1;
    return {
      metaCode: `${catalog.prefix}_RESERVED_${pad(reservedIndex)}`,
      name: i18n(
        `${modelLabels[catalog.model]!.zh}预留项${reservedIndex}`,
        `${modelLabels[catalog.model]!.en} Reserved ${reservedIndex}`,
        `${modelLabels[catalog.model]!.ja}予約項目${reservedIndex}`,
      ),
      description: i18n(
        '查询测试预留元数据',
        'Reserved metadata for query tests',
        'クエリテスト用予約メタデータ',
      ),
      active: false,
      sortOrder: index + 1,
      ...(catalog.model === 'UnitDefinition'
        ? { symbol: `u${reservedIndex}`, quantityKind: 'Reserved', decimalScale: 3 }
        : {}),
    };
  });
}

function buildSeeds(count: number): ModelSeed[] {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const operatorsUsed = Math.min(20, count);
  const concentratedParents = Math.min(20, count);

  const metadataSeeds: ModelSeed[] = [
    {
      model: 'MetaDefinition',
      keyField: 'metaCode',
      rows: Array.from({ length: count }, (_, index) => {
        const catalog = metaCatalogs[index];
        const code = catalog
          ? `META_${catalog.model.toUpperCase()}`
          : `META_RESERVED_${pad(index + 1)}`;
        const label = catalog
          ? modelLabels[catalog.model]!
          : i18n('预留元数据域', 'Reserved metadata domain', '予約メタデータ領域');
        return {
          metaCode: code,
          name: label,
          description: i18n(
            `${label.zh}的分类定义域`,
            `Definition domain for ${label.en}`,
            `${label.ja}の定義領域`,
          ),
          active: Boolean(catalog),
          sortOrder: index + 1,
        };
      }),
    },
    ...metaCatalogs.map((catalog) => ({
      model: catalog.model,
      keyField: 'metaCode',
      rows: metadataRows(catalog, count),
    })),
  ];

  const assetTypeCodes = metaCodes('AssetType');
  const stationLevelCodes = metaCodes('StationLevel');
  const lineClassCodes = metaCodes('LineClass');
  const trainTypeCodes = metaCodes('TrainType');
  const serviceStatusCodes = metaCodes('ServiceStatus');
  const carriageTypeCodes = metaCodes('CarriageType');
  const employeeRoleCodes = metaCodes('EmployeeRole');
  const shiftTypeCodes = metaCodes('ShiftType');
  const workOrderCategoryCodes = metaCodes('WorkOrderCategory');
  const workOrderPriorityCodes = metaCodes('WorkOrderPriority');
  const workOrderStatusCodes = metaCodes('WorkOrderStatus');
  const incidentTypeCodes = metaCodes('IncidentType');
  const incidentSeverityCodes = metaCodes('IncidentSeverity');
  const travelClassCodes = metaCodes('TravelClass');
  const salesChannelCodes = metaCodes('SalesChannel');
  const ticketStatusCodes = metaCodes('TicketStatus');

  return [
    ...metadataSeeds,
    {
      model: 'RailwayAsset',
      keyField: 'assetCode',
      rows: indexes.map((index) => ({
        assetCode: `AST${pad(index + 1)}`,
        assetName: i18n(
          `铁路设施${index + 1}`,
          `Railway Asset ${index + 1}`,
          `鉄道設備${index + 1}`,
        ),
        assetTypeCode: assetTypeCodes[index % 5],
        inService: index % 13 !== 0,
        commissionedAt: iso(-(index * 17)),
        color: ['#1F6F8B', '#2E7D32', '#D97706', '#B91C1C'][index % 4],
        location: { kilometer: index * 1.75, zone: `Z${pad((index % 10) + 1, 2)}` },
      })),
    },
    {
      model: 'Station',
      keyField: 'stationCode',
      rows: indexes.map((index) => ({
        assetCode: `STA${pad(index + 1)}`,
        assetName: i18n(`示范站${index + 1}`, `Demo Station ${index + 1}`, `デモ駅${index + 1}`),
        assetTypeCode: 'STATION',
        inService: true,
        commissionedAt: iso(-(index * 31)),
        color: index % 2 === 0 ? '#2563EB' : '#16A34A',
        location: { province: `P${(index % 8) + 1}`, city: `C${(index % 20) + 1}` },
        stationCode: `STA${pad(index + 1)}`,
        regionCode: `REG${pad((index % 10) + 1, 2)}`,
        stationLevelCode: stationLevelCodes[index % stationLevelCodes.length],
        platformCount: (index % 12) + 2,
        dailyPassengers: 8_000 + index * 1_137,
        longitude: 100 + (index % 30) * 0.37,
        latitude: 22 + (index % 25) * 0.41,
      })),
    },
    {
      model: 'RailwayLine',
      keyField: 'lineCode',
      rows: indexes.map((index) => ({
        assetCode: `LIN${pad(index + 1)}`,
        assetName: i18n(`示范线路${index + 1}`, `Demo Line ${index + 1}`, `デモ路線${index + 1}`),
        assetTypeCode: 'RAILWAY_LINE',
        inService: index % 17 !== 0,
        commissionedAt: iso(-(index * 23)),
        color: ['#DC2626', '#2563EB', '#059669', '#7C3AED'][index % 4],
        location: { corridor: `COR${pad((index % 12) + 1, 2)}` },
        lineCode: `LIN${pad(index + 1)}`,
        operatorCode: `OPR${pad((index % operatorsUsed) + 1)}`,
        lineClassCode: lineClassCodes[index % lineClassCodes.length],
        lengthValue: 80 + index * 3.25,
        lengthUnitCode: 'KM',
        maxSpeedValue: [160, 200, 250, 350][index % 4],
        speedUnitCode: 'KMH',
        electrified: index % 6 !== 0,
      })),
    },
    {
      model: 'Train',
      keyField: 'trainCode',
      rows: indexes.map((index) => ({
        assetCode: `TRN${pad(index + 1)}`,
        assetName: i18n(`示范列车${index + 1}`, `Demo Train ${index + 1}`, `デモ列車${index + 1}`),
        assetTypeCode: 'TRAIN',
        inService: index % 19 !== 0,
        commissionedAt: iso(-(index * 11)),
        color: ['#0F766E', '#1D4ED8', '#B45309'][index % 3],
        location: { depot: `DEP${pad((index % 15) + 1, 2)}` },
        trainCode: `TRN${pad(index + 1)}`,
        operatorCode: `OPR${pad((index % operatorsUsed) + 1)}`,
        trainTypeCode: trainTypeCodes[index % trainTypeCodes.length],
        maxSpeedValue: [160, 200, 250, 350][index % 4],
        speedUnitCode: 'KMH',
        seatCapacity: 420 + (index % 8) * 64,
        mileageValue: 12_000 + index * 2_345,
        mileageUnitCode: 'KM',
      })),
    },
    {
      model: 'Operator',
      keyField: 'operatorCode',
      rows: indexes.map((index) => ({
        operatorCode: `OPR${pad(index + 1)}`,
        name: i18n(
          `铁路运营商${index + 1}`,
          `Rail Operator ${index + 1}`,
          `鉄道事業者${index + 1}`,
        ),
        headquarters: `City-${(index % 30) + 1}`,
        foundedAt: iso(-(3_650 + index * 37)),
        active: index % 23 !== 0,
        serviceRating: Number((3.5 + (index % 15) / 10).toFixed(1)),
      })),
    },
    {
      model: 'TrainService',
      keyField: 'serviceNo',
      rows: indexes.map((index) => ({
        serviceNo: `SVC${pad(index + 1)}`,
        lineCode: `LIN${pad(index + 1)}`,
        trainCode: `TRN${pad(index + 1)}`,
        businessDate: iso(index % 30),
        plannedDeparture: iso(index % 30, 5 + (index % 14), (index * 7) % 60),
        plannedArrival: iso(index % 30, 8 + (index % 14), (index * 11) % 60),
        statusCode: serviceStatusCodes[[0, 0, 1, 2][index % 4]!],
        delayMinutes: index % 4 === 2 ? 5 + (index % 45) : 0,
        passengerLoad: Number((0.35 + (index % 60) / 100).toFixed(2)),
        energyValue: 2_500 + index * 19,
        energyUnitCode: 'KWH',
      })),
    },
    {
      model: 'ServiceStop',
      keyField: 'stopCode',
      rows: indexes.map((index) => {
        const serviceIndex = index % concentratedParents;
        const sequence = Math.floor(index / concentratedParents) + 1;
        return {
          stopCode: `STP${pad(index + 1)}`,
          serviceNo: `SVC${pad(serviceIndex + 1)}`,
          stationCode: `STA${pad(((serviceIndex * 5 + sequence - 1) % count) + 1)}`,
          sequence,
          arrivalAt: iso(serviceIndex % 30, 7 + sequence, (serviceIndex * 3) % 60),
          departureAt: iso(serviceIndex % 30, 7 + sequence, (serviceIndex * 3 + 5) % 60),
          platform: String((index % 12) + 1),
          dwellMinutes: 2 + (index % 6),
        };
      }),
    },
    {
      model: 'Carriage',
      keyField: 'carriageCode',
      rows: indexes.map((index) => ({
        carriageCode: `CAR${pad(index + 1)}`,
        trainCode: `TRN${pad((index % concentratedParents) + 1)}`,
        position: Math.floor(index / concentratedParents) + 1,
        carriageTypeCode: carriageTypeCodes[index % carriageTypeCodes.length],
        seatCapacity: [48, 72, 36, 40][index % 4],
        accessible: index % 5 === 0,
        occupancyRate: Number((0.3 + (index % 65) / 100).toFixed(2)),
      })),
    },
    {
      model: 'Employee',
      keyField: 'employeeCode',
      rows: indexes.map((index) => ({
        employeeCode: `EMP${pad(index + 1)}`,
        operatorCode: `OPR${pad((index % operatorsUsed) + 1)}`,
        name: i18n(`员工${index + 1}`, `Employee ${index + 1}`, `従業員${index + 1}`),
        roleCode: employeeRoleCodes[index % employeeRoleCodes.length],
        certification: { level: (index % 4) + 1, expiresAt: iso(365 + index) },
        yearsOfService: index % 31,
        onDuty: index % 7 !== 0,
      })),
    },
    {
      model: 'Shift',
      keyField: 'shiftCode',
      rows: indexes.map((index) => ({
        shiftCode: `SHF${pad(index + 1)}`,
        stationCode: `STA${pad((index % count) + 1)}`,
        shiftTypeCode: shiftTypeCodes[index % shiftTypeCodes.length],
        startsAt: iso(index % 14, [6, 9, 15, 22][index % 4]),
        endsAt: iso(index % 14, [14, 17, 23, 6][index % 4]),
        requiredStaff: 3 + (index % 8),
        emergency: index % 29 === 0,
      })),
    },
    {
      model: 'WorkOrder',
      keyField: 'orderCode',
      rows: indexes.map((index) => ({
        orderCode: `WO${pad(index + 1, 4)}`,
        assetCode: `AST${pad(index + 1)}`,
        categoryCode: workOrderCategoryCodes[index % workOrderCategoryCodes.length],
        priorityCode: workOrderPriorityCodes[index % workOrderPriorityCodes.length],
        statusCode: workOrderStatusCodes[index % workOrderStatusCodes.length],
        openedAt: iso(-(index % 30)),
        dueAt: iso((index % 30) + 7),
        estimatedCostValue: 2_000 + index * 315,
        currencyUnitCode: 'CNY',
        description: i18n(
          `铁路设施维护工单${index + 1}`,
          `Railway asset work order ${index + 1}`,
          `鉄道設備保守指示${index + 1}`,
        ),
      })),
    },
    {
      model: 'Incident',
      keyField: 'incidentCode',
      rows: indexes.map((index) => ({
        incidentCode: `INC${pad(index + 1, 4)}`,
        serviceNo: `SVC${pad((index % Math.min(50, count)) + 1)}`,
        stationCode: `STA${pad((index % count) + 1)}`,
        incidentTypeCode: incidentTypeCodes[index % incidentTypeCodes.length],
        severityCode: incidentSeverityCodes[index % incidentSeverityCodes.length],
        occurredAt: iso(-(index % 20), 6 + (index % 16), (index * 13) % 60),
        resolved: index % 6 !== 0,
        impactMinutes: 3 + (index % 58),
        description: i18n(
          `运营事件${index + 1}`,
          `Operations incident ${index + 1}`,
          `運行事象${index + 1}`,
        ),
        evidence: { source: ['Sensor', 'Dispatcher', 'Passenger'][index % 3], verified: true },
      })),
    },
    {
      model: 'Ticket',
      keyField: 'ticketNo',
      rows: indexes.map((index) => ({
        ticketNo: `TKT${pad(index + 1, 5)}`,
        serviceNo: `SVC${pad((index % concentratedParents) + 1)}`,
        travelClassCode: travelClassCodes[index % travelClassCodes.length],
        originStationCode: `STA${pad((index % count) + 1)}`,
        destinationStationCode: `STA${pad(((index + 17) % count) + 1)}`,
        fareValue: 35 + (index % 40) * 12.5,
        currencyUnitCode: 'CNY',
        soldAt: iso(-(index % 30), 9 + (index % 10), (index * 5) % 60),
        salesChannelCode: salesChannelCodes[index % salesChannelCodes.length],
        ticketStatusCode: ticketStatusCodes[index % 17 === 0 ? 1 : index % 11 === 0 ? 2 : 0],
      })),
    },
  ];
}

async function insertSeed(
  client: Awaited<ReturnType<ModelDB['use']>>,
  seed: ModelSeed,
): Promise<Map<string, string>> {
  const result = await client.model(seed.model).insertMany(seed.rows, {
    sync: true,
    returning: true,
  });
  assert(result.failureCount === 0, `${seed.model} insert failures: ${result.failureCount}`);
  assert(result.successCount === seed.rows.length, `${seed.model} row count after insert`);
  assert(
    result.records?.length === seed.rows.length,
    `${seed.model} returning rows are incomplete`,
  );

  const ids = new Map<string, string>();
  for (const entity of result.records) {
    const key = String(entity.getData()[seed.keyField]);
    ids.set(key, entity.id);
  }
  return ids;
}

function requireId(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key);
  assert(id, `missing generated id for ${key}`);
  return id;
}

function rowData(rows: unknown): Record<string, unknown>[] {
  assert(Array.isArray(rows), 'query result must be an array');
  return rows.map((row) => {
    assert(
      row && typeof row === 'object' && 'getData' in row,
      'query row must be a hydrated entity',
    );
    return (row as RemoteHydratedEntity).getData();
  });
}

async function main(): Promise<void> {
  assert(
    new Set(relationDefs.map((relation) => relation.forward)).size === relationDefs.length,
    'forward relation names must be globally unique for remote bind()',
  );
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
      await modeldb.createBackup(database, 'pre-railway-regenerate');
      await modeldb.deleteDatabase(database);
    }

    await modeldb.createDatabase(database);
    const client = await modeldb.use(database);

    const ddl = await client.batchRegister({
      models: schemas.map((model) => ({
        name: model.name,
        schema: model.schema,
        ...(model.parentId ? { parentId: model.parentId } : {}),
      })),
      relations: relationDefs,
    });
    assert(ddl.created.models.length === schemas.length, 'not all models were registered');
    assert(
      ddl.created.relations.length === relationDefs.length,
      'not all relations were registered',
    );

    const seeds = buildSeeds(rowCount);
    const idsByModel = new Map<string, Map<string, string>>();
    for (const seed of seeds) {
      idsByModel.set(seed.model, await insertSeed(client, seed));
    }

    const stationIds = idsByModel.get('Station')!;
    const lineIds = idsByModel.get('RailwayLine')!;
    const employeeIds = idsByModel.get('Employee')!;
    const shiftIds = idsByModel.get('Shift')!;

    const stationHierarchyPairs: Array<readonly [string, string]> = [];
    const rootCount = Math.min(10, rowCount);
    for (let index = rootCount; index < rowCount; index++) {
      const parent = index % rootCount;
      stationHierarchyPairs.push([
        requireId(stationIds, `STA${pad(parent + 1)}`),
        requireId(stationIds, `STA${pad(index + 1)}`),
      ]);
    }

    const lineStationPairs: Array<readonly [string, string]> = [];
    for (let lineIndex = 0; lineIndex < rowCount; lineIndex++) {
      for (let offset = 0; offset < Math.min(6, rowCount); offset++) {
        lineStationPairs.push([
          requireId(lineIds, `LIN${pad(lineIndex + 1)}`),
          requireId(stationIds, `STA${pad(((lineIndex * 3 + offset) % rowCount) + 1)}`),
        ]);
      }
    }

    const employeeShiftPairs: Array<readonly [string, string]> = [];
    for (let employeeIndex = 0; employeeIndex < rowCount; employeeIndex++) {
      for (const offset of [0, 17]) {
        employeeShiftPairs.push([
          requireId(employeeIds, `EMP${pad(employeeIndex + 1)}`),
          requireId(shiftIds, `SHF${pad(((employeeIndex + offset) % rowCount) + 1)}`),
        ]);
      }
    }

    const manualRelations: RelationSeed[] = [
      { forward: 'subStations', strategy: 'MANUAL', pairs: stationHierarchyPairs },
      { forward: 'stations', strategy: 'MANUAL', pairs: lineStationPairs },
      { forward: 'assignedShifts', strategy: 'MANUAL', pairs: employeeShiftPairs },
    ];
    const protocolRelations: RelationSeed[] = relationDefs.flatMap((relation) => {
      if (!('matchOn' in relation)) {
        return [];
      }
      return [
        {
          forward: relation.forward,
          strategy: 'PROTOCOL' as const,
          matchOn: relation.matchOn,
        },
      ];
    });

    const relationStats: Record<string, unknown> = {};
    for (const relation of [...manualRelations, ...protocolRelations]) {
      const result = await client.bind(relation.forward, relation.strategy, {
        ...(relation.matchOn ? { matchOn: relation.matchOn } : {}),
        ...(relation.pairs ? { pairs: relation.pairs } : {}),
        sync: true,
      });
      relationStats[relation.forward] = result.stats;
    }

    const modelCounts: Record<string, number> = {};
    for (const schema of schemas) {
      const rows = await client.model(schema.name).query().execute();
      assert(Array.isArray(rows), `${schema.name} count query shape`);
      modelCounts[schema.name] = rows.length;
      assert(rows.length === rowCount, `${schema.name} expected ${rowCount}, got ${rows.length}`);
    }

    const firstLineId = requireId(lineIds, 'LIN001');
    const firstServiceId = requireId(idsByModel.get('TrainService')!, 'SVC001');
    const firstTrainId = requireId(idsByModel.get('Train')!, 'TRN001');
    const firstStationId = requireId(stationIds, 'STA001');
    const firstIncidentId = requireId(idsByModel.get('Incident')!, 'INC0001');
    const firstTicketId = requireId(idsByModel.get('Ticket')!, 'TKT00001');

    const lineStations = rowData(
      await client.model('RailwayLine').query([firstLineId]).relate('stations').execute(),
    );
    assert(lineStations.length === Math.min(6, rowCount), 'RailwayLine -> stations query');

    const serviceStops = rowData(
      await client.model('TrainService').query([firstServiceId]).relate('stops').execute(),
    );
    assert(serviceStops.length >= 4, 'TrainService -> stops reverse query');

    const trainCarriages = rowData(
      await client.model('Train').query([firstTrainId]).relate('carriages').execute(),
    );
    assert(trainCarriages.length >= 4, 'Train -> carriages reverse query');

    const serviceStatus = rowData(
      await client
        .model('TrainService')
        .query([firstServiceId])
        .relate('serviceStatusRef')
        .execute(),
    );
    assert(serviceStatus[0]?.metaCode === 'ON_TIME', 'TrainService -> ServiceStatus query');

    const incidentSeverity = rowData(
      await client
        .model('Incident')
        .query([firstIncidentId])
        .relate('incidentSeverityRef')
        .execute(),
    );
    assert(incidentSeverity[0]?.metaCode === 'SEV1', 'Incident -> IncidentSeverity query');

    const ticketStatus = rowData(
      await client.model('Ticket').query([firstTicketId]).relate('ticketStatusRef').execute(),
    );
    assert(ticketStatus[0]?.metaCode === 'REFUNDED', 'Ticket -> TicketStatus query');

    const lineLengthUnit = rowData(
      await client.model('RailwayLine').query([firstLineId]).relate('lineLengthUnit').execute(),
    );
    assert(lineLengthUnit[0]?.metaCode === 'KM', 'RailwayLine -> UnitDefinition query');

    const stationTree = await client
      .model('Station')
      .query([firstStationId])
      .children('subStations', { depth: 2, strategy: 'bfs' })
      .execute();
    assert(Array.isArray(stationTree) && stationTree.length === 1, 'station hierarchy root query');
    const stationTreeSize = (stationTree[0] as RemoteHydratedEntity).flatten({
      order: 'bfs',
    }).length;
    assert(stationTreeSize > 1, 'station recursive relation query');

    const delayedServices = rowData(
      await client.model('TrainService').query().where('delayMinutes', 'gt', 10).execute(),
    );
    assert(delayedServices.length > 0, 'typed numeric filter query');

    const ticketPage = (await client.model('Ticket').query().page(2).limit(10).execute()) as {
      readonly items?: readonly unknown[];
      readonly total?: number;
    };
    assert(ticketPage.total === rowCount, 'pagination total');
    assert(
      ticketPage.items?.length === Math.min(10, Math.max(0, rowCount - 20)),
      'pagination size',
    );

    const analysis = await client
      .model('TrainService')
      .query()
      .groupBy(['statusCode'])
      .compute({ delayMinutes: ['avg', 'max'] })
      .execute();
    assert(analysis && typeof analysis === 'object', 'grouped aggregation query');

    const catalog = await modeldb.getDatabaseCatalog(database);
    assert(catalog.models.length === schemas.length, 'management catalog model count');
    assert(catalog.relations.length === relationDefs.length, 'management catalog relation count');
    const designerMetadata = await syncDesignerMetadata(modeldb, catalog);
    const localizedCatalog = await modeldb.getDatabaseCatalog(database);
    const localizedModels = localizedCatalog.models.filter(
      (model) => model.displayName && Object.keys(model.displayName).length > 0,
    ).length;
    const localizedFields = localizedCatalog.models.reduce(
      (count, model) => count + Object.keys(model.fieldLabels ?? {}).length,
      0,
    );
    assert(localizedCatalog.displayName?.zh === '铁路运营验证库', 'database i18n display name');
    assert(localizedModels === schemas.length, 'model i18n display names');
    assert(localizedFields > 0, 'field i18n display names');

    const report = {
      generatedAt: new Date().toISOString(),
      database,
      server: `${host}:${port}`,
      models: schemas.length,
      relations: relationDefs.length,
      rowsPerModel: rowCount,
      totalRows: Object.values(modelCounts).reduce((sum, count) => sum + count, 0),
      modelCounts,
      relationStats,
      designerMetadata: {
        ...designerMetadata,
        catalogLocalizedModels: localizedModels,
        catalogLocalizedFields: localizedFields,
      },
      queryChecks: {
        lineStations: lineStations.length,
        serviceStops: serviceStops.length,
        trainCarriages: trainCarriages.length,
        serviceStatus: serviceStatus[0]?.metaCode,
        incidentSeverity: incidentSeverity[0]?.metaCode,
        ticketStatus: ticketStatus[0]?.metaCode,
        lineLengthUnit: lineLengthUnit[0]?.metaCode,
        stationTreeSize,
        delayedServices: delayedServices.length,
        ticketPageTotal: ticketPage.total,
        groupedAggregation: true,
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
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
