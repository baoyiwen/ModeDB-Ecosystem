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

type FieldValueEntry = {
  readonly code: string;
  readonly name: I18nText;
};

type FieldValueDomain = {
  readonly domain: string;
  readonly entries: readonly FieldValueEntry[];
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

const fieldValueEntry = (code: string, zh: string, en: string, ja: string): FieldValueEntry => ({
  code,
  name: i18n(zh, en, ja),
});

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
  {
    name: 'Region',
    schema: {
      regionCode: { type: DataType.String, required: true },
      name: { type: DataType.I18N, required: true },
      countryCode: DataType.String,
      timezone: DataType.String,
      active: { type: DataType.Boolean, required: true, default: true },
    },
  },
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
      length: { type: DataType.Unit, required: true, unit: 'km' },
      maxSpeed: { type: DataType.Unit, required: true, unit: 'km/h' },
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
      maxSpeed: { type: DataType.Unit, required: true, unit: 'km/h' },
      seatCapacity: DataType.Int,
      mileage: { type: DataType.Unit, required: true, unit: 'km' },
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
      energyUsed: { type: DataType.Unit, required: true, unit: 'kWh' },
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
      estimatedCost: { type: DataType.Unit, required: true, unit: 'CNY' },
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
      fare: { type: DataType.Unit, required: true, unit: 'CNY' },
      soldAt: DataType.DateTime,
      salesChannelCode: { type: DataType.String, required: true },
      ticketStatusCode: { type: DataType.String, required: true },
    },
  },
];

type DataSplitMetadata = {
  readonly model: string;
  /** 一行数据代表的最小业务单元；它不是额外的引擎模型。 */
  readonly grain: string;
  /** 在该单元内部仍保持完整的值对象字段。 */
  readonly valueObjectFields?: readonly string[];
};

/**
 * 业务库的拆分元数据只描述数据粒度，不会被注册为实体。
 * 值域由 fieldValueCatalogs 维护，只有真正具有独立生命周期的粒度才出现在 schemas 中。
 */
const dataSplitMetadata: readonly DataSplitMetadata[] = [
  { model: 'Region', grain: '一个运营区域' },
  { model: 'RailwayAsset', grain: '一个可独立维护的铁路资产' },
  { model: 'Station', grain: '一个车站' },
  {
    model: 'RailwayLine',
    grain: '一条铁路线路',
    valueObjectFields: ['length', 'maxSpeed'],
  },
  {
    model: 'Train',
    grain: '一个列车单元',
    valueObjectFields: ['maxSpeed', 'mileage'],
  },
  { model: 'Operator', grain: '一个运营商' },
  {
    model: 'TrainService',
    grain: '一个日期化车次运行任务',
    valueObjectFields: ['energyUsed'],
  },
  { model: 'ServiceStop', grain: '一条车次经停记录' },
  { model: 'Carriage', grain: '一节车厢' },
  { model: 'Employee', grain: '一名铁路员工' },
  { model: 'Shift', grain: '一个值班班次' },
  {
    model: 'WorkOrder',
    grain: '一张检修工单',
    valueObjectFields: ['estimatedCost'],
  },
  { model: 'Incident', grain: '一个运营事件' },
  { model: 'Ticket', grain: '一张客票', valueObjectFields: ['fare'] },
];

function validateDataSplitMetadata(): void {
  const schemaByName = new Map(schemas.map((schema) => [schema.name, schema]));
  assert(dataSplitMetadata.length === schemas.length, 'data split metadata must cover every model');
  for (const definition of dataSplitMetadata) {
    const schema = schemaByName.get(definition.model);
    assert(schema, `data split metadata references unknown model ${definition.model}`);
    for (const field of definition.valueObjectFields ?? []) {
      const fieldDef = schema.schema[field];
      assert(fieldDef, `${definition.model}.${field} is missing from its schema`);
      const type = typeof fieldDef === 'string' ? fieldDef : fieldDef.type;
      assert(
        type === DataType.Unit,
        `${definition.model}.${field} must remain a Unit value object`,
      );
    }
  }
}

const relationDefs = [
  {
    source: 'Station',
    target: 'Region',
    forward: 'stationRegionRef',
    reverse: 'stationsInRegion',
    logic: 'many-to-one' as const,
    matchOn: { sourceField: 'regionCode', targetField: 'regionCode' },
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
  Region: i18n('运营区域', 'Region', '運行地域'),
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
  description: ['描述', '説明'],
  countryCode: ['国家代码', '国コード'],
  timezone: ['时区', 'タイムゾーン'],
  active: ['是否有效', '有効'],
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
  length: ['线路长度', '路線長'],
  maxSpeed: ['最高速度', '最高速度'],
  lineClass: ['线路等级', '路線区分'],
  electrified: ['是否电气化', '電化済み'],
  trainCode: ['列车编码', '列車コード'],
  trainTypeCode: ['列车类型编码', '列車種別コード'],
  mileage: ['累计里程', '累積走行距離'],
  trainType: ['列车类型', '列車種別'],
  seatCapacity: ['座席容量', '座席定員'],
  name: ['名称', '名称'],
  headquarters: ['总部所在地', '本社所在地'],
  foundedAt: ['成立时间', '設立日時'],
  serviceRating: ['服务评分', 'サービス評価'],
  serviceNo: ['车次编号', '列車番号'],
  businessDate: ['运营日期', '運行日'],
  plannedDeparture: ['计划发车时间', '発車予定時刻'],
  plannedArrival: ['计划到达时间', '到着予定時刻'],
  statusCode: ['状态编码', '状態コード'],
  status: ['状态', '状態'],
  delayMinutes: ['延误分钟', '遅延分数'],
  passengerLoad: ['客座率', '乗車率'],
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
  fare: ['票价', '運賃'],
  soldAt: ['售票时间', '発売日時'],
  salesChannelCode: ['销售渠道编码', '販売チャネルコード'],
  ticketStatusCode: ['客票状态编码', '乗車券状態コード'],
  salesChannel: ['销售渠道', '販売チャネル'],
};

const relationLabelParts: Readonly<
  Record<
    string,
    { readonly forward: readonly [string, string]; readonly reverse: readonly [string, string] }
  >
> = {
  stationRegionRef: { forward: ['所属区域', '所属地域'], reverse: ['区域内车站', '地域内の駅'] },
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
  Region: { x: 250, y: 2_400 },
  RailwayAsset: { x: 2_520, y: 1_650 },
  Station: { x: 900, y: 2_400 },
  RailwayLine: { x: 1_900, y: 2_400 },
  Train: { x: 3_100, y: 2_400 },
  Operator: { x: 4_500, y: 2_400 },
  TrainService: { x: 2_500, y: 3_350 },
  ServiceStop: { x: 1_500, y: 4_350 },
  Carriage: { x: 3_650, y: 3_350 },
  Employee: { x: 4_850, y: 3_350 },
  Shift: { x: 4_850, y: 4_350 },
  WorkOrder: { x: 3_650, y: 4_350 },
  Incident: { x: 2_550, y: 4_350 },
  Ticket: { x: 350, y: 4_350 },
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
    '用于验证铁路业务模型、最小拆分单元、关系、过滤、分页、递归与聚合查询。',
    'Validates railway business models, data split units, relations, filters, pagination, recursion, and aggregation.',
    '鉄道業務モデル、最小分割単位、関係、フィルタ、ページング、再帰、集計クエリの検証用です。',
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

/**
 * 这些值域只用于生成业务字段值，不会注册成模型或关系。
 * 值域辅助解释字段含义；元数据的拆分边界由 schema 的字段和值对象表达。
 */
const fieldValueCatalogs: readonly FieldValueDomain[] = [
  {
    domain: 'AssetType',
    entries: [
      fieldValueEntry('SIGNAL', '信号设备', 'Signal', '信号設備'),
      fieldValueEntry('SWITCH', '道岔', 'Switch', '分岐器'),
      fieldValueEntry('BRIDGE', '桥梁', 'Bridge', '橋梁'),
      fieldValueEntry('CROSSING', '道口', 'Crossing', '踏切'),
      fieldValueEntry('POWER', '供电设备', 'Power equipment', '電力設備'),
      fieldValueEntry('STATION', '车站', 'Station', '駅'),
      fieldValueEntry('RAILWAY_LINE', '铁路线路', 'Railway line', '鉄道路線'),
      fieldValueEntry('TRAIN', '列车', 'Train', '列車'),
    ],
  },
  {
    domain: 'StationLevel',
    entries: Array.from({ length: 5 }, (_, index) =>
      fieldValueEntry(
        `LEVEL_${index + 1}`,
        `${index + 1}级车站`,
        `Station Level ${index + 1}`,
        `駅等級${index + 1}`,
      ),
    ),
  },
  {
    domain: 'LineClass',
    entries: [
      fieldValueEntry('HIGH_SPEED', '高速铁路', 'High-speed', '高速鉄道'),
      fieldValueEntry('INTERCITY', '城际铁路', 'Intercity', '都市間鉄道'),
      fieldValueEntry('REGIONAL', '区域铁路', 'Regional', '地域鉄道'),
      fieldValueEntry('FREIGHT', '货运铁路', 'Freight', '貨物鉄道'),
    ],
  },
  {
    domain: 'TrainType',
    entries: [
      fieldValueEntry('EMU', '动车组', 'EMU', '電車列車'),
      fieldValueEntry('INTERCITY', '城际列车', 'Intercity train', '都市間列車'),
      fieldValueEntry('REGIONAL', '区域列车', 'Regional train', '地域列車'),
      fieldValueEntry('FREIGHT', '货运列车', 'Freight train', '貨物列車'),
    ],
  },
  {
    domain: 'ServiceStatus',
    entries: [
      fieldValueEntry('ON_TIME', '正点', 'On time', '定刻'),
      fieldValueEntry('DELAYED', '晚点', 'Delayed', '遅延'),
      fieldValueEntry('COMPLETED', '已完成', 'Completed', '完了'),
      fieldValueEntry('CANCELLED', '已取消', 'Cancelled', '運休'),
    ],
  },
  {
    domain: 'CarriageType',
    entries: [
      fieldValueEntry('FIRST', '一等座车厢', 'First class', '一等車'),
      fieldValueEntry('SECOND', '二等座车厢', 'Second class', '二等車'),
      fieldValueEntry('DINING', '餐车', 'Dining car', '食堂車'),
      fieldValueEntry('SLEEPER', '卧铺车厢', 'Sleeper', '寝台車'),
    ],
  },
  {
    domain: 'EmployeeRole',
    entries: [
      fieldValueEntry('DRIVER', '司机', 'Driver', '運転士'),
      fieldValueEntry('DISPATCHER', '调度员', 'Dispatcher', '指令員'),
      fieldValueEntry('CONDUCTOR', '列车长', 'Conductor', '車掌'),
      fieldValueEntry('MAINTAINER', '检修员', 'Maintainer', '保守員'),
      fieldValueEntry('STATION_MANAGER', '站长', 'Station manager', '駅長'),
    ],
  },
  {
    domain: 'ShiftType',
    entries: [
      fieldValueEntry('MORNING', '早班', 'Morning', '早番'),
      fieldValueEntry('DAY', '日班', 'Day', '日勤'),
      fieldValueEntry('EVENING', '晚班', 'Evening', '遅番'),
      fieldValueEntry('NIGHT', '夜班', 'Night', '夜勤'),
    ],
  },
  {
    domain: 'WorkOrderCategory',
    entries: [
      fieldValueEntry('INSPECTION', '巡检', 'Inspection', '点検'),
      fieldValueEntry('REPAIR', '维修', 'Repair', '修理'),
      fieldValueEntry('CALIBRATION', '校准', 'Calibration', '校正'),
      fieldValueEntry('REPLACEMENT', '更换', 'Replacement', '交換'),
    ],
  },
  {
    domain: 'WorkOrderPriority',
    entries: Array.from({ length: 5 }, (_, index) =>
      fieldValueEntry(
        `P${index + 1}`,
        `${index + 1}级优先级`,
        `Priority ${index + 1}`,
        `優先度${index + 1}`,
      ),
    ),
  },
  {
    domain: 'WorkOrderStatus',
    entries: [
      fieldValueEntry('OPEN', '待处理', 'Open', '未処理'),
      fieldValueEntry('ASSIGNED', '已分派', 'Assigned', '割当済み'),
      fieldValueEntry('IN_PROGRESS', '处理中', 'In progress', '処理中'),
      fieldValueEntry('CLOSED', '已关闭', 'Closed', '完了'),
    ],
  },
  {
    domain: 'IncidentType',
    entries: [
      fieldValueEntry('SIGNAL_FAILURE', '信号故障', 'Signal failure', '信号故障'),
      fieldValueEntry('ROLLING_STOCK', '车辆故障', 'Rolling stock failure', '車両故障'),
      fieldValueEntry('WEATHER', '天气影响', 'Weather disruption', '気象障害'),
      fieldValueEntry('PASSENGER', '旅客事件', 'Passenger incident', '旅客事象'),
    ],
  },
  {
    domain: 'IncidentSeverity',
    entries: Array.from({ length: 5 }, (_, index) =>
      fieldValueEntry(
        `SEV${index + 1}`,
        `${index + 1}级严重度`,
        `Severity ${index + 1}`,
        `重大度${index + 1}`,
      ),
    ),
  },
  {
    domain: 'TravelClass',
    entries: [
      fieldValueEntry('FIRST', '一等座', 'First class', '一等席'),
      fieldValueEntry('SECOND', '二等座', 'Second class', '二等席'),
      fieldValueEntry('BUSINESS', '商务座', 'Business class', 'ビジネス席'),
    ],
  },
  {
    domain: 'SalesChannel',
    entries: [
      fieldValueEntry('APP', '移动应用', 'Mobile app', 'モバイルアプリ'),
      fieldValueEntry('WEB', '网站', 'Website', 'ウェブサイト'),
      fieldValueEntry('COUNTER', '售票窗口', 'Ticket counter', '窓口'),
      fieldValueEntry('AGENCY', '代理渠道', 'Agency', '代理店'),
    ],
  },
  {
    domain: 'TicketStatus',
    entries: [
      fieldValueEntry('ISSUED', '已出票', 'Issued', '発券済み'),
      fieldValueEntry('REFUNDED', '已退票', 'Refunded', '払戻済み'),
      fieldValueEntry('USED', '已使用', 'Used', '使用済み'),
      fieldValueEntry('CANCELLED', '已取消', 'Cancelled', '取消済み'),
    ],
  },
];

function fieldValueCodes(domain: string): readonly string[] {
  const catalog = fieldValueCatalogs.find((item) => item.domain === domain);
  assert(catalog, `missing field value domain for ${domain}`);
  return catalog.entries.map((entry) => entry.code);
}

function buildSeeds(count: number): ModelSeed[] {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const operatorsUsed = Math.min(20, count);
  const concentratedParents = Math.min(20, count);

  const assetTypeCodes = fieldValueCodes('AssetType');
  const stationLevelCodes = fieldValueCodes('StationLevel');
  const lineClassCodes = fieldValueCodes('LineClass');
  const trainTypeCodes = fieldValueCodes('TrainType');
  const serviceStatusCodes = fieldValueCodes('ServiceStatus');
  const carriageTypeCodes = fieldValueCodes('CarriageType');
  const employeeRoleCodes = fieldValueCodes('EmployeeRole');
  const shiftTypeCodes = fieldValueCodes('ShiftType');
  const workOrderCategoryCodes = fieldValueCodes('WorkOrderCategory');
  const workOrderPriorityCodes = fieldValueCodes('WorkOrderPriority');
  const workOrderStatusCodes = fieldValueCodes('WorkOrderStatus');
  const incidentTypeCodes = fieldValueCodes('IncidentType');
  const incidentSeverityCodes = fieldValueCodes('IncidentSeverity');
  const travelClassCodes = fieldValueCodes('TravelClass');
  const salesChannelCodes = fieldValueCodes('SalesChannel');
  const ticketStatusCodes = fieldValueCodes('TicketStatus');

  return [
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
      model: 'Region',
      keyField: 'regionCode',
      rows: Array.from({ length: 10 }, (_, index) => ({
        regionCode: `REG${pad(index + 1, 2)}`,
        name: i18n(
          `铁路运营区域${index + 1}`,
          `Railway Region ${index + 1}`,
          `鉄道運行地域${index + 1}`,
        ),
        countryCode: 'CN',
        timezone: 'Asia/Shanghai',
        active: index % 17 !== 0,
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
        length: { value: 80 + index * 3.25, unit: 'km' },
        maxSpeed: { value: [160, 200, 250, 350][index % 4]!, unit: 'km/h' },
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
        maxSpeed: { value: [160, 200, 250, 350][index % 4]!, unit: 'km/h' },
        seatCapacity: 420 + (index % 8) * 64,
        mileage: { value: 12_000 + index * 2_345, unit: 'km' },
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
        energyUsed: { value: 2_500 + index * 19, unit: 'kWh' },
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
        estimatedCost: { value: 2_000 + index * 315, unit: 'CNY' },
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
        fare: { value: 35 + (index % 40) * 12.5, unit: 'CNY' },
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
  validateDataSplitMetadata();
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
      const expectedCount = schema.name === 'Region' ? 10 : rowCount;
      assert(
        rows.length === expectedCount,
        `${schema.name} expected ${expectedCount}, got ${rows.length}`,
      );
    }

    const firstLineId = requireId(lineIds, 'LIN001');
    const firstServiceId = requireId(idsByModel.get('TrainService')!, 'SVC001');
    const firstTrainId = requireId(idsByModel.get('Train')!, 'TRN001');
    const firstStationId = requireId(stationIds, 'STA001');

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

    const stationRegion = rowData(
      await client.model('Station').query([firstStationId]).relate('stationRegionRef').execute(),
    );
    assert(stationRegion[0]?.regionCode === 'REG01', 'Station -> Region query');

    const firstLine = rowData(await client.model('RailwayLine').query([firstLineId]).execute())[0];
    const lineLength = firstLine?.length;
    assert(
      lineLength &&
        typeof lineLength === 'object' &&
        (lineLength as { unit?: unknown }).unit === 'km',
      'RailwayLine Unit field query',
    );

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
      dataSplitMetadata,
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
        stationRegion: stationRegion[0]?.regionCode,
        lineLengthValueUnit: (lineLength as { unit: string }).unit,
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
