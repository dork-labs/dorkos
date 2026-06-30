# Documentation Map

DorkOS keeps documentation in several trees, each with a distinct audience and a
distinct place where it is consumed. This map says where each kind of doc lives,
who reads it, where it renders, and which index or manifest is its entry point.

## Public (shipped on the site)

Rendered by `apps/site` (Next.js 16, Fumadocs) and served at `dorkos.ai`.

- **`docs/`**: user-facing guides, concepts, and integrations. Read by users and
  adopters. Served at `/docs`. Includes the auto-generated API reference under
  `docs/api/` (built from `docs/api/openapi.json`) and a public subset of
  contributor docs under `docs/contributing/`. Entry point: `docs/index.mdx` and
  `docs/meta.json`.
- **`blog/`**: release notes and announcements. Read by users following the
  project. Served at `/blog`. Release-note posts are scaffolded by
  `/system:release`. Entry point: the dated `*.mdx` files in `blog/`.

## Internal dev

Lives in the repo; read by contributors and coding agents, not shipped to the
site.

- **`contributing/`**: internal developer guides (architecture, design system,
  data fetching, testing, marketplace, the `/flow` engine, and more). Read by
  contributors and agents. Gateway: `contributing/INDEX.md`, which is the single
  source of truth for the doc-to-code coverage map (it points at
  `.claude/scripts/docs-coverage-map.{json,mjs}`).

## Decisions

- **`decisions/`**: Architecture Decision Records (ADRs). Read by anyone tracing
  why a choice was made. Tracked in `decisions/manifest.json`; superseded or
  trivial ADRs move to `decisions/archive/`.

## Work artifacts

Point-in-time records of design and investigation.

- **`specs/`**: feature specifications (the validated contract work is executed
  against). Read by implementers and agents. Tracked in `specs/manifest.json`;
  completed or superseded specs move to `specs/archive/` (see
  `specs/archive/README.md` and the `managing-specs` skill).
- **`plans/`**: implementation plans, design explorations, and findings reports
  (the thinking between research and a tracked spec). Index: `plans/INDEX.md`;
  completed or superseded plans move to `plans/archive/`.
- **`research/`**: research reports, named `YYYYMMDD_slug.md` with a frontmatter
  `status`. Read before starting new investigation so work is not repeated.

## Strategy

- **`meta/`**: brand foundation, personas, litepapers, value-architecture method,
  and PM methodology. Read for the "why" and the voice, not for current product
  behavior. Index: `meta/INDEX.md`.

## How this stays maintained

The doc trees are kept honest by harness mechanisms, not by hope:

- **Developer guides**: `/docs:status` (health dashboard), `/docs:reconcile`
  (drift against recent code), and `/docs:coverage` (the doc-to-code coverage
  map). The `writing-developer-guides` skill structures new guides.
- **Research**: `/research:curate` inventories and updates frontmatter status.
- **Decisions**: `/adr:curate` and `/adr:review` promote, accept, deprecate, or
  archive ADRs.
- **Specs**: `/spec:audit` reconciles `specs/manifest.json` against the
  filesystem.
- **SessionStart nags**: `.claude/hooks/check-adr-drift.sh`,
  `.claude/hooks/check-docs-staleness.sh`, and
  `.claude/hooks/check-research-curation.sh` surface drift at the start of a
  session.
- **Stop hook**: `.claude/hooks/create-checkpoint.sh` checkpoints work when a
  session ends.
