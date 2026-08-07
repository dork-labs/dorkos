---
id: 260806-222546
title: imageUrl is the fourth render-cache field, stored locally behind a sync-ready seam
status: draft
created: 2026-08-06
spec: identity-consistency
superseded-by: null
---

# 260806-222546. `imageUrl` is the fourth render-cache field, stored locally behind a sync-ready seam

## Status

Draft (auto-extracted from spec: identity-consistency)

## Context

Every avatar in the cockpit is an emoji, a colour, or a letter. `displayName` + `emoji` + `color` is
the render-cache triplet `AuthorRef`, `CommunityMember` and the `authors` table all speak, and none of
them has a photo field. Better Auth's `user.image` column exists in both the local and cloud schemas
and is read nowhere. A profile photo could be sourced three ways — Gravatar from the email, the
optional dorkos.ai cloud account, or a local file — and two of those assume a network on an install
that runs fully offline and may have no account at all. It could also be modelled as a replacement
for the emoji/colour pair, which would fork a second avatar system for the one kind of identity that
has a photo while agents keep the old one.

## Decision

We will add `imageUrl` as a **fourth optional render-cache field** beside `displayName`, `emoji` and
`color` — additive on `AuthorRef`, `CommunityMember`, the `authors` table, `TeamMember` and every
avatar renderer, with the precedence image → emoji → letter — exactly as `responseMode` was added to
`CommunityMemberSchema` as an orthogonal optional field. The only source is a **local upload**: png,
jpeg or webp, validated by magic bytes, ≤2 MB, no re-encoding, stored at
`<dorkHome>/avatars/<authorId>.<ext>` via `resolveDorkHome()` and served by the local server. No
Gravatar and no cloud fetch. The write and read go through an `AvatarStore` interface whose `put`
returns the URL the cache stores, so a future server- or cloud-backed store returns an absolute
`https://` URL and no schema, route or renderer changes.

## Consequences

### Positive

- Offline installs get photos; nothing depends on an account, an email or a network.
- The seam is testable rather than aspirational: substituting a fake store that returns an absolute
  URL proves the sync-readiness claim.
- Emoji and colour keep working for everyone who has no photo, and for agents, which is their whole
  identity language.
- `user.image` finally means something, so the account record and the roster cannot disagree.

### Negative

- A photo is only as portable as the machine it was uploaded to until a remote store exists — moving
  installs loses it.
- Refusing to re-encode means the stored file is whatever was uploaded, so a 2 MB photo is served at
  2 MB until a resize step is added.
- SVG is refused, which is the right call for a script vector but will surprise someone with a
  vector avatar.
- One more optional field on four schemas and a dozen components, each of which must remember to pass
  it through.
