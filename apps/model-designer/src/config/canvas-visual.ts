/**
 * 画布视觉与交互常量（开发时可在此集中调整，无需改绘制逻辑）。
 */
export const CANVAS_VISUAL = {
  /** 关系边 */
  relation: {
    strokePx: 1.45,
    strokeHoverPx: 2.1,
    strokeSelectedPx: 2.45,
    arrowPx: 9.5,
    inheritColor: '#64748b',
    inheritHoverColor: '#475569',
    inheritSelectedColor: '#334155',
    normalColor: '#8ea0b6',
    hoverColor: '#0f8bd6',
    selectedColor: '#0f66c7',
  },
  /** 模型节点 */
  node: {
    selectedRingColor: '#7c3aed',
    selectedRingWidth: 3,
    hoverRingColor: '#3b82f6',
    hoverRingWidth: 2.5,
  },
  /** 命中测试 */
  hit: {
    relationThresholdPx: 24,
  },
  /** 背景点阵 */
  grid: {
    dotColor: 'rgba(100, 116, 139, 0.35)',
  },
  snapGuide: {
    tangentColor: 'rgba(37, 99, 235, 0.95)',
    centerColor: 'rgba(236, 72, 153, 0.95)',
    previewTangentColor: 'rgba(59, 130, 246, 0.42)',
    equalGapColor: 'rgba(5, 150, 105, 1)',
  },
  /** 连线 / 继承预览 */
  preview: {
    linkColor: '#2563eb',
    inheritColor: '#7c3aed',
  },
  /** 关系标签 */
  label: {
    color: '#243244',
    bgColor: 'rgba(248, 250, 252, 0.86)',
    borderColor: 'rgba(100, 116, 139, 0.42)',
    borderWidth: 0.8,
    paddingX: 5,
    paddingY: 2.5,
    radius: 3,
  },
} as const;

export type CanvasVisualConfig = typeof CANVAS_VISUAL;
