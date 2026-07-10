import { useState, useEffect, useCallback } from 'react';
import type { SecretDeclaration, SettingDeclaration } from '@dorkos/extension-api';
import { Settings, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  FieldCard,
  FieldCardContent,
  CollapsibleFieldCard,
  SettingRow,
  PasswordInput,
  Badge,
  Button,
} from '@/layers/shared/ui';
import {
  TextSettingRow,
  NumberSettingRow,
  BooleanSettingRow,
  SelectSettingRow,
  type SettingStatus,
} from './SettingFieldRenderers';
import { extensionApiUrl } from '../model/extension-api-url';

/** Server response shape for a single secret's status. */
interface SecretStatus {
  key: string;
  isSet: boolean;
}

/** Discriminated union for secrets and settings within a group. */
type ConfigItem =
  | { kind: 'secret'; declaration: SecretDeclaration; isSet: boolean }
  | { kind: 'setting'; declaration: SettingDeclaration; status: SettingStatus };

/**
 * Merge secrets and settings by group, preserving declaration order.
 *
 * Within each group, secrets appear first (credential setup), followed by
 * settings (configuration). Ungrouped items use `undefined` as the key.
 */
function groupConfigItems(
  secrets: SecretDeclaration[],
  secretStatuses: Map<string, boolean>,
  settings: SettingDeclaration[],
  settingStatuses: SettingStatus[]
): Map<string | undefined, ConfigItem[]> {
  const grouped = new Map<string | undefined, ConfigItem[]>();

  const addToGroup = (group: string | undefined, item: ConfigItem) => {
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group)!.push(item);
  };

  // Secrets first within each group
  for (const decl of secrets) {
    addToGroup(decl.group, {
      kind: 'secret',
      declaration: decl,
      isSet: secretStatuses.get(decl.key) ?? false,
    });
  }

  // Then settings
  for (const status of settingStatuses) {
    const decl = settings.find((s) => s.key === status.key);
    if (decl) {
      addToGroup(decl.group, { kind: 'setting', declaration: decl, status });
    }
  }

  return grouped;
}

/**
 * Auto-generated settings panel for extension secrets and settings declared
 * in the manifest.
 *
 * Renders a polished settings card using the host design system — extension
 * authors get this for free by declaring `serverCapabilities.secrets` and/or
 * `serverCapabilities.settings` in their `extension.json`. No UI code required.
 *
 * @param extensionId - The extension ID for API calls
 * @param secrets - Secret declarations from the manifest
 * @param settings - Setting declarations from the manifest
 */
export function ManifestSettingsPanel({
  extensionId,
  secrets,
  settings,
}: {
  extensionId: string;
  secrets: SecretDeclaration[];
  settings: SettingDeclaration[];
}) {
  const [secretStatuses, setSecretStatuses] = useState<Map<string, boolean>>(new Map());
  const [settingStatuses, setSettingStatuses] = useState<SettingStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchStatuses = useCallback(async () => {
    try {
      const [secretsRes, settingsRes] = await Promise.all([
        secrets.length > 0
          ? fetch(extensionApiUrl(`/extensions/${extensionId}/secrets`))
          : Promise.resolve(null),
        settings.length > 0
          ? fetch(extensionApiUrl(`/extensions/${extensionId}/settings`))
          : Promise.resolve(null),
      ]);

      if (secretsRes?.ok) {
        const data = (await secretsRes.json()) as SecretStatus[];
        setSecretStatuses(new Map(data.map((s) => [s.key, s.isSet])));
      }

      if (settingsRes?.ok) {
        const data = (await settingsRes.json()) as SettingStatus[];
        setSettingStatuses(data);
      }
    } catch {
      // Non-blocking — settings panel degrades gracefully
    } finally {
      setLoading(false);
    }
  }, [extensionId, secrets.length, settings.length]);

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

  const grouped = groupConfigItems(secrets, secretStatuses, settings, settingStatuses);
  const ungrouped = grouped.get(undefined);
  const namedGroups = [...grouped.entries()].filter(([key]) => key !== undefined) as Array<
    [string, ConfigItem[]]
  >;

  function renderItem(item: ConfigItem) {
    if (item.kind === 'secret') {
      return (
        <SecretRow
          key={item.declaration.key}
          extensionId={extensionId}
          secret={item.declaration}
          isSet={item.isSet}
          onChanged={fetchStatuses}
        />
      );
    }
    switch (item.status.type) {
      case 'text':
        return (
          <TextSettingRow
            key={item.declaration.key}
            extensionId={extensionId}
            status={item.status}
          />
        );
      case 'number':
        return (
          <NumberSettingRow
            key={item.declaration.key}
            extensionId={extensionId}
            status={item.status}
          />
        );
      case 'boolean':
        return (
          <BooleanSettingRow
            key={item.declaration.key}
            extensionId={extensionId}
            status={item.status}
            onChanged={fetchStatuses}
          />
        );
      case 'select':
        return (
          <SelectSettingRow
            key={item.declaration.key}
            extensionId={extensionId}
            status={item.status}
            onChanged={fetchStatuses}
          />
        );
    }
  }

  return (
    <>
      {ungrouped && ungrouped.length > 0 && (
        <FieldCard>
          <FieldCardContent>{ungrouped.map(renderItem)}</FieldCardContent>
        </FieldCard>
      )}

      {namedGroups.map(([groupName, items]) => (
        <ConfigGroupCard
          key={groupName}
          groupName={groupName}
          items={items}
          renderItem={renderItem}
        />
      ))}
    </>
  );
}

/** Icon used for extension settings tabs in the sidebar nav. */
export { Settings as ManifestSettingsIcon };

// ---------------------------------------------------------------------------
// ConfigGroupCard — collapsible group of config items
// ---------------------------------------------------------------------------

function ConfigGroupCard({
  groupName,
  items,
  renderItem,
}: {
  groupName: string;
  items: ConfigItem[];
  renderItem: (item: ConfigItem) => React.JSX.Element | undefined;
}) {
  const [open, setOpen] = useState(true);

  return (
    <CollapsibleFieldCard open={open} onOpenChange={setOpen} trigger={groupName}>
      {items.map(renderItem)}
    </CollapsibleFieldCard>
  );
}

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
      const res = await fetch(extensionApiUrl(`/extensions/${extensionId}/secrets/${secret.key}`), {
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
      const res = await fetch(extensionApiUrl(`/extensions/${extensionId}/secrets/${secret.key}`), {
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
          placeholder={secret.placeholder ?? secret.key}
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
