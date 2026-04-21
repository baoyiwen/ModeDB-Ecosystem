import type { PropObject } from '../types/prop-object.js';

const VAULT_META_KEY = 'vault_ref';
/** 与 `@mode-db/common` {@link InternalVault} 指针一致；浏览器端避免依赖 common 全量包（含 Node polyfill）。 */
const VAULT_ADDR_PREFIX = 'm_addr_';

function isVaultPointer(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(VAULT_ADDR_PREFIX);
}

/**
 * `DataType` 中与保险库句柄对应的字段在引擎侧存为 `m_addr_*` 指针；画布 Prop 使用 `metadata.vault_ref` 或加密等级标记。
 */
export class PropVaultController {
  /** UI：是否显示为“加密锁定”（不可见明文直至解锁）。 */
  isVaultField(prop: PropObject): boolean {
    const ref = prop.metadata[VAULT_META_KEY];
    if (typeof ref === 'string' && isVaultPointer(ref)) {
      return true;
    }
    return prop.encrypt_level > 0;
  }

  /** 掩码展示用的占位符（真实明文仅在校验通过后由引擎/SDK 注入）。 */
  maskedPlaceholder(): string {
    return `(${VAULT_ADDR_PREFIX}···)`;
  }

  /** 若存在合法 vault 指针则返回规范化展示串（仍为句柄，非明文）。 */
  displayHandle(prop: PropObject): string {
    const ref = prop.metadata[VAULT_META_KEY];
    if (typeof ref === 'string' && ref.startsWith(VAULT_ADDR_PREFIX)) {
      return ref.slice(0, 12) + '…';
    }
    return this.maskedPlaceholder();
  }

  /** 权限通过后 UI 可切换为展示解密值（由调用方写入本地 state，不经本类持久化）。 */
  formatUnlockedValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value);
  }
}
