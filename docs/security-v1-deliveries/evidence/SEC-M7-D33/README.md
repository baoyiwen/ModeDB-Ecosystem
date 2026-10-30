# SEC-M7 / D33 公开证据说明

本目录只归档明确公开的统计、源码清单、页面字节、检查命令及日志，不归档临时实例目录、台账、Vault、口令、签名私钥或恢复包。任务状态及结果以唯一里程碑台账、SEC-M7 的 D33 和最终 `acceptance.json` 为准。

- `exploration/`：冻结源码的正式探索，保留全部 108 个样本及四块原始统计。
- `registration.json`：探索后、确认前独立生成的不可覆盖门槛登记；不能据确认结果回改。
- `confirmation/`：全新实例的独立 AB-BA 确认，固定 504 个正常样本及原生满容量洪泛检查。
- 两份 `source-manifest.json` 绑定相同源码；两份 `candidate-manifest.json` 及 `designer/` 绑定各自全新构建的公开页面字节。Server 由独立 Node/tsx 加载源码，不能称为安装后压缩发行包性能。
- `checks.json` 和对应 `*.original.txt`：定向测试、原生 Chrome、严格类型和限定静态检查的原始命令及输出。修复后最终工具 61、受影响测试 191、原生浏览器 1 合计 253 项，不重复计算初始 249 项及中间运行；`pre-expiry-repair-checks.json` 和旧日志保留。
- `development-failures/`：开发中的探索失败报告，保留原字节；部分源码尚未冻结，不能作为正式性能基线。未登记失败的开发试跑不等于独立确认失败。
- `pre-expiry-repair/`：首次正式探索、原门槛登记和完整失败确认，包含公开页面及四块原始统计。注册开始和静态请求客户端 p95 超限，不能因业务零错误或洪泛维护通过而改成成功；后续修复须使用新源码重新探索和独立确认。
- `flood-before.tool-result.json`：修复前约 34.95 秒本机维护的工具输出转录，明确标为开发观察，缺少冻结报告；不是正式前后性能比较。
- `flood-after.original.json`：修复后开发探针的原始公开结果。本机动作是创建合成主体；正式探索/确认改为真实 OS 管道网络规则预览、应用、确认及回滚，二者不能混为同一场景。
- `document-check.mjs` / `documents.json`：限定文档链接、任务计数、命令和边界检查；已知秘密模式扫描不能证明不存在任意秘密。
- `verification.json` / `acceptance.json`：最终摘要、当前开发文件及 D32 以前 1666 条历史证据的原字节绑定。总核验不重新运行实例，也不保证临时目录持续存在。

每次确认保持正常审计、DPAPI 和限流，不删除慢样本。CPU/RSS 只计服务端 Node；DPAPI 子进程的墙钟已计入请求，子进程 CPU/RSS 未测。软件 WebAuthn 签名和合成保护器队列边界分别标记，不替代实际 Windows Hello、双机、分布式洪泛或生产容量验收。
