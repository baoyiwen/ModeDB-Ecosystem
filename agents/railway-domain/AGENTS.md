# Railway Domain Graph Agent Rules

本目录定义新的铁路领域图谱规范。它是一个独立的 Agent 规则包，不描述也不修改
`railway_operations_demo` 等旧验证图谱。

## 执行顺序

Agent 在提出或执行建模前，必须按以下顺序读取文件：

1. `graph-policy.yaml`：读取对象分类、拆分、命名和关系硬约束。
2. `model-catalog.yaml`：读取已有的规范模型和最小数据粒度。
3. `relation-catalog.yaml`：读取规范关系、方向、基数和关联实体规则。
4. `validation.yaml`：用验收场景检查候选图谱。

## 硬约束

- 元数据描述数据拆分粒度、身份、生命周期和字段语义，不自动生成实体模型。
- 业务概念不能因为是一个名词就直接建模；必须先判断是否有独立身份、生命周期、查询或 CRUD 需求。
- 具有独立身份且可被多个模型引用的公共数据，优先建成引用模型。
- 固定且封闭的值域可以是字段枚举；需要复用、版本、生效时间、启停用或独立维护时，必须建成字典模型。
- 坐标、几何、地址、金额和带单位数值默认是值对象；只有具备独立身份和生命周期时才升级为实体。
- 关系携带顺序、里程、覆盖比例、方向或有效期时，必须使用关联实体，不能丢失这些属性。
- 继承只表达模型结构复用，默认不作为数据查询链路遍历；子模型不能因为继承关系被重复创建成查询节点。
- 一个概念出现多个数据粒度时，应拆成多个模型，并明确它们之间的关系；不能用模糊的“元数据模型”代替拆分定义。
- 存在多个可能模型、关系或挂载位置时，Agent 必须输出歧义清单并暂停写入，等待人工选择。
- Agent 必须先输出 proposal，再执行图谱写入；禁止直接覆盖旧图谱或自动迁移旧图谱数据。

## 输出契约

每次自动建模都应生成以下结果：

```yaml
proposal:
  graph: railway_domain_v1
  source_summary: '用户输入或数据来源摘要'
  models: []
  relations: []
  value_objects: []
  dictionary_bindings: []
  metadata: []
  decisions: []
  ambiguities: []
  rejected_concepts: []
  validation: []
  write_ready: false
```

`write_ready` 只有在硬约束通过、歧义为空、验收场景通过后才能设为 `true`。
