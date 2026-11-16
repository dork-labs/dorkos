---
slug: feature-promo-system
number: 178
created: 2026-03-24
status: ideation
---

# Feature Promo System

**Slug:** feature-promo-system
**Author:** Claude Code
**Date:** 2026-03-24

---

## 1) Intent & Assumptions

- **Task brief:** Build a declarative framework for contextually surfacing feature promos to users based on their current state. The system should make users aware of features they haven't discovered, explain the value those features provide, and offer a direct path to action. Adding a new promo should be as simple as writing a config object — no bespoke UI wiring per promo.

- **Assumptions:**
  - The condition system can evaluate all necessary state client-side (adapter status, session count, agent count, tool enablement, etc.) via existing hooks and stores
  - localStorage persistence (via Zustand persist) is sufficient for dismissal tracking — no server-side state needed
  - The existing `ResponsiveDialog` component in `shared/ui` handles Dialog ↔ Drawer switching for promo dialogs
  - The SessionSidebar's tab system can accommodate a fourth tab (Overview) without UX issues
  - The dev playground's existing registry pattern (PlaygroundSection + sections arrays) extends to a promo showcase
  - DorkOS's primary persona (Kai) actively dismisses "chatbot wrapper" UX — promos must feel like a control panel, not marketing

- **Out of scope:**
  - Server-side promo targeting or A/B testing
  - Analytics/tracking on promo engagement (follow-up)
  - Onboarding flow changes — the existing onboarding modal is separate
  - Changelog or "What's New" system (complementary but distinct)
  - Hotspot beacons or tooltip-based announcements (future enhancement)
  - Embedded mode (Obsidian plugin) promo support

## 2) Pre-reading Log

- `apps/client/src/layers/widgets/dashboard/ui/DashboardPage.tsx`: Scrollable section-based layout. Four sections in priority order: NeedsAttentionSection (conditional, zero DOM when empty via AnimatePresence), ActiveSessionsSection, SystemStatusRow, RecentActivityFeed. Max-w-4xl constraint, space-y-6 gaps. PromoSlot inserts after NeedsAttentionSection.
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Three-tab sidebar (Sessions, Schedules, Connections). Tab state in Zustand. Keyboard shortcuts Cmd+1/2/3. Dynamic tab visibility based on feature flags. New Overview tab becomes tab 1, shifting existing tabs.
- `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx`: Three nav buttons (Dashboard, Sessions, Agents) + "Recent Agents" section. Compact layout with text-xs typography. PromoSlot goes below Recent Agents.
- `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx`: DorkLogo + settings/theme/devtools buttons. Compact px-2 py-1.5 styling.
- `apps/client/src/layers/features/onboarding/ui/WelcomeStep.tsx`: Existing FTUE modal pattern. Uses HoverBorderGradient for branded CTAs, staggered motion animations, useReducedMotion. Separate from promo system.
- `apps/client/src/layers/shared/ui/responsive-dialog.tsx`: ResponsiveDialog switches Dialog ↔ Drawer via useIsMobile(). Fullscreen toggle on desktop. Components: ResponsiveDialogContent, Header, Title, Description, Footer, Close, Body, FullscreenToggle. Directly usable for promo dialogs.
- `apps/client/src/layers/shared/ui/responsive-popover.tsx`: ResponsivePopover switches Popover ↔ Drawer. Context provides isDesktop.
- `apps/client/src/dev/playground-registry.ts`: Central registry composing PlaygroundSection arrays per page. PLAYGROUND_REGISTRY exported for search/navigation.
- `apps/client/src/dev/showcases/ButtonShowcases.tsx`: Pattern for showcase files — export function returning PlaygroundSection fragments with ShowcaseLabel + ShowcaseDemo helpers.
- `apps/client/src/dev/sections/components-sections.ts`: Pattern for section registration — array of { id, title, page, category, keywords }.
- `contributing/design-system.md`: Calm Tech design language. Card radius: rounded-xl (16px). Card padding: p-6. Shadows: shadow-soft, shadow-elevated. Section headers: text-xs font-medium tracking-widest uppercase text-muted-foreground. Animation: 100-300ms, motion/react library, stagger pattern with 40ms intervals.
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`: ResponsiveDialog + NavigationLayout for tabbed settings. SettingRow component with label + description + control. Pattern for the "Feature suggestions" toggle.
- `research/20260324_feature_discovery_ux_patterns.md`: 28-search research across 10 platforms (Linear, Slack, Notion, Raycast, Arc, GitHub, Vercel, Stripe, Figma, 1Password). Key findings: passive + contextual nudge wins for developer audiences; contextual triggers see 60% higher adoption; non-dismissible promos erode trust; empty states are highest-trust education moments; Vercel's 4-tier empty state taxonomy most applicable.

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/widgets/dashboard/ui/DashboardPage.tsx` — integration point for dashboard-main PromoSlot
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — integration point for agent-sidebar PromoSlot + new Overview tab
- `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx` — integration point for dashboard-sidebar PromoSlot
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` — integration point for global toggle
- `apps/client/src/layers/shared/ui/responsive-dialog.tsx` — reused for PromoDialog shell
- `apps/client/src/layers/shared/model/app-store.ts` — Zustand store to extend with promo state

**Shared Dependencies:**

- `@/layers/shared/ui` — Card, Button, Switch, ResponsiveDialog, cn()
- `@/layers/shared/model` — useAppStore (Zustand), useIsMobile, useSettings
- `@/layers/shared/lib` — cn utility
- `motion/react` — AnimatePresence, motion for section enter/exit
- `lucide-react` — icon types for PromoContent.icon

**Data Flow:**
PromoContext (assembled from entity/shared hooks) → shouldShow evaluation → filtered/sorted array → PromoSlot → PromoCard → user click → PromoDialog (ResponsiveDialog shell + dialog component)

**Feature Flags/Config:**

- `promoEnabled` (Zustand persist, default: true) — global toggle
- `dismissedPromoIds` (Zustand persist, default: []) — per-promo dismissal

**Potential Blast Radius:**

- New feature module: `layers/features/feature-promos/` (all new files)
- Modified: DashboardPage.tsx (1 line — add PromoSlot)
- Modified: SessionSidebar.tsx (add Overview tab, shift existing tab indices)
- Modified: DashboardSidebar.tsx (add PromoSlot below Recent Agents)
- Modified: SettingsDialog.tsx (add SettingRow for toggle)
- Modified: app-store.ts (add promo state slice)
- New dev playground: showcases/PromoShowcases.tsx + sections entry
- Tests: new tests for all promo module files + updated tests for SessionSidebar tab changes

## 5) Research

Full research documented in `research/20260324_feature_discovery_ux_patterns.md` (28 searches, 45 sources, 10 platforms analyzed).

**Key findings that shaped the design:**

1. **Passive + contextual nudge is the winning pattern** for developer audiences (Raycast, Vercel, GitHub, Linear). DorkOS personas (Kai, Priya) would dismiss intrusive promos instantly.
2. **Vercel's 4-tier empty state taxonomy** (Blank Slate, Informational, Educational, Guide) is the closest precedent. Our PromoSlot is analogous to Vercel's Educational empty state tier.
3. **Contextual triggers see 60% higher adoption** vs. generic announcements (industry data). Our `shouldShow` condition system enables this.
4. **Permanent dismissal is expected** for developer audiences. Non-dismissible promos (1Password passkey banner) generate support tickets and erode trust.
5. **Stripe's design system explicitly bans promotional content** in alert-style components — never conflate feature education with system alerts. Our NeedsAttentionSection is strictly separated from PromoSlot.
6. **Linear achieves 60% monthly changelog engagement** by treating it as a content product. Benefit-first language ("loads 2x faster") outperforms feature-first ("performance improvements"). Our PromoContent uses benefit-first copy.

**Recommendation:** Declarative registry with slot-driven rendering, permanent dismissal, and a global off switch. Matches the patterns used by the platforms most similar to DorkOS (Vercel, Raycast, Linear, Stripe).

## 6) Decisions

| #   | Decision              | Choice                                                               | Rationale                                                                                                                                                                                                                |
| --- | --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Architecture approach | Declarative registry in single feature module                        | Simplest to add promos, all discoverable in one file, clean FSD compliance. Preferred over hook-based composition (scattered definitions) and entity-level system (over-engineered for UI concern).                      |
| 2   | Condition system      | `shouldShow` function with curated `PromoContext`                    | Infinite flexibility via plain functions, but context object keeps them pure and testable. Shared helpers (hasAdapter, isPulseEnabled) cover common cases.                                                               |
| 3   | Visual format         | Slot-driven (container dictates presentation)                        | Each slot owns its visual language. Promo definitions provide content fields, slot renderers pick subsets. Prevents visual inconsistency when different authors create promos. Matches Vercel/Stripe patterns.           |
| 4   | Dismissal behavior    | Permanent by default                                                 | Research shows developer audiences expect permanent dismiss. Non-dismissible promos erode trust (1Password case study). shouldShow naturally handles state-change re-qualification but dismissal state takes precedence. |
| 5   | Dashboard placement   | After NeedsAttentionSection, before ActiveSessions                   | Highest-engagement non-urgent real estate. Naturally deprioritized for power users with many active sessions. Zero DOM when no promos qualify.                                                                           |
| 6   | Agent sidebar         | New "Overview" tab as tab 1 (default)                                | Context hub: agent summary + promos + quick actions. Existing tabs shift to positions 2-4.                                                                                                                               |
| 7   | Dialog content        | Component reference in promo definition                              | Each promo with `type: 'dialog'` specifies a React component rendered inside ResponsiveDialog shell. Full creative freedom inside. Organized in `ui/dialogs/` directory.                                                 |
| 8   | Global off switch     | Settings toggle "Feature suggestions"                                | Single toggle disables all promo slots. Stored in Zustand persist. Respects user autonomy.                                                                                                                               |
| 9   | Priority + density    | Per-slot maxUnits cap, promos sorted by priority (0-100)             | Fill slots with highest-priority qualifying promos. Simple, predictable, no algorithmic complexity.                                                                                                                      |
| 10  | Dev playground        | Registry table + slot previews + override controls + dialog previews | Full visibility into promo system state for development and debugging. Follows existing showcase pattern.                                                                                                                |
