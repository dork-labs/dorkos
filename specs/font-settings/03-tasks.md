---
slug: font-settings
---

# Tasks: Font Selection Settings

## Phase 1: Foundation (no dependencies)

### P1-T1: Create font-config.ts with FontConfig type, FONT_CONFIGS array, and helpers

Create `apps/client/src/lib/font-config.ts` with the complete font configuration registry.

**File**: `apps/client/src/lib/font-config.ts` (new)

```typescript
/**
 * Font Configuration Registry
 *
 * This is the single source of truth for all font pairings.
 * To add a new font:
 *   1. Append a new object to FONT_CONFIGS below
 *   2. That's it. The type, dropdown, loader, and validation all derive from this array.
 *
 * Each entry defines:
 *   - key: Unique identifier, stored in localStorage
 *   - displayName: Shown in the Settings dropdown
 *   - description: Subtitle in dropdown (e.g., "Inter + JetBrains Mono")
 *   - sans: CSS font-family value for UI text
 *   - mono: CSS font-family value for code blocks
 *   - googleFontsUrl: URL for the Google Fonts stylesheet (null = no external load)
 */

export interface FontConfig {
  key: string;
  displayName: string;
  description: string;
  sans: string;
  mono: string;
  googleFontsUrl: string | null;
}

// Using 'as const satisfies' to get both literal types and runtime array
export const FONT_CONFIGS = [
  {
    key: 'system',
    displayName: 'System Default',
    description: 'Native platform fonts',
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    mono: "ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', Menlo, Consolas, monospace",
    googleFontsUrl: null,
  },
  {
    key: 'inter',
    displayName: 'Inter',
    description: 'Inter + JetBrains Mono',
    sans: "'Inter', system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, monospace",
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono&display=swap',
  },
  {
    key: 'geist',
    displayName: 'Geist',
    description: 'Geist + Geist Mono',
    sans: "'Geist', system-ui, sans-serif",
    mono: "'Geist Mono', ui-monospace, monospace",
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono&display=swap',
  },
  {
    key: 'ibm-plex',
    displayName: 'IBM Plex',
    description: 'IBM Plex Sans + IBM Plex Mono',
    sans: "'IBM Plex Sans', system-ui, sans-serif",
    mono: "'IBM Plex Mono', ui-monospace, monospace",
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap',
  },
  {
    key: 'roboto',
    displayName: 'Roboto',
    description: 'Roboto + Roboto Mono',
    sans: "'Roboto', system-ui, sans-serif",
    mono: "'Roboto Mono', ui-monospace, monospace",
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Roboto+Mono&display=swap',
  },
  {
    key: 'source',
    displayName: 'Source',
    description: 'Source Sans 3 + Source Code Pro',
    sans: "'Source Sans 3', system-ui, sans-serif",
    mono: "'Source Code Pro', ui-monospace, monospace",
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600&family=Source+Code+Pro&display=swap',
  },
  {
    key: 'fira',
    displayName: 'Fira',
    description: 'Fira Sans + Fira Code',
    sans: "'Fira Sans', system-ui, sans-serif",
    mono: "'Fira Code', ui-monospace, monospace",
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Fira+Sans:wght@400;500;600&family=Fira+Code&display=swap',
  },
  {
    key: 'space',
    displayName: 'Space',
    description: 'Space Grotesk + Space Mono',
    sans: "'Space Grotesk', system-ui, sans-serif",
    mono: "'Space Mono', ui-monospace, monospace",
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=Space+Mono&display=swap',
  },
] as const satisfies readonly FontConfig[];

/** Union type of all valid font keys — derived from the config array */
export type FontFamilyKey = typeof FONT_CONFIGS[number]['key'];

/** Default font key for new users / reset */
export const DEFAULT_FONT: FontFamilyKey = 'inter';

/** Look up a font config by key. Returns default font config if key is invalid. */
export function getFontConfig(key: string): FontConfig {
  return FONT_CONFIGS.find(f => f.key === key) ?? FONT_CONFIGS.find(f => f.key === DEFAULT_FONT)!;
}

/** Check if a string is a valid FontFamilyKey */
export function isValidFontKey(key: string): key is FontFamilyKey {
  return FONT_CONFIGS.some(f => f.key === key);
}
```

**Acceptance criteria**:
- File exports `FontConfig` interface, `FONT_CONFIGS` array (8 entries), `FontFamilyKey` type, `DEFAULT_FONT` constant ('inter'), `getFontConfig()`, `isValidFontKey()`
- All 8 font configs have unique keys
- All non-system configs have a `googleFontsUrl`
- `getFontConfig` returns default config for unknown keys
- `isValidFontKey` returns true for valid keys, false for invalid

---

### P1-T2: Create font-loader.ts with DOM manipulation utilities

Create `apps/client/src/lib/font-loader.ts` with functions to manage Google Fonts link elements and CSS application.

**File**: `apps/client/src/lib/font-loader.ts` (new)

```typescript
const LINK_ID = 'google-fonts-link';

export function loadGoogleFont(url: string): void {
  let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (link) {
    link.href = url;
  } else {
    link = document.createElement('link');
    link.id = LINK_ID;
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);
  }
}

export function removeGoogleFont(): void {
  document.getElementById(LINK_ID)?.remove();
}

export function applyFontCSS(sans: string, mono: string): void {
  document.documentElement.style.setProperty('font-family', sans);
  document.documentElement.style.setProperty('--font-mono', mono);
}

export function removeFontCSS(): void {
  document.documentElement.style.removeProperty('font-family');
  document.documentElement.style.removeProperty('--font-mono');
}
```

**Acceptance criteria**:
- `loadGoogleFont(url)` creates a `<link>` element with `id="google-fonts-link"`, `rel="stylesheet"`, and the given `href`, appended to `document.head`
- `loadGoogleFont(url)` reuses existing link element if present (updates `href`)
- `removeGoogleFont()` removes the link element from the DOM
- `applyFontCSS(sans, mono)` sets `font-family` inline style on `document.documentElement` and sets `--font-mono` CSS variable
- `removeFontCSS()` removes both inline style properties

---

### P1-T3: Add preconnect hints to index.html and --font-mono CSS variable to index.css

Modify two existing files to support font loading.

**File**: `apps/client/index.html` — Add Google Fonts preconnect hints in `<head>` before the theme script:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
```

The `<head>` section should look like:

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>DorkOS</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <script>
    (function() {
      var t = localStorage.getItem('gateway-theme');
      var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
      if (dark) document.documentElement.classList.add('dark');
    })();
  </script>
</head>
```

**File**: `apps/client/src/index.css` — Add `--font-mono` CSS variable to the first `:root` block (lines 15-27):

```css
:root {
  --mobile-scale: 1.25;
  --user-font-scale: 1;
  --font-mono: ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', Menlo, Consolas, monospace;
  /* Optional per-category overrides: */
  /* --mobile-scale-text: 1.15; */
  /* --mobile-scale-icon: 1.25; */
  /* --mobile-scale-interactive: 1.30; */

  /* Internal active multipliers (1 on desktop) */
  --_st: 1;
  --_si: 1;
  --_sb: 1;
}
```

**Acceptance criteria**:
- `index.html` has two preconnect `<link>` tags for `fonts.googleapis.com` and `fonts.gstatic.com` (with `crossorigin`)
- `index.css` defines `--font-mono` in `:root` with the system monospace fallback stack
- Preconnect hints appear before the theme script in `<head>`

---

## Phase 2: Store Integration (depends on P1)

### P2-T1: Add fontFamily state, setter, init, and reset to app-store.ts

Modify `apps/client/src/stores/app-store.ts` to add font family persistence.

**Changes to `AppState` interface** — add two new members:

```typescript
fontFamily: FontFamilyKey;
setFontFamily: (key: FontFamilyKey) => void;
```

**Add imports** at the top of the file:

```typescript
import { type FontFamilyKey, DEFAULT_FONT, getFontConfig, isValidFontKey, FONT_CONFIGS } from '@/lib/font-config';
import { loadGoogleFont, removeGoogleFont, applyFontCSS, removeFontCSS } from '@/lib/font-loader';
```

**Add initialization** (follows the `fontSize` IIFE pattern, place after `fontSize`):

```typescript
fontFamily: (() => {
  try {
    const stored = localStorage.getItem('gateway-font-family');
    const key = isValidFontKey(stored ?? '') ? stored! : DEFAULT_FONT;
    const config = getFontConfig(key);
    if (config.googleFontsUrl) {
      loadGoogleFont(config.googleFontsUrl);
    }
    if (config.key !== 'system') {
      applyFontCSS(config.sans, config.mono);
    }
    return key as FontFamilyKey;
  } catch {
    return DEFAULT_FONT;
  }
})() as FontFamilyKey,
```

**Add setter** (place after `setFontSize`):

```typescript
setFontFamily: (key) => {
  try { localStorage.setItem('gateway-font-family', key); } catch {}
  const config = getFontConfig(key);
  if (config.googleFontsUrl) {
    loadGoogleFont(config.googleFontsUrl);
  } else {
    removeGoogleFont();
  }
  if (config.key !== 'system') {
    applyFontCSS(config.sans, config.mono);
  } else {
    removeFontCSS();
  }
  set({ fontFamily: key });
},
```

**Modify `resetPreferences()`** — add font cleanup to localStorage removal block:

```typescript
localStorage.removeItem('gateway-font-family');
```

After the `document.documentElement.style.setProperty('--user-font-scale', '1');` line, add:

```typescript
const defaultConfig = getFontConfig(DEFAULT_FONT);
if (defaultConfig.googleFontsUrl) loadGoogleFont(defaultConfig.googleFontsUrl);
applyFontCSS(defaultConfig.sans, defaultConfig.mono);
```

Add `fontFamily: DEFAULT_FONT,` to the `set({...})` call in `resetPreferences`.

**Acceptance criteria**:
- `fontFamily` initializes to stored value from localStorage (or `DEFAULT_FONT` if missing/invalid)
- On init, if font has `googleFontsUrl`, injects the link tag; if not 'system', applies CSS
- `setFontFamily(key)` persists to localStorage, loads/removes Google Font link, applies/removes CSS
- `setFontFamily('system')` removes Google Fonts link and CSS overrides
- `resetPreferences()` removes `gateway-font-family` from localStorage, resets to `DEFAULT_FONT` ('inter'), loads Inter font

---

## Phase 3: UI (depends on P2)

### P3-T1: Add Appearance tab to SettingsDialog with font family selector

Modify `apps/client/src/components/settings/SettingsDialog.tsx` to add an Appearance tab.

**Add imports**:

```typescript
import { FONT_CONFIGS, type FontFamilyKey } from '@/lib/font-config';
```

**Add to destructured store values**:

```typescript
fontFamily, setFontFamily,
```

**Change default tab** from `'preferences'` to `'appearance'`:

```typescript
const [activeTab, setActiveTab] = useState('appearance');
```

**Change tab grid** from `grid-cols-3` to `grid-cols-4`:

```tsx
<TabsList className="grid w-full grid-cols-4 mx-4 mt-3" style={{ width: 'calc(100% - 2rem)' }}>
```

**Add Appearance tab trigger** (first position, before Preferences):

```tsx
<TabsTrigger value="appearance">Appearance</TabsTrigger>
<TabsTrigger value="preferences">Preferences</TabsTrigger>
<TabsTrigger value="statusBar">Status Bar</TabsTrigger>
<TabsTrigger value="server">Server</TabsTrigger>
```

**Add Appearance tab content** (before the Preferences TabsContent). Move Theme and Font size selectors from Preferences into Appearance, and add Font family selector:

```tsx
<TabsContent value="appearance" className="mt-0 space-y-6">
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-semibold text-foreground">Appearance</h3>
      <button
        onClick={() => { resetPreferences(); setTheme('system'); }}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors duration-150"
      >
        Reset to defaults
      </button>
    </div>

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
                <span className="text-xs text-muted-foreground">{font.description}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>

    <SettingRow label="Font size" description="Adjust the text size across the interface">
      <Select value={fontSize} onValueChange={(v) => setFontSize(v as 'small' | 'medium' | 'large')}>
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
  </div>
</TabsContent>
```

**Remove Theme and Font size from Preferences tab** — the Preferences tab should only contain: "Reset to defaults" header, Show timestamps, Expand tool calls, Auto-hide tool calls, Show shortcut chips, Show dev tools, Verbose logging.

**Acceptance criteria**:
- Settings dialog has 4 tabs: Appearance, Preferences, Status Bar, Server
- Appearance tab is the default active tab
- Appearance tab contains Theme, Font family, and Font size selectors
- Font family dropdown shows all 8 options with display name and description subtitle
- Selecting a font calls `setFontFamily` with the selected key
- Theme and Font size are no longer in the Preferences tab
- Preferences tab retains all toggle switches (timestamps, tool calls, etc.)
- "Reset to defaults" button appears in the Appearance tab header

---

## Phase 4: Tests (depends on P3)

### P4-T1: Write tests for font-config, font-loader, app-store fontFamily, and SettingsDialog Appearance tab

Create two new test files and extend two existing test files.

**File**: `apps/client/src/lib/__tests__/font-config.test.ts` (new)

```typescript
import { describe, it, expect } from 'vitest';
import { FONT_CONFIGS, DEFAULT_FONT, getFontConfig, isValidFontKey } from '../font-config';

describe('font-config', () => {
  it('all FONT_CONFIGS have unique keys', () => {
    const keys = FONT_CONFIGS.map(f => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('all non-system configs have a googleFontsUrl', () => {
    FONT_CONFIGS.filter(f => f.key !== 'system').forEach(f => {
      expect(f.googleFontsUrl).toBeTruthy();
    });
  });

  it('system config has null googleFontsUrl', () => {
    const system = FONT_CONFIGS.find(f => f.key === 'system');
    expect(system?.googleFontsUrl).toBeNull();
  });

  it('DEFAULT_FONT is inter', () => {
    expect(DEFAULT_FONT).toBe('inter');
  });

  describe('getFontConfig', () => {
    it('returns correct config for each valid key', () => {
      FONT_CONFIGS.forEach(config => {
        expect(getFontConfig(config.key)).toEqual(config);
      });
    });

    it('returns default (inter) config for unknown key', () => {
      const result = getFontConfig('nonexistent');
      expect(result.key).toBe(DEFAULT_FONT);
    });

    it('returns default config for empty string', () => {
      const result = getFontConfig('');
      expect(result.key).toBe(DEFAULT_FONT);
    });
  });

  describe('isValidFontKey', () => {
    it('returns true for all valid keys', () => {
      FONT_CONFIGS.forEach(config => {
        expect(isValidFontKey(config.key)).toBe(true);
      });
    });

    it('returns false for invalid key', () => {
      expect(isValidFontKey('comic-sans')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isValidFontKey('')).toBe(false);
    });
  });
});
```

**File**: `apps/client/src/lib/__tests__/font-loader.test.ts` (new)

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadGoogleFont, removeGoogleFont, applyFontCSS, removeFontCSS } from '../font-loader';

describe('font-loader', () => {
  beforeEach(() => {
    // Clean up any link elements from previous tests
    document.getElementById('google-fonts-link')?.remove();
    // Reset inline styles on documentElement
    document.documentElement.style.removeProperty('font-family');
    document.documentElement.style.removeProperty('--font-mono');
  });

  describe('loadGoogleFont', () => {
    it('creates a link element with correct attributes', () => {
      loadGoogleFont('https://fonts.googleapis.com/css2?family=Inter');
      const link = document.getElementById('google-fonts-link') as HTMLLinkElement;
      expect(link).toBeTruthy();
      expect(link.rel).toBe('stylesheet');
      expect(link.href).toContain('fonts.googleapis.com');
    });

    it('updates existing link instead of creating duplicate', () => {
      loadGoogleFont('https://fonts.googleapis.com/css2?family=Inter');
      loadGoogleFont('https://fonts.googleapis.com/css2?family=Roboto');
      const links = document.querySelectorAll('#google-fonts-link');
      expect(links.length).toBe(1);
      expect((links[0] as HTMLLinkElement).href).toContain('Roboto');
    });
  });

  describe('removeGoogleFont', () => {
    it('removes the link element', () => {
      loadGoogleFont('https://fonts.googleapis.com/css2?family=Inter');
      expect(document.getElementById('google-fonts-link')).toBeTruthy();
      removeGoogleFont();
      expect(document.getElementById('google-fonts-link')).toBeNull();
    });

    it('does nothing if no link exists', () => {
      expect(() => removeGoogleFont()).not.toThrow();
    });
  });

  describe('applyFontCSS', () => {
    it('sets inline styles on documentElement', () => {
      applyFontCSS("'Inter', sans-serif", "'JetBrains Mono', monospace");
      expect(document.documentElement.style.fontFamily).toBe("'Inter', sans-serif");
      expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe("'JetBrains Mono', monospace");
    });
  });

  describe('removeFontCSS', () => {
    it('removes inline styles', () => {
      applyFontCSS("'Inter', sans-serif", "'JetBrains Mono', monospace");
      removeFontCSS();
      expect(document.documentElement.style.fontFamily).toBe('');
      expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe('');
    });
  });
});
```

**Extend**: `apps/client/src/components/settings/__tests__/SettingsDialog.test.tsx` — add tests for the Appearance tab:

```typescript
it('renders four tabs: Appearance, Preferences, Status Bar, Server', () => {
  render(
    <SettingsDialog open={true} onOpenChange={vi.fn()} />,
    { wrapper: createWrapper() },
  );
  expect(screen.getByRole('tab', { name: /appearance/i })).toBeDefined();
  expect(screen.getByRole('tab', { name: /preferences/i })).toBeDefined();
  expect(screen.getByRole('tab', { name: /status bar/i })).toBeDefined();
  expect(screen.getByRole('tab', { name: /server/i })).toBeDefined();
});

it('displays font family selector in Appearance tab', () => {
  render(
    <SettingsDialog open={true} onOpenChange={vi.fn()} />,
    { wrapper: createWrapper() },
  );
  expect(screen.getByText('Font family')).toBeDefined();
  expect(screen.getByText('Choose the typeface for the interface')).toBeDefined();
});

it('displays Theme and Font size in Appearance tab (not Preferences)', () => {
  render(
    <SettingsDialog open={true} onOpenChange={vi.fn()} />,
    { wrapper: createWrapper() },
  );
  // Theme and Font size should exist (in Appearance)
  expect(screen.getByText('Theme')).toBeDefined();
  expect(screen.getByText('Font size')).toBeDefined();
  // Font family should also exist in Appearance
  expect(screen.getByText('Font family')).toBeDefined();
});
```

Update the existing test `'renders three tabs: Preferences, Status Bar, Server'` to check for four tabs including Appearance. Update `'displays all preference controls'` to reflect that Theme and Font size are now in Appearance, not Preferences.

**Acceptance criteria**:
- `font-config.test.ts`: Tests for unique keys, googleFontsUrl presence, getFontConfig valid/invalid, isValidFontKey valid/invalid
- `font-loader.test.ts`: Tests for link creation, link reuse, link removal, CSS application, CSS removal
- `SettingsDialog.test.tsx`: Updated to check for 4 tabs, font family selector presence, Theme/Font size in Appearance tab
- All tests pass with `npx vitest run`
