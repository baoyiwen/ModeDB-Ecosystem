/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MODE_DB_HOST?: string;
  readonly VITE_MODE_DB_PORT?: string;
  readonly VITE_MODE_DB_TOKEN?: string;
  /** 设计器固定连接的逻辑库名（构建时注入，UI 不可改）；缺省为 `model_designer`。 */
  readonly VITE_MODE_DB_WORKSPACE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
