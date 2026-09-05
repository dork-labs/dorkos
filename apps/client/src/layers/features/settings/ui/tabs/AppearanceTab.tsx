import {
  FieldCard,
  FieldCardContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingRow,
} from '@/layers/shared/ui';
import { useAppStore, useTheme } from '@/layers/shared/model';
import { FONT_CONFIGS, type FontFamilyKey } from '@/layers/shared/lib';
import { ResetToDefaultsButton } from '../ResetToDefaultsButton';

/**
 * Header action for the Appearance panel — puts back the three things this
 * panel shows (theme, font family, font size) and nothing else.
 *
 * A component rather than an element because the dialog declares its tabs
 * before any of them mount, and this needs the same stores the panel reads.
 */
export function AppearanceResetAction() {
  const { setTheme } = useTheme();
  const resetAppearance = useAppStore((s) => s.resetAppearance);

  return (
    <ResetToDefaultsButton
      onClick={() => {
        resetAppearance();
        setTheme('system');
      }}
    />
  );
}

/** Appearance settings tab — theme, font family, font size. */
export function AppearanceTab() {
  const { theme, setTheme } = useTheme();
  const { fontFamily, setFontFamily, fontSize, setFontSize } = useAppStore();

  return (
    <div className="space-y-4">
      <FieldCard>
        <FieldCardContent>
          <SettingRow label="Theme">
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

          <SettingRow label="Font family">
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

          <SettingRow label="Font size">
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
