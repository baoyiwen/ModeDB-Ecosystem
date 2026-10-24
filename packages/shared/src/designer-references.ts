/** Stable identity for a virtual, direct parent/child edge; never a traversable relation. */
export function designerInheritanceRelationId(parentId: string, childId: string): string {
  return `inherit_${parentId.length}_${parentId}_${childId}`;
}
