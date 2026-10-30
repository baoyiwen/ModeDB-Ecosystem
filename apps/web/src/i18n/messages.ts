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
  identity_sessionExpired:
    'Your session has expired or is no longer valid. Sign in again with your passkey.',
  identity_title: 'Connect with a passkey',
  identity_subtitle: 'Verify in your browser without entering a token.',
  identity_server: 'Current server',
  identity_instance: 'Instance ID',
  identity_login: 'Sign in with Passkey / Windows Hello',
  identity_session: 'Identity verified. Continue to your authorized libraries.',
  identity_continue: 'Continue to libraries',
  identity_logout: 'Sign out',
  identity_registerTitle: 'First visit? Request access',
  identity_registerHint:
    'Create a passkey and submit a request. After local approval on the server, sign in separately.',
  identity_name: 'Request name (for the administrator)',
  identity_register: 'Create passkey and request access',
  identity_download: 'Download connection descriptor',
  identity_import: "Import this server's JSON descriptor (optional)",
  identity_imported:
    'Descriptor matches the current server. The file is never executed and grants no access.',
  identity_pendingTitle: 'Awaiting local administrator approval',
  identity_pending:
    'Request submitted. Use a trusted channel to explain your identity and required library access to the administrator.',
  identity_approvedTitle: 'Request approved',
  identity_approved:
    'Use the sign-in button above to verify with your new passkey. Approval alone does not create a session.',
  identity_rejectedTitle: 'Request rejected',
  identity_rejected:
    'Contact the administrator to confirm the reason. Confirm the registration window and permissions before applying again.',
  identity_expiredTitle: 'Request or challenge expired',
  identity_expired:
    'Start a new request. An existing approved passkey can sign in directly without registering again.',
  identity_application: 'Request ID',
  identity_expires: 'Request expires',
  identity_polling:
    'Checks at intervals of at least 5 seconds. Closing this page loses its status-query capability.',
  identity_dismiss: 'Dismiss status details',
  identity_working: "Working… Complete the browser's verification prompt.",
  identity_retry: 'Retry',
  identity_cancelled:
    'Verification was cancelled or timed out. You can retry; cancellation grants no access.',
  identity_unsupported:
    'Use a trusted HTTPS domain and a browser with WebAuthn support. Check the address, certificate trust and browser support. Do not bypass certificate warnings.',
  identity_limited:
    'Too many requests or the server is busy. Wait at least one minute before retrying.',
  identity_identity:
    'This passkey cannot sign in. It may be unapproved, disabled, revoked or from another instance. Contact the administrator.',
  identity_descriptor:
    "The descriptor or instance binding does not match. Download the latest JSON on the correct server page; do not use another instance's file.",
  identity_closed:
    'Registration is closed. Existing approved passkeys can still sign in. Contact the local administrator for new requests.',
  identity_loginClosed:
    'Passkey login is not enabled on this server. Contact the local administrator.',
  identity_unavailable:
    'The request could not be completed. Check the network and server before retrying. Do not resubmit a request whose outcome is uncertain.',
  identity_helpTitle: 'Replacement, lost credentials and recovery',
  identity_help:
    'Passkeys may sync through your platform; they do not prove physical device binding. Windows Hello availability depends on the browser and OS.',
  identity_replaceTitle: 'Replace a passkey',
  identity_replace:
    'Create a new pending request and share its ID with the local administrator through a trusted channel. Sign in after identity checks and key replacement. This page cannot take over an existing user.',
  identity_recoverTitle: 'Lost passkey or disabled access',
  identity_recover:
    "Use another approved passkey or ask the server's local administrator to verify your identity, revoke lost credentials and approve a replacement. Recovery cannot bypass verification.",
  identity_transient:
    'Reloading or closing loses the in-memory query secret; the request remains on the server. Ask the administrator to check its name and ID instead of repeatedly creating requests. Once approved, sign in directly.',
  identity_trust:
    'Descriptors contain public deployment information only. Downloading, importing or reaching the server does not grant approval. Verify the server identity through a trusted channel.',
  identity_legacy: 'Other methods: pairing code / application token',
  identity_advanced: 'Other connections: pairing code or application credential',
  'session.authMode': 'Authentication',
  'session.browserMode': 'Browser session (recommended)',
  'session.tokenMode': 'Service credential (advanced)',
  'session.pairingCode': 'One-time pairing code (optional for an existing session)',
  'session.pairingHint':
    'Use the local launcher or an administrator-issued pairing code. Sessions renew while in use, last at most 8 hours, and can be restored after reloading.',
  'session.logoutFailed':
    'Server logout could not be confirmed. Retry logout or ask the administrator to revoke the session.',
  'security.transport':
    'Remote security connections require HTTPS. Check the address, port and certificate trust; loopback HTTP is allowed.',
  'security.source':
    'The source network, browser Origin or proxy chain is not allowed. Check the server source policy.',
  'security.transportHint':
    'Use 127.0.0.1 locally, or https://hostname remotely with the HTTPS listening port.',
  'security.unconfirmed':
    'The operation may have completed, but its audit outcome could not be saved. Check its actual result before retrying.',
  'security.credentials':
    'The credential is invalid, expired or revoked. Obtain a new credential from the instance owner.',
  'security.forbidden':
    'This credential does not permit this database or operation. Model Designer also needs separate permissions for its designer workspace.',
  'security.scopeChanged':
    'The published interface changed. Review its release and authorize the new release digest.',
  'security.protocol':
    'Client credentials and server security protocol do not match. Upgrade the client and use the correct credential type.',
  'security.legacyVault':
    'This database uses the old Vault format. Continuing the security upgrade will not migrate it automatically.',
  'security.unavailable':
    'The security service is unavailable or cannot persist its audit. Check the server diagnostics.',
  'security.closed':
    'The secure connection closed or timed out. Reconnect with a valid credential.',
  'security.memoryOnly':
    'Credentials are kept only in memory. After refreshing this page, enter them again.',
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
  'session.restoring': 'Restoring session…',
  'session.expired': 'Session expired. Please connect again.',
  'session.reconnectFailed': 'Could not restore session: {reason}',
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
  'query.advancedHint':
    'Build wire-safe queries: filters, relation hops, pagination, and analysis. See the query manual for full examples and operator tables.',
  'query.tabForm': 'Form builder',
  'query.tabSnapshot': 'Snapshot JSON',
  'query.sectionStart': 'Start',
  'query.startIds': 'Row _id filter (optional)',
  'query.startIdsPlaceholder': 'id-1, id-2 (empty = all rows)',
  'query.sectionFilter': 'Filters',
  'query.filtersHint':
    'JSON array of { "field", "op", "value" }. Ops: eq, neq, gt, gte, lt, lte, like, in, between.',
  'query.sectionRelation': 'Relation hop',
  'query.hopKind': 'Hop type',
  'query.hopNone': 'None',
  'query.hopRelate': 'relate (change subject)',
  'query.hopGroup': 'group (lateral attach)',
  'query.hopChildren': 'children (tree)',
  'query.hopRecursive': 'relateRecursive',
  'query.relateLabel': 'Relation forward label',
  'query.relatePlaceholder': 'Forward label from catalog',
  'query.maxDepth': 'Max depth',
  'query.sectionExecute': 'Execute options',
  'query.limit': 'Limit',
  'query.page': 'Page (0-based)',
  'query.includeRelates': 'includeRelates (nested relates slots)',
  'query.sectionAnalysis': 'Analysis',
  'query.resultMode': 'Result mode',
  'query.modeRows': 'Rows',
  'query.modeAnalysis': 'Analysis (aggregate)',
  'query.groupBy': 'groupBy dimensions',
  'query.groupByPlaceholder': 'region, category',
  'query.compute': 'compute spec (JSON)',
  'query.run': 'Run query (chain)',
  'query.runViaApply': 'Run via apply(JSON)',
  'query.snapshotHint':
    'Full RemoteExecuteSnapshot for apply({ op: "executeQuery", snapshot }). Multi-hop plans — see query manual.',
  'query.fillModelTemplate': 'Fill template for selected model',
  'query.runSnapshot': 'Run snapshot',
  'query.openManual': 'Open query manual',

  'manual.title': 'Query operation manual',
  'manual.subtitle':
    'How to build wire-safe queries in the playground: form builder, fluent chain, and executeQuery snapshot.',
  'manual.back': '← Back to playground',
  'manual.backToPlayground': 'Return to playground',
  'manual.toc': 'Contents',
  'manual.footer':
    'Full protocol reference: docs/engine-operation-protocol.md in the repository. Snapshot JSON tab supports multi-hop plans and nested branches not exposed in the form.',
  'manual.sOverview.title': 'Overview',
  'manual.sOverview.p1':
    'ModeDB queries are relation-first: you start from a model (optionally filtered by _id), apply where filters, traverse relations via hops, then execute with optional pagination and analysis.',
  'manual.sOverview.p2':
    'The playground offers three paths: (1) Form builder → chain.execute(), (2) Form builder → apply({ op: "executeQuery", snapshot }), (3) Snapshot JSON tab for hand-written RemoteExecuteSnapshot.',
  'manual.sOverview.p3':
    'Chain and apply(JSON) return the same engine result; apply wraps rows in wire JSON ({ kind: "rows" | "paginated" | "analysis" }).',
  'manual.sQuickstart.title': 'Quick start',
  'manual.sQuickstart.p1':
    'Connect with host/port/token, pick a logical database and model in the left tree. The query form auto-saves per model in localStorage.',
  'manual.sQuickstart.p2':
    'Click a relation row in the tree to pre-fill the forward label and set hop type to relate. Run with「Run query (chain)」or「Run via apply(JSON)」and inspect JSON in the Result panel.',
  'manual.sStart.title': 'Start · model & row IDs',
  'manual.sStart.p1':
    'Leave「Row _id filter」empty to query all rows of the selected model. Comma/space/semicolon-separated IDs restrict the starting set before filters and hops.',
  'manual.sStart.p2':
    'The selected model in the tree becomes plan.start.model. IDs map to query([...]) vs query().',
  'manual.sFilters.title': 'Filters · where',
  'manual.sFilters.p1':
    'Filters are wire-safe predicate atoms: { field, op, value }. In the form, paste a JSON array; each entry becomes .where(field, op, value) on the chain.',
  'manual.sFilters.p2':
    'Multiple filters are AND-combined in order. See the filter operator table below for supported ops and value shapes.',
  'manual.sHops.title': 'Relation hops',
  'manual.sHops.p1':
    'One hop per form run. Use Snapshot JSON for chained hops (e.g. Order → lines → product) or nested build() branches.',
  'manual.sHops.p2':
    'Forward label must match the catalog relation forward name (shown in the left tree). Inverse labels are resolved by the engine.',
  'manual.sHops.p3':
    'children and relateRecursive accept maxDepth (default 5 in the form). includeRelates fills data.relates[slot] with nested rows or trees.',
  'manual.sExecute.title': 'Execute options',
  'manual.sExecute.p1':
    'limit caps rows per page; page is zero-based. When pagination applies, apply(JSON) returns { kind: "paginated", items: ... }.',
  'manual.sExecute.p2':
    "includeRelates: when true, related rows attach under each row's relates map (essential for group/children tree results).",
  'manual.sAnalysis.title': 'Analysis · groupBy + compute',
  'manual.sAnalysis.p1':
    'Set result mode to Analysis. groupBy accepts comma-separated field names (dimensions). compute is a JSON object mapping field → aggregate op (or array of ops).',
  'manual.sAnalysis.p2':
    'Response shape: { kind: "analysis", dimensionKeys, shape: "flat", rows: [...] }. Use Snapshot JSON for complex analysis not covered by the form.',
  'manual.sSnapshot.title': 'Snapshot JSON · executeQuery',
  'manual.sSnapshot.p1':
    'RemoteExecuteSnapshot = { plan, execute, analysis }. plan.start sets model and mode; plan.hops is an ordered hop list (relate, lateral group, recursive tree, branches).',
  'manual.sSnapshot.p2':
    'Prefer generating snapshots via chain.getRemoteExecuteSnapshot(options) in code, then paste into the Snapshot tab for editing.',
  'manual.sSnapshot.p3':
    'Run snapshot calls wire.apply({ op: "executeQuery", snapshot }) directly — no model selection required if plan.start.model is set.',
  'manual.sResults.title': 'Result shapes',
  'manual.sResults.p1':
    'Chain execute() returns hydrated entities (serialized in the UI as { model, data }). apply() returns wire JSON with a kind discriminator.',
  'manual.sResults.p2':
    'Paginated wrappers nest the inner result under items. Analysis rows are plain objects keyed by dimension and metric aliases.',
  'manual.sLimits.title': 'Wire limitations',
  'manual.sLimits.p1':
    'Not supported over the wire: filter(callback), customReduce(), wrapGroups(). Use server-side authoring or in-process QueryChain for those.',
  'manual.sLimits.p2':
    'Form builder covers a single hop. Multi-hop graphs, lateral branches, and build() subtrees require Snapshot JSON.',
  'manual.sLimits.p3':
    'Hand-written plan.hops must follow QueryPlanASTv2; invalid snapshots fail at execute with a diagnostic message.',
  'manual.sTips.title': 'Tips',
  'manual.sTips.p1':
    'Form settings persist per model key modedb.playground.query.<ModelName> in localStorage.',
  'manual.sTips.p2':
    'Compare chain vs apply on the same form to learn wire JSON — use「Run via apply(JSON)」.',
  'manual.sTips.p3':
    'For DDL / mutations (insert, alterModel, bindRelation), use the Operations panel; see engine-operation-protocol.md §4.',
  'manual.sFilterOps.title': 'Filter operators',
  'manual.sFilterOps.p1': 'Supported where ops in the playground form (JSON filters):',
  'manual.sHopCompare.title': 'Hop comparison',
  'manual.sHopCompare.p1': 'Choose hop type based on whether the query subject should change:',
  'manual.sComputeOps.title': 'Compute operators',
  'manual.sComputeOps.p1':
    'Values in compute JSON (single op or array for multiple metrics on one field):',
  'manual.table.op': 'Op',
  'manual.table.meaning': 'Meaning',
  'manual.table.valueShape': 'Value shape',
  'manual.table.hop': 'Hop',
  'manual.table.subject': 'Query subject',
  'manual.table.typicalUse': 'Typical use',
  'manual.op.eq': 'Equal',
  'manual.op.neq': 'Not equal',
  'manual.op.gt': 'Greater / greater-or-equal',
  'manual.op.lt': 'Less / less-or-equal',
  'manual.op.like': 'Pattern match (engine like semantics)',
  'manual.op.in': 'Value in set',
  'manual.op.between': 'Inclusive range [lo, hi]',
  'manual.opVal.scalar': 'string | number | boolean | null',
  'manual.opVal.number': 'number',
  'manual.opVal.string': 'string',
  'manual.opVal.array': 'JSON array',
  'manual.opVal.tuple': '[lo, hi] two-element array',
  'manual.hop.relateSubject': 'Changes to target model',
  'manual.hop.relateUse': 'Navigate along a relation; main query rows are targets',
  'manual.hop.groupSubject': 'Unchanged (lateral attach)',
  'manual.hop.groupUse': 'Keep parent rows; attach targets under relates[slot]',
  'manual.hop.childrenSubject': 'Unchanged (tree under slot)',
  'manual.hop.childrenUse': 'Self-relation tree via parent/child forward label',
  'manual.hop.recursiveSubject': 'Changes along recursive walk',
  'manual.hop.recursiveUse': 'Deep graph traversal with maxDepth cap',
  'manual.compute.sum': 'Sum of numeric field',
  'manual.compute.avg': 'Average',
  'manual.compute.min': 'Minimum',
  'manual.compute.max': 'Maximum',
  'manual.compute.count': 'Row count (often on id field)',
  'manual.compute.variance': 'Variance',
  'manual.compute.stdDev': 'Standard deviation',
  'manual.ex.allRows': 'All rows',
  'manual.ex.byIds': 'Start from specific _id values',
  'manual.ex.filtersJson': 'Filters JSON (form field)',
  'manual.ex.filtersChain': 'Equivalent fluent chain',
  'manual.ex.relate': 'relate — change subject',
  'manual.ex.group': 'group — lateral attach',
  'manual.ex.children': 'children — nested tree',
  'manual.ex.recursive': 'relateRecursive — deep traversal',
  'manual.ex.pagination': 'Limit and page',
  'manual.ex.analysis': 'Analysis chain',
  'manual.ex.computeJson': 'compute object',
  'manual.ex.snapshotMinimal': 'Minimal snapshot',
  'manual.ex.snapshotRelate': 'Snapshot with one relate hop',
  'manual.ex.applyQuery': 'Generate snapshot from chain, run via apply',
  'manual.ex.resultRows': 'rows result (apply)',
  'manual.ex.resultPaginated': 'paginated result (apply)',

  'insert.title': 'Rows · insertMany',
  'insert.button': 'Insert rows',
  'insert.mustArray': 'Insert body must be a JSON array of row objects.',

  'schema.title': 'Schema · alterModel (patch)',
  'schema.applyPatch': 'Apply patch',
  'schema.dropModel': 'Drop model',
  'schema.confirmDrop': 'Drop model "{name}" (logical delete on server)?',

  'data.title': 'Data · clear rows',
  'data.clearModel': 'Clear selected model data',
  'data.clearAll': 'Clear all data in library',
  'data.confirmClearModel':
    'Clear all row data for model "{name}"? Schema and relations stay registered.',
  'data.confirmClearAll':
    'Clear all row data in library "{db}"? All models and relations stay registered.',

  'backup.title': 'Database backup / recovery',
  'backup.hint':
    'Backups are server-side files under workspace/modeldb/backups. Restore and force reset create a safety backup first when possible.',
  'backup.create': 'Create backup',
  'backup.restore': 'Restore backup',
  'backup.clear': 'Clear data (managed)',
  'backup.forceReset': 'Force reset',
  'backup.empty': 'No backup files are available for the selected database.',
  'backup.restorePrompt': 'Enter a backup file name to restore:',
  'backup.confirmRestore':
    'Restore from {file}? Current database files will be replaced after a safety backup is created.',
  'backup.confirmClear':
    'Clear all data in {db}? Schema stays registered and a safety backup will be created first.',
  'backup.confirmForceReset':
    'Force-reset {db}? This is a corruption-recovery backdoor and will recreate the physical database after a safety backup.',

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
  identity_sessionExpired: '登录会话已到期或失效。请重新使用通行密钥登录。',
  identity_title: '使用通行密钥连接',
  identity_subtitle: '在浏览器中验证身份，无需输入 Token。',
  identity_server: '当前服务器',
  identity_instance: '实例标识',
  identity_login: '使用 Passkey / Windows Hello 登录',
  identity_session: '已验证身份。可继续选择有权访问的逻辑库。',
  identity_continue: '继续选择逻辑库',
  identity_logout: '退出登录',
  identity_registerTitle: '首次连接？申请访问权限',
  identity_registerHint: '创建通行密钥并提交申请。管理员在服务器本机批准后，仍需单独登录。',
  identity_name: '申请名称（供管理员识别）',
  identity_register: '创建通行密钥并申请',
  identity_download: '下载连接描述文件',
  identity_import: '导入此服务器的 JSON 描述文件（可选）',
  identity_imported: '描述文件已与当前服务器核对；文件不会执行，也不授予权限。',
  identity_pendingTitle: '等待本机管理员审批',
  identity_pending: '申请已提交。请通过可信渠道向管理员说明身份和所需库权限。',
  identity_approvedTitle: '申请已批准',
  identity_approved:
    '请点击上方登录按钮，再次使用刚创建的通行密钥验证身份。批准本身不会创建登录会话。',
  identity_rejectedTitle: '申请已被拒绝',
  identity_rejected: '请联系管理员核实原因。需要再次申请时，由管理员确认注册窗口与授权范围。',
  identity_expiredTitle: '申请或挑战已到期',
  identity_expired: '请重新开始申请。已有获批通行密钥可直接登录，无需重新注册。',
  identity_application: '申请编号',
  identity_expires: '申请到期时间',
  identity_polling: '每隔至少 5 秒查询一次。关闭页面会丢失本次查询能力。',
  identity_dismiss: '关闭状态详情',
  identity_working: '正在处理，请完成浏览器的身份验证提示…',
  identity_retry: '重试',
  identity_cancelled: '验证已取消或超时。可以重试；取消不会授予访问权限。',
  identity_unsupported:
    '此页面需要可信 HTTPS 域名和支持 WebAuthn 的浏览器。请确认服务器地址、证书信任和浏览器支持；不要绕过证书警告。',
  identity_limited: '请求过于频繁或服务繁忙。请至少等待一分钟后重试。',
  identity_identity:
    '此通行密钥无法登录，可能未批准、已停用、已撤销或不属于当前实例。请联系管理员。',
  identity_descriptor:
    '描述文件或实例绑定不匹配。请在正确服务器页面下载最新 JSON 文件；不要使用其他实例的文件。',
  identity_closed: '注册窗口已关闭。已有获批通行密钥仍可登录；新申请需联系本机管理员。',
  identity_loginClosed: '此服务器尚未启用通行密钥登录，请联系本机管理员。',
  identity_unavailable:
    '暂时无法完成请求。请检查网络及服务器状态后重试，勿重复提交不确定是否已成功的申请。',
  identity_helpTitle: '更换设备、丢失凭据与恢复',
  identity_help:
    'Passkey 可以由系统同步，不代表物理设备绑定。Windows Hello 是否可用由浏览器与系统决定。',
  identity_replaceTitle: '更换通行密钥',
  identity_replace:
    '先创建新的待审申请，将申请编号通过可信渠道交给本机管理员。管理员核实身份并执行换钥后再登录；页面不能自行接管原用户。',
  identity_recoverTitle: '通行密钥丢失或访问被停用',
  identity_recover:
    '使用另一枚已获批的通行密钥，或联系服务器本机管理员核实身份、撤销丢失凭据并批准替换。没有自动绕过验证的恢复入口。',
  identity_transient:
    '刷新或关闭页面会丢失申请查询秘密，申请仍保留在服务器。请让管理员按申请名称和编号核查；不要仅为恢复状态反复创建申请。获批后可直接登录。',
  identity_trust:
    '连接描述文件仅包含公开部署信息。下载、导入或能访问服务器均不等于获批；请通过可信渠道核对服务器身份。',
  identity_legacy: '其他连接方式：原配对码 / 应用 Token',
  identity_advanced: '其他连接方式：配对码或应用凭据',
  'session.authMode': '连接验证方式',
  'session.browserMode': '浏览器会话（推荐）',
  'session.tokenMode': '服务凭证（高级）',
  'session.pairingCode': '一次性配对码（已有会话可留空）',
  'session.pairingHint':
    '使用本机启动器或管理员提供的一次性配对码。会话在使用期间自动续期，最长 8 小时，刷新页面可恢复。',
  'session.logoutFailed': '未能确认服务端注销，请重试或由管理员撤销会话。',
  'security.transport':
    '远程安全连接需要 HTTPS。请检查主机地址、端口和证书信任；本机可使用 loopback HTTP。',
  'security.source': '来源网段、浏览器 Origin 或代理链未获允许，请检查服务端安全来源配置。',
  'security.transportHint':
    '本机填写 127.0.0.1；远程填写 https://域名，并将端口设为 HTTPS 监听端口。',
  'security.unconfirmed': '操作可能已执行，但审计结果未能确认。请先核对实际结果，避免重复提交。',
  'security.credentials': '凭据无效、已过期或已撤销，请向实例维护者获取新凭据。',
  'security.forbidden':
    '当前凭据没有该库或操作的权限。Model Designer 还需要设计器专属库的独立权限。',
  'security.scopeChanged': '接口发布内容已变更，请审核后重新授权新的发布摘要。',
  'security.protocol': '客户端凭据与服务端安全协议不匹配，请升级客户端并使用对应类型的凭据。',
  'security.legacyVault': '该库仍是旧版 Vault 格式，继续安全改造不会自动迁移它。',
  'security.unavailable': '安全服务不可用或无法保存审计记录，请检查服务端诊断。',
  'security.closed': '安全连接已关闭或超时，请使用有效凭据重新连接。',
  'security.memoryOnly': '凭据仅保存在内存中，刷新页面后需要重新输入。',
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
  'session.restoring': '正在恢复会话…',
  'session.expired': '会话已过期，请重新连接。',
  'session.reconnectFailed': '无法恢复会话：{reason}',
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
  'query.advancedHint':
    '构建 wire-safe 查询：过滤、关系跳转、分页与分析。完整示例与算子表见「查询操作手册」。',
  'query.tabForm': '表单构建',
  'query.tabSnapshot': 'Snapshot JSON',
  'query.sectionStart': '起点',
  'query.startIds': '行 _id 过滤（可选）',
  'query.startIdsPlaceholder': 'id-1, id-2（留空 = 全量）',
  'query.sectionFilter': '过滤条件',
  'query.filtersHint':
    'JSON 数组，元素为 { "field", "op", "value" }。op：eq、neq、gt、gte、lt、lte、like、in、between。',
  'query.sectionRelation': '关系跳转',
  'query.hopKind': '跳转类型',
  'query.hopNone': '无',
  'query.hopRelate': 'relate（切换主体）',
  'query.hopGroup': 'group（横向附加）',
  'query.hopChildren': 'children（树形）',
  'query.hopRecursive': 'relateRecursive',
  'query.relateLabel': '关系正向标签',
  'query.relatePlaceholder': '目录中的 forward 名',
  'query.maxDepth': '最大深度',
  'query.sectionExecute': '执行选项',
  'query.limit': 'Limit',
  'query.page': '页码（从 0 起）',
  'query.includeRelates': 'includeRelates（嵌套 relates 槽位）',
  'query.sectionAnalysis': '分析聚合',
  'query.resultMode': '结果模式',
  'query.modeRows': '行结果',
  'query.modeAnalysis': '分析（聚合）',
  'query.groupBy': 'groupBy 维度',
  'query.groupByPlaceholder': 'region, category',
  'query.compute': 'compute 规格（JSON）',
  'query.run': '执行查询（链式）',
  'query.runViaApply': '经 apply(JSON) 执行',
  'query.snapshotHint':
    '完整 RemoteExecuteSnapshot，用于 apply({ op: "executeQuery", snapshot })。多 hop 写法见「查询操作手册」。',
  'query.fillModelTemplate': '填充当前模型模板',
  'query.runSnapshot': '执行 Snapshot',
  'query.openManual': '打开查询操作手册',

  'manual.title': '查询操作手册',
  'manual.subtitle':
    '演练场中构建 wire-safe 查询的说明：表单构建、链式 API 与 executeQuery Snapshot。',
  'manual.back': '← 返回演练场',
  'manual.backToPlayground': '返回演练场',
  'manual.toc': '目录',
  'manual.footer':
    '完整协议见仓库 docs/engine-operation-protocol.md。Snapshot JSON 标签页支持表单未暴露的多 hop 与嵌套 branches。',
  'manual.sOverview.title': '概览',
  'manual.sOverview.p1':
    'ModeDB 查询以关系为先：从模型出发（可按 _id 限定起点），叠加 where 过滤，经关系 hop 遍历，最后执行并可选分页或分析聚合。',
  'manual.sOverview.p2':
    '演练场提供三种路径：(1) 表单 → chain.execute()；(2) 表单 → apply({ op: "executeQuery", snapshot })；(3) Snapshot JSON 标签页手写 RemoteExecuteSnapshot。',
  'manual.sOverview.p3':
    '链式与 apply(JSON) 走同一引擎；apply 返回 wire JSON（{ kind: "rows" | "paginated" | "analysis" }）。',
  'manual.sQuickstart.title': '快速上手',
  'manual.sQuickstart.p1':
    '填写主机/端口/令牌连接，在左侧树选择逻辑库与模型。查询表单按模型自动存入 localStorage。',
  'manual.sQuickstart.p2':
    '点击树中的关系行可预填 forward 标签并设为 relate。用「执行查询（链式）」或「经 apply(JSON) 执行」，在右侧结果面板查看 JSON。',
  'manual.sStart.title': '起点 · 模型与行 ID',
  'manual.sStart.p1':
    '「行 _id 过滤」留空表示选中模型的全量行。逗号/空格/分号分隔的 ID 会在过滤与 hop 之前限定起点集合。',
  'manual.sStart.p2':
    '树中选中的模型对应 plan.start.model；ID 列表对应 query([...]) 与 query() 之分。',
  'manual.sFilters.title': '过滤 · where',
  'manual.sFilters.p1':
    '过滤为 wire-safe 谓词：{ field, op, value }。表单中粘贴 JSON 数组，每条转为链上的 .where(field, op, value)。',
  'manual.sFilters.p2': '多条过滤按顺序 AND 组合。算子与取值形状见下文表格。',
  'manual.sHops.title': '关系跳转',
  'manual.sHops.p1':
    '表单每次运行仅支持一个 hop。多 hop（如 Order → lines → product）或 build() 分支请用 Snapshot JSON。',
  'manual.sHops.p2': 'forward 标签须与目录中关系正向名一致（左侧树可见）。逆名由引擎解析。',
  'manual.sHops.p3':
    'children / relateRecursive 可设 maxDepth（表单默认 5）。includeRelates 会把关联行填入 data.relates[slot]（group/树形结果常用）。',
  'manual.sExecute.title': '执行选项',
  'manual.sExecute.p1':
    'limit 为每页条数上限；page 从 0 起。命中分页时 apply(JSON) 返回 { kind: "paginated", items: ... }。',
  'manual.sExecute.p2':
    'includeRelates：为 true 时在每行 relates 映射下挂载关联行（group/children 树形展示依赖此项）。',
  'manual.sAnalysis.title': '分析 · groupBy + compute',
  'manual.sAnalysis.p1':
    '结果模式选「分析（聚合）」。groupBy 为逗号分隔的维度字段；compute 为 JSON 对象，字段名 → 聚合算子（或算子数组）。',
  'manual.sAnalysis.p2':
    '响应形态：{ kind: "analysis", dimensionKeys, shape: "flat", rows: [...] }。复杂分析可仅用 Snapshot JSON。',
  'manual.sSnapshot.title': 'Snapshot JSON · executeQuery',
  'manual.sSnapshot.p1':
    'RemoteExecuteSnapshot = { plan, execute, analysis }。plan.start 指定模型与模式；plan.hops 为有序 hop 列表（relate、横向 group、递归树、branches）。',
  'manual.sSnapshot.p2':
    '建议在代码中用 chain.getRemoteExecuteSnapshot(options) 生成后粘贴到 Snapshot 标签页再编辑。',
  'manual.sSnapshot.p3':
    '执行 Snapshot 直接调用 wire.apply({ op: "executeQuery", snapshot })；若 plan.start.model 已设置，可不依赖当前选中模型。',
  'manual.sResults.title': '结果形态',
  'manual.sResults.p1':
    '链式 execute() 返回 hydrated 实体（界面序列化为 { model, data }）；apply() 返回带 kind 的 wire JSON。',
  'manual.sResults.p2': '分页结果在 items 内嵌套内层结果；分析结果为维度与指标键的普通对象行。',
  'manual.sLimits.title': 'Wire 限制',
  'manual.sLimits.p1':
    '经 wire 不支持：filter(callback)、customReduce()、wrapGroups()。需在进程内 QueryChain 或服务端治理侧使用。',
  'manual.sLimits.p2': '表单仅单 hop。多 hop 图、横向分支、build() 子树须用 Snapshot JSON。',
  'manual.sLimits.p3':
    '手写 plan.hops 须符合 QueryPlanASTv2；非法 snapshot 会在 execute 时报诊断信息。',
  'manual.sTips.title': '提示',
  'manual.sTips.p1': '表单按模型持久化，键名 modedb.playground.query.<ModelName>（localStorage）。',
  'manual.sTips.p2': '同一表单分别「链式」与「apply」对比，便于理解 wire JSON。',
  'manual.sTips.p3':
    'DDL / 变更（insert、alterModel、bindRelation）见中间「操作」面板与 engine-operation-protocol.md §4。',
  'manual.sFilterOps.title': '过滤算子',
  'manual.sFilterOps.p1': '表单 JSON 过滤支持的 where 算子：',
  'manual.sHopCompare.title': '跳转类型对比',
  'manual.sHopCompare.p1': '按查询主体是否切换选择 hop 类型：',
  'manual.sComputeOps.title': '聚合算子',
  'manual.sComputeOps.p1': 'compute JSON 中的取值（单算子或数组表示同字段多指标）：',
  'manual.table.op': '算子',
  'manual.table.meaning': '含义',
  'manual.table.valueShape': 'value 形态',
  'manual.table.hop': '跳转',
  'manual.table.subject': '查询主体',
  'manual.table.typicalUse': '典型场景',
  'manual.op.eq': '等于',
  'manual.op.neq': '不等于',
  'manual.op.gt': '大于 / 大于等于',
  'manual.op.lt': '小于 / 小于等于',
  'manual.op.like': '模式匹配（引擎 like 语义）',
  'manual.op.in': '属于集合',
  'manual.op.between': '闭区间 [lo, hi]',
  'manual.opVal.scalar': 'string | number | boolean | null',
  'manual.opVal.number': 'number',
  'manual.opVal.string': 'string',
  'manual.opVal.array': 'JSON 数组',
  'manual.opVal.tuple': '[lo, hi] 二元数组',
  'manual.hop.relateSubject': '切换为目标模型',
  'manual.hop.relateUse': '沿关系前进；结果行为目标侧',
  'manual.hop.groupSubject': '不变（横向附加）',
  'manual.hop.groupUse': '保留父行；目标挂在 relates[slot]',
  'manual.hop.childrenSubject': '不变（slot 下树形）',
  'manual.hop.childrenUse': '自关联树，forward 为 parent/child 标签',
  'manual.hop.recursiveSubject': '沿递归 walk 切换',
  'manual.hop.recursiveUse': '带 maxDepth 的深度图遍历',
  'manual.compute.sum': '数值求和',
  'manual.compute.avg': '平均值',
  'manual.compute.min': '最小值',
  'manual.compute.max': '最大值',
  'manual.compute.count': '计数（常用 id 字段）',
  'manual.compute.variance': '方差',
  'manual.compute.stdDev': '标准差',
  'manual.ex.allRows': '全量行',
  'manual.ex.byIds': '指定 _id 起点',
  'manual.ex.filtersJson': '过滤 JSON（表单字段）',
  'manual.ex.filtersChain': '等价的链式写法',
  'manual.ex.relate': 'relate — 切换主体',
  'manual.ex.group': 'group — 横向附加',
  'manual.ex.children': 'children — 嵌套树',
  'manual.ex.recursive': 'relateRecursive — 深度遍历',
  'manual.ex.pagination': 'Limit 与分页',
  'manual.ex.analysis': '分析链',
  'manual.ex.computeJson': 'compute 对象',
  'manual.ex.snapshotMinimal': '最小 snapshot',
  'manual.ex.snapshotRelate': '含一个 relate hop 的 snapshot',
  'manual.ex.applyQuery': '由链生成 snapshot 再 apply',
  'manual.ex.resultRows': 'rows 结果（apply）',
  'manual.ex.resultPaginated': 'paginated 结果（apply）',

  'insert.title': '行 · insertMany',
  'insert.button': '插入行',
  'insert.mustArray': '插入内容须为行对象的 JSON 数组。',

  'schema.title': '模式 · alterModel（补丁）',
  'schema.applyPatch': '应用补丁',
  'schema.dropModel': '删除模型',
  'schema.confirmDrop': '在服务端逻辑删除模型「{name}」？',

  'data.title': '数据 · 清除行',
  'data.clearModel': '清除所选模型数据',
  'data.clearAll': '清除库内全部数据',
  'data.confirmClearModel': '清除模型「{name}」的全部行数据？模型与关系定义保留。',
  'data.confirmClearAll': '清除逻辑库「{db}」的全部行数据？所有模型与关系定义保留。',

  'backup.title': '数据库备份 / 恢复',
  'backup.hint':
    '备份文件会生成在服务端 workspace/modeldb/backups 下。恢复与强制重置会先尽量创建安全备份。',
  'backup.create': '创建备份',
  'backup.restore': '恢复备份',
  'backup.clear': '管理清除数据',
  'backup.forceReset': '强制重置',
  'backup.empty': '当前选中的数据库没有可用备份文件。',
  'backup.restorePrompt': '请输入要恢复的备份文件名：',
  'backup.confirmRestore': '确定从 {file} 恢复吗？当前数据库文件会在创建安全备份后被替换。',
  'backup.confirmClear': '确定清除 {db} 的所有数据吗？模型结构会保留，并会先创建安全备份。',
  'backup.confirmForceReset':
    '确定强制重置 {db} 吗？这是数据损坏时的后门恢复能力，会先尝试创建安全备份再重建物理库。',

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
