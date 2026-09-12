import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ModelDB, type RemoteModelDBClient } from '@mode-db/sdk';

const DATABASE = 'railway_operations_demo';
const TARGET_ROWS = 100;

type DataRow = Record<string, unknown> & { _id: string };
type RowFactory = (index: number) => Record<string, unknown>;

const keyFields = {
  Station: 'code',
  Line: 'code',
  LineSection: 'code',
  TrackSegment: 'code',
  TrainService: 'serviceNo',
  TrainStop: 'stopCode',
  RollingStock: 'unitNo',
  Carriage: 'carNo',
  Crew: 'employeeNo',
  MaintenanceWorkOrder: 'orderNo',
  InspectionRecord: 'inspectNo',
  Incident: 'incidentNo',
} as const;

type ModelName = keyof typeof keyFields;

const pad = (value: number, width = 3): string => String(value).padStart(width, '0');
const pick = <T>(values: readonly T[], index: number): T => values[index % values.length]!;
const isoTime = (index: number, hour: number, minute = 0): string =>
  new Date(Date.UTC(2026, 6, 1 + (index % 28), hour, minute)).toISOString();
const dateOnly = (index: number): string => `2026-07-${pad(1 + (index % 28), 2)}`;

const factories: Record<ModelName, RowFactory> = {
  Station: (index) => ({
    code: `ST-AUTO-${pad(index)}`,
    name: `测试车站${pad(index)}`,
    city: pick(['上海', '苏州', '无锡', '南京', '杭州', '合肥', '徐州', '济南'], index),
    level: pick(['特等站', '一等站', '二等站', '三等站'], index),
    status: pick(['ACTIVE', 'ACTIVE', 'ACTIVE', 'MAINTENANCE', 'PLANNED'], index),
    passengerVolumeDaily: 8_000 + ((index * 3_791) % 180_000),
  }),
  Line: (index) => ({
    code: `LN-AUTO-${pad(index)}`,
    name: `测试铁路${pad(index)}`,
    kind: pick(['HIGH_SPEED', 'INTERCITY', 'CONVENTIONAL', 'FREIGHT'], index),
    status: pick(['ACTIVE', 'ACTIVE', 'MAINTENANCE', 'PLANNED'], index),
    designSpeedKmH: pick([120, 160, 200, 250, 300, 350], index),
  }),
  LineSection: (index) => {
    const startKm = index * 8.5;
    const lengthKm = 8 + (index % 12) * 1.75;
    return {
      code: `SEC-AUTO-${pad(index)}`,
      name: `测试区间${pad(index)}`,
      startKm,
      endKm: startKm + lengthKm,
      lengthKm,
      speedLimitKmH: pick([120, 160, 200, 250, 280, 300, 320], index),
      status: pick(['OPEN', 'OPEN', 'OPEN', 'RESTRICTED', 'MAINTENANCE'], index),
    };
  },
  TrackSegment: (index) => ({
    code: `TRK-AUTO-${pad(index)}`,
    trackNo: `${index % 2 === 0 ? '下行' : '上行'}-${pad(index, 2)}`,
    lengthKm: 8 + (index % 15) * 1.2,
    electrified: index % 10 !== 0,
    status: pick(['IN_SERVICE', 'IN_SERVICE', 'SPEED_RESTRICTED', 'MAINTENANCE'], index),
  }),
  TrainService: (index) => {
    const delayMinutes = pick([0, 0, 2, 5, 12, 30], index);
    return {
      serviceNo: `TS-AUTO-${pad(index)}`,
      serviceDate: dateOnly(index),
      direction: index % 2 === 0 ? 'DOWN' : 'UP',
      plannedDeparture: isoTime(index, 6 + (index % 12), (index * 7) % 55),
      actualDeparture: isoTime(index, 6 + (index % 12), ((index * 7) % 55) + delayMinutes),
      status: pick(['RUNNING', 'COMPLETED', 'PLANNED', 'DELAYED', 'CANCELLED'], index),
      delayMinutes,
    };
  },
  TrainStop: (index) => {
    const delayMinutes = index % 6;
    return {
      stopCode: `STOP-AUTO-${pad(index)}`,
      sequence: 1 + ((index - 1) % 8),
      plannedArrival: isoTime(index, 7 + (index % 11), (index * 5) % 50),
      actualArrival: isoTime(index, 7 + (index % 11), ((index * 5) % 50) + delayMinutes),
      platform: String(1 + (index % 16)),
      status: pick(['PLANNED', 'EXPECTED', 'ARRIVED', 'DEPARTED'], index),
    };
  },
  RollingStock: (index) => ({
    unitNo: `EMU-AUTO-${pad(index)}`,
    type: pick(['EMU', 'EMU', 'LOCOMOTIVE', 'MAINTENANCE_VEHICLE'], index),
    model: pick(['CR400AF', 'CR400BF', 'CRH2A', 'CRH380B', 'HXD3D'], index),
    maxSpeedKmH: pick([160, 200, 250, 300, 350], index),
    mileageKm: 100_000 + index * 21_357.5,
    status: pick(['IN_SERVICE', 'IN_SERVICE', 'MAINTENANCE_DUE', 'UNDER_INSPECTION'], index),
  }),
  Carriage: (index) => ({
    carNo: `CAR-AUTO-${pad(index)}`,
    type: pick(['BUSINESS_CLASS', 'FIRST_CLASS', 'SECOND_CLASS', 'DINING', 'SLEEPER'], index),
    capacity: pick([24, 48, 60, 80, 90, 100], index),
    accessible: index % 3 === 0,
    status: pick(['AVAILABLE', 'AVAILABLE', 'UNDER_INSPECTION', 'MAINTENANCE'], index),
  }),
  Crew: (index) => ({
    employeeNo: `EMP-AUTO-${pad(index)}`,
    name: `测试员工${pad(index)}`,
    role: pick(['DRIVER', 'CONDUCTOR', 'ATTENDANT', 'DISPATCHER', 'MAINTENANCE_ENGINEER'], index),
    licenseLevel: pick(['L1', 'L2', 'L3', 'SENIOR', 'CR400'], index),
    baseDepot: pick(['上海动车段', '南京动车段', '杭州机务段', '上海客运段', '南京客运段'], index),
    status: pick(['ON_DUTY', 'AVAILABLE', 'RESTING', 'TRAINING'], index),
  }),
  MaintenanceWorkOrder: (index) => ({
    orderNo: `WO-AUTO-${pad(index)}`,
    category: index % 2 === 0 ? 'TRACK' : 'ROLLING_STOCK',
    priority: pick(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], index),
    status: pick(['OPEN', 'IN_PROGRESS', 'PLANNED', 'COMPLETED'], index),
    openedAt: isoTime(index, 1 + (index % 8)),
    dueAt: isoTime(index + 1, 8 + (index % 10)),
    ...(index % 4 === 0 ? { completedAt: isoTime(index + 1, 6) } : {}),
    description: `自动生成检修任务${pad(index)}：${index % 2 === 0 ? '轨道几何复核' : '车辆关键部件检查'}`,
  }),
  InspectionRecord: (index) => ({
    inspectNo: `INS-AUTO-${pad(index)}`,
    inspectionType: index % 2 === 0 ? 'TRACK_GEOMETRY' : 'ROLLING_DAILY',
    result: pick(['PASS', 'PASS', 'ATTENTION', 'FAIL'], index),
    measuredValue: Number((((index * 13) % 100) + index / 100).toFixed(2)),
    inspectedAt: isoTime(index, 2 + (index % 12)),
    inspector: `检测员${pad(1 + (index % 20), 2)}`,
  }),
  Incident: (index) => ({
    incidentNo: `INC-AUTO-${pad(index)}`,
    type: pick(
      ['SPEED_RESTRICTION', 'EQUIPMENT_FAULT', 'PASSENGER_SERVICE', 'WEATHER', 'SIGNAL'],
      index,
    ),
    severity: pick(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], index),
    status: pick(['OPEN', 'MONITORING', 'RESOLVED', 'CLOSED'], index),
    occurredAt: isoTime(index, index % 24, (index * 11) % 55),
    delayMinutes: pick([0, 3, 5, 10, 20, 45], index),
    description: `自动生成运营事件${pad(index)}，用于状态、时间和关系查询测试。`,
  }),
};

function rowsData(value: unknown): DataRow[] {
  if (!Array.isArray(value)) {
    throw new Error('Unexpected ModelDB query result');
  }
  return value.map((row) => {
    if (!row || typeof row !== 'object' || !('getData' in row)) {
      throw new Error('Unexpected ModelDB row');
    }
    const data = (row as { getData(): Record<string, unknown> }).getData();
    if (typeof data._id !== 'string') {
      throw new Error('ModelDB row is missing _id');
    }
    return data as DataRow;
  });
}

async function readModel(client: RemoteModelDBClient, model: ModelName): Promise<DataRow[]> {
  return rowsData(await client.model(model).query().execute());
}

function sortByKey(model: ModelName, rows: readonly DataRow[]): DataRow[] {
  const key = keyFields[model];
  return [...rows].sort((left, right) => String(left[key]).localeCompare(String(right[key])));
}

async function fillModel(
  client: RemoteModelDBClient,
  model: ModelName,
): Promise<{ rows: DataRow[]; inserted: number }> {
  const before = await readModel(client, model);
  const missingCount = Math.max(0, TARGET_ROWS - before.length);
  if (missingCount === 0) {
    return { rows: sortByKey(model, before), inserted: 0 };
  }

  const key = keyFields[model];
  const existingKeys = new Set(before.map((row) => String(row[key])));
  const candidates: Record<string, unknown>[] = [];
  for (let index = 1; candidates.length < missingCount; index++) {
    const candidate = factories[model](index);
    if (!existingKeys.has(String(candidate[key]))) {
      candidates.push(candidate);
    }
  }

  const result = await client.model(model).insertMany(candidates, { sync: true });
  if (result.failureCount > 0 || result.successCount !== candidates.length) {
    throw new Error(`${model} insert failed: ${result.failureCount} failures`);
  }
  const after = await readModel(client, model);
  if (after.length < TARGET_ROWS) {
    throw new Error(`${model} expected ${TARGET_ROWS} rows, found ${after.length}`);
  }
  return { rows: sortByKey(model, after), inserted: candidates.length };
}

async function bindPairs(
  client: RemoteModelDBClient,
  forward: string,
  pairs: readonly (readonly [string, string])[],
): Promise<number> {
  const unique = [...new Map(pairs.map((pair) => [`${pair[0]}\0${pair[1]}`, pair])).values()];
  const result = await client.apply({
    op: 'bind',
    forward,
    strategy: 'MANUAL',
    pairs: unique,
    sync: true,
  });
  if (!('op' in result) || result.op !== 'bind') {
    throw new Error(`${forward} bind returned an unexpected result`);
  }
  return unique.length;
}

const config = JSON.parse(readFileSync(resolve(process.cwd(), 'modeldb.config.json'), 'utf8')) as {
  host?: string;
  port?: number;
  connectToken?: string;
};
if (!config.connectToken) {
  throw new Error('connectToken is missing from modeldb.config.json');
}

const db = new ModelDB({
  host: config.host ?? '127.0.0.1',
  port: config.port ?? 9090,
  token: config.connectToken,
});
const client = await db.use(DATABASE);

try {
  const rows = {} as Record<ModelName, DataRow[]>;
  const inserted = {} as Record<ModelName, number>;
  for (const model of Object.keys(keyFields) as ModelName[]) {
    const result = await fillModel(client, model);
    rows[model] = result.rows;
    inserted[model] = result.inserted;
  }

  const station = rows.Station;
  const line = rows.Line;
  const section = rows.LineSection;
  const track = rows.TrackSegment;
  const service = rows.TrainService;
  const stop = rows.TrainStop;
  const rolling = rows.RollingStock;
  const carriage = rows.Carriage;
  const crew = rows.Crew;
  const workOrder = rows.MaintenanceWorkOrder;
  const inspection = rows.InspectionRecord;
  const incident = rows.Incident;

  const relationPairs: Record<string, Array<readonly [string, string]>> = {
    sections: section.map((target, index) => [line[index % line.length]!._id, target._id]),
    startStation: section.map((source, index) => [
      source._id,
      station[index % station.length]!._id,
    ]),
    endStation: section.map((source, index) => [
      source._id,
      station[(index + 1) % station.length]!._id,
    ]),
    tracks: track.map((target, index) => [section[index % section.length]!._id, target._id]),
    operatesOnLine: service.map((source, index) => [source._id, line[index % line.length]!._id]),
    stops: stop.map((target, index) => [service[index % service.length]!._id, target._id]),
    station: stop.map((source, index) => [source._id, station[index % station.length]!._id]),
    assignedRollingStock: service.map((source, index) => [
      source._id,
      rolling[index % rolling.length]!._id,
    ]),
    carriages: carriage.map((target, index) => [rolling[index % rolling.length]!._id, target._id]),
    crewMembers: service.flatMap((source, index) => [
      [source._id, crew[index % crew.length]!._id] as const,
      [source._id, crew[(index + 25) % crew.length]!._id] as const,
    ]),
    maintainsRollingStock: workOrder
      .filter((row) => row.category === 'ROLLING_STOCK')
      .map((source, index) => [source._id, rolling[index % rolling.length]!._id]),
    maintainsTrack: workOrder
      .filter((row) => row.category === 'TRACK')
      .map((source, index) => [source._id, track[index % track.length]!._id]),
    inspectsRollingStock: inspection
      .filter((row) => !String(row.inspectionType).startsWith('TRACK'))
      .map((source, index) => [source._id, rolling[index % rolling.length]!._id]),
    inspectsTrack: inspection
      .filter((row) => String(row.inspectionType).startsWith('TRACK'))
      .map((source, index) => [source._id, track[index % track.length]!._id]),
    occursOnSection: incident.map((source, index) => [
      source._id,
      section[index % section.length]!._id,
    ]),
    involvesService: incident.map((source, index) => [
      source._id,
      service[index % service.length]!._id,
    ]),
    managedByStation: incident.map((source, index) => [
      source._id,
      station[index % station.length]!._id,
    ]),
  };

  const boundPairs: Record<string, number> = {};
  for (const [forward, pairs] of Object.entries(relationPairs)) {
    boundPairs[forward] = await bindPairs(client, forward, pairs);
  }

  const sample = rowsData(
    await client
      .model('TrainService')
      .query()
      .is('serviceNo', 'TS-AUTO-001')
      .group('operatesOnLine')
      .group('assignedRollingStock')
      .group('crewMembers')
      .execute({ includeRelates: true }),
  );
  if (sample.length !== 1) {
    throw new Error(`Expected one TS-AUTO-001 row, found ${sample.length}`);
  }
  const sampleRelates = sample[0]!.relates as Record<string, unknown> | undefined;
  if (
    !Array.isArray(sampleRelates?.operatesOnLine) ||
    !Array.isArray(sampleRelates?.assignedRollingStock) ||
    !Array.isArray(sampleRelates?.crewMembers)
  ) {
    throw new Error('TrainService relation verification failed');
  }

  console.log(
    JSON.stringify(
      {
        database: DATABASE,
        targetRowsPerModel: TARGET_ROWS,
        totalRows: Object.values(rows).reduce((total, modelRows) => total + modelRows.length, 0),
        counts: Object.fromEntries(
          Object.entries(rows).map(([model, modelRows]) => [model, modelRows.length]),
        ),
        inserted,
        boundPairs,
        sampleQuery: {
          serviceNo: sample[0]!.serviceNo,
          lineCount: sampleRelates.operatesOnLine.length,
          rollingStockCount: sampleRelates.assignedRollingStock.length,
          crewCount: sampleRelates.crewMembers.length,
        },
      },
      null,
      2,
    ),
  );
} finally {
  client.close();
}
