# Design review checklist

What **passes** a design review or a UI audit. The UI audit charter, [`audits/ui.md`](../audits/ui.md), lists _what to look at_ through its twelve lenses; this file lists the bar each one is held to, numbered, so a finding can cite the rule it breaks ("breaks 3.1"). The `auditing-ui` skill's browser leg measures the rendered page against the floors here: `.agents/skills/auditing-ui/assets/measure/floors.json` holds the numbers, and the section numbers in that file point back to this one.

Use it for both modes:

- **PR review.** Capture the change (§0), measure it, and sign off in the PR thread in the format at the end.
- **Audit.** The charter's lenses decide what gets looked at. This file decides whether it passes, and its severity maps onto the charter's rubric.

| Here        | Charter | Meaning                                                                     |
| ----------- | ------- | --------------------------------------------------------------------------- |
| **Blocker** | P1      | Broken, confusing, inaccessible, or under a measured floor. It can't merge. |
| **Should**  | P2      | Breaks a rule here. Fix it in this PR, or file it.                          |
| **Polish**  | P3      | Note it and file it. Polish is never dropped.                               |

Every finding names the issue, the rule it breaks (a section number here) and the concrete fix.

Related: [`design-system.md`](design-system.md) (tokens, the mobile scale, the responsive wrappers), [`animations.md`](animations.md) (motion), and `packages/ui/src/touch-target.ts` (the 44px target, spelled once).

---

## 0. Capture before you judge

Never review from source alone. Review the rendered page, measured. `/ui-audit:measure` (the script `.agents/skills/auditing-ui/assets/measure/measure.mjs`) does all of this in one run.

| Viewport    | Size           | Why                                                   |
| ----------- | -------------- | ----------------------------------------------------- |
| Phone       | **390 × 844**  | The common phone, and a first-class surface           |
| Small phone | **375 × 667**  | The short case: keyboard up, sheets, a cramped header |
| Tablet      | **768 × 1024** | The `md:` breakpoint, where touch sizes switch        |
| Desktop     | **1440 × 900** | The default                                           |

- **0.1** Capture **both themes** at every viewport.
- **0.2** Capture **every state the change touches:** default, hover, focus-visible, active, disabled, loading, empty, error and offline. Use real content: long names, and 0, 1 and many items.
- **0.3** Capture the **preference modes** for anything with state, selection or motion: Increase Contrast (`prefers-contrast: more`), forced colours, and reduced motion.
- **0.4** For anything that moves, take a recording, plus a capture with reduced motion on.
- **0.5** **Measure, don't eyeball.** Font size, line height, tracking, icon box, hit box and contrast all come from the rendered page. A flag from the script is a candidate, not a finding: open the screenshot before filing it.

## 1. Hierarchy & layout

- **1.1** Squint at it: the hierarchy reads, and there's one primary action per view.
- **1.2** Spacing sits on the scale. Optical alignment overrides the math where the math looks wrong.
- **1.3** Separation comes from whitespace first, then a tint, then elevation. **No hairline dividers** and no decorative borders.
- **1.4** Nothing overflows its container. Long strings truncate or wrap on purpose. _Measured:_ text that escapes the viewport is a Blocker (charter lens 8 makes overflow P1 automatically).
- **1.5** Chrome stays out of the way until hover or focus. Anything revealed on hover is also revealed on focus.

## 2. Type

- **2.1** Use scale tokens only. A raw `text-[13px]` ignores both the phone scale and the person's font setting.
- **2.2** **Floors (measured):**
  - Desktop: **12px** for anything a person reads. `text-2xs` (11px) is for incidental metadata only, and 10px is the absolute floor (counts).
  - Phone: **13px** to read and **12px** absolute. Body text is 17px.
- **2.3** **Line height and tracking (measured).** Use §11.1's values.
  - Multi-line text has a line height of at least **1.3**, and reading text 1.5 or more.
  - Single-line labels sit at 1.15 or more, so nothing clips.
  - No negative tracking under 14px.
- **2.4** **Text fields are 16px on the phone (measured).** Anything smaller makes iOS zoom the page on focus. That includes `password`, `url`, `number` and `contenteditable`, which the global rule in `index.css` misses.
- **2.5** No walls of text. Prose blocks become a headline and bullets, or a link to more.

## 3. Icons

- **3.1** **Icons step up on the phone and never shrink below their desktop size.** Use §11.2's role sizes. _Measured floors:_
  - control and chrome icons: 16px desktop, **20px phone**;
  - inline icons: 12px desktop, 14px phone.

  A control icon under 20px on the phone is a **Blocker**. That's the "tiny icons in the mobile header" problem.

- **3.2** Size icons with a token (`size-(--size-icon-*)`), never a raw `size-3` or `h-4 w-4`. Raw sizes don't grow on the phone, and there are about 660 of them today.
- **3.3** The icon grows _with_ its target (`TOUCH_TARGET_RESPONSIVE_SIZE`, 44px on the phone). The glyph sits centred in the box; don't shrink the box to fit the glyph.
- **3.4** Stroke and weight match the neighbouring icons. Icon-only buttons have an `aria-label`.

## 4. Colour & contrast

- **4.1** Use semantic tokens only: no hex, no palette classes (`bg-blue-500`), and no pure `#fff` or `#000`.
- **4.2** **Spend orange on purpose:** focus, the one primary action, and "you". Never decoration.
- **4.3** **Status colour goes on the icon or the word, never the whole container.** Failed is the only resting state that gets colour.
- **4.4** **Contrast (measured):**
  - text **4.5:1**, and large text (24px, or 18.66px bold) 3:1;
  - controls, meaningful icons and focus rings **3:1**.

  Check both themes. A timestamp at 2.9:1 is a Blocker even though it's "just metadata".

- **4.5** In dark mode, height is light: raised surfaces are lighter, never darker, than what they sit on.

## 5. States

- **5.1** Hover, focus-visible, active, disabled, loading (a skeleton for anything over 300ms), empty, error and offline are each designed, and none is left at the default.
- **5.2** **Empty states** say what this is and give one action. No illustration needed.
- **5.3** **Errors use `ProblemNotice`:** what happened, then whose it is, then one action. No "Something went wrong" and no raw codes; details sit behind "Details".
- **5.4** Active, selected and hover can always be told apart, including while the pointer is over the strip.

## 6. Motion

- **6.1** Every animation answers one question: where did this come from, where did it go, what changed, or did my input register?
- **6.2** Timing: 100ms instant, 150ms hover, 200ms enter and exit, 300ms expand. Anything longer needs a reason.
- **6.3** Entrances ease out; exits ease in and are shorter. Interactive motion uses the springs (snap 400/40, glide 280/32, fold 400/36) with no overshoot.
- **6.4** Animate only `transform` and `opacity`. Motion can be interrupted.
- **6.5** **Reduced motion** is an instant change or a short crossfade: `animation: none`, never `animation-name` on `*`.
- **6.6** Nothing animates history loads, text being read, or anything that delays input.

## 7. Keyboard & accessibility

- **7.1** **Focus (measured):** the tab order is logical, Esc closes, and nothing traps focus. Every stop paints **the system ring** (the `focus-ring` utility: a 2px gap and a 2px ring). The browser's default ring counts as a miss, and so does a focused control hidden under a sticky header or sheet (WCAG 2.4.11).
- **7.2** **Hit targets (measured):** **24px desktop, 44px phone** (`TOUCH_TARGET_*`). A grown `::after` hit area counts. Inline text links are exempt.
- **7.3** **Space between targets on the phone (measured):** small neighbours sit **8px apart** or more, and hit boxes never overlap.
- **7.4** Roles and names are right: `tab` with `aria-selected`, toggles with `aria-pressed`, status rows with `role="status"`.
- **7.5** Colour is never the only signal.
- **7.6** Text spacing survives WCAG 1.4.12: line height 1.5, letter spacing 0.12em and word spacing 0.16em, with no clipping.

## 8. Phone (every review and every audit)

- **8.1** Capture at 390 × 844 and 375 × 667, in both themes.
- **8.2** Layouts **adapt**; they don't just shrink: stacked, one column, key actions within thumb reach. Name the strategy (charter lens 8: icon-only, fold into a menu, hide, or swap the variant).
- **8.3** §11's phone values are applied. Nothing is smaller than its desktop size.
- **8.4** No sideways page scroll at 320px or wider (WCAG 1.4.10), unless it's a deliberate carousel or a tab strip with its scrollbar hidden. _Measured._
- **8.5** **Safe areas:** nothing sits under the notch or the home indicator, fixed bars pad with `env(safe-area-inset-*)`, and the composer clears the keyboard.
- **8.6** The edges need the most room. Header and bottom-bar targets are never the smallest on the screen; touch accuracy is worst at the top and bottom edges (Hoober).

## 9. Copy

- **9.1** Short, plain and specific: the label says what happens. At most 15 words per block, and no "we" in app copy.
- **9.2** People are called by name, with "You" only in your own view. No blame words.
- **9.3** The banned-words check (`scripts/check-banned-words.sh`) and the `writing-app-copy` rules pass.

## 10. System fit

- **10.1** Use existing tokens and components (`shared/ui`), so nothing new is a one-off.
- **10.2** Add anything new to `design-system.md`, on purpose.
- **10.3** Shared components appear in the dev playground with their states.

---

## 11. Phone tokens (proposed)

**The rule:** phone values only ever go up from desktop, whether size, line height in px, spacing or target. Phone means a viewport under 768px (`md`), the same gate `--_st` and `TOUCH_TARGET_*` already use.

**The mechanism today:** `--mobile-scale: 1.25` multiplies every text token, icon token and button height (`apps/client/src/index.css`). That's sound, but it gives fractional sizes (16.25, 17.5), and it doesn't reach two pinned line heights or the roughly 660 raw icon sizes. These tokens replace the single multiplier with an explicit phone value per token, snapped to the iOS default ramp. A follow-up PR makes them real, with a lint that fails below the floors; until it lands, the **floors** in `floors.json` are what review enforces and these tables are the target.

### 11.1 Type: size / line height / tracking

| Token               | Desktop            | Phone                    | Today's phone (×1.25) | Note                                  |
| ------------------- | ------------------ | ------------------------ | --------------------- | ------------------------------------- |
| `text-3xs`          | 10 / 14 · +0.01em  | **12 / 16** · 0          | 12.5 / 14 (1.12) ✗    | Counts and initials only              |
| `text-2xs`          | 11 / 16 · +0.005em | **13 / 18** · 0          | 13.75 / 16 (1.16) ✗   | iOS Footnote                          |
| `text-xs`           | 12 / 16 · 0        | **15 / 20** · 0          | 15 / 20 ✓             | iOS Subhead                           |
| `text-control`      | 13 / 18 · 0        | **16 / 21** · 0          | 16.25 / inherited     | iOS Callout; gets its own line height |
| `text-sm` (UI)      | 14 / 20 · 0        | **17 / 22** · 0          | 17.5 / 25             | iOS Body                              |
| `text-sm` (reading) | 14 / 22 · 0        | **17 / 26** · 0          | —                     | Messages and docs, 1.5+               |
| `text-base`         | 16 / 24 · 0        | **20 / 28** · −0.01em    | 20 / 30               |                                       |
| `text-lg`           | 18 / 28 · −0.01em  | **22 / 28** · −0.01em    | 22.5 / 31.5           | iOS Title 2                           |
| `text-xl`           | 20 / 28 · −0.01em  | **24 / 30** · −0.02em    | 25 / 35               |                                       |
| text inputs         | 14 / 20            | **16 / 22** (never less) | 17.5 or max(16)       | §2.4                                  |

- **Tracking follows the rendered size, not the device:**
  - 11px and under: +0.01em;
  - 12–17px: 0;
  - 18–23px: −0.01em;
  - 24px and up: −0.02em;
  - never negative under 14px.

  These are rounded from Inter's own dynamic metrics.

- **Load Inter's optical-size axis** (`opsz 14..32`). Small text then gets the text-tuned outlines, which do more for 12px legibility than any tracking value.

### 11.2 Icons, by role

| Token (new)           | Role                                 | Desktop | Phone  | Floor (measured) |
| --------------------- | ------------------------------------ | ------- | ------ | ---------------- |
| `--size-icon-inline`  | Beside metadata text                 | 12      | **15** | 12 / 14          |
| `--size-icon-control` | Inside a button, row or tab          | 16      | **20** | 16 / **20**      |
| `--size-icon-chrome`  | Header, toolbar, tab bar, navigation | 16      | **22** | 16 / **20**      |
| `--size-icon-feature` | Empty state, hero                    | 24      | **32** | —                |

These map onto today's `icon-xs`, `icon-sm` and `icon-md`, plus one new step for chrome. A header icon is 22px on the phone, between Apple's nav glyph (about 22pt) and Material's 24dp.

### 11.3 Targets and the gaps between them

| Token                              | Desktop         | Phone                                 |
| ---------------------------------- | --------------- | ------------------------------------- |
| Minimum target (`TOUCH_TARGET_*`)  | 24 (WCAG 2.5.8) | **44** (Apple; WCAG 2.5.5)            |
| Default control height             | 36 (`h-9`)      | **44** (`h-11`)                       |
| Compact control height             | 32 (`h-8`)      | **40**, with the hit area grown to 44 |
| Gap between small adjacent targets | 4               | **8** (Material, Primer)              |
| Header and bottom-bar targets      | 28–32           | **44**, never the smallest on screen  |

### 11.4 Spacing and density

| Token                                  | Desktop | Phone                  |
| -------------------------------------- | ------- | ---------------------- |
| Panel inset (edge to first glyph)      | 16      | **16** (never less)    |
| Card padding                           | 16      | **16**                 |
| List row, one line                     | 32      | **44**                 |
| List row, two lines                    | 48      | **60**                 |
| Icon-to-label gap in a row             | 8       | **12**                 |
| Gap between stacked controls in a form | 12      | **16**                 |
| Section spacing                        | 24      | **24–32**              |
| Header bar height                      | 36      | **44** + top safe area |

### 11.5 Margins and safe areas

| Token                       | Desktop | Phone                                                                                |
| --------------------------- | ------- | ------------------------------------------------------------------------------------ |
| Page gutter                 | 16–24   | **16** + `env(safe-area-inset-left/right)`                                           |
| Fixed top bar               | —       | pad `env(safe-area-inset-top)`                                                       |
| Fixed bottom bar / composer | 12      | `max(12px, env(safe-area-inset-bottom))`                                             |
| Bottom sheet                | —       | content clears the home indicator; the drawer handles the keyboard (never pad twice) |

### 11.6 Inputs

| Token                          | Desktop | Phone               |
| ------------------------------ | ------- | ------------------- |
| Field font-size                | 14      | **16** (hard floor) |
| Field height                   | 36      | **44**              |
| Field padding-x                | 12      | **12**              |
| Textarea / composer min height | 36      | **44**              |

---

**Sign-off format** (in the PR thread):

- **Signed off** or **Not yet**.
- Then a ranked list: Blockers, then Should, then Polish. Each item gives the issue, the rule (§ here), the measured value against the floor, and the fix.
- One line on what's good.

---

## Sources

The phone values come from the platforms' own defaults, not taste:

- Apple HIG, [Typography](https://developer.apple.com/design/human-interface-guidelines/typography) (the Dynamic Type ramp: Body 17/22, Footnote 13/18, Subhead 15/20, and SF tracking by size), [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) (44×44pt controls, 28pt minimum, spacing around controls) and [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons).
- Material 3 [type scale tokens](https://github.com/material-components/material-web) (small labels with positive tracking and roomy leading), [window size classes](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes), and [48dp targets, 8dp apart](https://support.google.com/accessibility/android/answer/7101858).
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/): 1.4.3, 1.4.10, 1.4.11, 1.4.12, 2.4.11, 2.4.13, 2.5.5 and [2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- iOS input zoom under 16px: [CSS-Tricks](https://css-tricks.com/16px-or-larger-text-prevents-ios-form-zoom/).
- Inter's [dynamic metrics](https://d.rsms.me/inter-website/v3/dynmetrics/) (tracking by size) and its `opsz` axis in [Inter 4](https://github.com/rsms/inter/discussions/493).
- [Primer's mobile checklist](https://primer.style/accessibility/tools-and-resources/checklists/mobile-checklist/) and [designer checklist](https://primer.style/accessibility/tools-and-resources/checklists/designer-checklist/), [Vercel's Web Interface Guidelines](https://vercel.com/design/guidelines), and Hoober's [touch research](https://www.uxmatters.com/mt/archives/2013/11/design-for-fingers-and-thumbs-instead-of-touch.php) (the edges of the screen need the most room).
- Practice: [NN/g severity ratings](https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/), and Linear's [zero-bugs policy](https://linear.app/now/zero-bugs-policy) and [Quality Wednesdays](https://linear.app/now/quality-wednesdays) ("other people need to point out problems").
