/**
 * Simple subsequence fuzzy matcher for command palette and file palette filtering.
 * Returns whether all characters in query appear in target in order,
 * plus a score that rewards consecutive character matches,
 * plus the indices of matched characters in target.
 */
export function fuzzyMatch(
  query: string,
  target: string,
): { match: boolean; score: number; indices: number[] } {
  if (!query) return { match: true, score: 0, indices: [] };

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  const indices: number[] = [];

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive++;
      score += consecutive;
      indices.push(ti);
    } else {
      consecutive = 0;
    }
  }

  return { match: qi === q.length, score, indices };
}
