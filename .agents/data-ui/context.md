# Data UI AI Context

`@mode-db/data-ui` 负责数据页 React 组件与 provider 装配。

高优先级事实：

1. 组件层不拥有 staged operation、upsert、关系绑定语义；这些来自 `data-kit`。
2. `ImportPanel` 负责文件选择、字段映射、关系绑定配置和提交按钮交互。
3. Pivot 只消费 `ViewDataShape.columns[].label`，不要重新推导字段显示名。
4. `nameDisplayMode` 必须贯穿表格、Pivot、导入面板。
5. 显示名模式为 `显示名[唯一名]`，唯一名模式只显示 name。
