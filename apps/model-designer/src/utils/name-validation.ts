/**
 * 模型 / 关系的**唯一名（unique name）**约束：
 *
 * - 仅英文字母、数字、下划线、连字符。
 * - 首字符必须是字母（与多数引擎对标识符的约束一致）。
 *
 * 用于：`EngineModelNode.model_name`、`EngineRelationEdge.forward_name` / `reverse_name`。
 */
export const UNIQUE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function isValidUniqueName(name: string): boolean {
  return UNIQUE_NAME_RE.test(name);
}

/** 唯一名输入框：过滤掉不允许的字符（保留字母、数字、下划线、连字符）。 */
export function filterUniqueNameInput(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * 把任意输入归一为合法的唯一名片段：非 `[A-Za-z0-9_-]` 一律替换为 `_`，
 * 若首字符为数字则前置 `m`。返回值仍可能为空字符串（输入完全为空时）。
 *
 * 主要用于自动命名 fallback（如根据 `model_name` 拼接 `source-target`），
 * 不应用于用户直接输入的 commit 路径 —— 那里要 {@link isValidUniqueName} 拒绝。
 */
export function sanitizeUniqueNameFragment(input: string): string {
  if (!input) {
    return '';
  }
  let s = input.replace(/[^A-Za-z0-9_-]+/g, '_');
  if (s.length > 0 && /^[0-9_-]/.test(s)) {
    s = `m${s}`;
  }
  return s;
}

/**
 * 在已占用名字集合中得到唯一的可用名。若 `base` 未冲突直接返回；冲突则附加
 * `-<base36 时间戳>`，仍冲突则再补一个递增数字后缀。
 */
export function makeUniqueName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) {
    return base;
  }
  const stamp = Date.now().toString(36);
  let candidate = `${base}-${stamp}`;
  let i = 1;
  while (used.has(candidate)) {
    candidate = `${base}-${stamp}-${i}`;
    i += 1;
  }
  return candidate;
}
