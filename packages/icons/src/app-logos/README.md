# App logos

The marks the Connections page shows for the popular apps DorkOS always lists
(`apps/server/src/services/connectors/resources/built-in-apps.ts`). They ship in
the repo so they show on a fresh install, before anything is set up, and
offline. Every other app shows the logo its connection service sends, fetched
and kept by the DorkOS server.

These are other companies' trademarks, shown to identify their apps. Using them
does not mean the companies endorse DorkOS. Never change a mark's shape or
colors.

Each file is named after the app's service id, and `app-logos.ts` maps the id to
the file.

## Sources

**Simple Icons** ([simple-icons](https://www.npmjs.com/package/simple-icons)
16.33.0, CC0 1.0). The file is the package's `icons/<slug>.svg`, byte for byte,
with one attribute added to the root `<svg>`: `fill`, set to the brand color the
package records for that icon (`data/simple-icons.json`, `hex`). Simple Icons
ships each mark in one color and publishes the brand color beside it for this
use; an `<img>` cannot color a mark any other way.

| File                 | Simple Icons slug | Fill      |
| -------------------- | ----------------- | --------- |
| `airtable.svg`       | `airtable`        | `#18BFFF` |
| `asana.svg`          | `asana`           | `#F06A6A` |
| `dropbox.svg`        | `dropbox`         | `#0061FF` |
| `github.svg`         | `github`          | `#181717` |
| `gmail.svg`          | `gmail`           | `#EA4335` |
| `googlecalendar.svg` | `googlecalendar`  | `#4285F4` |
| `googledocs.svg`     | `googledocs`      | `#4285F4` |
| `googledrive.svg`    | `googledrive`     | `#4285F4` |
| `googlesheets.svg`   | `googlesheets`    | `#34A853` |
| `hubspot.svg`        | `hubspot`         | `#FF7A59` |
| `jira.svg`           | `jira`            | `#0052CC` |
| `linear.svg`         | `linear`          | `#5E6AD2` |
| `notion.svg`         | `notion`          | `#000000` |
| `telegram.svg`       | `telegram`        | `#26A5E4` |
| `todoist.svg`        | `todoist`         | `#E44332` |

**The brand's own mark.** Simple Icons does not carry these two, so the file is
the brand's own published mark, byte for byte.

| File          | Source                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outlook.svg` | Microsoft's Fluent brand icons CDN: `https://res-1.cdn.office.net/files/fabric-cdn-prod_20230815.002/assets/brand-icons/product/svg/outlook_48x1.svg` |
| `slack.svg`   | The Slack mark on slack.com (the site header of `https://slack.com/media-kit`): `https://a.slack-edge.com/9cc0056/marketing/img/nav/logo.svg`         |

All files were fetched on 2026-09-27.
