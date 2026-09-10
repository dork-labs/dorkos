---
id: 260910-001729
title: Make Composio services ready to connect with managed sign-in defaults
status: specified
created: 2026-09-10
---

# Intent and decisions

DOR-1958 extends DOR-1792 and the white-label-connections programme. The operator explicitly chose Composio-managed OAuth by default, existing custom overrides first, and the full dynamic Composio catalog from day one within supported authentication capabilities. DorkOS-owned OAuth migration is future work. Existing Gmail ReadOnly verification setup and grants remain intact; that temporary fixture does not define normal Gmail capabilities.

Source investigation is pinned to 57171c402690bc82b3166ae057e75d6c599ed3d8. Hosted config.ts requires a manual auth map; authentication-service.ts snapshots that mapped ID; discovery-service.ts advertises unsupported when it is absent. The local legacy client already creates managed auth configs, but its first-enabled-config selection is unsuitable for hosted trust. The pinned SDK exposes exact managed modes, scope ceilings and field metadata. Raw link.create already supports multiple accounts: allowMultiple is a high-level SDK local preflight guard and is not a wire field.

Root accepted a scheme-specific boundary: OAuth retains deferred callback identity verification. Non-OAuth fields are entered only on the same-origin hosted owner page and relayed transiently to Composio. They never pass through local-instance, agent or CLI transports. No generic polling completion may bypass OAuth verification.

This is complex under Flow: shared contract, hosted policy/DB, provider boundary, browser copy and representative conformance. Keep one bounded spec and two implementation tracks after the common contract is frozen. No product code or production actions have occurred.
