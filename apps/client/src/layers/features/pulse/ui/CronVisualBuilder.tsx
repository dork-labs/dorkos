import { useMemo, useCallback } from 'react';
import {
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/layers/shared/ui';

interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

/** @internal Exported for testing only. */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  return {
    minute: parts[0] ?? '*',
    hour: parts[1] ?? '*',
    dayOfMonth: parts[2] ?? '*',
    month: parts[3] ?? '*',
    dayOfWeek: parts[4] ?? '*',
  };
}

/** @internal Exported for testing only. */
export function assembleCron(fields: CronFields): string {
  return `${fields.minute} ${fields.hour} ${fields.dayOfMonth} ${fields.month} ${fields.dayOfWeek}`;
}

const MINUTE_OPTIONS = ['*', '0', '5', '10', '15', '20', '30', '45'] as const;

const HOUR_OPTIONS = ['*', ...Array.from({ length: 24 }, (_, i) => String(i))] as const;

const DAY_OF_MONTH_OPTIONS = ['*', ...Array.from({ length: 31 }, (_, i) => String(i + 1))] as const;

const MONTH_OPTIONS = [
  { value: '*', label: 'Every month' },
  { value: '1', label: 'Jan' }, { value: '2', label: 'Feb' },
  { value: '3', label: 'Mar' }, { value: '4', label: 'Apr' },
  { value: '5', label: 'May' }, { value: '6', label: 'Jun' },
  { value: '7', label: 'Jul' }, { value: '8', label: 'Aug' },
  { value: '9', label: 'Sep' }, { value: '10', label: 'Oct' },
  { value: '11', label: 'Nov' }, { value: '12', label: 'Dec' },
] as const;

const DAY_OF_WEEK_OPTIONS = [
  { value: '*', label: 'Every day' },
  { value: '0', label: 'Sun' }, { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' }, { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' }, { value: '5', label: 'Fri' },
  { value: '6', label: 'Sat' },
] as const;

interface CronVisualBuilderProps {
  value: string;
  onChange: (cron: string) => void;
}

/** Visual cron expression builder with 5-field Select dropdowns. */
export function CronVisualBuilder({ value, onChange }: CronVisualBuilderProps) {
  const fields = useMemo(() => parseCron(value), [value]);

  const updateField = useCallback(
    (field: keyof CronFields, fieldValue: string) => {
      const updated = { ...parseCron(value), [field]: fieldValue };
      onChange(assembleCron(updated));
    },
    [value, onChange]
  );

  return (
    <div className="grid grid-cols-5 gap-2">
      <CronFieldSelect label="Minute" value={fields.minute} options={MINUTE_OPTIONS} onChange={(v) => updateField('minute', v)} />
      <CronFieldSelect label="Hour" value={fields.hour} options={HOUR_OPTIONS} onChange={(v) => updateField('hour', v)} />
      <CronFieldSelect label="Day" value={fields.dayOfMonth} options={DAY_OF_MONTH_OPTIONS} onChange={(v) => updateField('dayOfMonth', v)} />
      <CronFieldSelect label="Month" value={fields.month} options={MONTH_OPTIONS} onChange={(v) => updateField('month', v)} />
      <CronFieldSelect label="Weekday" value={fields.dayOfWeek} options={DAY_OF_WEEK_OPTIONS} onChange={(v) => updateField('dayOfWeek', v)} />
    </div>
  );
}

function CronFieldSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: readonly string[] | readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 text-xs" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => {
            const val = typeof opt === 'string' ? opt : opt.value;
            const display = typeof opt === 'string' ? (opt === '*' ? 'Any' : opt) : opt.label;
            return (
              <SelectItem key={val} value={val} className="text-xs">
                {display}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
