import * as React from 'react';
import { SettingRow, Switch, Button, FieldCard, FieldCardContent } from '@/layers/shared/ui';
import {
  STATUS_BAR_REGISTRY,
  getGroupedRegistryItems,
  useStatusBarVisibility,
  useResetStatusBarPreferences,
  type StatusBarItemKey,
} from '../model/status-bar-registry';

/** Single toggle row for one registry item — reads/writes visibility via the hook. */
function RegistryItemRow({ itemKey }: { itemKey: StatusBarItemKey }) {
  const config = STATUS_BAR_REGISTRY.find((item) => item.key === itemKey);
  const [visible, setVisible] = useStatusBarVisibility(itemKey);

  if (!config) return null;

  const Icon = config.icon;

  return (
    <SettingRow
      label={
        <span className="flex items-center gap-1.5">
          <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          {config.label}
        </span>
      }
      description={config.description}
    >
      <Switch
        checked={visible}
        onCheckedChange={setVisible}
        aria-label={`Toggle ${config.label}`}
      />
    </SettingRow>
  );
}

/**
 * Grouped toggle list for all user-configurable status bar items.
 *
 * Renders each registry item as a `SettingRow` + `Switch`, organized under group
 * headers inside `FieldCard` containers matching the Settings dialog visual style.
 */
function StatusBarConfigureContent() {
  const groups = getGroupedRegistryItems();
  const resetStatusBarPreferences = useResetStatusBarPreferences();

  return (
    <div className="flex flex-col gap-4" aria-label="Status bar configuration">
      {groups.map((group) => (
        <div key={group.group} className="space-y-1.5">
          <p className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
            {group.label}
          </p>
          <FieldCard>
            <FieldCardContent>
              {group.items.map((item) => (
                <RegistryItemRow key={item.key} itemKey={item.key} />
              ))}
            </FieldCardContent>
          </FieldCard>
        </div>
      ))}

      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground h-auto justify-start px-1 py-1 text-xs"
        onClick={resetStatusBarPreferences}
      >
        Reset to defaults
      </Button>
    </div>
  );
}

StatusBarConfigureContent.displayName = 'StatusBarConfigureContent';

export { StatusBarConfigureContent };
