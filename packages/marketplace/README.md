# @dorkos/marketplace

## Purpose

Foundation package for the DorkOS marketplace — the first of a five-spec series (`01-foundation`, `02-install`, `03-browse`, `04-registry`, `05-agent-installer`). This package owns the canonical `.dork/manifest.json` Zod schema, a tolerant Claude Code-compatible `marketplace.json` parser, an on-disk package validator, and a scaffolder for the four installable package types (`agent`, `plugin`, `skill-pack`, `adapter`). It ships schemas, types, parsing, validation, and scaffolding only — zero install logic, zero registry logic, zero UI.

## Exports

| Export                      | Browser-safe | Purpose                                                                |
| --------------------------- | ------------ | ---------------------------------------------------------------------- |
| `.`                         | yes          | Barrel — schemas, parser, types, constants                             |
| `./manifest-schema`         | yes          | Zod schema for `.dork/manifest.json` (discriminated union over `type`) |
| `./manifest-types`          | yes          | TypeScript types derived from the manifest schema                      |
| `./package-types`           | yes          | `PackageType` union, `PackageTypeSchema`, `requiresClaudePlugin()`     |
| `./marketplace-json-schema` | yes          | Zod schema for `marketplace.json` registry files                       |
| `./marketplace-json-parser` | yes          | Tolerant string-in / result-out parser for `marketplace.json`          |
| `./constants`               | yes          | Filenames, paths, schema version                                       |
| `./slug`                    | yes          | Package slug normalization and validation                              |
| `./package-validator`       | no           | Node-only on-disk package validator (`fs`)                             |
| `./package-scanner`         | no           | Node-only directory scanner that discovers packages                    |
| `./scaffolder`              | no           | Node-only `createPackage()` for new package directories                |

Node-only modules are excluded from the barrel and must be imported via subpath.

## Usage

Schema validation:

```ts
import { MarketplacePackageManifestSchema } from '@dorkos/marketplace';

const manifest = MarketplacePackageManifestSchema.parse(json);
```

Tolerant `marketplace.json` parsing:

```ts
import { parseMarketplaceJson } from '@dorkos/marketplace';

const result = parseMarketplaceJson(rawJson);
if (!result.ok) throw new Error(result.error);
console.log(result.marketplace.plugins.length);
```

On-disk package validation (Node only):

```ts
import { validatePackage } from '@dorkos/marketplace/package-validator';

const { ok, issues, manifest } = await validatePackage('/abs/path/to/pkg');
if (!ok) for (const issue of issues) console.error(issue.code, issue.message);
```

## CLI

The `dorkos` CLI (in `packages/cli`) wires the scaffolder and validator into two commands:

```bash
dorkos package init my-pkg --type agent
dorkos package validate ./my-pkg
```

`init` calls `createPackage()` from `./scaffolder`; `validate` calls `validatePackage()` from `./package-validator`.

## Related ADRs

- [ADR 220 — Adopt SKILL.md Open Standard for Task and Command Definitions](../../decisions/0220-adopt-skill-md-open-standard.md)
- [ADR 228 — Use `.dork/manifest.json` for Marketplace Package Manifests](../../decisions/0228-marketplace-manifest-filename.md)
- [ADR 229 — Add Optional `kind` Discriminator Field to SKILL.md Frontmatter](../../decisions/0229-skill-md-kind-discriminator-field.md)
- [ADR 230 — Use `agent` (not `agent-template`) as Marketplace Package Type](../../decisions/0230-marketplace-package-type-agent-naming.md)

## Out of Scope

Install logic lives in spec 02 (`marketplace-02-install`), browse UI in spec 03, registry/index in spec 04, and the agent installer in spec 05. This package never reads from a registry, never writes outside a package directory, and never mutates global state.
