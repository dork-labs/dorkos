# Page width consistency — ideation

**Work item:** DOR-1047 · **Date:** 2026-08-09 · **Source:** live-browser audit (1720px viewport) + full code trace + external best-practice research, all in one session.

## The problem, measured

The main content area renders at wildly different widths depending on the route. Measured against a 1392px content pane:

| Route                         | Width today   | Mechanism                                                                  |
| ----------------------------- | ------------- | -------------------------------------------------------------------------- |
| `/` home room                 | full (1392)   | full-bleed list, text capped by `--msg-content-max-width: 100ch`           |
| `/channels`                   | full (1392)   | same — the best pattern in the app                                         |
| `/session` agent chat         | 1280 centered | `max-w-7xl` in `ChatPanel.tsx:333`                                         |
| `/team` cards                 | full          | `p-4 md:p-6`                                                               |
| `/tasks`                      | full          | `p-4`                                                                      |
| `/activity`                   | 896 centered  | hand-rolled `max-w-4xl`, **zero horizontal padding**                       |
| `/workspaces`                 | 896 centered  | `container-default` + redundant `mx-auto px-4`                             |
| `/connections`                | 896 centered  | `container-default` + redundant `mx-auto px-4`, **no scroll container**    |
| `/feedback-requests`          | 896 centered  | `container-default` + redundant `mx-auto px-4`                             |
| `/marketplace` browse         | 1280 centered | `max-w-7xl`                                                                |
| `/marketplace?view=installed` | **707**       | same wrapper **shrink-wraps**: `mx-auto` without `w-full` in a flex column |
| `/marketplace/sources`        | **517**       | `max-w-2xl` + same shrink-wrap bug, **no scroll container**                |

Root causes:

1. **The shell gives pages nothing.** `AppShell.tsx` hands each route a full-width `overflow:hidden` panel with no padding or width policy, so all 12 routes invented their own wrapper. Five distinct max-widths and 7+ horizontal padding values resulted.
2. **`mx-auto` without `w-full` in a flex column shrink-wraps.** CSS flexbox: auto cross-axis margins defeat `align-items: stretch`, so the box sizes to content. Marketplace installed (707px vs 1280 cap) and sources (517px vs 672 cap) are live victims — this is the "headers shift" bug.
3. **Agent chat and room chat diverged.** Both share the message-row grid (`messageItem` + `--msg-*` tokens), but `ChatPanel` adds a second competing clamp (`max-w-7xl`) and a `px-3` scroller pad that rooms don't have. Rooms (full list, capped text) are the pattern the operator prefers — and the Slack-like industry standard.
4. **Home chrome misaligns.** Four `widgets/home` pieces center at `max-w-4xl` above a full-bleed feed; edges don't line up.
5. **Missing scrollers.** `/connections` and `/marketplace/sources` have no scroll container inside the `overflow:hidden` panel; Connections even calls `scrollIntoView` into the non-scrollable box.

## What the industry does (research summary)

- **GitHub Primer**: pages cap at 1280px (1232 visual) for readability; caps hold on large monitors — extra space becomes gutters. Diff/code views deliberately break the cap.
- **Atlassian**: two tokens by content type — fixed-wide 1296px (dashboards/directories), fixed-narrow 864px (long-form) — plus a fluid mode for tables/boards.
- **Material 3**: extra width on big screens becomes more panes, never wider text.
- **Messengers (Slack-family) and AI chat (ChatGPT/Claude)**: message list is pane-width; readability comes from the pane and/or a text cap, never from centering the list in a column.
- **Mechanism consensus for Tailwind 4 apps**: width as `@theme` CSS variables consumed by one container component with named variants; container queries for component internals. Change the token once, every page follows.

## Direction chosen

One `PageContainer` primitive with three named widths, backed by two `@theme` tokens:

- **`full`** — no cap, shared gutter scale: chat-free data surfaces (`/team`, `/tasks`). Chat surfaces stay full-bleed panes and do not use PageContainer (their width system is the `--msg-*` token family, which already works).
- **`wide`** — `--page-width-wide: 80rem` (1280px): `/marketplace` (both views).
- **`reading`** — `--page-width-reading: 56rem` (896px): `/activity`, `/workspaces`, `/connections`, `/feedback-requests`, `/marketplace/sources`.

Decisions locked during ideation (operator delegated remaining decisions 2026-08-09):

- **Sources page = `reading`** (896px). It's a settings-style form; 1280 feels empty. Accepted tradeoff: browse→sources header x-position changes; they are distinct pages.
- **Agent chat drops its `max-w-7xl`** to match rooms exactly. `--msg-content-max-width: 100ch` remains the single text-readability knob.
- **Home chrome goes full-width**, left-aligned with the feed rows via `px-[var(--msg-padding-x)]` (banner pattern, like Slack pins).
- **`container-default` is retired** (superseded; repo rule: remove superseded patterns).
- **PageContainer owns the scroll container by default** (native `overflow-y-auto`; global thin-scrollbar styling applies), opt-out for pages with internal scrollers. This makes "page forgot its scroller" structurally impossible.

## Non-goals

- No change to `--msg-content-max-width` (100ch) or the message grid.
- No multi-pane/ultrawide pane-splitting work (future; tokens make it easy later).
- No mobile redesign — gutters collapse naturally; behavior below `sm` is unchanged in spirit.
- No Obsidian-embedded-mode layout work.
