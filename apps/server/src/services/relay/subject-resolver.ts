/**
 * Resolve relay subject strings into human-readable labels.
 *
 * @module services/relay/subject-resolver
 */
import { extractSessionIdFromSubject } from '@dorkos/relay';

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
  deps: ResolverDeps
): Promise<SubjectLabel> {
  const raw = subject;

  // Static patterns
  if (subject === 'relay.system.console') {
    return { label: 'System Console', raw };
  }
  if (subject.startsWith('relay.system.tasks.')) {
    return { label: 'Tasks Scheduler', raw };
  }
  if (subject.startsWith('relay.human.console.')) {
    return { label: 'You', raw };
  }

  // Agent pattern — resolve name from manifest. `relay.agent.*` subjects use
  // the shared parser so both legacy (`relay.agent.<sessionId>`) and
  // runtime-scoped (`relay.agent.<runtimeType>.<sessionId>`) shapes resolve
  // to the same canonical sessionId. `relay.inbox.*` stays on the legacy
  // slice — inbox subjects have never carried a runtime-type segment.
  if (subject.startsWith('relay.agent.') || subject.startsWith('relay.inbox.')) {
    const sessionId = subject.startsWith('relay.agent.')
      ? extractSessionIdFromSubject(subject)
      : subject.slice('relay.inbox.'.length);
    if (!sessionId) return { label: subject, raw };

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
  deps: ResolverDeps
): Promise<Map<string, SubjectLabel>> {
  const unique = [...new Set(subjects)];
  const results = await Promise.all(
    unique.map(async (s) => [s, await resolveSubjectLabel(s, deps)] as const)
  );
  return new Map(results);
}
