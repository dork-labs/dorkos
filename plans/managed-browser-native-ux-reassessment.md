# Managed browser: native design reassessment

Date: 2026-10-08. Status: active design work; no replacement runtime or readiness is established.

## Product direction

The user rejected requiring Docker and requires “install DorkOS and it just works.” Choose designs by the work and confusion they create for the person installing DorkOS. Browser dependencies belong in the supported install/update flow; users must not run a separate service or terminal setup commands. Broad monitoring permissions and OS upgrade requirements are not accepted defaults.

## Current evidence

PR #2686 at b486c5d1b8 is clean and pushed. CI is complete: 29 passed, five skipped. Those checks do not establish installed-browser acceptance. The latest native storage run failed because a discovered descendant disappeared between its identity read and watcher registration. The missing interval cannot prove that it left no surviving descendant. Preserve that failed home and journal; do not retry unchanged code or reinterpret the refusal as successful cleanup.

## Native paths to assess

- Apple's established Endpoint Security client supplies process lifecycle events, but needs a restricted Apple entitlement and user Full Disk Access; a system-extension deployment also needs installation approval. This is not the default UX target.
- Apple's newer descendant-only client observes the caller's browser family without root privilege or TCC approval, but still requires the entitlement. Current Apple DocC metadata places it at macOS 27.0. The current qualification host is macOS 26.6.2 with SDK 26.5. Availability, entitlement eligibility, event-loss handling, crash recovery and signed distribution must be verified; no OS upgrade requirement or implementation is approved.
- Investigate a supported packaged browser launch/ownership architecture that avoids a separate monitor and user permissions. Electron owner events alone are not evidence of exhaustive descendant custody. A replacement needs a concrete supported mechanism and independent review before implementation acceptance.

Do not weaken process ownership, profile exclusion or uncertainty handling to make a candidate pass. Do not activate Docker, Endpoint Security, a privileged helper or a system extension as an inferred approval. The rejected Docker proposal remains historical evidence rather than the active delivery direction.

## Deferred test campaign

The external shared-IP/shared-SAN HTTP/2 campaign is a nice-to-have deferred by the user. It is not an initial-delivery blocker and needs no public hostname setup now. Preserve its fixture and original no-common-public-IP failure. Its result remains deferred/unverified, never passed. Other network denial, revocation, protected-endpoint and DNS/IP acceptance remains required.

## Next concrete work

1. Independently assess supported native designs against zero separate-service setup, minimal permissions and existing supported macOS versions.
2. Select a feasible design and record its precise ownership mechanism, installation behavior and remaining uncertainty before changing runtime code.
3. Implement and test the chosen design, then repeat genuine fresh installed storage, performance/resource and remaining acceptance on changed code. Preserve failed evidence and exact platform limits.
4. Keep the experiment off by default and PR draft until the remaining applicable acceptance converges. Merge and recoverably clean owned worktrees after qualification; do not bypass protected-workspace restrictions.

Primary sources: [Apple Endpoint Security client](<https://developer.apple.com/documentation/endpointsecurity/es_new_client(_:_:)>), [descendant-only client](<https://developer.apple.com/documentation/endpointsecurity/es_new_descendants_client(_:_:)>), [system extensions](https://developer.apple.com/system-extensions/), and Apple's current DocC metadata for the descendant-only client.
