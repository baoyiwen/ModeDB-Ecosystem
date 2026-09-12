import type { PropObject } from '../types/prop-object.js';

export function sortPropsBySort(props: readonly PropObject[]): PropObject[] {
  return [...props].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
}
