import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ModelDB, type RemoteModelDBClient } from '@mode-db/sdk';

const BUSINESS_DATABASE = 'railway_operations_demo';
const DESIGNER_DATABASE = 'model_designer_workspace';

type LocaleMap = { zh: string; en: string; ja: string };
type MetadataEntry = { name: LocaleMap; description: LocaleMap };

const locale = (zh: string, en: string, ja: string): LocaleMap => ({ zh, en, ja });
const metadata = (zh: string, en: string, ja: string, description: LocaleMap): MetadataEntry => ({
  name: locale(zh, en, ja),
  description,
});
const fieldMetadata = (zh: string, en: string, ja: string): MetadataEntry =>
  metadata(
    zh,
    en,
    ja,
    locale(`记录${zh}。`, `Records ${en.toLowerCase()}.`, `${ja}を記録します。`),
  );

const libraryMetadata: MetadataEntry = metadata(
  '铁路运营综合示例库',
  'Railway Operations Demo',
  '鉄道運行統合デモ',
  locale(
    '用于验证铁路基础设施、运输组织、车辆、人员、检修和安全事件的综合模型。',
    'An integrated model for validating railway infrastructure, operations, rolling stock, crew, maintenance, and incidents.',
    '鉄道インフラ、運行、車両、乗務員、保守、インシデントを検証するための統合モデルです。',
  ),
);

const modelMetadata: Record<string, MetadataEntry> = {
  Station: metadata(
    '车站',
    'Station',
    '駅',
    locale(
      '铁路客货运输的车站主数据。',
      'Master data for railway stations.',
      '鉄道駅のマスターデータです。',
    ),
  ),
  Line: metadata(
    '铁路线',
    'Railway Line',
    '鉄道路線',
    locale(
      '铁路线路及其运营属性。',
      'Railway lines and their operating attributes.',
      '鉄道路線と運行属性を管理します。',
    ),
  ),
  LineSection: metadata(
    '线路区间',
    'Line Section',
    '線路区間',
    locale(
      '相邻车站之间的线路区间。',
      'A railway section between adjacent stations.',
      '隣接駅間の線路区間です。',
    ),
  ),
  TrackSegment: metadata(
    '轨道区段',
    'Track Segment',
    '軌道区間',
    locale(
      '区间内可独立维护和监测的轨道资产。',
      'A track asset maintained and monitored within a line section.',
      '線路区間内で個別に保守・監視する軌道資産です。',
    ),
  ),
  TrainService: metadata(
    '列车车次',
    'Train Service',
    '列車運行',
    locale(
      '按日期开行的列车运行任务。',
      'A dated train operating service.',
      '運行日ごとの列車運行タスクです。',
    ),
  ),
  TrainStop: metadata(
    '经停记录',
    'Train Stop',
    '停車記録',
    locale(
      '车次在车站的计划与实际经停信息。',
      'Planned and actual stop information for a train service.',
      '列車の計画・実績停車情報です。',
    ),
  ),
  RollingStock: metadata(
    '动车组',
    'Rolling Stock',
    '鉄道車両',
    locale(
      '执行运输任务的动车组或车辆单元。',
      'A rolling-stock unit assigned to transport services.',
      '輸送サービスに割り当てる鉄道車両ユニットです。',
    ),
  ),
  Carriage: metadata(
    '车厢',
    'Carriage',
    '客車',
    locale(
      '动车组编组中的单节车厢。',
      'An individual carriage in a rolling-stock consist.',
      '鉄道車両編成を構成する個別の客車です。',
    ),
  ),
  Crew: metadata(
    '乘务人员',
    'Crew',
    '乗務員',
    locale(
      '司机、列车长和检修人员等铁路作业人员。',
      'Railway operating staff such as drivers, conductors, and maintenance engineers.',
      '運転士、車掌、保守技術者などの鉄道従事者です。',
    ),
  ),
  MaintenanceWorkOrder: metadata(
    '检修工单',
    'Maintenance Work Order',
    '保守作業指示',
    locale(
      '面向车辆或轨道资产的检修处置工单。',
      'A maintenance work order for rolling stock or track assets.',
      '車両または軌道資産に対する保守作業指示です。',
    ),
  ),
  InspectionRecord: metadata(
    '检测记录',
    'Inspection Record',
    '検査記録',
    locale(
      '车辆或轨道资产的检测结果。',
      'Inspection results for rolling stock or track assets.',
      '車両または軌道資産の検査結果です。',
    ),
  ),
  Incident: metadata(
    '运营事件',
    'Operational Incident',
    '運行インシデント',
    locale(
      '影响铁路运输的安全或服务事件。',
      'A safety or service incident affecting railway operations.',
      '鉄道運行に影響する安全・サービス上のインシデントです。',
    ),
  ),
};

const fieldMetadataByName: Record<string, MetadataEntry> = {
  accessible: fieldMetadata('无障碍设施', 'Accessible', 'バリアフリー対応'),
  actualArrival: fieldMetadata('实际到达时间', 'Actual Arrival', '実到着時刻'),
  actualDeparture: fieldMetadata('实际发车时间', 'Actual Departure', '実発車時刻'),
  baseDepot: fieldMetadata('所属段所', 'Base Depot', '所属車両所'),
  capacity: fieldMetadata('定员', 'Capacity', '定員'),
  carNo: fieldMetadata('车厢编号', 'Carriage Number', '客車番号'),
  category: fieldMetadata('类别', 'Category', 'カテゴリ'),
  city: fieldMetadata('所在城市', 'City', '所在都市'),
  code: fieldMetadata('编码', 'Code', 'コード'),
  completedAt: fieldMetadata('完成时间', 'Completed At', '完了日時'),
  delayMinutes: fieldMetadata('晚点分钟数', 'Delay Minutes', '遅延分数'),
  description: fieldMetadata('说明', 'Description', '説明'),
  designSpeedKmH: fieldMetadata('设计速度（公里/小时）', 'Design Speed (km/h)', '設計速度（km/h）'),
  direction: fieldMetadata('运行方向', 'Direction', '運行方向'),
  dueAt: fieldMetadata('要求完成时间', 'Due At', '期限'),
  electrified: fieldMetadata('是否电气化', 'Electrified', '電化済み'),
  employeeNo: fieldMetadata('员工编号', 'Employee Number', '従業員番号'),
  endKm: fieldMetadata('终点里程', 'End Kilometer', '終点キロ程'),
  incidentNo: fieldMetadata('事件编号', 'Incident Number', 'インシデント番号'),
  inspectNo: fieldMetadata('检测编号', 'Inspection Number', '検査番号'),
  inspectedAt: fieldMetadata('检测时间', 'Inspected At', '検査日時'),
  inspectionType: fieldMetadata('检测类型', 'Inspection Type', '検査種別'),
  inspector: fieldMetadata('检测人员', 'Inspector', '検査担当者'),
  kind: fieldMetadata('线路类型', 'Line Type', '路線種別'),
  lengthKm: fieldMetadata('长度（公里）', 'Length (km)', '延長（km）'),
  level: fieldMetadata('等级', 'Level', '等級'),
  licenseLevel: fieldMetadata('资质等级', 'License Level', '資格等級'),
  maxSpeedKmH: fieldMetadata('最高速度（公里/小时）', 'Maximum Speed (km/h)', '最高速度（km/h）'),
  measuredValue: fieldMetadata('测量值', 'Measured Value', '測定値'),
  mileageKm: fieldMetadata('累计里程（公里）', 'Mileage (km)', '累積走行距離（km）'),
  model: fieldMetadata('车型', 'Vehicle Model', '車両形式'),
  name: fieldMetadata('名称', 'Name', '名称'),
  openedAt: fieldMetadata('创建时间', 'Opened At', '起票日時'),
  orderNo: fieldMetadata('工单编号', 'Work Order Number', '作業指示番号'),
  occurredAt: fieldMetadata('发生时间', 'Occurred At', '発生日時'),
  passengerVolumeDaily: fieldMetadata('日均客流量', 'Daily Passenger Volume', '一日平均旅客数'),
  plannedArrival: fieldMetadata('计划到达时间', 'Planned Arrival', '計画到着時刻'),
  plannedDeparture: fieldMetadata('计划发车时间', 'Planned Departure', '計画発車時刻'),
  platform: fieldMetadata('站台', 'Platform', 'ホーム'),
  priority: fieldMetadata('优先级', 'Priority', '優先度'),
  result: fieldMetadata('检测结果', 'Result', '検査結果'),
  role: fieldMetadata('岗位角色', 'Role', '職務'),
  sequence: fieldMetadata('停站顺序', 'Stop Sequence', '停車順序'),
  serviceDate: fieldMetadata('开行日期', 'Service Date', '運行日'),
  serviceNo: fieldMetadata('车次号', 'Service Number', '列車番号'),
  severity: fieldMetadata('严重程度', 'Severity', '重大度'),
  speedLimitKmH: fieldMetadata('限速（公里/小时）', 'Speed Limit (km/h)', '速度制限（km/h）'),
  startKm: fieldMetadata('起点里程', 'Start Kilometer', '起点キロ程'),
  status: fieldMetadata('状态', 'Status', '状態'),
  stopCode: fieldMetadata('经停编码', 'Stop Code', '停車コード'),
  trackNo: fieldMetadata('股道编号', 'Track Number', '線路番号'),
  type: fieldMetadata('类型', 'Type', '種別'),
  unitNo: fieldMetadata('车辆编号', 'Unit Number', '車両番号'),
};

const relationNames: Record<string, { forward: LocaleMap; reverse: LocaleMap }> = {
  sections: {
    forward: locale('所含区间', 'Sections', '所属線区'),
    reverse: locale('所属线路', 'Line', '所属路線'),
  },
  startStation: {
    forward: locale('起点车站', 'Start Station', '起点駅'),
    reverse: locale('发出区间', 'Departing Sections', '始発側区間'),
  },
  endStation: {
    forward: locale('终点车站', 'End Station', '終点駅'),
    reverse: locale('到达区间', 'Arriving Sections', '終着側区間'),
  },
  tracks: {
    forward: locale('所含轨道', 'Tracks', '所属軌道'),
    reverse: locale('所属区间', 'Section', '所属線区'),
  },
  operatesOnLine: {
    forward: locale('运行线路', 'Operates On Line', '運行路線'),
    reverse: locale('开行车次', 'Train Services', '運行列車'),
  },
  stops: {
    forward: locale('经停记录', 'Stops', '停車記録'),
    reverse: locale('所属车次', 'Train Service', '所属列車'),
  },
  station: {
    forward: locale('停靠车站', 'Station', '停車駅'),
    reverse: locale('车站经停记录', 'Train Stops', '駅停車記録'),
  },
  assignedRollingStock: {
    forward: locale('配属动车组', 'Assigned Rolling Stock', '充当車両'),
    reverse: locale('执行车次', 'Services', '担当列車'),
  },
  carriages: {
    forward: locale('编组车厢', 'Carriages', '編成客車'),
    reverse: locale('所属动车组', 'Rolling Stock', '所属編成'),
  },
  crewMembers: {
    forward: locale('乘务人员', 'Crew Members', '乗務員'),
    reverse: locale('值乘车次', 'Assigned Services', '担当列車'),
  },
  maintainsRollingStock: {
    forward: locale('检修动车组', 'Maintains Rolling Stock', '保守対象車両'),
    reverse: locale('车辆检修工单', 'Maintenance Orders', '車両保守指示'),
  },
  maintainsTrack: {
    forward: locale('检修轨道', 'Maintains Track', '保守対象軌道'),
    reverse: locale('轨道检修工单', 'Track Maintenance Orders', '軌道保守指示'),
  },
  inspectsRollingStock: {
    forward: locale('检测动车组', 'Inspects Rolling Stock', '検査対象車両'),
    reverse: locale('车辆检测记录', 'Inspection Records', '車両検査記録'),
  },
  inspectsTrack: {
    forward: locale('检测轨道', 'Inspects Track', '検査対象軌道'),
    reverse: locale('轨道检测记录', 'Track Inspection Records', '軌道検査記録'),
  },
  occursOnSection: {
    forward: locale('发生区间', 'Occurs On Section', '発生線区'),
    reverse: locale('区间事件', 'Incidents', '線区インシデント'),
  },
  involvesService: {
    forward: locale('涉及车次', 'Involves Service', '関連列車'),
    reverse: locale('车次事件', 'Incidents', '列車インシデント'),
  },
  managedByStation: {
    forward: locale('处置车站', 'Managed By Station', '対応駅'),
    reverse: locale('处置事件', 'Managed Incidents', '対応インシデント'),
  },
};

function rowData(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object' || !('getData' in row)) {
    throw new Error('Unexpected ModelDB row');
  }
  return (row as { getData(): Record<string, unknown> }).getData();
}

function rowsData(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error('Unexpected ModelDB query result');
  }
  return value.map(rowData);
}

function parseMeta(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function relationDescription(
  source: MetadataEntry,
  target: MetadataEntry,
  relation: LocaleMap,
): LocaleMap {
  return locale(
    `从${source.name.zh}关联到${target.name.zh}的“${relation.zh}”关系。`,
    `The "${relation.en}" relation from ${source.name.en} to ${target.name.en}.`,
    `${source.name.ja}から${target.name.ja}への「${relation.ja}」関係です。`,
  );
}

async function runUpdates(
  client: RemoteModelDBClient,
  operations: Array<{ model: string; id: string; partial: Record<string, unknown> }>,
): Promise<void> {
  for (let index = 0; index < operations.length; index += 40) {
    const batch = operations.slice(index, index + 40);
    const result = await client.batchUpdate(batch, { sync: true });
    if (result.failureCount > 0) {
      throw new Error(`I18N_UPDATE_FAILED at batch ${Math.floor(index / 40) + 1}`);
    }
  }
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
const client = await db.use(DESIGNER_DATABASE);

try {
  const assetRows = rowsData(await client.model('sys_data_asset_map').query().execute());
  const asset = assetRows.find((row) => row.code === BUSINESS_DATABASE);
  if (!asset || typeof asset._id !== 'string') {
    throw new Error(`Library metadata row not found: ${BUSINESS_DATABASE}`);
  }

  const modelRows = rowsData(
    await client
      .model('sys_model')
      .query()
      .group('modelOwnsProps')
      .execute({ includeRelates: true }),
  ).filter((row) => row.library_code === BUSINESS_DATABASE);
  const relationRows = rowsData(await client.model('sys_relation').query().execute()).filter(
    (row) => row.library_code === BUSINESS_DATABASE,
  );

  const operations: Array<{ model: string; id: string; partial: Record<string, unknown> }> = [
    {
      model: 'sys_data_asset_map',
      id: asset._id,
      partial: libraryMetadata,
    },
  ];
  const seenFields = new Set<string>();

  for (const modelRow of modelRows) {
    const modelName = typeof modelRow.engine_name === 'string' ? modelRow.engine_name : '';
    const modelId = typeof modelRow._id === 'string' ? modelRow._id : '';
    const modelEntry = modelMetadata[modelName];
    if (!modelId || !modelEntry) {
      throw new Error(`Missing model i18n mapping: ${modelName || '<unknown>'}`);
    }
    operations.push({ model: 'sys_model', id: modelId, partial: modelEntry });

    const relates = modelRow.relates as Record<string, unknown> | undefined;
    const props = Array.isArray(relates?.modelOwnsProps)
      ? (relates.modelOwnsProps as Record<string, unknown>[])
      : [];
    for (const prop of props) {
      const propId = typeof prop._id === 'string' ? prop._id : '';
      const fieldName = typeof prop.engine_name === 'string' ? prop.engine_name : '';
      const fieldEntry = fieldMetadataByName[fieldName];
      if (!propId || !fieldEntry) {
        throw new Error(`Missing field i18n mapping: ${modelName}.${fieldName || '<unknown>'}`);
      }
      seenFields.add(`${modelName}.${fieldName}`);
      operations.push({ model: 'sys_props', id: propId, partial: fieldEntry });
    }
  }

  for (const relationRow of relationRows) {
    const relationId = typeof relationRow._id === 'string' ? relationRow._id : '';
    const forwardName = typeof relationRow.engine_name === 'string' ? relationRow.engine_name : '';
    const labels = relationNames[forwardName];
    const canvasMeta = parseMeta(relationRow.canvas_meta);
    const sourceName = typeof canvasMeta.source === 'string' ? canvasMeta.source : '';
    const targetName = typeof canvasMeta.target === 'string' ? canvasMeta.target : '';
    const source = modelMetadata[sourceName];
    const target = modelMetadata[targetName];
    if (!relationId || !labels || !source || !target) {
      throw new Error(`Missing relation i18n mapping: ${sourceName}.${forwardName}.${targetName}`);
    }
    const forwardDescription = relationDescription(source, target, labels.forward);
    const reverseDescription = relationDescription(target, source, labels.reverse);
    operations.push({
      model: 'sys_relation',
      id: relationId,
      partial: {
        name: labels.forward,
        description: forwardDescription,
        forwardDescription,
        reverseDescription,
        canvas_meta: JSON.stringify({
          ...canvasMeta,
          forwardNameI18n: labels.forward,
          reverseNameI18n: labels.reverse,
          forwardDescription,
          reverseDescription,
        }),
      },
    });
  }

  if (modelRows.length !== Object.keys(modelMetadata).length) {
    throw new Error(
      `Expected ${Object.keys(modelMetadata).length} models, found ${modelRows.length}`,
    );
  }
  if (relationRows.length !== Object.keys(relationNames).length) {
    throw new Error(
      `Expected ${Object.keys(relationNames).length} relations, found ${relationRows.length}`,
    );
  }
  if (seenFields.size !== 74) {
    throw new Error(`Expected 74 model fields, found ${seenFields.size}`);
  }

  await runUpdates(client, operations);

  const verifyModels = rowsData(await client.model('sys_model').query().execute()).filter(
    (row) => row.library_code === BUSINESS_DATABASE,
  );
  const verifyProps = rowsData(await client.model('sys_props').query().execute()).filter(
    (row) => row.library_code === BUSINESS_DATABASE,
  );
  const verifyRelations = rowsData(await client.model('sys_relation').query().execute()).filter(
    (row) => row.library_code === BUSINESS_DATABASE,
  );
  const complete = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const map = value as Record<string, unknown>;
    return ['zh', 'en', 'ja'].every((key) => typeof map[key] === 'string' && map[key] !== '');
  };
  if (!verifyModels.every((row) => complete(row.name) && complete(row.description))) {
    throw new Error('Model i18n verification failed');
  }
  if (!verifyProps.every((row) => complete(row.name) && complete(row.description))) {
    throw new Error('Field i18n verification failed');
  }
  if (
    !verifyRelations.every((row) => {
      const meta = parseMeta(row.canvas_meta);
      return (
        complete(row.name) &&
        complete(row.description) &&
        complete(meta.forwardNameI18n) &&
        complete(meta.reverseNameI18n) &&
        complete(meta.forwardDescription) &&
        complete(meta.reverseDescription)
      );
    })
  ) {
    throw new Error('Relation i18n verification failed');
  }

  console.log(
    JSON.stringify(
      {
        database: BUSINESS_DATABASE,
        locales: ['zh', 'en', 'ja'],
        library: 1,
        models: verifyModels.length,
        fields: verifyProps.length,
        relations: verifyRelations.length,
        updatedRows: operations.length,
      },
      null,
      2,
    ),
  );
} finally {
  client.close();
}
