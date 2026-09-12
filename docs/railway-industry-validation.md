# 铁路行业模型与查询验证库

`scripts/railway-industry-validation.ts` 使用 ModelDB Server 的管理 API 和 Wire API 创建
`railway_operations_demo`，注册铁路领域模型、元数据字典和双向关系，并为每个模型生成
100 行确定性测试数据。

## 运行

先启动根目录 `modeldb.config.json` 对应的服务，然后执行：

```powershell
pnpm run seed:railway
```

数据库已存在时脚本会停止，避免误覆盖。明确需要重建时执行：

```powershell
pnpm run seed:railway -- --reset
```

`--reset` 会先创建 `pre-railway-regenerate` 备份，再删除并重建目标库。如果业务库已经正确，
只需重新导入 i18n、清理旧版 Designer 元数据或重设画布坐标，可以执行：

```powershell
pnpm run seed:railway -- --designer-only
```

其他可选参数：

```text
--config <modeldb.config.json>
--host <server-host>
--port <server-port>
--database <logical-database-name>
--rows <rows-per-model, minimum 20>
```

## 模型分层

验证库包含 32 个模型，共 3,200 行数据。

元数据层由 `MetaDefinition` 基类和 18 个独立字典模型组成：

- `UnitDefinition`、`Region`、`AssetType`、`StationLevel`
- `LineClass`、`TrainType`、`ServiceStatus`、`CarriageType`
- `EmployeeRole`、`ShiftType`
- `WorkOrderCategory`、`WorkOrderPriority`、`WorkOrderStatus`
- `IncidentType`、`IncidentSeverity`
- `TravelClass`、`SalesChannel`、`TicketStatus`

每个元数据模型统一包含 `metaCode`、I18N `name`、I18N `description`、`active` 和
`sortOrder`。`UnitDefinition` 进一步保存 `symbol`、`quantityKind` 和 `decimalScale`，
`Region` 保存国家代码和时区。真实标准项用于领域数据引用，其余行作为停用的查询测试预留项，
因此每个字典模型同样保持 100 行数据，但不会把预留值写入业务事实。

领域层保留 13 个模型：

- 基础设施：`RailwayAsset`、`Station`、`RailwayLine`、`Train`、`Operator`
- 运输组织：`TrainService`、`ServiceStop`、`Carriage`
- 人员与维护：`Employee`、`Shift`、`WorkOrder`、`Incident`
- 客运票务：`Ticket`

## 规范化规则

状态、单位、类型、等级、严重度、优先级、席别和销售渠道不再保存为重复的语义文本或数字。
领域模型只保存稳定代码，并通过 many-to-one 关系连接到相应元数据模型。例如：

```text
TrainService.statusCode -> ServiceStatus.metaCode
Incident.severityCode -> IncidentSeverity.metaCode
Ticket.ticketStatusCode -> TicketStatus.metaCode
RailwayLine.lengthUnitCode -> UnitDefinition.metaCode
```

原 `DataType.Unit` 字段拆分为“数值 + 单位代码 + 单位关系”。例如线路长度由
`lengthValue`、`lengthUnitCode` 和 `lineLengthUnit` 关系组成。线路速度、列车速度、里程、
车次能耗、工单成本和票价使用相同模式，查询可以直接获得单位名称、符号、量纲和精度。

客票的出发站与到达站也分别建立 `originStationRef` 和 `destinationStationRef` 关系，
不再只依赖孤立的车站代码。

## Designer 元数据与布局

脚本把业务 catalog 同步到 `model_designer_workspace`，不会把 `sys_*` 模型写入业务库。
数据库、模型、字段、正向关系和反向关系均提供 `zh/en/ja` 显示名称与描述。

模型坐标使用按模型名称定义的确定性布局：元数据模型位于上方两个宽间距区域，领域模型按基础设施、
运输组织、人员维护和票务分区排列。脚本同步时会删除当前铁路库中已不在 catalog 内的旧 Designer
模型/关系，并清理同名模型副本，避免旧节点与当前布局重叠。

## 自动验证

脚本在灌数后检查：

- 32 个模型、42 条关系以及每个模型的实际行数
- 业务 catalog 和 Designer 中的数据库、模型、字段、关系 i18n
- 线路到车站、车次到停靠、列车到车厢等正反向关系
- 车站 `children()` 递归树查询
- `delayMinutes > 10` 类型化过滤和客票分页
- 按 `statusCode` 分组的延误平均值与最大值聚合
- 车次状态、事件严重度、客票状态和线路长度单位的元数据关系查询

完整重建报告写入 `vault/railway_operations_demo/validation-report.json`。该目录是运行时数据，
不应作为源码提交。
