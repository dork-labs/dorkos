# dorkos-community / marketplace

The official community registry for the [DorkOS Marketplace](https://dorkos.ai/marketplace) — agents, plugins, skill packs, and adapters built by the DorkOS community.

This repo is the source of truth for the public catalog. The `marketplace.json` file in the root is fetched hourly by `dorkos.ai/marketplace` and consumed by the `dorkos` CLI when users browse or install packages.

## What lives here

- `marketplace.json` — The registry index. One entry per published package.
- `README.md` — This file.
- `CONTRIBUTING.md` — How to submit a new package. Read this before opening a PR.
- `.github/workflows/validate-submission.yml` — Runs `dorkos package validate` on every PR.

## Browse the catalog

The web view at <https://dorkos.ai/marketplace> renders this registry with screenshots, READMEs, install instructions, and per-package permission previews. If you want to discover what DorkOS can do without installing anything, start there.

## Submit a package

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full submission flow, checklist, PR format, and validation requirements.
