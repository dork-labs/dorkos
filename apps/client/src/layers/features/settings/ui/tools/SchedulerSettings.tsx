/**
 * Scheduler configuration rows for the Settings Tools tab.
 *
 * Renders concurrent runs and run-history retention controls inside the
 * expandable Tasks tool group. The component is purely presentational —
 * persistence is delegated to the `onUpdate` callback supplied by the parent.
 *
 * There was a third row here, a default timezone for cron schedules. It was
 * removed in DOR-1482: every schedule carries its own timezone, so the setting
 * could never take effect and the control was telling people otherwise.
 *
 * @module features/settings/ui/tools/SchedulerSettings
 */

import { Input, SettingRow } from '@/layers/shared/ui';

interface SchedulerSettingsProps {
  scheduler: { maxConcurrentRuns: number; retentionCount: number };
  onUpdate: (patch: Record<string, unknown>) => void;
}

/** Scheduler configuration rows rendered inside the Tasks tool group expansion. */
export function SchedulerSettings({ scheduler, onUpdate }: SchedulerSettingsProps) {
  return (
    <>
      <SettingRow label="Concurrent runs" description="Maximum parallel task runs">
        <Input
          type="number"
          min={1}
          max={10}
          value={scheduler.maxConcurrentRuns}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (v >= 1 && v <= 10) onUpdate({ maxConcurrentRuns: v });
          }}
          className="w-20"
        />
      </SettingRow>

      <SettingRow label="Run history" description="Completed runs to keep">
        <Input
          type="number"
          min={1}
          max={10000}
          value={scheduler.retentionCount}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (v >= 1) onUpdate({ retentionCount: v });
          }}
          className="w-24"
        />
      </SettingRow>
    </>
  );
}
