# Design Decisions — feedback form redesign (DOR-2232)

Visual companion session, 2026-09-23. The reviewed screen is copied to
`design/feedback-form.html` (the `.dork/visual-companion/` original is gitignored).

## Why

Ikechi's six reports (FB-49..54, 2026-09-21) exposed three failures:

- **No email on 5 of 6.** `reporterEmail` comes only from the server-resolved
  login identity (`routes/feedback.ts` → `resolveFeedbackIdentity`). His Linux
  install ran with `auth.enabled=false`, so there was no identity, and the
  optional contact field was empty. A login-off reporter who skips that field
  can never be told their report shipped.
- **No words on 5 of 6.** Point-at-element appended an `Element: … / Slot: … /
Testid: …` block to the message, which made the message non-empty, so Send
  turned on with nothing the person wrote.
- **Identical titles.** The Linear title is the message's first line, so five
  tickets were titled `Element: [data-testid="message-list"]`.

## 1. Help menu

**Chosen: A — three items.** `Send feedback…`, `Your reports` (renamed from
"Product feedback"; it is the person's own history at `/feedback-requests`),
`Documentation`. "Report a bug" merges into Send feedback (the form has the
kind picker). The "Report on GitHub…" sub-menu moves into the form as one
footer link. Rejected: B (two items; history one hop further away).

## 2. Form layout

**Chosen: A — composer.** Rejected: B (three dashed tiles under the box).

Top to bottom:

1. Header: "Send feedback" / "Straight to the DorkOS team. Private." + close.
2. Kind pills: Feedback · Bug · Idea.
3. The message box, with everything attached living INSIDE its border:
   thumbnails row (screenshot; pointed-at element crop with its human name as
   a caption and a remove ✕), then a toolbar row: `Capture app`, `Point at it`
   (desktop only; `Point again` once used), a 📎 icon button (file picker; its
   tooltip says paste and drop work anywhere on the form). Right side of the
   toolbar: `⌘↵ to send` hint once there is text.
4. "Also send" chips: `Diagnostics`, `This conversation` (only with a session in
   context), each a toggle with an eye button that opens the existing preview.
5. Identity:
   - signed in → one quiet line "Replying to <email> · Send anonymously" (today's line);
   - signed out → a visible **Your email** field, hint "So we can tell you when
     it's fixed. We remember it for next time." Remembered in `localStorage`
     (per-browser convenience; wrapped in try/catch; the form works without
     it). Sent as the existing `contact` field, which the site already uses as
     the notify address — no wire change.
6. Footer: 🔒 "Only the DorkOS team sees this" + Send. Under it, small:
   "Prefer a public GitHub issue? Open one instead" (today's GitHub path).

**The container stays `ResponsiveDialog`** (operator requirement): a centered
modal on desktop, a bottom drawer on mobile, as the dialog already was. Never a
plain Dialog or a custom panel. On the drawer: the message box and Send stay
reachable above the on-screen keyboard (the footer sits outside the one scroll
region), the toolbar wraps or shrinks cleanly at 360px, thumbnails never
overflow, and the capture flows hide the drawer or modal and bring it back with
the draft intact.

No collapsible "Attachments & details" panel. The three hint paragraphs under
the capture buttons go; their promises move into tooltips/aria.

## 3. Pointing at an element

The element no longer writes into the message. It travels as its own
structured field on the submission (`element: { selector, slot?, testId? }`)
and shows as the crop thumbnail captioned with a human name derived from
`data-slot`/`data-testid` ("message-list" → "Message list"; fallback "This
part"). The placeholder becomes "What's wrong with the message list?". Kind
still switches to Bug.

**Words are required.** Send is disabled until the trimmed message is
non-empty, and when an attachment exists but no words, the footer says "Add a
few words so we know what to look for." The Linear title comes from the
person's words; the site renders the element under the message in the body.

## 4. Small delights

- The draft survives an accidental close (reset only after a successful send,
  or when a caller opens with its own prefill, e.g. a crash report).
- ⌘↵ / Ctrl↵ sends; Esc closes.
- The success toast says what happens next ("We'll email you@… when it's
  fixed." when an address is known) and links to Your reports.
- An identical report (same kind + message + attachment) sent again within 60
  seconds is caught with a toast rather than filed twice (FB-52/53 were 33 s apart).

## What is not done (follow-ups, not DOR-2232)

Breadcrumb dedupe of repeated errors; errors serialized as `{}`; server-log
excerpt lines with no path/status; the `cockpit` surface label in reports;
blank captures of virtualized lists (DOR-2230).

Also known, by design or deferred:

- The pointed-at element is not stored in the site's `feedback_submission` row;
  it lives only in the Linear description. A report whose Linear mirror fails
  and is retried later (the documented reconciliation sweep) would be filed
  without its element.
- A caller's prefill (the crash stub, a failed-action summary) counts as words,
  so such a report can be sent without the person adding any. That is on
  purpose: the prefill already says what went wrong.
