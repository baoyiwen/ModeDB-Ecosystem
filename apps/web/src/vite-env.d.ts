/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_HOST?: string;
  readonly VITE_DEFAULT_PORT?: string;
  readonly VITE_DEFAULT_DATABASE?: string;
  readonly VITE_DEFAULT_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
