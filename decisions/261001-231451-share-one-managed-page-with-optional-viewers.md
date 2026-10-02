---
id: 261001-231451
title: Share one managed page with optional viewers
status: proposed
created: 2026-10-01
spec: shared-browser-control
superseded-by: null
amends: 260912-025251
---

# 261001-231451. Share one managed page with optional viewers

## Status

Proposed, extracted from [the production contract](../specs/shared-browser-control/06-production-specification.md). This record is awaiting independent review and acceptance; it changes no accepted decision yet.

Upon acceptance, this partially amends [260912-025251](260912-025251-browser-driving-rides-the-in-page-shim.md): its title's “never a server-side browser” clause, its requirement that all driving extend the in-page shim, and its positive consequence “No headless browser, no CDP, no second rendering, and no new process to supervise or sandbox” stop governing managed browsing. Its unchanged-security-posture consequence also cannot govern the new managed path, which adds authenticated streams, profile grants and process supervision. The same-visible-state rationale and iframe-only driving/security boundaries continue governing lightweight previews; the parent stays accepted with `superseded-by: null`. Parent status notes and both manifest entries belong to the later coordinated acceptance change, not this draft.

## Context

The visible iframe preview and storage-state-seeded agent browser are independent renderings with different state and lifetime. Retained profiles, unattended agents and authorized co-browsing need a page whose lifetime does not depend on an open client. The earlier decision correctly rejected invisible automation of a second unshared rendering, but its absolute prohibition also excludes a canonical managed page whose actual captures people view. Prototype evidence proves useful mechanics while retaining latency, recent-write crash and native observation limitations.

## Decision

We will own one canonical Chromium Page per live tab and direct authorized human and agent actions to that Page, with optional viewers of its actual captures. We will place browser mechanics in private `@dorkos/browser` with an injected data directory, while the server owns profiles' user permissions, scope attachments, authenticated streams and controller epochs. We will retain lightweight instrumented iframe previews and keep Doc Channel's parent/MessagePort transport independent; a pixel viewer is not an SDK iframe parent. We will install runtimes explicitly and gate release on measured performance, native input/accessibility, platform presence and exact recovery behavior, without promising lossless sudden-death storage or replaying uncertain actions.

The initial rollout is a persistent default-off `browser.enabled` experiment called Shared browser in the existing Settings → Advanced → Experiments list. Off retains legacy browsing and independent lightweight previews. On permits explicit managed selection only for its exact accepted identity mode, across every runtime. Enabling does not install a browser, weaken readiness or silently choose another browser. The global setting uses existing server config-write authority; it grants no access to another user's page or profile, and the existing login-off local-trust limits still apply.

Live disable closes admission, revokes views/control/grants and queued work, drains/resets held input within the current barrier and stops only exact owned processes. Preserve named profiles and report stopping or uncertain failure until cleanup is observed. Persistence failure leaves admission fenced without off-success; restart reconciles the setting and ownership evidence without resuming stale pages, grants or queued actions. Never replay uncertain effects or automatically move a live page into legacy browsing. [DOR-2671](https://linear.app/dorkspace/issue/DOR-2671/decide-whether-shared-browser-graduates-from-experiments) separately decides later graduation; it is not a prerequisite for initial rollout or full-programme closure. The full Chrome preference and all five delivery requirements remain unchanged. This user-requested addendum needs fresh independent plan review and changes no accepted ADR or implementation status.

## Consequences

### Positive

- People and agents inspect and operate the same page state instead of separate renderings of a URL.
- Browsers keep working without viewers; retained profiles and clean mode have explicit independent lifetimes.
- One server authority can enforce participant grants and serialized control across session, Room and phone views.
- Existing lightweight previews remain useful without browser-process cost or a Doc Channel redesign.

### Negative

- Chromium lifecycle, private storage, runtime distribution, network confinement and signed-in account sharing add substantial security and recovery obligations.
- Streaming adds latency and resource use; the retained injected-RTT target failed, and loaded-host resource observations establish no production capacity guarantee.
- Pixels alone do not provide semantic accessibility or prove native IME, clipboard, physical phone or macOS presence; those remain acceptance gates.
- Sudden death can lose acknowledged recent site writes. Actions interrupted during death cannot safely be replayed automatically.
