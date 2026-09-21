---
slug: community-switcher-navigation
number: 260920-205153
created: 2026-09-20
status: ideated
linear-issue: DOR-2183
project: Community Navigation
---

# Community switcher and navigation

## Intent and assumptions

DorkOS needs one calm, persistent way to move among the local installation and every independent Community a person has connected. The interaction should feel as immediate as switching Slack workspaces while preserving DorkOS's existing agent-first Home, Today, and Library experience.

Assumptions:

- The local installation remains a complete destination. It owns agents, sessions, local rooms, tasks, connections, and settings; it is labelled with the installation name rather than the technical word “Local.”
- A remote destination is identified by the local owner plus `CommunityConnectionDescriptor.ref`; the remote immutable community UUID remains part of every qualified server request.
- DOR-2171 supplies same-host tenant-qualified routes and identities. DOR-2179 supplies create, join, invite, leave, sign-in, and installation-connection journeys. DOR-2175 supplies tenant-aware administration and lifecycle states.
- The current `/channels?community=<ref>&id=<roomId>` address is a valid foundation. Navigation state belongs in the URL and server-backed preferences, not a second global selected-community store.
- DorkOS Cloud is not required.

Out of scope: implementing tenancy, membership admission, community administration, provider provisioning, a public directory, cross-host identity federation, or a combined inbox that copies message content across communities.

## Codebase findings

- `CommunityChannelGroups.tsx` appends every connected community and all of its channels below the local Library. This works for a few channels but provides no community-level context, order, keyboard switch, or privacy boundary during rapid navigation.
- `CommunityConnectionDescriptor` carries a stable local `ref`, remote UUID, label, pinned origin, member identity, and pending/connected status. It has no presentation icon, lifecycle availability, last-opened destination, order, or split unread/mention summary.
- TanStack Query keys already begin with `['communities', ref]`, and remote room routes carry both community ref and room ID. Draft delivery is also community-qualified.
- `RemoteCommunitySurface` subscribes per community and room, but a complete switch contract must cancel old reads, close old streams, key the visible boundary, and keep late mutation receipts attached to their original destination.
- Desktop navigation uses a persistent sidebar. Phone navigation uses four bottom destinations and opaque panels; it deliberately has no generic sidebar drawer. A fifth permanent tab would compete with core DorkOS destinations.

## Options considered

### Placement

1. Permanent icon rail: fast and familiar, but consumes scarce width, scales poorly to many communities, and visually demotes the local agent workspace.
2. Put remote communities inside Library: minimal change, but repeats today's unbounded list and gives no clear active context.
3. **Selected:** one shared community trigger in persistent shell chrome. It opens an accessible desktop popover and phone bottom sheet. Selecting a destination swaps the contextual navigation body while the local installation remains one explicit destination.

### State authority

1. Global selected-community store: easy to wire, but can disagree with deep links, reload, back/forward, and multiple windows.
2. **Selected:** derive active destination from the qualified route. Persist only order and each destination's last authorized sub-route. URL navigation is the commit point.

### Attention

1. One unread dot: compact, but hides the difference between general activity and messages directed at the person.
2. **Selected:** show mentions as the stronger signal and other unread activity as a quieter signal. Aggregate counts contain no message text and are returned only for authorized memberships/connections.

## Decisions

| Decision          | Choice                                                                                                               | Rationale                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Local destination | Keep it as the named DorkOS installation                                                                             | Agents and local work remain complete without any Community.                                 |
| Desktop surface   | Trigger plus popover; contextual sidebar body                                                                        | Preserves width and the established sidebar model.                                           |
| Phone surface     | Same trigger plus bottom sheet; no fifth tab                                                                         | Keeps four primary destinations and gives touch targets room.                                |
| Selection source  | Qualified URL                                                                                                        | Deep links, reload, history, and multiple windows agree.                                     |
| Switch privacy    | Blank/skeleton the new keyed boundary before rendering cached data; abort old reads and streams                      | Old community content can never flash under a new identity.                                  |
| Ordering          | Owner-scoped local preference by connection ref, with keyboard-accessible move controls                              | Manual order is durable without making it a host-wide membership fact.                       |
| Offline behavior  | Keep destination selectable and label saved content as offline                                                       | A network failure does not silently change identity or route.                                |
| Add action        | A menu of Connect existing, Join by invitation, Create on this host, and Deploy a new host, shown only when eligible | These actions have different authority and must not collapse into one ambiguous plus button. |

## Result

Proceed to SPECIFY and DECOMPOSE. DOR-2184 owns switching, shell surfaces, and per-community view state. DOR-2185 connects lifecycle and membership actions after their upstream contracts land. DOR-2186 proves accessibility, race safety, and cross-community isolation.
