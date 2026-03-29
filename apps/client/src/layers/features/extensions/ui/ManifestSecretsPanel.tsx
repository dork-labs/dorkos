import { useState, useEffect, useCallback } from 'react';
import type { SecretDeclaration } from '@dorkos/extension-api';
import { KeyRound, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  FieldCard,
  FieldCardContent,
  SettingRow,
  PasswordInput,
  Badge,
  Button,
} from '@/layers/shared/ui';

/** Server response shape for a single secret's status. */
interface SecretStatus {
  key: string;
  isSet: boolean;
}

/**
 * Auto-generated settings panel for extension secrets declared in the manifest.
 *
 * Renders a polished settings card using the host design system — extension
 * authors get this for free by declaring `serverCapabilities.secrets` in
 * their `extension.json`. No UI code required.
 *
 * @param extensionId - The extension ID for API calls
 * @param secrets - Secret declarations from the manifest
 */
export function ManifestSecretsPanel({
  extensionId,
  secrets,
}: {
  extensionId: string;
  secrets: SecretDeclaration[];
}) {
  const [statuses, setStatuses] = useState<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(true);

  const fetchStatuses = useCallback(async () => {
    try {
      const res = await fetch(`/api/extensions/${extensionId}/secrets`);
      if (!res.ok) return;
      const data = (await res.json()) as SecretStatus[];
      setStatuses(new Map(data.map((s) => [s.key, s.isSet])));
    } catch {
      // Non-blocking — secrets panel degrades gracefully
    } finally {
      setLoading(false);
    }
  }, [extensionId]);

  useEffect(() => {
    void fetchStatuses();
  }, [fetchStatuses]);

  if (loading) {
    return (
      <FieldCard>
        <FieldCardContent>
          <div className="text-muted-foreground py-4 text-center text-sm">Loading…</div>
        </FieldCardContent>
      </FieldCard>
    );
  }

  return (
    <FieldCard>
      <FieldCardContent>
        {secrets.map((secret) => (
          <SecretRow
            key={secret.key}
            extensionId={extensionId}
            secret={secret}
            isSet={statuses.get(secret.key) ?? false}
            onChanged={fetchStatuses}
          />
        ))}
      </FieldCardContent>
    </FieldCard>
  );
}

/** Icon used for extension settings tabs in the sidebar nav. */
export { KeyRound as ManifestSecretsIcon };

// ---------------------------------------------------------------------------
// SecretRow — individual secret with set/clear states
// ---------------------------------------------------------------------------

function SecretRow({
  extensionId,
  secret,
  isSet,
  onChanged,
}: {
  extensionId: string;
  secret: SecretDeclaration;
  isSet: boolean;
  onChanged: () => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!value.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/extensions/${extensionId}/secrets/${secret.key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setValue('');
      toast.success(`${secret.label} saved`);
      await onChanged();
    } catch {
      toast.error(`Failed to save ${secret.label}`);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/extensions/${extensionId}/secrets/${secret.key}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success(`${secret.label} removed`);
      await onChanged();
    } catch {
      toast.error(`Failed to remove ${secret.label}`);
    } finally {
      setSaving(false);
    }
  };

  const description = secret.description ?? (secret.required ? 'Required' : 'Optional');

  if (isSet) {
    return (
      <SettingRow label={secret.label} description={description}>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-muted-foreground gap-1">
            <Check className="size-3" />
            Configured
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={saving}
            className="text-muted-foreground hover:text-destructive h-7 px-2 text-xs"
          >
            <X className="size-3" />
            Clear
          </Button>
        </div>
      </SettingRow>
    );
  }

  return (
    <SettingRow label={secret.label} description={description}>
      <div className="flex items-center gap-2">
        <PasswordInput
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={secret.key.replace(/_/g, '_')}
          className="h-8 w-48 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSave();
          }}
        />
        <Button size="sm" onClick={handleSave} disabled={saving || !value.trim()} className="h-8">
          Save
        </Button>
      </div>
    </SettingRow>
  );
}
