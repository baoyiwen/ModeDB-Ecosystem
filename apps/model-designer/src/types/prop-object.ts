/**
 * Prop 提升为对象；与 catalog **`sys_props`** 对齐（`type` 为画布侧逻辑类型字符串，`engine_type` 为引擎整型码）。
 */
export interface PropObject {
  id: string;
  name: string;
  type: string;
  is_primary: boolean;
  encrypt_level: number;
  metadata: Record<string, unknown>;
  /** `sys_props.engineType` */
  engine_type?: number;
  /** `sys_props.description`（I18N） */
  description_i18n?: Record<string, string>;
  /** `sys_props.sort` */
  sort?: number;
  /** `sys_props.isRequired` */
  is_required?: boolean;
  /** `sys_props.vaultKey` */
  vault_key?: string;
}
