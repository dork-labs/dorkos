---
id: 260713-133412
title: Ship the Windows desktop as an unsigned alpha; adopt Azure Artifact Signing later
status: accepted
created: 2026-07-13
spec: desktop-windows-support
superseded-by: null
---

# 260713-133412. Ship the Windows desktop as an unsigned alpha; adopt Azure Artifact Signing later

## Status

Accepted

## Context

The Windows x64 desktop build ships an NSIS installer that end users download and run. Windows Defender SmartScreen shows a "Windows protected your PC" warning for any installer whose publisher it does not yet trust. Code signing is the only part of Windows support that cannot be done autonomously: it requires spending money and validating a legal entity (Blaze Ventures, LLC). The build infrastructure (packaging, auto-update, CI) is fully independent of signing — an unsigned installer builds and auto-updates today. As of 2026, the signing landscape shifted materially: Microsoft **removed EV certificates' instant-SmartScreen-reputation benefit in March 2024** (EV now earns reputation on the same per-file-hash curve as OV), and **OV certificates require a FIPS-140-2 hardware token that cannot be attached to GitHub-hosted CI runners**. **Azure Artifact Signing** (formerly Azure Trusted Signing) reached GA in April 2026: cloud HSM (no hardware token), $9.99/mo Basic, headless on `windows-latest` via `azure/login` OIDC + `Azure/trusted-signing-action`, wired into electron-builder via `win.azureSignOptions` — and its former 3-year organization-age eligibility requirement was dropped at GA.

## Decision

We will ship the Windows desktop build **unsigned** for the pre-launch alpha, gated behind the demo-claim honesty gate (labeled "alpha" in all user-facing copy, never described as verified until a real end-user install confirms it). We will **not** buy an EV or OV certificate. When Windows moves from alpha to a public surface, we will adopt **Azure Artifact Signing** as the signing path: enroll Blaze Ventures, LLC, wire `win.azureSignOptions` + an `azure/login` OIDC step into the existing `AZURE_SIGNING_CONFIGURED` seam in `desktop-release.yml`, and re-verify. The CI workflow already carries that inert seam (mirroring the macOS `APPLE_DEVELOPER_CONFIGURED` gate) so the change is additive.

## Consequences

### Positive

- Windows support ships now, decoupled from a spend/legal-verification decision that only Dorian can make.
- No money spent on EV (which buys nothing over OV since March 2024) or on OV hardware tokens (unusable in CI).
- The chosen future path (Azure Artifact Signing) is the cheapest and least operationally painful signed-build option, with first-class electron-builder + GitHub Actions support and no hardware token.
- The alpha audience (developers) routinely clicks "More info → Run anyway," so the unsigned SmartScreen prompt is tolerable interim friction, not a credibility blocker.

### Negative

- Unsigned installers show the SmartScreen "Windows protected your PC" warning on first run, a worse first impression than the signed, notarized macOS build.
- Even after adopting Azure Artifact Signing, SmartScreen reputation accrues per file hash through download volume, so the warning will not vanish on day one of signing — signing removes it only as reputation builds.
- Carrying an inert signing seam in CI is dead-until-activated configuration; it is documented as such to avoid the "labeled signed but actually unsigned" footgun (the Windows job is a single unconditional unsigned step today, not a fake signed/unsigned split).

## Alternatives Considered

- **EV certificate** — rejected: Microsoft removed EV's instant SmartScreen bypass in March 2024, so the EV premium buys no reputation advantage over OV.
- **OV certificate (hardware token or cloud HSM)** — rejected for now: the token cannot run on GitHub CI, and the cloud-HSM alternative adds a third-party dependency and per-signature cost for marginal benefit during an alpha.
- **Sign from day one** — rejected: it blocks shipping on a business/legal decision, and signing does not remove the SmartScreen warning immediately anyway.
