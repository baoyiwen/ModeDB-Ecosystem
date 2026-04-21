/**
 * Prop 提升为对象；模型与字段由 DataManager 受控维护。
 */
export interface PropObject {
  id: string;
  name: string;
  type: string;
  is_primary: boolean;
  encrypt_level: number;
  metadata: Record<string, unknown>;
}
