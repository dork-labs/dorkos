import type { Task } from '@dorkos/shared/types';

/** The marks a schedule was written under, as the server sends them. */
type OriginMarks = NonNullable<Task['originMarks']>;

/**
 * Why a schedule waits for a person whatever the trust preset (DOR-3036): the agent wrote it in a
 * turn that read words from outside the owner's circle, or that a teammate in a shared space
 * started. One line per mark, naming where it came from when DorkOS knew.
 */
export function ScheduleOriginMarks({ marks }: { marks: OriginMarks }) {
  const lines: { key: string; text: string }[] = [];
  if (marks.outsider) {
    lines.push({ key: 'outsider', text: 'Written after reading words DorkOS can’t vouch for.' });
  }
  for (const origin of marks.teammate ?? []) {
    const who = origin.name ?? 'a teammate';
    const where = origin.room ? `${origin.room}, a shared space` : 'a shared space';
    lines.push({
      key: `${origin.roomId}:${origin.authorId}`,
      text: `Started by ${who} in ${where}.`,
    });
  }
  if (lines.length === 0) return null;
  return (
    <div data-slot="schedule-origin-marks" className="min-w-0 space-y-0.5 text-xs">
      <p className="text-muted-foreground">Waiting for you because it was:</p>
      <ul className="space-y-0.5">
        {lines.map((line) => (
          <li key={line.key} className="min-w-0 break-words">
            {line.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
