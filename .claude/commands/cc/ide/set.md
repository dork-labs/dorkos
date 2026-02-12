---
description: Set VS Code color scheme from a single color
argument-hint: <color>
allowed-tools: Read, Edit, Write, Bash
---

# Set VS Code IDE Color Scheme

Generate a cohesive, professional VS Code color scheme from a single seed color.

## Scope

**IMPORTANT: This command ONLY modifies project-level settings.**

| Setting | Path | Modified? |
|---------|------|-----------|
| Project settings | `.vscode/settings.json` | YES |
| User settings | `~/.config/Code/User/settings.json` | **NEVER** |
| User settings (macOS) | `~/Library/Application Support/Code/User/settings.json` | **NEVER** |

**NEVER read, write, or modify any file outside the project's `.vscode/` directory.**

## Input

The user provides: `$ARGUMENTS` - A color in any format:
- Hex: `#3b82f6`, `#85bb65`
- RGB: `rgb(59, 130, 246)`
- HSL: `hsl(217, 91%, 60%)`
- Color name: `forest green`, `ocean blue`, `coral`, `purple`, `gold`

## Execution Steps

### Step 1: Generate the Color Scheme

Write this script to the project's temp directory and execute it:

```javascript
// Save to .temp/vscode-theme-gen.js and run: node .temp/vscode-theme-gen.js "<color>"

const COLOR_NAMES = {
  'red': 0, 'crimson': 348, 'coral': 16, 'salmon': 6,
  'orange': 30, 'amber': 45, 'gold': 51, 'yellow': 60,
  'lime': 75, 'chartreuse': 90, 'green': 120, 'forest green': 130,
  'emerald': 140, 'teal': 170, 'cyan': 180, 'sky': 195,
  'blue': 210, 'ocean blue': 215, 'azure': 210, 'cobalt': 215,
  'indigo': 240, 'violet': 270, 'purple': 280, 'magenta': 300,
  'pink': 330, 'rose': 340, 'slate': 215, 'gray': 0, 'grey': 0
};

function parseColor(input) {
  const str = input.trim().toLowerCase();
  for (const [name, hue] of Object.entries(COLOR_NAMES)) {
    if (str === name || str.replace(/[-_]/g, ' ') === name) {
      return { h: hue, s: 50, l: 50 };
    }
  }
  const hexMatch = str.match(/^#?([0-9a-f]{3,8})$/i);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = parseInt(hex.slice(0,2),16)/255;
    const g = parseInt(hex.slice(2,4),16)/255;
    const b = parseInt(hex.slice(4,6),16)/255;
    return rgbToHsl(r, g, b);
  }
  const rgbMatch = str.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (rgbMatch) {
    return rgbToHsl(parseInt(rgbMatch[1])/255, parseInt(rgbMatch[2])/255, parseInt(rgbMatch[3])/255);
  }
  const hslMatch = str.match(/hsl\s*\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?\s*\)/);
  if (hslMatch) {
    return { h: parseInt(hslMatch[1]), s: parseInt(hslMatch[2]), l: parseInt(hslMatch[3]) };
  }
  console.error('Warning: Could not parse color, defaulting to blue');
  return { h: 210, s: 50, l: 50 };
}

function rgbToHsl(r, g, b) {
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s, l = (max+min)/2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch(max) {
      case r: h = ((g-b)/d + (g<b?6:0))/6; break;
      case g: h = ((b-r)/d + 2)/6; break;
      case b: h = ((r-g)/d + 4)/6; break;
    }
  }
  return { h: Math.round(h*360), s: Math.round(s*100), l: Math.round(l*100) };
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1-l);
  const f = n => {
    const k = (n + h/30) % 12;
    const color = l - a * Math.max(Math.min(k-3, 9-k, 1), -1);
    return Math.round(255*color).toString(16).padStart(2,'0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function generatePalette(seedHue) {
  const steps = [
    { name: '50',  n: 0.03, lightness: 97, saturation: 5 },
    { name: '100', n: 0.12, lightness: 88, saturation: 15 },
    { name: '200', n: 0.25, lightness: 75, saturation: 25 },
    { name: '300', n: 0.38, lightness: 62, saturation: 35 },
    { name: '400', n: 0.50, lightness: 50, saturation: 45 },
    { name: '500', n: 0.62, lightness: 38, saturation: 40 },
    { name: '600', n: 0.75, lightness: 25, saturation: 30 },
    { name: '700', n: 0.85, lightness: 15, saturation: 20 },
    { name: '750', n: 0.90, lightness: 12, saturation: 15 },
    { name: '800', n: 0.94, lightness: 8,  saturation: 10 },
    { name: '900', n: 1.00, lightness: 4,  saturation: 5 },
  ];
  const palette = {};
  for (const step of steps) {
    const hueShift = 5 * (1 - step.n);
    palette[step.name] = hslToHex((seedHue + hueShift) % 360, step.saturation, step.lightness);
  }
  return palette;
}

function withOpacity(hex, opacity) {
  return hex + Math.round(opacity * 255).toString(16).padStart(2, '0');
}

function generateTheme(seedColor) {
  const hsl = parseColor(seedColor);
  const p = generatePalette(hsl.h);
  return {
    seedColor, seedHue: hsl.h, palette: p,
    colorCustomizations: {
      "editor.background": p['800'], "editor.foreground": p['100'],
      "editor.lineHighlightBackground": p['700'],
      "editor.selectionBackground": withOpacity(p['500'], 0.5),
      "editorCursor.foreground": p['400'],
      "editorLineNumber.foreground": p['600'],
      "editorLineNumber.activeForeground": p['400'],
      "editorGutter.background": p['800'],
      "editorGroup.border": p['600'],
      "editorGroupHeader.tabsBackground": p['750'],
      "activityBar.background": p['700'], "activityBar.foreground": p['400'],
      "activityBar.inactiveForeground": p['500'], "activityBar.border": p['600'],
      "activityBarBadge.background": p['400'], "activityBarBadge.foreground": p['800'],
      "sideBar.background": p['750'], "sideBar.foreground": p['200'],
      "sideBar.border": p['600'], "sideBarTitle.foreground": p['400'],
      "sideBarSectionHeader.background": p['700'],
      "sideBarSectionHeader.foreground": p['400'],
      "tab.activeBackground": p['700'], "tab.activeForeground": p['400'],
      "tab.inactiveBackground": p['750'], "tab.inactiveForeground": p['500'],
      "tab.border": p['600'], "tab.activeBorderTop": p['400'],
      "titleBar.activeBackground": p['700'], "titleBar.activeForeground": p['400'],
      "titleBar.inactiveBackground": p['750'], "titleBar.inactiveForeground": p['500'],
      "titleBar.border": p['600'],
      "statusBar.background": p['700'], "statusBar.foreground": p['400'],
      "statusBar.border": p['600'], "statusBar.debuggingBackground": p['500'],
      "statusBar.noFolderBackground": p['600'],
      "panel.background": p['750'], "panel.border": p['600'],
      "panelTitle.activeBorder": p['400'], "panelTitle.activeForeground": p['400'],
      "panelTitle.inactiveForeground": p['500'],
      "terminal.background": p['800'], "terminal.foreground": p['100'],
      "terminalCursor.foreground": p['400'],
      "input.background": p['700'], "input.foreground": p['100'],
      "input.border": p['600'], "input.placeholderForeground": p['500'],
      "inputOption.activeBorder": p['400'],
      "dropdown.background": p['700'], "dropdown.border": p['600'],
      "dropdown.foreground": p['100'],
      "button.background": p['500'], "button.foreground": p['100'],
      "button.hoverBackground": p['400'],
      "list.activeSelectionBackground": p['500'],
      "list.activeSelectionForeground": p['100'],
      "list.hoverBackground": p['700'], "list.focusBackground": p['600'],
      "scrollbarSlider.background": withOpacity(p['600'], 0.5),
      "scrollbarSlider.hoverBackground": withOpacity(p['500'], 0.5),
      "scrollbarSlider.activeBackground": withOpacity(p['400'], 0.5),
      "badge.background": p['400'], "badge.foreground": p['800'],
      "progressBar.background": p['400'],
      "focusBorder": p['400'], "selection.background": withOpacity(p['500'], 0.5)
    }
  };
}

const input = process.argv.slice(2).join(' ') || 'blue';
const theme = generateTheme(input);
console.log(JSON.stringify({
  seedColor: theme.seedColor,
  seedHue: theme.seedHue,
  palette: theme.palette,
  colorCustomizations: theme.colorCustomizations
}, null, 2));
```

**Run the script:**
```bash
mkdir -p .temp && node .temp/vscode-theme-gen.js "$ARGUMENTS"
```

Note: `.temp/` is already in `.gitignore` so the script won't be committed.

### Step 2: Update Project Settings

1. **Read** `.vscode/settings.json` (create directory and file if they don't exist)
2. **Parse** the existing JSON (or start with `{}` if new)
3. **Merge** the generated `colorCustomizations` into `workbench.colorCustomizations`
4. **Preserve** all other existing settings
5. **Write** the updated JSON back to `.vscode/settings.json`

**CRITICAL: Only modify `.vscode/settings.json` in the current project. NEVER touch user-level settings.**

### Step 3: Report Results

Output a summary:

```
IDE Theme Set

Seed color: [color name/hex] (hue: [X]deg)
File: .vscode/settings.json

Key colors generated:
  Background:  [hex from palette 800]
  Foreground:  [hex from palette 100]
  Accent:      [hex from palette 400]
  Borders:     [hex from palette 600]

The theme is now active. Restart VS Code if colors don't update immediately.
```

## Algorithm Notes

The script uses these design principles:

| Principle | Implementation |
|-----------|----------------|
| **60-30-10 Rule** | 60% backgrounds (800), 30% UI (600-700), 10% accents (400) |
| **Tonal Palette** | 11 steps from near-white (50) to near-black (900) |
| **Hue Shift** | +5deg at highlights, 0deg at shadows (Bezold-Brucke compensation) |
| **Saturation Curve** | Peaks at mid-tones (400), tapers at extremes |
| **No Pure B/W** | Backgrounds ~8% lightness, foregrounds ~88% lightness |

## Supported Color Names

`red`, `crimson`, `coral`, `salmon`, `orange`, `amber`, `gold`, `yellow`, `lime`, `chartreuse`, `green`, `forest green`, `emerald`, `teal`, `cyan`, `sky`, `blue`, `ocean blue`, `azure`, `cobalt`, `indigo`, `violet`, `purple`, `magenta`, `pink`, `rose`, `slate`, `gray`
