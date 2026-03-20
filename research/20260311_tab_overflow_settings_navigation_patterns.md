---
title: 'Tab Overflow & Settings Navigation Patterns'
date: 2026-03-11
type: external-best-practices
status: active
tags:
  [tabs, navigation, settings, overflow, sidebar, mobile, desktop, ux, apple-hig, material-design]
searches_performed: 14
sources_count: 28
---

## Research Summary

When there are too many tabs to fit in a row — the specific case being six settings categories (Appearance, Preferences, Status Bar, Server, Tools, Advanced) — the industry consensus is clear: for a settings dialog with more than 4–5 tabs, the correct pattern on desktop is a **vertical left sidebar**, not horizontal tabs. Android explicitly prohibits tabs for settings. Apple moved macOS System Settings from a toolbar/grid pattern to a persistent sidebar in macOS Ventura (2022). On mobile, the canonical pattern is a list-based drill-down hierarchy — not tabs at all. Horizontal scrollable tabs with fade indicators are the correct fallback for browsing contexts (media categories, document sections) but are inappropriate for settings, which prioritize discoverability over browsing.

---

## Key Findings

### 1. Hard Limits Across Major Design Systems

Every major design system specifies a small maximum for tabs before alternatives are required:

| System                                   | Hard Limit                                         | Source                     |
| ---------------------------------------- | -------------------------------------------------- | -------------------------- |
| Apple HIG (iOS Tab Bar)                  | 5 tabs on iPhone                                   | HIG: Tab Bars              |
| Apple HIG (Segmented Control)            | 5 segments on iPhone                               | HIG: Segmented Controls    |
| Apple HIG (macOS Toolbar-style Settings) | No longer recommended — Apple now uses sidebars    | macOS Ventura redesign     |
| Material Design 3                        | 5 tabs maximum for fixed tabs; scrollable for more | M3 Tabs spec               |
| PatternFly                               | "Keep to a minimum" — overflow menu for excess     | PatternFly Tabs guidelines |
| General UX consensus                     | 5–7 tabs before considering alternatives           | NN/g, Eleken, LogRocket    |
| Android Settings pattern                 | **Tabs explicitly prohibited** for settings        | Android Design: Settings   |

Six tabs is at or above the threshold where all systems recommend reassessing the pattern.

### 2. Apple's Approach — Settings Always Uses Sidebars or Lists

Apple's clearest signal is the **macOS Ventura redesign of System Settings** (2022): Apple replaced the old icon-grid/"tiled" System Preferences with a persistent sidebar navigation that mirrors iOS Settings. The explicit rationale was discoverability and alignment with iOS conventions. This is the reference implementation for settings navigation across Apple platforms.

**iOS Settings**: Pure list-based hierarchical navigation. The top level is a vertically scrollable list of categories. Tapping a category pushes a new screen (drill-down). This scales to dozens of categories with zero overflow problems. Critically, iOS Settings does **not** use a tab bar for its top-level navigation.

**Segmented Controls** (Apple's equivalent of a tab strip): Designed for 2–5 mutually exclusive options that are variants of the same thing — e.g., grid vs. list view, days/weeks/months in Calendar. The Apple HIG calls out "five or fewer segments" for iPhone and notes that wider segments are easier to tap. Segmented controls are **not** meant for primary navigation or settings categories — they're in-content toggles.

**macOS Toolbar-style Settings** (the NSToolbar approach used by apps like older System Preferences and Xcode): This pattern shows icon+label tabs in a toolbar at the top of a settings window. It works well for 4–6 options. Apple used it for decades, then deprecated it in favor of sidebars for complex apps. For a dialog with exactly 6 tabs all of roughly equal importance, this is the closest Apple-blessed alternative to a sidebar — but Apple has since moved away from it.

### 3. Material Design — Fixed vs. Scrollable Tabs, and the Settings Exception

Material Design distinguishes:

- **Fixed tabs**: Equal-width tabs, all visible. Use when you have "a limited number of tabs" and "consistent placement aids muscle memory." Maximum 5. If they overflow their container, tabs **clip** (truncate) — not a graceful degradation.
- **Scrollable tabs**: Variable-width, horizontally scrollable. "Best used for browsing contexts in touch interfaces when users don't need to directly compare the tab labels." The canonical example is a news app with many category tabs (Sports, Entertainment, Tech, etc.).

The key phrase is **browsing context**. Material Design's own guidance calls scrollable tabs "inappropriate when there are only a few tabs" and, implicitly, inappropriate for settings. The scrollable tab pattern assumes users will swipe to discover more content — reasonable for a news feed, but not appropriate for a settings dialog where the user needs to know all available categories upfront.

**Material Design explicitly warns against scrollable tabs on desktop**: Users do not expect horizontal scrolling on desktop screens, and fade indicators are easy to miss with mouse-only interaction.

### 4. The Overflow Menu Pattern (PatternFly, Ant Design)

When horizontal tabs overflow their container, two systems handle this with an overflow button:

**PatternFly's "More Tabs" overflow menu:**

- The last tab position becomes a "..." or "More" button.
- Clicking it reveals a dropdown with the hidden tabs.
- Selecting a hidden tab brings it into the visible strip and replaces the previously selected visible tab.
- The overflow count can be displayed: "More (3)".
- This is used in enterprise-grade software (Red Hat admin consoles, OpenShift).

**Ant Design's 3-dots overflow:**

- Triggered on hover (not click), which is a UX weakness — hover is not a reliable affordance.
- Community has requested click-trigger behavior.

**Trade-offs of the overflow menu pattern:**

- Pros: Preserves familiar horizontal tab strip; no layout change required.
- Cons: Hidden tabs are "second-class citizens" — users who don't know they exist never discover them. The "More" button is a secondary disclosure step. For settings, this is particularly bad because Appearance and Advanced should feel equally discoverable — not one hidden behind a dropdown. The pattern was designed for "browsing" tabs (where you may add/remove tabs dynamically), not for static settings categories.

### 5. The Sidebar Pattern — The Correct Answer for 6+ Settings Tabs

Every reference application that handles 6+ settings categories on desktop uses a persistent **left sidebar** (vertical list) for navigation:

- **macOS System Settings** (Apple): Left sidebar with search, sections scroll vertically.
- **VS Code Settings**: Left sidebar with categories, search, breadcrumbs.
- **Linear Settings**: Left sidebar with 4 top-level categories; sub-items under each.
- **Raycast Settings**: 5 toolbar-tabs (small enough to fit), but adds a content list inside each tab. Even at 5 tabs, they don't scroll the tab bar.
- **GitHub Settings**: Left sidebar, 15+ categories, vertically scrollable.
- **Figma Settings**: Left sidebar.
- **Discord Settings**: Left sidebar with sections and dividers.
- **Slack Settings**: Left sidebar.

The pattern is near-universal in professional desktop software. The reason: a vertical sidebar scales infinitely (just scrolls), is fully discoverable (all items visible), supports section headers and grouping, and leaves the content area undivided.

### 6. Mobile-Specific Patterns

**iOS Settings pattern** (the gold standard for mobile settings):

- Top level: vertically scrollable list of labeled rows, grouped by category with section dividers.
- Tapping a row pushes a new screen (drill-down navigation with back button).
- Zero horizontal scrolling. Zero tabs.
- Scales from 10 settings to 200+ with identical UX.

**Android Settings** (explicit guidance in Android developer documentation):

- "Create a settings section by using the list or list-detail layout."
- "Don't use tabs for settings organization" — this is a hard "don't" in the official docs.
- On larger screens: list-detail (master-detail) layout where the sidebar list remains visible alongside the detail pane.
- On small screens: full-screen list, drill-down to detail.

**Why not scrollable tabs on mobile for settings?**

- Scrollable tabs are not self-revealing. Users often do not know more tabs exist.
- Settings categories benefit from being equally discoverable. A horizontally scrolled tab bar hides items off the edge and requires swipe gesture discovery.
- The fade indicator only communicates overflow if the user looks for it — which they often don't in a settings context.
- Settings has spatial expectation: "where do I find X?" is answered by a visible list, not by horizontally scrolling a tab bar.

### 7. Scrollable Tabs with Fade Indicators — When They Work

The fade gradient/scroll indicator pattern is well-suited for:

- **Browsing contexts**: Media categories, playlist tabs, sports leagues.
- **User-generated tabs**: Browser tabs, document tabs, where count is dynamic and large.
- **Context where discovery of new tabs is expected**: A streaming app where you scroll to find more genres.

The CSS implementation uses `mask-image: linear-gradient()` or `background: linear-gradient()` to create a soft fade at the edge, combined with a scroll event listener that shows/hides the fade based on scroll position.

Libraries: `react-gradient-scroll-indicator` (npm), CSS-only with scroll shadows (CSS-Tricks technique).

**This pattern is explicitly inappropriate for settings** because:

1. Settings categories are static and finite — users need to see all of them upfront.
2. The "there's more to the right" implication of a fade works against settings discoverability.
3. On desktop, the fade is subtle and easy to miss without a touch swipe.

---

## Detailed Analysis

### The Six-Tab Problem

The specific case: six settings categories in a dialog that must work on both desktop and mobile:

- Appearance
- Preferences
- Status Bar
- Server
- Tools
- Advanced

**The core tension**: Six tabs barely fit at comfortable tap target sizes on a small mobile screen (each tab would need ~55px minimum — that's 330px total on a 375px screen with zero padding). On desktop with a wide dialog, six labeled tabs fit fine. The problem is not desktop; it's mobile.

**What breaks first**: On mobile (375px viewport), a dialog with 6 equal-width tabs would render each at ~62px wide. Labels like "Appearance" (9 chars), "Preferences" (11 chars), and "Advanced" (8 chars) all need to be either truncated, icon-only, or the tabs need to scroll. None of these are ideal for settings.

### Decision Tree: Which Pattern for Which Context

```
Settings UI — how many categories?
├── 2–3 items → Segmented control (Apple style) or small tab bar
├── 4–5 items → Horizontal tabs (still fits, use icon+label)
├── 6+ items on DESKTOP → Left sidebar (vertical list)
└── 6+ items on MOBILE → One of:
    ├── Full-screen list + drill-down (iOS/Android Settings pattern)
    ├── Left sidebar with responsive collapse to hamburger/sheet
    └── NEVER: scrollable horizontal tabs for settings
```

### Approach Comparison: 6 Settings Tabs

#### Option A: Horizontal Tabs (Status Quo)

**How it works**: Six labeled tabs across the top of the dialog.

**Desktop**: Works if the dialog is wide enough (~700px+). Labels may need to be shortened. The "Advanced" tab typically gets less visual weight than "Appearance" even though both are equal.

**Mobile**: Catastrophic. Either tabs scroll (bad for settings discoverability) or labels truncate/become icon-only without the user knowing what they represent.

**Verdict**: Acceptable only if this dialog is desktop-only and the dialog width is controlled. Breaks on mobile.

---

#### Option B: Scrollable Tabs with Fade Indicators

**How it works**: The tab bar becomes horizontally scrollable. A gradient fade at the right edge indicates more tabs are present. Scroll arrows may appear on desktop.

**Desktop**: Works visually but violates discoverability. A user who opens the dialog may not know "Advanced" exists if it's scrolled off. Users who need Advanced settings are exactly the users who matter most for a developer tool.

**Mobile**: Better than clipping, but still a settings antipattern. The hidden-tabs-off-screen issue is the same.

**Who uses this**: News app category filters (Chrome, YouTube, Google News), not settings dialogs.

**Verdict**: Wrong pattern for settings. The argument "the user can scroll to find more" fails for settings where all categories must be equally discoverable.

---

#### Option C: Overflow / "More" Menu

**How it works**: 4–5 tabs fit in the bar; an "..." or "More" button at the end reveals the rest in a dropdown.

**Pros**: Familiar from enterprise UI systems (PatternFly, GitHub tabbed views). No scrolling.

**Cons**: Hidden categories feel like footnotes. For six settings tabs where all are potentially relevant to a given user, hiding any of them behind an extra click is a product mistake. If "Tools" and "Advanced" are behind "More", power users (who are exactly DorkOS's target) feel demoted.

**Verdict**: Tolerable for dynamic tab contexts (browser, document editors), wrong for static settings categories.

---

#### Option D: Vertical Left Sidebar (Recommended for Desktop)

**How it works**: The dialog becomes a two-column layout. Left column: vertical list of category names (~180–220px). Right column: content for the selected category. Clicking a category name switches the content pane.

**Desktop**: This is the macOS System Settings model, GitHub Settings model, VS Code model, Linear Settings model. It is the dominant pattern in professional desktop software precisely because:

- All categories are visible at once.
- The list naturally accommodates 3 or 30 items with zero overflow.
- Search can be added above the list.
- Section groupings (dividers, headers) can be added without restructuring.
- The currently-selected item is clearly indicated.

**Mobile**: The dialog collapses to a full-screen list (top level: list of categories). Tapping a category pushes the content panel full-screen with a back button. This is the iOS Settings model.

**Implementation complexity**: The dialog becomes a responsive two-column component. On narrow screens (< 640px), the left column becomes the starting screen and selecting a category navigates to a full-width content screen.

**Verdict**: Correct for this use case. Scales to any number of tabs. The most discoverable. Industry standard.

---

#### Option E: Segmented Control (Apple Style) Inside a Section

**How it works**: Rather than 6 top-level tabs, group the 6 items into 2–3 logical groups, with a segmented control handling the group switch, and secondary navigation within each group.

**Example grouping for the 6 settings:**

- Group 1: "Interface" → Appearance, Preferences, Status Bar (use segmented control or sub-tabs)
- Group 2: "System" → Server, Tools, Advanced

**Pros**: Can fit on mobile. Reduces visual clutter.

**Cons**: Introduces cognitive overhead (two-level navigation). Forces the user to mentally categorize the settings before finding what they want. "Is Status Bar under Interface or somewhere else?" This is the problem that made Apple move away from the old System Preferences icon grid.

**Verdict**: A reasonable middle ground if a sidebar isn't feasible. Requires careful grouping. Risk of creating non-obvious categories.

---

#### Option F: Full-Screen List Navigation (Mobile-First)

**How it works**: The settings "dialog" opens to a categorized list. Tapping a category opens a full-screen settings pane. No dialog chrome — just a sheet or route change.

**Pros**: Mirrors the iOS Settings experience exactly. Infinitely scalable.

**Cons**: Loses the "dialog" mental model. On desktop, users expect settings dialogs, not a settings "app." Requires navigation stack management.

**Verdict**: Correct on mobile; uncomfortable as the only pattern on desktop. Best used as the mobile breakpoint behavior when the sidebar collapses.

---

### The Responsive Strategy (Combining D + F)

The cleanest approach handles both contexts:

```
Desktop (>= 640px dialog width):
  ┌──────────────────────────────────────────┐
  │ [Appearance]     │ Appearance settings    │
  │ [Preferences]    │ ...                    │
  │ [Status Bar]     │ ...                    │
  │ [Server]         │                        │
  │ [Tools]          │                        │
  │ [Advanced]       │                        │
  └──────────────────────────────────────────┘
  Left: 180px vertical list
  Right: content pane

Mobile (< 640px):
  Screen 1: Full-width list of category rows
  → Tap "Server" →
  Screen 2: Full-width Server settings
  ← Back button returns to category list
```

This is precisely how macOS System Settings (sidebar on Mac, list on iPhone) and Android's adaptive list-detail layout work.

### Specific Analysis for DorkOS Settings

The six categories for DorkOS settings:

| Category    | Who primarily needs it | Frequency of change |
| ----------- | ---------------------- | ------------------- |
| Appearance  | All users              | Rare                |
| Preferences | All users              | Rare                |
| Status Bar  | Most users             | Rare                |
| Server      | Power users / Kai      | Occasional          |
| Tools       | Power users            | Rare                |
| Advanced    | Expert users / Priya   | Rare                |

This distribution confirms the sidebar is correct: all categories have similar access frequency, so hiding any of them creates a discoverability problem. The sidebar gives all six equal visual weight with equal discoverability.

The "control panel, not consumer app" brand direction also aligns with the sidebar model. Linear, VS Code, GitHub, Raycast — Kai's daily tools — all use sidebar-based settings navigation. A scrollable tab bar or overflow "More" menu would feel cheap and consumer-facing by comparison.

---

## Concrete Implementation Notes

### Sidebar Dialog in shadcn/ui

A responsive settings dialog can be built with shadcn `Dialog` + a two-column layout inside:

```tsx
// Desktop: two-column layout
// Mobile: responsive navigation stack

<DialogContent className="max-w-3xl p-0">
  <div className="flex h-[600px]">
    {/* Left nav */}
    <nav className="flex w-44 flex-col gap-1 border-r p-3">
      {SETTINGS_TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={cn(
            'w-full rounded-md px-3 py-2 text-left text-sm',
            activeTab === tab.id
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
          )}
        >
          {tab.label}
        </button>
      ))}
    </nav>
    {/* Right content */}
    <div className="flex-1 overflow-y-auto p-6">{renderActiveTab()}</div>
  </div>
</DialogContent>
```

On mobile, the dialog becomes a Sheet (bottom drawer or full-screen), the left nav becomes a full-screen list, and selecting a tab pushes the content via a local navigation stack (a simple `step` state variable: `'list' | 'tab-id'`).

### Apple-Style Segmented Control (for 4 or fewer categories)

If the six settings were consolidated to four:

```tsx
// Only appropriate for ≤5 items, no overflow
<SegmentedControl
  items={['Interface', 'Server', 'Tools', 'Advanced']}
  value={activeSegment}
  onValueChange={setActiveSegment}
/>
```

The segmented control pill group is the "Apple style" option — all items equal-width, connected borders, works at 2–5 items. It is not designed for 6.

### Fade Indicator Implementation (for browsing contexts, not settings)

For reference, the correct implementation for contexts where scrollable tabs with fades are appropriate:

```css
/* Mask-based scroll shadow */
.tab-container {
  overflow-x: auto;
  mask-image: linear-gradient(to right, black calc(100% - 60px), transparent 100%);
}

/* Dynamic: show/hide fade based on scroll position via JS */
.tab-container.can-scroll-right::after {
  content: '';
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 60px;
  background: linear-gradient(to right, transparent, var(--background));
  pointer-events: none;
}
```

The fade is updated on `scroll` event: show when `scrollLeft + clientWidth < scrollWidth`.

---

## Trade-Off Summary

| Pattern                      | Discoverability   | Mobile                   | Desktop    | Appropriate for Settings? |
| ---------------------------- | ----------------- | ------------------------ | ---------- | ------------------------- |
| Horizontal tabs (6)          | Low (overflow)    | Poor                     | Acceptable | Marginal                  |
| Scrollable tabs + fade       | Very low          | Poor                     | Poor       | No                        |
| Overflow "More" menu         | Low (hidden tabs) | Acceptable               | Acceptable | No                        |
| Left sidebar                 | High              | N/A (use list-drilldown) | Excellent  | Yes                       |
| Full-screen list + drilldown | High              | Excellent                | Poor       | Mobile only               |
| Responsive sidebar + list    | High              | Excellent                | Excellent  | Yes (recommended)         |
| Segmented control            | High              | Good (≤5)                | Good (≤5)  | Only if ≤5 categories     |

---

## Research Gaps and Limitations

- Direct inspection of Raycast's settings dialog UI was limited to documentation text, not screenshots. Raycast uses 5 tabs, which fits without overflow.
- Apple HIG documentation requires JavaScript to render — full text of current HIG guidelines for settings windows was not directly accessible. Guidance inferred from secondary sources and the macOS Ventura design change.
- No user research data on whether DorkOS's specific target users (Kai, Priya) have preferences between sidebar and tab navigation in settings dialogs specifically.

---

## Contradictions and Disputes

- **"Sidebar is too heavy for a dialog"**: Some argue a sidebar is overkill for a settings dialog (vs. a full-page settings screen), and that toolbar-style icon+label tabs (as in older macOS preferences panes) are more appropriate for dialogs. This is valid for 4–5 tabs. At 6 tabs, toolbar tabs start to feel crowded, and the sidebar distinction becomes more justified.
- **"Scrollable tabs are fine on desktop with scroll arrows"**: Material Design's scrollable tabs include scroll arrows on desktop (not just touch swipe). These are more discoverable than a fade alone. However, the fundamental problem remains: settings categories should not be hidden. Scroll arrows are a navigation affordance, not a disclosure affordance.
- **"Segmented control consolidation simplifies the UX"**: Consolidating 6 tabs into 3–4 groups (each with a segmented control) is a real option. But it introduces a two-level navigation hierarchy and forces the user to learn which group each setting lives in. This was exactly the complaint about the old macOS System Preferences icon grid — users couldn't find things because the organization was non-obvious.

---

## Sources and Evidence

- [Apple HIG: Segmented Controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls) — "five or fewer segments on iPhone"
- [Apple HIG: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars) — sidebar as primary navigation surface for settings
- [Apple HIG: Tab Bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) — 5 tab maximum on iPhone
- [macOS Ventura System Settings redesign — 9to5Mac](https://9to5mac.com/2022/06/06/macos-13-ventura-system-settings-first-look/) — Apple's move from icon grid to sidebar
- [macOS Settings Window Guidelines — Zenn](https://zenn.dev/usagimaru/articles/b2a328775124ef?locale=en) — NSToolbar-based settings window conventions
- [Material Design 1: Tabs — m1.material.io](https://m1.material.io/components/tabs.html) — fixed vs scrollable tab guidance
- [Android Settings Design Guidelines — developer.android.com](https://developer.android.com/design/ui/mobile/guides/patterns/settings) — "Don't use tabs for settings organization"
- [PatternFly Tabs Design Guidelines](https://www.patternfly.org/components/tabs/design-guidelines/) — horizontal overflow menu pattern ("More tabs" button)
- [PatternFly Overflow Menu](https://www.patternfly.org/components/overflow-menu/design-guidelines/) — enterprise overflow pattern with count indicator
- [Ant Design Tabs — ant.design](https://ant.design/components/tabs/) — 3-dot overflow trigger behavior
- [Tabs UX Best Practices — Eleken](https://www.eleken.co/blog-posts/tabs-ux) — maximum tab counts, overflow patterns, sidebar alternatives
- [Tabbed Navigation UX — LogRocket](https://blog.logrocket.com/ux-design/tabs-ux-best-practices/) — 5–7 tab limit, sidebar for 6+ categories
- [Modern iOS Navigation Patterns — Frank Rausch](https://frankrausch.com/ios-navigation/) — drill-down hierarchy, iOS Settings as canonical example
- [Basic Patterns for Mobile Navigation — NN/g](https://www.nngroup.com/articles/mobile-navigation-patterns/) — hierarchical vs. hub-and-spoke patterns
- [Settings UI Design Best Practices — Setproduct](https://www.setproduct.com/blog/settings-ui-design) — tabs (4–8) vs sidebar (larger) decision framework
- [Linear Changelog: New Settings Pages](https://linear.app/changelog/2024-12-18-personalized-sidebar) — sidebar-based settings with Account / Features / Administration / Teams
- [Raycast Manual: Preferences](https://manual.raycast.com/preferences) — 5-tab toolbar, content list within tabs
- [Scroll Shadows — CSS-Tricks](https://css-tricks.com/books/greatest-css-tricks/scroll-shadows/) — CSS mask technique for overflow fade indicators
- [react-gradient-scroll-indicator — GitHub](https://github.com/jbccollins/react-gradient-scroll-indicator) — React implementation of overflow fade
- [Tabs, Used Right — NN/g](https://www.nngroup.com/articles/tabs-used-right/) — authoritative guidance on appropriate tab usage
- [iOS vs Android App UI Design — LearnUI](https://www.learnui.design/blog/ios-vs-android-app-ui-design-complete-guide.html) — bottom navigation vs drawer patterns

---

## Search Methodology

- Searches performed: 14
- Most productive queries: "Apple HIG settings navigation sidebar vs tabs macOS System Settings 2025", "Material Design scrollable tabs vs fixed tabs overflow", "PatternFly Ant Design overflow menu more tabs tab bar desktop", "Android settings design guidelines list-based", "settings dialog tab overflow patterns UX desktop mobile"
- Primary sources: Apple developer documentation (via secondary sources), Material Design spec, Android developer docs, PatternFly design guidelines, Eleken UX blog, LogRocket UX blog, NN/g
