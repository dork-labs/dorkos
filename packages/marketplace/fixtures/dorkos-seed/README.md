# dorkos-seed

Marketplace-05 seed fixture for the Dork Labs marketplace (same-repo monorepo
pattern). This directory mirrors the layout that `dork-labs/marketplace` will
publish at `github.com/dork-labs/marketplace`:

```
.claude-plugin/
├── marketplace.json   # CC-standard marketplace index
└── dorkos.json        # DorkOS extension sidecar (type, layers, icon, pricing)

plugins/<name>/
├── .claude-plugin/
│   └── plugin.json    # CC plugin manifest stub
├── README.md          # One-paragraph description
└── skills/<name>/SKILL.md   # (agent plugins only) placeholder skill
```

The `marketplace.json` here passes `claude plugin validate` and serves as the
canonical regression fixture. Real plugin logic is scaffolded separately and
tracked outside the marketplace-05 scope.

See `contributing/marketplace-registry.md` for the full format reference and
`research/20260407_cc_validator_empirical_verify.md` for the empirical CC
validator verification result that justifies the sidecar strategy
(ADR-0236).
