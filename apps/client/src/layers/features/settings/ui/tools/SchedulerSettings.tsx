/**
 * Scheduler configuration rows for the Settings Tools tab.
 *
 * Renders concurrent runs, timezone, and run-history retention controls inside
 * the expandable Tasks tool group. The component is purely presentational —
 * persistence is delegated to the `onUpdate` callback supplied by the parent.
 *
 * @module features/settings/ui/tools/SchedulerSettings
 */

import {
  Input,
  SettingRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';

interface SchedulerSettingsProps {
  scheduler: { maxConcurrentRuns: number; timezone: string | null; retentionCount: number };
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

      <SettingRow label="Timezone" description="IANA timezone for cron schedules">
        <Select
          value={scheduler.timezone ?? 'system'}
          onValueChange={(v) => onUpdate({ timezone: v === 'system' ? null : v })}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">System default</SelectItem>
            <SelectItem value="UTC">UTC</SelectItem>
            <SelectItem value="America/New_York">America/New_York</SelectItem>
            <SelectItem value="America/Chicago">America/Chicago</SelectItem>
            <SelectItem value="America/Denver">America/Denver</SelectItem>
            <SelectItem value="America/Los_Angeles">America/Los_Angeles</SelectItem>
            <SelectItem value="Europe/London">Europe/London</SelectItem>
            <SelectItem value="Europe/Berlin">Europe/Berlin</SelectItem>
            <SelectItem value="Europe/Paris">Europe/Paris</SelectItem>
            <SelectItem value="Asia/Tokyo">Asia/Tokyo</SelectItem>
            <SelectItem value="Asia/Shanghai">Asia/Shanghai</SelectItem>
            <SelectItem value="Asia/Kolkata">Asia/Kolkata</SelectItem>
            <SelectItem value="Australia/Sydney">Australia/Sydney</SelectItem>
          </SelectContent>
        </Select>
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
