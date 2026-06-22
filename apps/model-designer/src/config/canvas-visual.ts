/**
 * 画布视觉与交互常量（开发时可在此集中调整，无需改绘制逻辑）。
 */
export const CANVAS_VISUAL = {
  /** 关系边 */
  relation: {
    strokePx: 1.8,
    strokeHoverPx: 2.4,
    strokeSelectedPx: 2.8,
    arrowPx: 11,
    inheritColor: '#64748b',
    inheritHoverColor: '#475569',
    inheritSelectedColor: '#334155',
    normalColor: '#94a3b8',
    hoverColor: '#3b82f6',
    selectedColor: '#2563eb',
  },
  /** 模型节点 */
  node: {
    selectedRingColor: '#7c3aed',
    selectedRingWidth: 3,
    hoverRingColor: '#3b82f6',
    hoverRingWidth: 2.5,
    shadowBlur: 14,
    shadowBlurHover: 16,
    shadowBlurSelected: 18,
    shadowColor: 'rgba(15, 23, 42, 0.18)',
  },
  /** 命中测试 */
  hit: {
    relationThresholdPx: 16,
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
    color: '#334155',
    bgColor: 'rgba(255, 255, 255, 0.94)',
    borderColor: 'rgba(148, 163, 184, 0.9)',
    borderWidth: 1,
    paddingX: 6,
    paddingY: 3,
    radius: 4,
  },
} as const;

export type CanvasVisualConfig = typeof CANVAS_VISUAL;
