# Design Decisions — composer parity

Visual companion session: `.dork/visual-companion/81863-1786054606/` (2026-08-06, with Dorian)

## 1. Which capabilities does the room composer expose?

**Screen:** `composer-parity-capabilities.html`
**Options:** A) lean room composer (attach + mentions only) · B) full parity minus session machinery · C) same shell, lean now, flip per-surface later
**Chosen:** **B** — "as close to full parity as makes sense."

The capability matrix:

| Capability                     | Chat                                               | Room                 | Dashboard    |
| ------------------------------ | -------------------------------------------------- | -------------------- | ------------ |
| Attach (chip bar, drag, paste) | yes                                                | **yes (new)**        | follows chat |
| Slash commands                 | yes                                                | **yes (new)**        | follows chat |
| `@` mentions                   | no (single-agent session — nobody to disambiguate) | yes                  | no           |
| Queue-while-busy               | yes                                                | no (session concept) | yes          |
| Prompt suggestions             | yes                                                | no (session concept) | yes          |
| Interactive input panel        | yes                                                | no (session concept) | yes          |

Mentions can flip on for chat later inside the same capability model if multi-agent sessions arrive.

## 2. Architecture (stated by Dorian in the terminal, beyond the screen options)

Chat and rooms must **literally use the same components** — the **Compound Components pattern** (a `Composer.Root` / `Composer.Input` / `Composer.Attach`-style family), with props handling the per-surface differences. This also settles the chrome question: identical by construction, not by convention.

## Final Design Summary

One compound composer component family in a layer both `features/chat` and `widgets/room-view` can import. Each surface composes the same parts and declares its capability set; there is no fork of the input core, chip bar, or send affordance. The room composer gains attach and slash commands with chat's exact chrome; queue/suggestions/interactive-panel remain chat/dashboard-only because they are session concepts. SPECIFY should define the compound API, where the family lives under FSD, and the migration order for the three existing surfaces.
