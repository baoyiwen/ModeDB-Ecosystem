# 铁路领域 Agent 自动建模规范

本规范用于指导人工和 AI Agent 建设新的铁路领域图谱。规范文件位于
`agents/railway-domain/`，现有铁路验证图谱只作为历史样本，不属于本图谱的输入或写入目标。

## 文件职责

- `AGENTS.md`：Agent 的执行顺序、硬约束和输出契约。
- `graph-policy.yaml`：对象分类、拆分规则、字典边界、空间规则和命名政策。
- `model-catalog.yaml`：铁路领域的规范模型、最小数据粒度和必需字段。
- `relation-catalog.yaml`：规范关系、关系方向、基数和关联实体。
- `validation.yaml`：自动验收规则和典型查询场景。

## Agent 的工作流程

1. 从用户描述、文件或已有数据中提取概念、属性、关系和数据粒度。
2. 对每个概念判断它是实体、引用模型、值对象、关联实体还是仅存在于概念层。
3. 为候选模型填写身份、生命周期、所有权、拆分粒度和字段角色。
4. 根据关系属性决定使用直接关系还是关联实体。
5. 检查状态、分类、单位和行政区划是否应该成为可复用的公共引用模型。
6. 生成 proposal，列出已确定内容、拒绝的拆分、未解决歧义和校验结果。
7. 只有 `write_ready: true` 时，才允许生成新的图谱文件或调用图谱写入流程。

## 关键原则

元数据回答“数据应该拆到什么粒度、字段具有什么语义”，它不等于一个实体模型。一个
“线路”可以拆成线路、路段和轨道区段，但每一层必须有独立的数据理由。坐标和几何默认
作为值对象保存；行政区划、单位、状态和分类在具备稳定编码、复用和独立维护需求时，
作为公共引用模型保存。

路段与行政区划之间可能是多对多关系，而且需要保存覆盖比例、里程范围和生效时间，
因此使用 `SectionDivisionAssignment` 保存关系本身。线路与车站的顺序、方向和里程也
使用 `LineStationAssignment` 保存，避免把这些语义压缩成一个没有属性的普通关系。

## Agent 产物

Agent 应输出机器可解析的 proposal，并至少包含：

```yaml
proposal:
  graph: railway_domain_v1
  models: []
  relations: []
  value_objects: []
  dictionary_bindings: []
  metadata: []
  decisions: []
  ambiguities: []
  validation: []
  write_ready: false
```

这使得后续可以把“领域描述 -> proposal -> 人工确认 -> 图谱写入 -> Query Designer 验证”
实现为标准 Agent 工作流。

## 已创建的新图谱

`railway_domain_v1` 已按照本规范独立创建，初始化脚本为
[`scripts/railway-domain-v1.ts`](../scripts/railway-domain-v1.ts)。它不会覆盖旧的
`railway_operations_demo`。

当前图谱包含：

- 12 个模型：线路、线路区间、轨道区段、车站、行政区划、单位、状态、分类和四个关联实体。
- 21 条关系：组成关系、公共字典引用、行政区划层级和空间覆盖关系。
- 56 条确定性示例数据。
- 关系属性：顺序、方向、里程、覆盖比例、边界版本和生效时间。

运行或重建：

```powershell
pnpm run seed:railway-domain-v1 -- --host 127.0.0.1 --port 9091
pnpm run seed:railway-domain-v1 -- --host 127.0.0.1 --port 9091 --reset
```

重建只针对 `railway_domain_v1`，脚本会先创建该库的备份。构建报告写入
`vault/railway_domain_v1/build-report.json`。
