# Common AI Task Guide

适合 AI 处理：

- 路径与 manifest 说明补充
- 类型与注册表文档补充
- 日志与诊断梳理
- Vault 随机密钥引用与安全提交（SEC-M1 契约见 `docs/security-v1-vault-contract.md`）；密钥不能从网络 Token 派生，OS 保护适配放在 server

优先读：

- `packages/common/src/index.ts`
- `packages/common/src/registry.ts`
- `packages/common/src/atlas-paths.ts`
- `packages/common/src/diagnostic.ts`
