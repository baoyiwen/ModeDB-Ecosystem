/**
 * UI strings for playground. Keys are stable; values per locale.
 */
export type LocaleId = 'en' | 'zh-CN';

export const DEFAULT_LOCALE: LocaleId = 'zh-CN';

export const LOCALE_LABEL: Record<LocaleId, string> = {
  en: 'English',
  'zh-CN': '中文',
};

const en = {
  'app.title': 'ModeDB playground',
  'app.lang': 'Language',
  'meta.endpoint': '{endpoint} · WebGPU: {webGpu}',
  'webgpu.unavailable': 'unavailable',
  'webgpu.adapterOk': 'adapter ok',
  'webgpu.noAdapter': 'no adapter',
  'webgpu.ellipsis': '…',

  'connect.host': 'Host',
  'connect.port': 'Port',
  'connect.token': 'Connect token',
  'connect.button': 'Connect',
  'connect.needCredentials': 'Host, port, and token are required.',

  'session.connected': 'Connected.',
  'session.refreshTree': 'Refresh tree',
  'session.disconnect': 'Disconnect',
  'session.noDatabases': 'No databases in workspace.',

  'tree.models': 'Models',
  'tree.relations': 'Relations',
  'tree.extends': ' extends ',

  'db.newName': 'New database name',
  'db.create': 'Create database',
  'db.deleteSelected': 'Delete selected DB',
  'db.needName': 'New database name is required.',
  'db.confirmDelete': 'Delete logical database "{name}" from workspace?',

  'ops.title': 'Operations',
  'ops.connectFirst': 'Connect to load databases and models.',
  'ops.selectionDb': 'DB: {db}',
  'ops.selectionDbModel': 'DB: {db} · Model: {model}',
  'ops.selectDb': 'Select a database in the tree.',
  'ops.hint':
    'Wire meta supports alterModel (patch), dropModel, dropRelation, and row insertMany. Creating brand-new models or relations from an empty atlas requires server-side authoring tools; use an existing catalog or seed data first.',

  'query.title': 'Query',
  'query.relateLabel': 'Optional relation forward (hop + includeRelates)',
  'query.relatePlaceholder': 'Forward label from catalog',
  'query.run': 'Run query',

  'insert.title': 'Rows · insertMany',
  'insert.button': 'Insert rows',
  'insert.mustArray': 'Insert body must be a JSON array of row objects.',

  'schema.title': 'Schema · alterModel (patch)',
  'schema.applyPatch': 'Apply patch',
  'schema.dropModel': 'Drop model',
  'schema.confirmDrop': 'Drop model "{name}" (logical delete on server)?',

  'rel.title': 'Relation · drop',
  'rel.placeholder': 'Relation forward label',
  'rel.drop': 'Drop relation',
  'rel.needForward': 'Enter relation forward label to drop.',

  'result.title': 'Result',
  'result.empty': 'Query / mutation output appears here (hydrated rows when applicable).',
  'result.loading': 'Loading…',

  'error.selectDbModel': 'Select a database and a model.',
} as const;

const zhCN: Record<keyof typeof en, string> = {
  'app.title': 'ModeDB 演练场',
  'app.lang': '语言',
  'meta.endpoint': '{endpoint} · WebGPU：{webGpu}',
  'webgpu.unavailable': '不可用',
  'webgpu.adapterOk': '适配器正常',
  'webgpu.noAdapter': '无适配器',
  'webgpu.ellipsis': '…',

  'connect.host': '主机',
  'connect.port': '端口',
  'connect.token': '连接令牌',
  'connect.button': '连接',
  'connect.needCredentials': '请填写主机、端口和令牌。',

  'session.connected': '已连接。',
  'session.refreshTree': '刷新目录树',
  'session.disconnect': '断开连接',
  'session.noDatabases': '工作区中暂无数据库。',

  'tree.models': '模型',
  'tree.relations': '关系',
  'tree.extends': ' 继承 ',

  'db.newName': '新数据库名称',
  'db.create': '创建数据库',
  'db.deleteSelected': '删除所选库',
  'db.needName': '请填写新数据库名称。',
  'db.confirmDelete': '从工作区删除逻辑库「{name}」？',

  'ops.title': '操作',
  'ops.connectFirst': '请先连接以加载数据库与模型。',
  'ops.selectionDb': '库：{db}',
  'ops.selectionDbModel': '库：{db} · 模型：{model}',
  'ops.selectDb': '在左侧树中选择数据库。',
  'ops.hint':
    '线协议元操作支持 alterModel（补丁）、dropModel、dropRelation 与 insertMany 行写入。在空 atlas 上新建模型或关系需要服务端治理工具；请先使用已有目录或种子数据。',

  'query.title': '查询',
  'query.relateLabel': '可选关系正向名（一跳 + includeRelates）',
  'query.relatePlaceholder': '目录中的正向标签',
  'query.run': '执行查询',

  'insert.title': '行 · insertMany',
  'insert.button': '插入行',
  'insert.mustArray': '插入内容须为行对象的 JSON 数组。',

  'schema.title': '模式 · alterModel（补丁）',
  'schema.applyPatch': '应用补丁',
  'schema.dropModel': '删除模型',
  'schema.confirmDrop': '在服务端逻辑删除模型「{name}」？',

  'rel.title': '关系 · 删除',
  'rel.placeholder': '关系正向标签',
  'rel.drop': '删除关系',
  'rel.needForward': '请填写要删除的关系正向标签。',

  'result.title': '结果',
  'result.empty': '查询 / 变更结果将显示在此（含可序列化的 hydrated 行）。',
  'result.loading': '加载中…',

  'error.selectDbModel': '请选择数据库与模型。',
};

export type MessageKey = keyof typeof en;

export const messages: Record<LocaleId, Record<MessageKey, string>> = {
  en: en as unknown as Record<MessageKey, string>,
  'zh-CN': zhCN,
};
