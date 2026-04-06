import {
  FieldCard,
  FieldCardContent,
  NavigationLayoutPanelHeader,
  SwitchSettingRow,
} from '@/layers/shared/ui';
import {
  STATUS_BAR_REGISTRY,
  useStatusBarVisibility,
  resetStatusBarPreferences,
  type StatusBarItemConfig,
} from '@/layers/features/status';

/** Toggle row for a single status bar registry item. */
function StatusBarSettingRow({ item }: { item: StatusBarItemConfig }) {
  const [visible, setVisible] = useStatusBarVisibility(item.key);
  return (
    <SwitchSettingRow
      label={item.label}
      description={item.description}
      checked={visible}
      onCheckedChange={setVisible}
    />
  );
}

/** Status Bar settings tab — toggle visibility of registry items. */
export function StatusBarTab() {
  return (
    <div className="space-y-4">
      <NavigationLayoutPanelHeader
        actions={
          <button
            onClick={resetStatusBarPreferences}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors duration-150"
          >
            Reset to defaults
          </button>
        }
      >
        Status Bar
      </NavigationLayoutPanelHeader>
      <FieldCard>
        <FieldCardContent>
          {STATUS_BAR_REGISTRY.map((item) => (
            <StatusBarSettingRow key={item.key} item={item} />
          ))}
        </FieldCardContent>
      </FieldCard>
    </div>
  );
}
