/**
 * Resolve relay subject strings into human-readable labels.
 *
 * @module services/relay/subject-resolver
 */

export interface SubjectLabel {
  label: string;
  raw: string;
}

interface ResolverDeps {
  getSession?: (sessionId: string) => Promise<{ cwd?: string } | null>;
  readManifest?: (cwd: string) => Promise<{ name?: string } | null>;
}

const SESSION_ID_PREVIEW_LENGTH = 7;

/**
 * Resolve a relay subject string into a human-readable label.
 *
 * @param subject - Raw relay subject string
 * @param deps - Optional dependency injection for session/manifest lookup
 */
export async function resolveSubjectLabel(
  subject: string,
  deps: ResolverDeps,
): Promise<SubjectLabel> {
  const raw = subject;

  // Static patterns
  if (subject === 'relay.system.console') {
    return { label: 'System Console', raw };
  }
  if (subject.startsWith('relay.system.pulse.')) {
    return { label: 'Pulse Scheduler', raw };
  }
  if (subject.startsWith('relay.human.console.')) {
    return { label: 'You', raw };
  }

  // Agent pattern — resolve name from manifest
  if (subject.startsWith('relay.agent.')) {
    const sessionId = subject.slice('relay.agent.'.length);
    const shortId = sessionId.slice(0, SESSION_ID_PREVIEW_LENGTH);
    const fallback: SubjectLabel = { label: `Agent (${shortId})`, raw };

    if (!deps.getSession) return fallback;

    try {
      const session = await deps.getSession(sessionId);
      if (!session?.cwd || !deps.readManifest) return fallback;

      const manifest = await deps.readManifest(session.cwd);
      if (!manifest?.name) return fallback;

      return { label: manifest.name, raw };
    } catch {
      return fallback;
    }
  }

  // Unknown pattern
  return { label: subject, raw };
}

/**
 * Batch-resolve multiple subjects, deduplicating lookups.
 *
 * @param subjects - Array of raw subject strings
 * @param deps - Dependency injection for session/manifest lookup
 */
export async function resolveSubjectLabels(
  subjects: string[],
  deps: ResolverDeps,
): Promise<Map<string, SubjectLabel>> {
  const unique = [...new Set(subjects)];
  const results = await Promise.all(
    unique.map(async (s) => [s, await resolveSubjectLabel(s, deps)] as const),
  );
  return new Map(results);
}
