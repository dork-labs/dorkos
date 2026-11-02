import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';

/**
 * A reason's one explicit mode name, in this runtime's vocabulary. This is
 * display/suggestion only, never authority: the person's approval grants it.
 * Multiple named modes are ambiguous and leave the saved mode selected.
 */
export function requestedPermissionMode(
  reason: string | null | undefined,
  modes: readonly PermissionModeDescriptor[]
): PermissionModeDescriptor | null {
  const text = (reason ?? '').replaceAll('’', "'").toLowerCase();
  const matches = modes.filter((mode) => {
    const names = [
      mode.id,
      mode.label,
      ...(mode.id === 'dontAsk' ? ["don't ask", 'never ask'] : []),
    ];
    return names.some((name) => {
      const escaped = name
        .replaceAll('’', "'")
        .toLowerCase()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'g');
      for (const match of text.matchAll(pattern)) {
        const before = text.slice(0, match.index).trimEnd();
        if (
          /\b(?:do not|don't|not|without|no|avoid|instead of)(?:\s+(?:use|using|run at))?\s*["'`]*$/u.test(
            before
          )
        )
          continue;
        // Ordinary words such as “plan the release” are not mode requests.
        if (/^(?:plan|default|auto)$/u.test(name.toLowerCase())) {
          const after = text.slice(match.index + match[0].length);
          if (
            !/\b(?:mode|permissions|level|use|at|as|needs?|requires?)\s*[:=]?\s*["'`]*$/u.test(
              before
            ) &&
            !/^\s*["'`]*\s+(?:mode|permissions|level)\b/u.test(after) &&
            text.trim() !== name.toLowerCase()
          )
            continue;
        }
        return true;
      }
      return false;
    });
  });
  return matches.length === 1 ? matches[0]! : null;
}
