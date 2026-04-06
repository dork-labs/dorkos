import {
  FieldCard,
  FieldCardContent,
  NavigationLayoutPanelHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingRow,
} from '@/layers/shared/ui';
import { useAppStore, useTheme } from '@/layers/shared/model';
import { FONT_CONFIGS, type FontFamilyKey } from '@/layers/shared/lib';

/** Appearance settings tab — theme, font family, font size. */
export function AppearanceTab() {
  const { theme, setTheme } = useTheme();
  const { fontFamily, setFontFamily, fontSize, setFontSize, resetPreferences } = useAppStore();

  return (
    <div className="space-y-4">
      <NavigationLayoutPanelHeader
        actions={
          <button
            onClick={() => {
              resetPreferences();
              setTheme('system');
            }}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors duration-150"
          >
            Reset to defaults
          </button>
        }
      >
        Appearance
      </NavigationLayoutPanelHeader>

      <FieldCard>
        <FieldCardContent>
          <SettingRow label="Theme" description="Choose your preferred color scheme">
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow label="Font family" description="Choose the typeface for the interface">
            <Select value={fontFamily} onValueChange={(v) => setFontFamily(v as FontFamilyKey)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_CONFIGS.map((font) => (
                  <SelectItem key={font.key} value={font.key}>
                    <div className="flex flex-col">
                      <span>{font.displayName}</span>
                      <span className="text-muted-foreground text-xs">{font.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow label="Font size" description="Adjust the text size across the interface">
            <Select
              value={fontSize}
              onValueChange={(v) => setFontSize(v as 'small' | 'medium' | 'large')}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="small">Small</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="large">Large</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </FieldCardContent>
      </FieldCard>
    </div>
  );
}
