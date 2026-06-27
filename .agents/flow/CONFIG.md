# `/flow` configuration

The `/flow` engine reads its runtime configuration from three files in this
directory. Two are committed and shared by everyone on the repo; one is
per-machine and never committed. This split keeps behavioral policy in version
control while keeping credentials and per-machine overrides off it.

## The config triad

| File                        | Committed?      | Purpose                                                                                                         |
| --------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| `config.json`               | yes             | Shared team defaults. Pure behavioral policy: stages, autonomy, gates, dispatch, and so on. Carries NO secrets. |
| `config.local.json`         | no (gitignored) | Per-machine secrets and overrides. Holds your tracker credentials plus any field you want to override locally.  |
| `config.local.example.json` | yes             | Committed template for `config.local.json`. Copy it, rename it, fill in your values.                            |

`config.local.json` is listed in the repo `.gitignore` so real credentials never
land in a commit. Only the `.example` template is tracked.

### Getting started

```bash
cp .agents/flow/config.local.example.json .agents/flow/config.local.json
# then edit config.local.json and fill in your values
```

Delete any block in `config.local.json` you do not need. If your host already
supplies tracker auth (for example through a connected MCP server or CLI
connection), you can omit `secrets.trackerToken` entirely and keep only the
account handle.

## Precedence

When the engine resolves a config value, later layers override earlier ones:

```
environment variable  >  config.local.json  >  config.json  >  schema defaults
```

1. **Environment variables** (highest). The right place for secrets in CI or
   ephemeral environments where writing a file is undesirable. The engine reads
   `FLOW_`-prefixed variables (for example `FLOW_TRACKER_TOKEN`,
   `FLOW_TRACKER_ACCOUNT`), and they win over both files.
2. **`config.local.json`** (per-machine). Deep-merges over `config.json`. Use it
   for your credentials and for any local override (for example forcing
   `autonomy.default` to `manual` on your own machine).
3. **`config.json`** (committed). The shared team defaults.
4. **Schema defaults** (lowest). Every field has a resolved default declared in
   the schema, so any field absent from all of the above still resolves to a
   sensible value.

### How secrets and overrides coexist

The behavioral policy schema is strict (unknown keys are rejected), and it
deliberately contains no credential fields. So the loader handles
`config.local.json` in two parts:

- The `secrets` block is read out-of-band as adapter credentials. It is never
  passed through the policy schema, so it can hold whatever your tracker adapter
  needs.
- Every other key (for example `identity`, `autonomy`) deep-merges over
  `config.json` and is validated against the policy schema like the committed
  file.

## Schema and editor validation

`config.json` references `config.schema.json` through its `$schema` key, which
gives editors inline validation and autocomplete for the behavioral policy.

`config.schema.json` is **generated**, not hand-written. The authoritative schema
is the engine's `config-schema.ts` (the Zod source of truth); the JSON Schema
artifact is produced from it. Never hand-edit `config.schema.json`. To change the
config shape, edit the Zod schema and regenerate the JSON Schema artifact.

`config.local.json` and its `.example` intentionally do not reference
`config.schema.json`: the `secrets` block lives outside the strict policy schema,
so pointing the local file at the schema would flag those fields as errors. The
policy fields you override there are still validated once the loader merges them
over `config.json`.

## Why `config.json` has no secrets

`config.json` is committed and shared, so it must stay free of tokens, API keys,
and account handles. The behavioral policy schema reflects this: identity
resolves at runtime (`agent: "auto"`, `reviewer: null`) rather than shipping a
real account, and there is no credential field anywhere in the committed config.
Anything secret or machine-specific belongs in `config.local.json` (gitignored)
or in a `FLOW_`-prefixed environment variable.
