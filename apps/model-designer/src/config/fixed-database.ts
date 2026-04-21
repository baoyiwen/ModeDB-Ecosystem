/**
 * Model Designer 连接使用的逻辑库名（构建时由环境变量决定，运行时不可在 UI 中修改）。
 */
export const FIXED_MODEL_DESIGNER_DATABASE: string = (
  import.meta.env.VITE_MODE_DB_WORKSPACE ?? 'model_designer'
).trim();
