# App logos

The marks the Connections page shows for the popular apps DorkOS always lists
(`apps/server/src/services/connectors/resources/built-in-apps.ts`). They ship in
the repo so they show on a fresh install, before anything is set up, and
offline. Every other app shows the logo its connection service sends, fetched
and kept by the DorkOS server.

These are other companies' trademarks, shown to identify their apps. Using them
does not mean the companies endorse DorkOS.

## The rule

Every file is the brand's own published mark, byte for byte: downloaded from the
brand's own site, CDN or brand kit, and never edited. The one exception is a
Simple Icons file, used only when the brand's mark is a single flat color and
Simple Icons' color matches the brand's own file exactly. A Simple Icons file
ships one color-less path, so it carries one added attribute on its root
`<svg>`: `fill`, set to that color.

To add or update a mark, download it again from the source below, check it has
no script or external reference in it, and record the URL and date here. Each
file is named after the app's service id, and `app-logos.ts` maps the id to the
file.

## The brand's own files

| File                 | Source                                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `airtable.png`       | Airtable's brand kit, linked as "Brand assets" from `https://www.airtable.com/newsroom` (an Airtable shared view, `https://airtable.com/appA7j0QSl46txyIa/shrBPDdtZsWdsQPrX`), record "Logomark: Black", file `Airtable_Icon_Black.png`. The kit offers the mark only in black or white; there is no color version |
| `dropbox.svg`        | `https://cfl.dropboxstatic.com/static/images/logo_catalog/dropbox_logo_glyph_2015_m1.svg`                                                                                                                                                                                                                          |
| `github.svg`         | GitHub's logo kit, `https://brand.github.com/GitHub_Logos.zip`, file `GitHub Logos/SVG/GitHub_Invertocat_Black.svg`                                                                                                                                                                                                |
| `gmail.svg`          | `https://fonts.gstatic.com/s/i/productlogos/gmail_2020q4/v10/192px.svg`                                                                                                                                                                                                                                            |
| `googlecalendar.svg` | `https://fonts.gstatic.com/s/i/productlogos/calendar_2020q4/v10/192px.svg`                                                                                                                                                                                                                                         |
| `googledocs.svg`     | `https://fonts.gstatic.com/s/i/productlogos/docs_2020q4/v12/192px.svg`                                                                                                                                                                                                                                             |
| `googledrive.svg`    | `https://fonts.gstatic.com/s/i/productlogos/drive_2020q4/v10/192px.svg`                                                                                                                                                                                                                                            |
| `googlesheets.svg`   | `https://fonts.gstatic.com/s/i/productlogos/sheets_2020q4/v10/192px.svg`                                                                                                                                                                                                                                           |
| `hubspot.png`        | HubSpot's site icon, `https://www.hubspot.com/hubfs/HubSpot_Logos/HubSpot-Inversed-Favicon.png`                                                                                                                                                                                                                    |
| `jira.svg`           | The Jira icon on `https://www.atlassian.com/software/jira`, from Atlassian's asset library: `https://dam-cdn.atl.orangelogic.com/CDNLink/AT14G4B.svg`                                                                                                                                                              |
| `linear.svg`         | Linear's brand kit, `https://static.linear.app/design-assets/Linear-Brand-Assets.zip`, file `linear-icon.svg`                                                                                                                                                                                                      |
| `notion.png`         | Notion's app icon, `https://www.notion.com/front-static/logo-ios.png`                                                                                                                                                                                                                                              |
| `outlook.svg`        | Microsoft's Fluent brand icons CDN: `https://res-1.cdn.office.net/files/fabric-cdn-prod_20230815.002/assets/brand-icons/product/svg/outlook_48x1.svg`                                                                                                                                                              |
| `slack.svg`          | The Slack mark on slack.com (the site header of `https://slack.com/media-kit`): `https://a.slack-edge.com/9cc0056/marketing/img/nav/logo.svg`                                                                                                                                                                      |
| `telegram.svg`       | `https://telegram.org/img/t_logo.svg`                                                                                                                                                                                                                                                                              |
| `todoist.svg`        | Doist's press kit, `https://doist.com/brand-assets/todoist-logo.zip`, file `Icon/Color.svg`                                                                                                                                                                                                                        |

## Simple Icons

From [simple-icons](https://www.npmjs.com/package/simple-icons) 16.33.0 (CC0 1.0),
`icons/<slug>.svg`, with the `fill` attribute described above.

| File        | Simple Icons slug | Fill      | Why it qualifies                                                                                                                                                        |
| ----------- | ----------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asana.svg` | `asana`           | `#F06A6A` | Asana's mark is one flat coral. Its own logo file (`https://assets.asana.biz/m/5f083bc48e06e1e2/original/asana-logo-1200x1200.png`) draws the dots in exactly `#F06A6A` |

All files were fetched on 2026-09-27.
