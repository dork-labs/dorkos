---
slug: shared-ui-consumer-adoption
number: 260925-100000
created: 2026-09-25
status: ideation
---

# Complete shared UI consumer adoption

The operator's goal is consistent controls, styles and interaction behavior across the product. The completed foundation and 0.2.0 extraction projects supplied maintained customized Radix primitives and a standalone catalog. Their sign-in pilots and dependency upgrades did not migrate the remaining equivalent controls. This continuation owns that adoption; historical release claims remain scoped to what shipped.

Public baseline: dbff5a6f6b3005d4e9815d1b3d485446528f2900. Existing package remains 0.2.0. DOR-2342 tracks this work in Shared UI — Consumer Adoption. Current tracker search found no overlapping adoption programme; DOR-1808 concerns data-slot ownership and DOR-2204 shared-package naming, not this migration.

The opposing-theme dialog defect reproduces in real Chromium on this base: a dark class-only portal host inside a light document gives DialogContent rgb(23,23,23) foreground on rgb(10,10,10) background, although its foreground token is 87% gray. Catalog parent text styling hid the missing component foreground. AlertDialog, Sheet and outline Button have the same missing semantic pairing. Fix the owning implementations and verify both directions.

Community currently adopts package controls in Admission and EntryRemoval. Equivalent controls elsewhere still use .button/.field/.notice CSS. Adopt them across account, recovery, host administration and channel actions without changing requests, permissions, focus or deliberate native control semantics. Concurrent import/takedown branches touch several of these files; preserve their behavior and reconcile new changes before delivery.

Site operational forms may share equivalent foundations; marketing composition, Fumadocs controls, marketplace whole-card/filter links and navigation remain owned by their surfaces. Inventory actual live call sites before choosing changes. Card, Badge and Skeleton differ materially between existing surfaces: client Card uses application elevation/interactivity, Badge uses status vocabulary, Skeleton uses breathing animation. Do not extract solely because names match.

Decisions: retain customized Radix package; no upstream regeneration or primitive rewrite; preserve native selects/file/date/radio controls; apps own auth/data/routing/state. Exact packed contract proof precedes a compatible patch release when package exports are unchanged. Independent consumers track their implementation privately and publish only contract-level proof. All writes stay in isolated worktrees.
