/**
 * Your hours: time zone, working days and times, and "away until" (spec
 * `heartbeats` §3.5).
 *
 * Describes the setting only. What agents do with it arrives with the beat
 * runner (spec §10, PR 3), and this copy must not promise it before then.
 *
 * @module features/profile/ui/fields/ProfileHoursField
 */
import { useState } from 'react';
import type { Away, WorkingHours } from '@dorkos/shared/config-schema';
import {
  DEFAULT_WORKING_HOURS,
  systemTimeZone,
  zonedDay,
  zonedInstant,
} from '@dorkos/shared/working-hours';
import { browserTimeZone, useProfile } from '@/layers/entities/user-profile';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  FieldCard,
  FieldCardContent,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingRow,
} from '@/layers/shared/ui';
import { FieldNote } from './ProfileFields';

/** The week as the chips show it, Monday first. */
const WEEK: ReadonlyArray<{ day: number; short: string; name: string }> = [
  { day: 1, short: 'M', name: 'Monday' },
  { day: 2, short: 'T', name: 'Tuesday' },
  { day: 3, short: 'W', name: 'Wednesday' },
  { day: 4, short: 'T', name: 'Thursday' },
  { day: 5, short: 'F', name: 'Friday' },
  { day: 6, short: 'S', name: 'Saturday' },
  { day: 0, short: 'S', name: 'Sunday' },
];

/** Every zone this browser knows, with `zone` in it even if the list lacks it. */
function zoneList(zone: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return supported.includes(zone) ? supported : [zone, ...supported];
}

/** What the form holds while it is being edited. */
interface HoursDraft {
  timezone: string;
  days: number[];
  start: string;
  end: string;
  /** `YYYY-MM-DD` in `timezone`, or `''` for not away. */
  awayUntil: string;
}

/** The draft a stored profile reads as. */
function draftFrom(
  timezone: string | null,
  workingHours: WorkingHours | null,
  away: Away | null
): HoursDraft {
  const zone = timezone ?? browserTimeZone() ?? systemTimeZone();
  const hours = workingHours ?? DEFAULT_WORKING_HOURS;
  return {
    timezone: zone,
    days: [...hours.days],
    start: hours.start,
    end: hours.end,
    awayUntil: away?.until ? zonedDay(new Date(away.until), zone) : '',
  };
}

/** Whether two drafts would save the same thing. */
function sameDraft(a: HoursDraft, b: HoursDraft): boolean {
  return (
    a.timezone === b.timezone &&
    a.start === b.start &&
    a.end === b.end &&
    a.awayUntil === b.awayUntil &&
    [...a.days].sort().join() === [...b.days].sort().join()
  );
}

/** Why a draft cannot be saved, or `null` when it can. */
function problemWith(draft: HoursDraft): string | null {
  if (draft.days.length === 0) return 'Pick at least one working day.';
  if (!draft.start || !draft.end) return 'Set a start and an end time.';
  if (draft.end <= draft.start) return 'The day has to end after it starts.';
  return null;
}

/**
 * What `away` a save writes.
 *
 * Untouched unless the "Away until" field changed: the stored value can say
 * more than the field shows (a note, "until further notice", a time other than
 * midnight), and a save about your hours must not rewrite it. A new date keeps
 * the note; clearing the field clears the whole thing.
 *
 * @param sent - The draft being saved.
 * @param seed - The draft the stored profile read as.
 * @param stored - The stored `away`.
 */
function awayToSave(sent: HoursDraft, seed: HoursDraft, stored: Away | null): Away | null {
  if (sent.awayUntil === seed.awayUntil) return stored;
  if (!sent.awayUntil) return null;
  return {
    ...stored,
    until: zonedInstant(sent.awayUntil, '00:00', sent.timezone).toISOString(),
  };
}

/**
 * Edit your time zone, working days and times, and when you are back.
 *
 * Follows the other profile fields: a local draft seeded from the server and
 * reseeded only when the stored value moves underneath it, one Save, and a
 * "Saved." that tracks what was actually sent.
 */
export function ProfileHoursField() {
  const { timezone, workingHours, away, isLoading, saveHours } = useProfile();
  const stored = draftFrom(timezone, workingHours, away);
  const [draft, setDraft] = useState<HoursDraft>(stored);
  const [seed, setSeed] = useState<HoursDraft>(stored);
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<HoursDraft | null>(null);

  if (!isLoading && !sameDraft(seed, stored)) {
    setSeed(stored);
    setDraft(stored);
  }

  const problem = problemWith(draft);
  const edit = (patch: Partial<HoursDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const toggleDay = (day: number) =>
    edit({
      days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day],
    });

  const handleSave = () => {
    if (problem) return;
    setStatus('saving');
    const sent = draft;
    saveHours({
      timezone: sent.timezone,
      workingHours: {
        days: [...sent.days].sort((a, b) => a - b),
        start: sent.start,
        end: sent.end,
      },
      away: awayToSave(sent, seed, away),
    })
      .then(() => {
        setStatus('idle');
        setFailure(null);
        setLastSaved(sent);
      })
      .catch((err: unknown) => {
        setStatus('error');
        setFailure(err instanceof Error ? err.message : null);
      });
  };

  return (
    <FieldCard>
      <FieldCardContent className="space-y-4">
        <SettingRow
          label="Your hours"
          description="Your time zone and working hours."
          orientation="vertical"
        >
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="profile-timezone" className="text-muted-foreground text-xs">
                Time zone
              </label>
              <Select value={draft.timezone} onValueChange={(value) => edit({ timezone: value })}>
                <SelectTrigger id="profile-timezone" className="h-8 text-sm" responsive={false}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {zoneList(draft.timezone).map((zone) => (
                    <SelectItem key={zone} value={zone} responsive={false}>
                      {zone.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <div id="profile-days-label" className="text-muted-foreground text-xs">
                Working days
              </div>
              <div role="group" aria-labelledby="profile-days-label" className="flex gap-1">
                {WEEK.map(({ day, short, name }) => {
                  const on = draft.days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-label={name}
                      aria-pressed={on}
                      onClick={() => toggleDay(day)}
                      className={cn(
                        'size-8 rounded-md border text-xs font-medium',
                        on
                          ? 'bg-primary text-primary-foreground border-transparent'
                          : 'text-muted-foreground hover:bg-accent'
                      )}
                    >
                      {short}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex gap-3">
              <div className="flex-1 space-y-1">
                <label htmlFor="profile-hours-start" className="text-muted-foreground text-xs">
                  Start
                </label>
                <Input
                  id="profile-hours-start"
                  type="time"
                  value={draft.start}
                  onChange={(event) => edit({ start: event.target.value })}
                />
              </div>
              <div className="flex-1 space-y-1">
                <label htmlFor="profile-hours-end" className="text-muted-foreground text-xs">
                  End
                </label>
                <Input
                  id="profile-hours-end"
                  type="time"
                  value={draft.end}
                  onChange={(event) => edit({ end: event.target.value })}
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="profile-away-until" className="text-muted-foreground text-xs">
                Away until
              </label>
              <div className="flex gap-2">
                <Input
                  id="profile-away-until"
                  type="date"
                  value={draft.awayUntil}
                  onChange={(event) => edit({ awayUntil: event.target.value })}
                />
                {draft.awayUntil && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => edit({ awayUntil: '' })}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
          </div>
        </SettingRow>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={
              isLoading || status === 'saving' || problem !== null || sameDraft(draft, seed)
            }
          >
            {status === 'saving' ? 'Saving…' : 'Save'}
          </Button>
          {problem && <FieldNote tone="error">{problem}</FieldNote>}
          {!problem && status === 'error' && (
            <FieldNote tone="error">{failure ?? 'Couldn’t save that. Try again.'}</FieldNote>
          )}
          {!problem && status !== 'error' && lastSaved && sameDraft(draft, lastSaved) && (
            <FieldNote tone="ok">Saved.</FieldNote>
          )}
        </div>
      </FieldCardContent>
    </FieldCard>
  );
}
