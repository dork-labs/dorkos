# Submitting a Package to the DorkOS Marketplace

## Quick Start

1. Build your package using `dorkos package init <name> --type <type>`
2. Develop, test locally with `dorkos package validate`
3. Push your package to a public GitHub repo
4. Open a PR to this repo adding your package to `marketplace.json`

## Submission Checklist

- [ ] Package builds and validates with `dorkos package validate`
- [ ] README explains what the package does and any required setup
- [ ] LICENSE file present (MIT, Apache-2.0, or compatible)
- [ ] No hardcoded secrets or credentials
- [ ] External hosts declared in `.dork/manifest.json`
- [ ] If type is `plugin`, includes `.claude-plugin/plugin.json`

## PR Format

Add your package to the `plugins` array in `marketplace.json`, alphabetically ordered:

```json
{
  "name": "your-package-name",
  "source": "https://github.com/your-username/your-package",
  "description": "What it does in one sentence",
  "type": "plugin",
  "category": "your-category",
  "tags": ["relevant", "tags"],
  "icon": "📦"
}
```

The `featured` field is set by maintainers, not contributors.

## Validation

Our GitHub Actions workflow runs `dorkos package validate` on every submission.
PRs failing validation cannot be merged.

## Review

A maintainer will review your submission within 7 days. We check:

- Package quality and usefulness
- Code safety (no obvious malware or supply chain risks)
- Description accuracy
- Category appropriateness
