---
title: 'Slack Sidebar & Channel Organization UX — Deep Dive'
date: 2026-07-16
type: external-best-practices
status: active
tags:
  [
    sidebar,
    slack,
    channel-organization,
    custom-sections,
    favorites,
    recents,
    frecency,
    quick-switcher,
    ux,
  ]
sources_count: 28
related_spec: agent-sidebar-organization
---

# Slack Sidebar & Channel Organization UX — Deep Research Report

**Date**: 2026-07-16
**Objective**: Study Slack's sidebar/channel organization (custom sections, starring, sorting, unreads, quick switcher) — what users like and dislike — to inform DorkOS agent sidebar organization (spec `agent-sidebar-organization`, DOR-329).

## 1. Custom Sidebar Sections (Paid Feature)

**What it is:** On paid Slack plans, members can group channels, DMs, and apps into personal, private "folders" in the sidebar called custom sections. Sections are per-user — "your custom sections are only visible to you and won't affect what your coworkers see." ([Slack Help: Organize your sidebar with custom sections](https://slack.com/help/articles/360043207674-Organize-your-sidebar-with-custom-sections))

**Creation flow (desktop only, syncs to mobile):**

1. Hover over the **Channels** header in the sidebar → click the **three-dot icon**.
2. Select **"Channel section"** (some docs/UI variants label it "Create new section").
3. Enter a name, or pick from Slack's suggestions (e.g., "Priority," "Social," "Projects").
4. Click the **smiley-face icon** to assign an emoji (used in place of a folder icon, and doubles as the collapse/expand affordance).
5. Click **Create**.

On mobile: open a channel/DM → tap the name in the header → tap **Star** or **Move** → **New Section**. Sections can only be _created_ on desktop, but they sync everywhere once made. ([MakeUseOf](https://www.makeuseof.com/organize-the-slack-sidebar/))

**Populating a section — three ways:**

- **Drag-and-drop:** grab any channel/DM row and drop it into a section.
- **Star icon shortcut:** open a conversation, click the star icon (or the section's emoji) at the top, and choose a section from the list, or "Create new section."
- **Bulk management:** from the Home tab, click **"Manage my sidebar"** → **"Bulk manage conversations"** → check boxes next to conversations → **"Move to…"** → pick or create a section.

A conversation lives in exactly **one** section at a time — moving it into a new section removes it from wherever it was. Removing it from a section returns it to the default Channels/DMs bucket. This is a deliberate constraint: Slack frames sections as "organizational containers for your personal sidebar," distinct from channels themselves.

**Per-section sort** (hover section name → three-dot icon → **Sort**):

- **A-Z** — alphabetical
- **Recency** — most recently active conversation floats to top
- **Priority** — ranks by usage frequency ("channels you use most often end up on top")

**Per-section filter/display** (same three-dot menu → **Filter**, sometimes labeled "Show"):

- **Active only** (default) — hides conversations with no new activity in the past 30 days
- **Unread conversations only** — hides everything without unread messages
- **Mute all** — mutes every conversation in the section at once (items render grayed out)

**Collapse/expand:** Click the section's emoji (or arrow) to collapse/expand. **Option-click** (Mac) / **Alt-click** on any section's arrow collapses/expands _all_ sections at once.

**Rename/delete:** three-dot menu on the section → **Rename** (also changes the emoji) or **Delete section**.

**Shared sections (paid plans):** any paid member can share a custom section with specific individuals; admins can attach **one custom section per user group** — used for onboarding ("share custom sections to make it easier for [new team members] to join key channels"). ([Slack Help: Share sidebar sections](https://slack.com/help/articles/29873996048019-Share-sidebar-sections-in-Slack))

**Free vs. Paid:** Custom sections require a **paid plan**. On the free plan (or downgrade), everything collapses back into three fixed buckets: **Channels, DMs, and Starred** — pre-existing custom organization is discarded/flattened. ([Slack Help: Feature limitations on the free version](https://slack.com/help/articles/27204752526611-Feature-limitations-on-the-free-version-of-Slack))

## 2. Starred Items → "Later," and the Default Sections

**Legacy Starred (pre-2023):** a simple bookmarking primitive — star messages, files, and channels/DMs; only the starring user sees their own stars.

**The "Save it for Later" migration (March 2023):** Slack merged Saved Items/Stars and Reminders into a unified **Later** tab with three sub-tabs (**In progress**, **Archived**, **Completed**), with attachable reminders. The `stars.*` API methods were frozen — a clean breaking change. ([Slack Developer Docs changelog](https://docs.slack.dev/changelog/2023-07-its-later-already-for-stars-and-reminders/))

**Starring channels/DMs today** remains separate and alive: click the star icon at the top of a conversation to add it to the **Starred** sidebar section. One of the three defaults that survive even on the free plan.

**Default sections in a fresh workspace / free plan:** **Channels**, **Direct messages**, **Apps**, and **Starred** (appears once you star anything).

**Unreads view:** Home → **Unreads** (desktop); mobile equivalent is **Catch up**. Deliberately cross-cutting: it can be filtered "according to your sidebar sections" — Unreads is a lens layered on top of existing organization, not a separate silo.

**Activity view:** a consolidated, filterable feed of everything requiring attention (threads, mentions, reactions, DMs, invitations, apps, reminders, VIP senders). Paid users can scope by specific channels or sidebar sections and save a filter combo as a named custom tab. Two density modes (Detailed vs Dense). Explicit distinction between **marking read** (unbolds sidebar item) and **clearing** (removes from the feed).

## 3. Sorting Options — Global and Per-Section, and Defaults

**Global sidebar sort** (Preferences → Sidebar): **Alphabetical** (default) or **By priority** (frequency-based). Users can also segregate private vs. shared channels and drag-reorder manually within a bucket.

**Per-section sort:** A-Z / Recency / Priority — the same three-way choice, scoped per section, letting a "Vital work" section sort by Priority while "Social" stays alphabetical.

**A known reliability complaint:** sort _preference_ is stored client-side/per-device in some cases, with a documented recurring bug where sort settings silently reset after major updates. The community workaround: rely on **custom sections** (server-persisted, sync reliably) instead of the sort toggle. ([WeLikeRemoteStack](https://welikeremotestack.com/slack-list-view-sorting-not-saving-preference-fix-2026/))

## 4. What Users Like

- **The "folder" mental model is intuitive.** Slack markets sections as "folders — group them by team, project or department" with role-based recipes (Sales, Engineering, Legal, Customer Service).
- **Unread-only filtering per section is the most-cited "aha" tip** across guides (MakeUseOf, Zapier, TheNextWeb, Slack's own blog) — the single highest-leverage move for taming a cluttered sidebar.
- **Power users build custom taxonomies on top of the primitives.** Notable example: "[Organize your Slack channels by 'How Often', not 'What'](https://aggressivelyparaphrasing.me/2025/09/30/organize-your-slack-channels-by-how-often-not-what/)" rejects Slack's suggested topic-based defaults as "pointless" and builds an Eisenhower-style cadence system — **Read Now/Hourly, Read Daily, Read Whenever, Read Never** — entirely with sections/mute/filter, achieving "Inbox Zero for Slack every day." Evidence the primitives (arbitrary grouping + per-group filter/sort/mute) outlive any vendor-suggested taxonomy.
- **The Quick Switcher (Cmd/Ctrl+K) is broadly loved as the "escape hatch"** from sidebar organization entirely (see §7).
- **Shared sections for onboarding** are praised as low-effort channel curation for new hires.

## 5. What Users Dislike / Complaints

- **Custom sections gated behind paywall.** Free-plan users get their organization flattened to Channels/DMs/Starred; recurring friction for small teams.
- **A conversation can only live in one section — no cross-tagging.** Strict single-parent folder tree, no "pin this channel in both Vital Work and Client X." No first-party workaround.
- **Muted channels behave unpredictably relative to visibility.** Muting doesn't remove a channel by default, but under Recency sort a quiet muted channel sinks and becomes invisible — yet unreads inside can still fire badges elsewhere: "why is there a red dot somewhere but I can't find the channel." In late 2025 Slack shipped a default-ON auto-hide of muted channels, which caused its own "where did my channel go" confusion. ([Nerd Techy](https://nerdtechy.com/why-is-slack-hiding-channels))
- **Sort-preference persistence bugs** (see §3) — undermines trust in "set it and forget it" organization.
- **The August 2023 redesign backlash** — the sharpest documented IA backlash in Slack's history: collapsed workspace tiles into Home/DMs/Activity/Later/More; immediate mockery ("Basically a Gmail reskin," "Did they copy and paste the Microsoft Teams UI?!"); the **Activity tab's ambiguous catch-all label singled out repeatedly** ("I have no idea what the notifications in my Activity section are about" — [Medium](https://medium.com/@SkylerSchain/the-real-problem-with-the-new-slack-ui-23cd436abdf8)); removing the exposed workspace switcher forced a rare public walk-back; **no rollback/legacy mode was offered**, compounding frustration. ([VentureBeat](https://venturebeat.com/virtual/slack-lash-slack-defends-controversial-redesign-amid-sharp-criticism), [HR Dive](https://www.hrdive.com/news/slack-ui-update-august-2023/694615/), [Engadget](https://www.engadget.com/slacks-latest-redesign-has-a-dedicated-dm-tab-and-a-discord-style-activity-view-130032154.html))
- **General clutter/findability complaints** (G2/Capterra): hard to see which chats are active; hard to find past conversations/threads/saved items, especially by date; open channel creation accumulates short-lived channels.

**Meta-pattern:** almost every dislike traces to (1) **a conversation can only exist in one organizational bucket at a time**, or (2) **an ambiguous catch-all label** (Activity, muted-but-still-badged) forcing a click to disambiguate.

## 6. Slack's Official Design Rationale

- **"Introducing a simpler, more organized Slack" (March 2020):** goals — speed up switching between recent conversations; surface mentions/reactions/files in one place; add customizable sections to "prioritize what deserves your attention." ([Slack blog](https://slack.com/blog/productivity/simpler-more-organized-slack))
- **Jorge Arango's critique** of the 2020 redesign: poor IA "can lead to confusion, wasted time, misunderstandings"; urged companies to "move more slowly and deliberately" with changes to "essential infrastructure" because they render user mental models and support docs obsolete overnight. ([jarango.com](https://jarango.com/2020/03/28/slacks-information-architecture-redesign/))
- **"Beyond the last message" (Slack Design):** chronological ordering biases recency — "the most recent message ends up feeling like the most important one." They **rejected** an elaborate "Boards" concept for a simpler Bookmark Bar: "Simple is not simplistic… solutions that add great value to users, without adding cognitive cost." ([Slack Design](https://slack.design/articles/beyond-the-last-message-designing-for-all-information-in-slack/))
- **"Designing teamwork" (Slack Design):** benchmarking research found **first-time users missed feature discovery when sidebar sections defaulted to collapsed** — Slack changed the default to **start everything open**, trading first-glance cleanliness for discoverability. ([Slack Design](https://slack.design/articles/designing-teamwork-how-our-customers-shaped-the-future-of-slack/))

## 7. Recent-Conversation Discovery: the Quick Switcher and History

**Quick Switcher (Cmd+K):** Slack's primary escape hatch from the sidebar. Design goals: "open nearly instantly, regardless of team size" and "remember who and what you switch to and prioritize those results." Performance work took median open time from **85ms → 7ms** (candidate list capped at 24 most relevant unread items on open; prefetching before first keystroke). ([Slack Engineering](https://slack.engineering/a-faster-smarter-quick-switcher/))

**The frecency algorithm (directly portable):**

- Every query + selected item is logged with a timestamp; up to **10 recent visits per query** retained.
- Recency buckets: **past 4 hours = 100 pts, past day = 80, past 3 days = 60, past week = 40, past month = 20, past 90 days = 10, beyond = 0.**
- Final score = **(Total Count × Score) ÷ (Number of timestamps, capped at 10)** — frequency multiplies a recency-decayed score, normalized so a few very recent hits can outrank a stale-but-frequent habit within a few uses.
- Fuzzy/graph-based substring matching: "devweb" matches `#devel-webapp`; "design team" matches both `#design-team` and `#team-design`.

**History navigation:** browser-style back/forward — **Cmd+[** / **Cmd+]** step through recently visited conversations; a clock-icon History button lists them chronologically.

**Why this works:** it decouples "finding a conversation" from "having organized it correctly in advance." No matter how stale the sidebar taxonomy gets, Quick Switcher + History give a self-correcting path weighted by real behavior. Power users lean on Cmd+K specifically _to route around_ sidebar friction.

## Design Lessons for DorkOS

1. **Treat manual organization and automatic ranking as two independent, freely-combinable dimensions.** Slack separates _where something lives_ (sections, manual) from _how it's ordered inside_ (A-Z / Recency / Priority, per-section). Let an agent be manually placed in a group while its position inside is driven by a per-group automatic signal.
2. **Give every group its own independent activity filter, not just a global one.** "Filter this section to unreads only" is the most-repeated tip in every guide. Cheap to build, disproportionately loved.
3. **Build a frecency ranking explicitly.** Slack's formula — `(count × recency-decayed score) / min(visits, 10)` with hour/day/week/month buckets — is public, battle-tested, and portable to recent-session ranking.
4. **Never gate the escape hatch behind organization quality.** Cmd+K + History work identically whether or not the sidebar is organized — the safety net that makes imperfect manual organization tolerable.
5. **Never let a muted/hidden item both disappear from view and still fire a badge.** Slack's most concrete reproducible complaint. Muting should own _all_ attention signals — no partial states.
6. **A strict single-parent-group model is defensible — but say so explicitly and consider a cross-cutting fallback.** The recurring complaint is the lack of any alternative for cross-cutting association, not the single-parent rule itself.
7. **Ambiguous catch-all labels are a top usability failure.** Avoid generic bucket names like "Updates" or "Activity" that mix fundamentally different notification types; make badges/previews specific enough that users don't click through to disambiguate.
8. **Persist organizational state server-side, not client-locally.** Slack users documented that sections (server-side) persist reliably while sort prefs (local/per-device) silently reset. Manual organization must sync across every client from day one.
9. **Default to "open," not "collapsed," when discovery matters.** Slack's own research: first-time users missed capabilities when sections defaulted collapsed; they changed the default to open.
10. **Big redesigns of navigation primitives are trust-expensive; ship incrementally, keep a path back.** The 2023 backlash was about changing _how people navigate to their work_ all at once with no rollback.
11. **Simple, well-understood primitives beat elaborate bespoke ones.** Slack chose a plain Bookmark Bar over an ambitious Boards concept: "Simple is not simplistic."

**Note on source freshness:** exact UI menu labels ("Filter" vs "Show," "Bulk manage conversations" vs "Edit sidebar") vary across sources — genuine churn in Slack's UI copy; re-verify against the live product if any exact string becomes load-bearing.
