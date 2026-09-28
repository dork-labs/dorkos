# Public consumer inventory

Original baseline: `dbff5a6f6b3005d4e9815d1b3d485446528f2900`; refreshed against `5794f638160a68811382347356fd29b31ee2e911`. This is an adoption ledger, not a count of manifest dependencies. Independent consumer implementation records stay in their own repositories.

## Package and client

All package-owned families are already adopted through the client FSD facade. Dialog, AlertDialog, Sheet and outline Button lacked a matching foreground despite owning a background. The baseline browser reproduction removed only a parent text utility; the fix owns color in each primitive, with both theme directions covered. Popover, menus, HoverCard, Tooltip and Tabs already pair their backgrounds. Switch/slider/progress/scrollbar tracks are decorative, not text surfaces. Transparent fields intentionally inherit form text.

Card stays local because it uses app elevation/interactive variants. Badge combines status vocabulary and tone rules. Skeleton's breathing animation is application-owned. Other surfaces' same-named modules differ in elements, spacing and animations; no compatible second-consumer contract justifies extracting them now. Responsive wrappers, router controls, identity/domain components, Markdown, data tables and form engines stay local by their dependencies.

## Community

Existing adoption: Admission (Button/Field/Input/Notice), EntryRemoval (menu/confirmation). Remaining equivalent controls are migrated across these groups:

| Group               | Files                                                                                                                                         | Preserved application responsibility                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Account and entry   | OwnerClaim, Pairing, SignInMethods, SignOut, AdmissionPanels, CommunityAddress, ShortNameRoute                                                | Auth requests, validation, owner recovery, redirects and pairing state                                    |
| Host/administration | Manage, CommunityAdministration, HostAdministration, HostHoldControls, HostApiKeys, HostCommunityLimits, HostShortNames, Erasure, ExportPanel | Permissions, dangerous-action confirmation, server requests and pending/error states                      |
| Channel and shell   | CommunityApp, Channel, EntryCard, CommunityChooser, HoldBanner, HostLinks, DeletionRecovery                                                   | Navigation, unavailable-choice semantics, message/thread/composer geometry, attachment and focus behavior |

Use shared generic Button/Input/Textarea/Label/Notice/Separator when equivalent. Native select/date/file/radio/checkbox controls, file-upload labels, app-owned FocusDialog focus management, scrims, navigation items, thread drawer and focusable unavailable community choices remain deliberate local controls. New import/takedown code is concurrent work and must be reconciled before delivery. Remove legacy generic styling only when no longer used; native-control selectors must not override shared controls.

## Site

Live forms are reachable from the public source's route tree; they are not classified as dead based on deployment assumptions.

| Consumer                                                                   | Adoption                                     | Preserved local contract                                                                                                      |
| -------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Newsletter page, footer, blog and tutorial capture                         | Shared Button/Input/Label subpaths           | Card explicitly light, compact explicitly dark; cream typography, layout, double opt-in, honeypot and request state           |
| Feedback                                                                   | Shared Button/Input/Textarea/Label subpaths  | Category selection, payload, honeypot, error/success copy and marketing layout                                                |
| Sign-in, sign-up, reset, verification, profile                             | Shared Button/Input/Label facade             | Auth state, validation, safe redirect and server session ownership; verification keeps a real Next Link                       |
| Admin search/actions; instance activation/registry; managed account fields | Shared Button/Input/Label/AlertDialog facade | Permissions, requests, native controls, field validation and confirmation content                                             |
| Account export                                                             | Shared Button asChild                        | Real anchor with download attribute and unchanged target                                                                      |
| Error recovery and cookie consent                                          | Shared Button subpath                        | Retry callbacks, real home link, consent state and dismissal behavior                                                         |
| Documentation                                                              | Fumadocs controls                            | Framework-owned page actions, navigation and MDX behavior                                                                     |
| Marketplace browse                                                         | Existing links and presentation              | Whole-card Next Link, category/filter links and safe Markdown navigation                                                      |
| Marketing CTAs and generic site-only composites                            | Existing site APIs                           | Deliberate branded composition; carousel/calendar/sidebar/input-group/pagination depend on site Base UI render/size contracts |

The retained site `components/ui` modules support those last compositions and their current Base UI APIs. This programme does not silently replace that API underneath a carousel/calendar/sidebar or rewrite branded navigation. The operational FSD facade directly names shared implementations, so it cannot accidentally fall back to the retained site module. Card/Badge/InputOTP are local presentation or specialized composition; the remaining Select/Checkbox facade exports preserve existing site-specific APIs and are not represented as shared adoption. The superseded site AlertDialog implementation has no remaining callers and is removed. No newly duplicated primitive is added.

## Distribution and proof

Workspace consumers build the public package before CSS scanning. The site replaces its separate animation import with the shared Tailwind entry, with no second reset or root palette rewrite. An independent consumer installs the exact packed archive with no source alias, tests all exports/declarations/CSS, and verifies one React runtime. Publication and registry upgrade are separate gates from extraction and adoption.
