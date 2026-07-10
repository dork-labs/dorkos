/**
 * Field renderer components for the auto-generated extension settings panel.
 *
 * Each renderer handles a specific setting type (text, number, boolean, select)
 * with appropriate input controls and save behavior.
 *
 * @module features/extensions/ui/SettingFieldRenderers
 */
import { useState } from 'react';
import { toast } from 'sonner';
import {
  SettingRow,
  Button,
  Input,
  Switch,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/layers/shared/ui';
import { extensionApiUrl } from '../model/extension-api-url';

/** Server response shape for a single setting's current value. */
export interface SettingStatus {
  key: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  label: string;
  description?: string;
  placeholder?: string;
  group?: string;
  value: string | number | boolean | null;
  isDefault: boolean;
  options?: Array<{ label: string; value: string | number }>;
  min?: number;
  max?: number;
}

// ---------------------------------------------------------------------------
// TextSettingRow — text input with explicit save button
// ---------------------------------------------------------------------------

/** Text input with explicit Save button. */
export function TextSettingRow({
  extensionId,
  status,
}: {
  extensionId: string;
  status: SettingStatus;
}) {
  const [value, setValue] = useState(String(status.value ?? ''));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(
        extensionApiUrl(`/extensions/${extensionId}/settings/${status.key}`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        }
      );
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success(`${status.label} saved`);
    } catch {
      toast.error(`Failed to save ${status.label}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow label={status.label} description={status.description ?? ''} orientation="vertical">
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={status.placeholder ?? status.key}
          className="h-8 min-w-0 flex-1 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSave();
          }}
        />
        <Button size="sm" onClick={handleSave} disabled={saving} className="h-8">
          Save
        </Button>
      </div>
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------
// NumberSettingRow — numeric input with min/max and explicit save button
// ---------------------------------------------------------------------------

/** Numeric input with min/max constraints and explicit Save button. */
export function NumberSettingRow({
  extensionId,
  status,
}: {
  extensionId: string;
  status: SettingStatus;
}) {
  const [value, setValue] = useState(String(status.value ?? ''));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const numValue = Number(value);
    if (Number.isNaN(numValue)) return;
    setSaving(true);
    try {
      const res = await fetch(
        extensionApiUrl(`/extensions/${extensionId}/settings/${status.key}`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: numValue }),
        }
      );
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success(`${status.label} saved`);
    } catch {
      toast.error(`Failed to save ${status.label}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow label={status.label} description={status.description ?? ''} orientation="vertical">
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={status.placeholder ?? status.key}
          min={status.min}
          max={status.max}
          className="h-8 min-w-0 flex-1 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSave();
          }}
        />
        <Button size="sm" onClick={handleSave} disabled={saving} className="h-8">
          Save
        </Button>
      </div>
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------
// BooleanSettingRow — switch with immediate save on toggle
// ---------------------------------------------------------------------------

/** Toggle switch that saves immediately on change. */
export function BooleanSettingRow({
  extensionId,
  status,
  onChanged,
}: {
  extensionId: string;
  status: SettingStatus;
  onChanged: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const checked = Boolean(status.value);

  const handleToggle = async (newValue: boolean) => {
    setSaving(true);
    try {
      const res = await fetch(
        extensionApiUrl(`/extensions/${extensionId}/settings/${status.key}`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: newValue }),
        }
      );
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success(`${status.label} ${newValue ? 'enabled' : 'disabled'}`);
      await onChanged();
    } catch {
      toast.error(`Failed to update ${status.label}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow label={status.label} description={status.description ?? ''}>
      <Switch checked={checked} onCheckedChange={handleToggle} disabled={saving} />
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------
// SelectSettingRow — dropdown with immediate save on change
// ---------------------------------------------------------------------------

/** Select dropdown that saves immediately on change. */
export function SelectSettingRow({
  extensionId,
  status,
  onChanged,
}: {
  extensionId: string;
  status: SettingStatus;
  onChanged: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  const handleChange = async (newValue: string) => {
    setSaving(true);
    try {
      // Parse as number if all options are numeric
      const numericOptions = status.options?.every((o) => typeof o.value === 'number');
      const parsedValue = numericOptions ? Number(newValue) : newValue;

      const res = await fetch(
        extensionApiUrl(`/extensions/${extensionId}/settings/${status.key}`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: parsedValue }),
        }
      );
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success(`${status.label} updated`);
      await onChanged();
    } catch {
      toast.error(`Failed to update ${status.label}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow label={status.label} description={status.description ?? ''} orientation="vertical">
      <Select value={String(status.value ?? '')} onValueChange={handleChange} disabled={saving}>
        <SelectTrigger className="h-8 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(status.options ?? []).map((opt) => (
            <SelectItem key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}
