# 铁路行业模型与查询验证库

`scripts/railway-industry-validation.ts` 使用 ModelDB Server 的管理 API 和 Wire API 创建
`railway_operations_demo`，注册铁路业务模型、业务关系和确定性测试数据。

## 运行

先启动 `modeldb.config.json` 对应的服务，然后执行：

```powershell
pnpm run seed:railway -- --host 127.0.0.1 --port 9091
```

数据库已存在时脚本会停止，重建时显式执行：

```powershell
pnpm run seed:railway -- --host 127.0.0.1 --port 9091 --reset
```

`--reset` 会先创建 `pre-railway-regenerate` 备份，再删除并重建目标库。`--designer-only`
只重新同步设计器库的 catalog 和布局。

## 元数据与最小拆分单元

本验证库不把“元数据”建模为一个 `MetaDefinition` 实体层。这里的元数据首先回答的是：
一份数据应按什么最小单元拆分、字段承载什么语义、值的类型和值域是什么。它是建模约束和
字段语义，而不是自动生成的 CRUD 模型。

因此，状态、类型、等级、严重度、优先级、席别和销售渠道只保留为字段值域。例如：

```text
TrainService.statusCode      -> RUNNING | COMPLETED | DELAYED | CANCELLED
Incident.severityCode        -> SEV1 | SEV2 | ...
Ticket.ticketStatusCode      -> ISSUED | REFUNDED | USED | CANCELLED
```

这些值域由脚本中的 `fieldValueCatalogs` 维护，用于生成可重复的测试值；它们不会被注册为
模型、不会出现在模型画布上，也没有自己的关系网络。

具有独立生命周期、独立属性并被业务关系引用的概念才保留为实体。`Region` 属于这一类：
它有名称、国家、时区和有效状态，车站可以通过 `stationRegionRef` 关联到它，因而是业务
对象而不是字段字典。

单位、数值和金额按一个最小值对象保存，不再拆成数值字段加单位字典关系：

```text
RailwayLine.length       = { value: 80.5, unit: "km" }
RailwayLine.maxSpeed     = { value: 350, unit: "km/h" }
Train.mileage            = { value: 12000, unit: "km" }
TrainService.energyUsed  = { value: 2500, unit: "kWh" }
WorkOrder.estimatedCost  = { value: 2000, unit: "CNY" }
Ticket.fare              = { value: 35, unit: "CNY" }
```

这样既保留了数值与单位的完整语义，也避免为了表达单位而创建一个可独立查询的实体。

## 模型分层

验证库包含 14 个业务模型：

- 资产基类：`RailwayAsset`
- 基础设施：`Region`、`Station`、`RailwayLine`
- 运输组织：`Train`、`Operator`、`TrainService`、`ServiceStop`、`Carriage`
- 人员与维护：`Employee`、`Shift`、`WorkOrder`
- 安全与客运：`Incident`、`Ticket`

除 `Region` 外，普通业务模型每个生成 `--rows` 行，区域生成 10 个真实区域。默认总行数为
`13 * --rows + 10`，默认 `--rows=100` 时为 1,310 行。

## 业务关系

关系只描述业务对象之间的可遍历联系，包括线路与车站、车次与线路/列车、工单与资产、
事件与车次/车站、客票与车次/出发站/到达站，以及车站自关联和员工班次关系。

字段值域不建立关系；单位不建立关系。默认脚本验证 `19` 条关系，并重点检查：

- 线路到车站、车次到停靠记录、列车到车厢的关系查询
- 车站 `children()` 递归树查询
- 车站到运营区域的协议绑定
- `delayMinutes > 10` 类型化过滤、客票分页和按 `statusCode` 分组聚合
- `DataType.Unit` 字段返回的 `{ value, unit }` 数据结构

## Designer 元数据与布局

脚本把业务 catalog 同步到 `model_designer_workspace`，不会把 `sys_*` 模型写入业务库。
设计器中只出现上述业务模型和业务关系；字段的显示名称、类型和必填状态仍来自业务
catalog 与 `sys_props`，字段顺序沿用 schema 定义顺序。

Designer 的布局不再为元数据字典预留独立区域，画布以业务关系网络为中心。

完整重建报告写入 `vault/railway_operations_demo/validation-report.json`。该目录是运行时
数据，不应作为源码提交。
