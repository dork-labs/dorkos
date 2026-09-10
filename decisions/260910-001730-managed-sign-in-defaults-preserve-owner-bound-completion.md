---
id: 260910-001730
title: Managed sign-in defaults preserve owner-bound completion
status: accepted
created: 2026-09-10
spec: composio-managed-auth-defaults
amends: ['260905-205123']
superseded-by: null
---

# Managed sign-in defaults preserve owner-bound completion

## Context

Requiring a developer OAuth application for each service blocks the dynamic catalog even when Composio supports managed authentication. The operator chose managed defaults and preserved existing custom overrides. Composio documents deferred callback identity verification for OAuth connections that pass through provider redirects. Its hosted Connect Link also collects API keys and custom fields, but the published contract does not extend that identity guarantee to non-OAuth collection. This is a missing documented guarantee, not a live-tested refusal.

## Decision

Use configured custom authentication first, then Composio-managed OAuth where supported, and declared account-field schemes where safely representable. Keep OAuth callback identity verification mandatory. Collect non-OAuth credentials only on the signed-in same-origin hosted page and relay them transiently to the fixed Composio endpoint after consuming the exact owner-bound flow. Keep account creation separate from agent grants and exact operation/account policy. Bound the complete POST envelope at 72 KiB and its encoded fields object at 64 KiB. Retain a returned account ID for reconciliation before creating the hosted connection binding only after exact user/toolkit/config/ACTIVE verification. A failed database checkpoint never authorizes another account create.

## Consequences

People can connect supported services without setting up developer OAuth apps. Managed provider consent may name Composio; custom branding remains an optional later migration. Non-OAuth credential values transiently cross dorkos.ai, requiring strict no-persistence/no-logging and honest custody copy. Unknown or developer-only authentication remains an explicit per-service exception. Existing test overrides and grants are never silently broadened.

## References

- [Hosted authentication](https://docs.composio.dev/docs/tools-direct/authenticating-tools#hosted-authentication-connect-link) describes hosted API-key and custom-field collection.
- [Callback identity verification](https://docs.composio.dev/reference/api-reference/connected-accounts) limits its documented deferred activation contract to OAuth/provider redirects. A generic callback account ID cannot establish who entered credentials into a copied link.
