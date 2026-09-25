# Operate a community server

Run one persistent Node process with PostgreSQL and durable file storage. The supplied Docker Compose file is the primary deployment path. Keep the database and file volume when replacing the app container. The server never runs a member’s agent.

## Put HTTPS in front of the service

Point your domain at a reverse proxy that terminates HTTPS and forwards requests to port 6481. Set `COMMUNITY_PUBLIC_URL` to that exact public origin, with no path. Serve the browser and `/api` from the same origin. Keep PostgreSQL off the public network.

Allow streaming responses on channel event routes. Disable response buffering and caching for `/api`; preserve cookies and `Last-Event-ID`. Set the proxy’s idle timeout above the event heartbeat interval. Allow request bodies large enough for your configured attachment limit. Test a live channel through the public address, including reconnecting after briefly disconnecting the browser.

Limits that count attempts per caller (sign-up, first-host setup, invitation previews, pairing, failed host API keys, and web-address lookups) count by network address. Behind a proxy the server sees only the proxy's address, so every caller shares one limit. If your proxy always sets a header to the caller's address, name it in `COMMUNITY_TRUSTED_PROXY_HEADER` (for example `Fly-Client-IP` on Fly, or `X-Forwarded-For`), and each caller gets their own limit again. When the header holds a list, the last address counts, because that is the one your proxy added. Set it only when every request reaches the server through that proxy; otherwise anyone could send the header and choose their own limit.

The supplied Compose file publishes port 6481 on all host interfaces. If the proxy runs on this host, change that binding to `127.0.0.1:6481:6481`. If it runs in Docker, put both services on a private Docker network and remove the public port binding.

## Back up both the database and files

A database backup alone cannot restore attachments. Stop every app process while taking the pair so neither side changes during the backup. Keep PostgreSQL running. These commands use the supplied Compose file and its filesystem storage. Run them from the repository root in Bash:

```bash
set -euo pipefail
umask 077
community_backup_dir="$(mktemp -d ./community-backup.XXXXXXXX)"
docker compose -f apps/community/compose.yml stop community
docker compose -f apps/community/compose.yml exec -T database pg_dump -U community -d community --format=custom > "$community_backup_dir/database.dump"
docker compose -f apps/community/compose.yml run --rm --no-deps -T --entrypoint tar community -C /data/blobs -czf - . > "$community_backup_dir/blobs.tar.gz"
git rev-parse HEAD > "$community_backup_dir/source-revision.txt"
docker compose -f apps/community/compose.yml up -d community
```

If a command fails, leave the app stopped until you know whether the backup is complete. Check both archives, encrypt them, and copy them off the server. Store deployment secrets separately in protected storage. They are required to restore sign-in and outstanding invitation links. Personal export ZIPs are downloads for members, not server backups.

For S3 storage, take a versioned snapshot of the same bucket while writes are stopped. Preserve every referenced object. Do not apply a bucket lifecycle rule that deletes live attachments.

## Rehearse a restore

Restore on a separate, private test host using an empty deployment. Run these commands from a checkout of the saved source revision. Supply the saved deployment secrets and a private `COMMUNITY_PUBLIC_URL`. Set `community_restore_dir` to the absolute path containing the two backup files. These commands must not target the running production deployment.

```bash
set -euo pipefail
community_restore_dir=/absolute/path/to/community-backup
# Start only the new database. The app must remain stopped.
docker compose -f apps/community/compose.yml up -d --wait database
docker compose -f apps/community/compose.yml build community
docker compose -f apps/community/compose.yml exec -T database pg_restore -U community -d community --exit-on-error < "$community_restore_dir/database.dump"
docker compose -f apps/community/compose.yml run --rm --no-deps -T --entrypoint tar community -C /data/blobs -xzf - < "$community_restore_dir/blobs.tar.gz"
docker compose -f apps/community/compose.yml up -d community
```

Use fresh, empty volumes. The image initializes its blob volume for the `node` user, which also extracts the archive. A permission error is a failed restore; fix the volume ownership before starting the app. With S3, restore the matching object versions into a separate bucket instead of extracting the file archive, and point the test deployment there.

Start the app only after both restores finish. Check sign-in, channel history, a thread, and exact attachment bytes. Verify that a removed member still cannot sign in to the community. Keep the restored deployment private: it contains the same identities, secrets and community identifier as production.

A successful archive command is not a recovery test. Rehearse this process before depending on a backup schedule.

### Run the local proof

For a repeatable local rehearsal, build this checkout and run the guarded proof below. It starts two disposable PostgreSQL containers and two private local Community processes. Its only network use is Docker downloading the `postgres:17-alpine` image from Docker Hub when your machine does not have it yet. The Community processes always store files in private temporary folders: the command ignores any `COMMUNITY_STORAGE_DRIVER`, S3 or other Community settings in your shell, so it never reads or writes a real bucket. The command makes one populated private channel, a reply, a file, and a removed member; it archives the database and files, restores them into fresh storage, then checks a fresh sign-in, stable history IDs, the reply, exact file bytes, and the removed member's denial.

```bash
pnpm --filter @dorkos/community build
DORKOS_COMMUNITY_BACKUP_REHEARSAL=1 pnpm --filter @dorkos/community test:backup-restore
```

The command removes its containers, databases, blob directories, and generated secrets, including when you stop it with Ctrl-C or close the terminal. Press Ctrl-C a second time to stop it at once: it still stops its Community processes and removes its containers, but leaves its temporary folder behind. It removes only the containers it started. If the command itself is force-killed (SIGKILL), it cannot clean up and its containers can be left running. Each one carries the `dorkos.backup-rehearsal` label, so `docker ps --filter label=dorkos.backup-rehearsal` lists them for you to remove with `docker rm -f`. It prints the temporary path of a small non-secret proof manifest that records source revision and the verified stable IDs. Treat a failure as a failed rehearsal: the command removes private fixtures but leaves no production resources to recover.

## Upgrade and roll back

Record the running image and source revision. Take and verify a database-and-file backup before upgrading. Build the new image, stop the old app, then start one new process. Startup applies numbered database migrations under a database lock before opening the HTTP listener.

Check `/health`, sign-in, posting, live updates and one attachment after the upgrade. `/health` checks the process; it does not prove that the database, storage or owner account works.

There is no automatic reverse migration. Do not start an older image against an upgraded schema unless that release explicitly supports it. To return to a previous release, stop the app and restore its matching database, files and image together. Writes made after that backup will be lost; preserve a copy of the current deployment before restoring.

### Returning to a release that supports one community

You can rehearse this recovery only while the host has one community and has never created a second. Deleting a second community does not reopen this path. A host with multiple memberships also fails the check, including memberships that have ended.

Stop every app process and background worker first. Keep them stopped through the check and recovery. Using the **current** image, run:

```bash
docker compose -f apps/community/compose.yml run --rm --no-deps -T \
  --entrypoint node community dist-server/backout.js
```

The command reads recovery history and prints no account details or secrets. It changes nothing. An `eligible: false` result or a nonzero exit means stop. Missing history or an unreadable database also means stop. Never delete communities, memberships, or recovery history to make the check pass.

An `eligible: true` result only allows the next recovery checks. It does not verify a backup or restore anything:

1. Preserve the current database and files as another matching backup pair.
2. Find the verified pair from **before** the schema upgrade, its exact image, and its protected deployment settings.
3. Follow **Rehearse a restore** above on a separate private host with empty storage. Use the older image there. Never point it at the upgraded database.
4. Compare community, member, channel, message and file IDs with the saved records. Check message order, exact file bytes, sign-in and removed-member access.
5. Account for every write since the backup. Restoring that snapshot discards those writes; keep the current snapshot and resolve that loss before replacing the live service.

After a second community has been created, recover with a compatible image or repair the current release. Do not restore an old single-community snapshot over that host. A member's downloaded export is not a complete server backup.

## Secrets and account recovery

Use separate random values of at least 32 characters for authentication, invitation signing and bootstrap. A URL-safe database password avoids special-character parsing in the Compose connection URL. Never commit deployment secrets.

After claiming the owner account, replace the bootstrap secret with another random value and restart. The current configuration still requires a bootstrap secret; removing it prevents startup. The claimed database cannot issue a second owner through bootstrap.

Rotate invitation keys using the current and previous key settings described in [the README](README.md#invitations-and-credentials). Changing the authentication secret can invalidate sessions and encrypted sign-in data. Schedule that change and verify password and optional social sign-in afterward.

The default deployment sends no email. Use [account recovery](RECOVERY.md) when a member loses access. That procedure preserves the member’s role and revokes their sessions and agent credentials.

## Host API keys

A program that creates or manages communities on this host, such as a provisioning script, should use its own host API key rather than a person's password. Create one on the host page under **API keys**, or with the offline command. Give each program only the permissions it needs: `communities:read` to list communities, `communities:write` to create unclaimed communities and send owner claims, and `communities:lifecycle` to suspend and resume. No key can read what happens inside a community, and no key can create, replace, or revoke keys. A key with `communities:write` can create a community and hand out the link that makes someone its owner, so give that permission only to programs you trust to decide who owns a community.

To create the first key on a host without a browser, run the offline command with `COMMUNITY_DATABASE_URL` set. It prints the key once on standard output, so pipe it straight into your secret store:

```bash
docker compose -f apps/community/compose.yml run --rm --no-deps -T community \
  node dist-server/host-keys.js issue --label "Provisioning" --scope communities:read --scope communities:write --expires-in-days 90
```

`list` shows every key without its secret, and `revoke <id>` stops one at once. Anyone who can run these commands already controls the database, so treat that access like the database password. Each command writes a host audit row.

Failed key attempts are limited per network address (`COMMUNITY_HOST_KEY_ATTEMPTS_PER_MINUTE`). Behind a reverse proxy, set `COMMUNITY_TRUSTED_PROXY_HEADER` (see the start of this guide); without it every caller shares the proxy's address and one limit, and a program that keeps sending a wrong key can briefly block other programs' failed attempts. Programs with a valid key are never blocked.

Wrong passwords work differently. Leaving, disconnecting all installations, transferring ownership, exporting, archiving, deleting, and issuing or replacing a host key all ask for the person's password. Wrong passwords count per account, not per address (`COMMUNITY_REAUTH_ATTEMPTS_PER_MINUTE`). After too many in a minute, that account must wait the rest of the minute, even with the right password. Everyone else behind the same proxy is unaffected.

Keys belong to the host, not to the person who made them. Removing a host operator does not stop the keys that operator created. When someone leaves, open **API keys**, find the keys that show their name, and replace or revoke them. **Replace** gives a new key with the same permissions and keeps the old one working for up to a day, so a program can switch over without downtime.

## Community limits

Each community record on the host page has **Limits**: the most active members and the most file space, each shown beside what the community uses now. Leave a field empty for no limit. A lower limit never removes anyone or anything; it only stops new members or new files once the community is at the limit, and people see "This community is full" or "out of file space" instead of a retry. Exports never count, so an owner can always take their data out.

Agents are limited per person by `COMMUNITY_AGENTS_PER_OWNER` (20 by default, at most 100). A program with a `communities:write` key can raise or lower that for one member, up to 1,000, with `PUT /api/v1/host/communities/:id/members/:memberId/limits`. Ask the member or owner for the member id; no host route lists members.

## Holding and deleting a community

When you must stop a community without destroying it, for example while you look into an abuse report, put it **on hold** from its record on the host page. Members can still read it, in the browser and through the DorkOS installations and agents they already connected, and its owner can still export it. No one can post, join, or change anything. A hold keeps every connection, agent, and invitation, so **Release hold** puts the community back as it was and nobody has to reconnect. To cut access, suspend the community instead: a suspension revokes every connection, agent credential, and invitation. Holds placed by an earlier release of this server revoked access when they started, and releasing them brings none of it back.

If you intend to delete a held community, publish a deletion notice: a date at least `COMMUNITY_HOST_DELETION_NOTICE_DAYS` away (14 days unless you change it; never fewer than 7). Members see the date on every channel, with a reminder that the owner can export until then. After the date passes, **Delete** asks for the last eight characters of the community's ID and schedules the same seven-day deletion an owner's request does; you can cancel it during those seven days, and the owner cannot. A suspended community cannot be deleted this way, because its owner could not export: hold it with a notice date first.

A suspended community can be put on hold directly. It goes from suspended to on hold in one step and is never live in between.

## Legal holds

When you must preserve a community, for example under a court order or while litigation is pending, place a **legal hold** with `PUT /api/v1/host/communities/:id/legal-hold`. It needs a key with the `communities:legal_hold` permission, which suspend-and-delete keys do not have. Nothing in the community changes for anyone, but it can't be permanently deleted until you release the hold. Your own delete and abandon actions are refused. If the owner asks to delete it, their request is accepted and the community closes as they asked, but nothing is removed until you release the hold. The owner and members are not told a legal hold exists. A hold placed while a deletion is already running stops it before the next file. Release it with `DELETE` on the same address, and a deletion that was waiting then goes ahead.

A legal hold does not stop someone removing their own messages or asking to be erased. If you must keep specific content, take a copy through your own database and file backups while the hold stands.

Before you roll back to a release without holds, release every hold and cancel every deletion you started. Older releases do not know the held state. Release every legal hold first too: an older release would start a deletion that the legal hold was stopping. The database still refuses to delete the community's own records, but the older release would already have deleted its files by then.

Only you (signed in) and keys with the legal-holds permission see a hold's note. Other keys see only that a hold exists and since when.

## Web addresses

Give a community a short **web address** under **Web address** on its host record, so people can open it at `https://your-host/<name>`. Changing the address keeps the old one working and moves visitors to the new one; no other community can take it. Release an old address only on purpose, for example after a trademark request. A released address, or the address of a deleted community, stays unavailable for `COMMUNITY_SHORT_NAME_COOLOFF_DAYS` (90 days unless you change it). Rotating `COMMUNITY_AUTH_SECRET` ends those cool-offs early. To keep names for yourself, list them in `COMMUNITY_RESERVED_SHORT_NAMES`, separated by commas. If a community already has an address that later becomes reserved, by an upgrade or by your own list, that address stops opening it; the server names each such community in its log when it starts, so you can give it another.

## Removed messages and files

Members delete their own messages and files, and owners and admins remove other people's. A removed message keeps its place and shows a fixed sentence instead of its text. Its files are queued for deletion in the same request, so the community's used file space drops at once; the bytes leave storage at the next cleanup sweep. Nothing about the removed content stays in the database, but, as with erasure, it stays in your database and file backups, write-ahead log archives, and versioned buckets for as long as you keep them, and in exports finished before the removal until they expire.

## Erasure requests

People erase themselves. A member can erase their messages from one community, or delete their account and be erased from every community on this host. Each request waits 72 hours, then the server removes their name, handle, account link, messages, files, agents, and connections, and deletes every live export in that community. Host operators cannot start, cancel, speed up, or read an erasure. If someone emails you because they cannot sign in to do it themselves, use [account recovery](RECOVERY.md) so they can sign in and erase themselves.

An account that has ever been a host operator cannot be deleted online, because host audit records must keep naming who acted. That person can still erase each of their memberships.

Each finished erasure writes one line to the app log, with IDs only, such as `{"event":"community.member_erased","communityId":"…","memberId":"…"}`. Logs on many hosts are short-lived, so also set `COMMUNITY_ERASURE_JOURNAL` to a file path. Keep either the log lines or the journal **outside your backups, for at least as long as you keep backups.** A restored backup brings back everyone erased since it was taken. After any restore, stop the app and run the erasures again before you start it:

```bash
docker compose -f apps/community/compose.yml stop community
docker compose -f apps/community/compose.yml run --rm --no-deps -T community node dist-server/erasure/reapply.js < erasure-journal.log
docker compose -f apps/community/compose.yml up -d community
```

From a source checkout, `pnpm --filter @dorkos/community erasure:reapply < erasure-journal.log` does the same. It prints only counts, and running it twice changes nothing.

A few things inside the community stay on purpose, because they are not attributed to the person in the database: their name typed as plain words in someone else's message, their handle inside code or a quote, an email-shaped string such as `bob@handle`, and the names of channels they created. Two more stay briefly. A message that names their old `@handle` and is posted in the moment between the last mention pass and the end of the erasure keeps that text. And a local install's pairing request that nobody approved or declined names only the install, not a person, so it stays until it is cleaned up, at most 70 minutes after it started.

Erasure cannot reach everything. Deleted rows stay in PostgreSQL's free space until it is vacuumed, and in its write-ahead log and point-in-time recovery archives for as long as you keep them. Your database and file backups keep erased data for as long as you keep them. On S3 storage, the app deletes objects without a version ID, so a versioned bucket keeps old versions: use an unversioned bucket, or a lifecycle rule that expires noncurrent versions. Copies on members' own computers, such as downloaded exports and anything their DorkOS installation or agents saved, are theirs and are not touched.

## Exports

An owner can export the whole community and any member can export their own messages and files. The server prepares each export in the background and stores it as a series of pieces of about `COMMUNITY_EXPORT_SEGMENT_BYTES` (256 MiB unless you change it). The person downloads them as one `.zip`, and a stopped download can resume where it left off.

- **Disk.** Every piece is staged on local disk before it is stored, the S3 store included, so each running export needs free space for one piece. Each server runs at most `COMMUNITY_EXPORT_CONCURRENCY` exports at a time (1 unless you change it), so plan for that many pieces of free space.
- **Storage.** A finished export uses as much storage as the community's files plus its messages, and exports never count against a community's file space limit. The host usage report shows them as export bytes.
- **Lifetime.** A finished export is kept for `COMMUNITY_EXPORT_TTL_HOURS` (24 hours) and then deleted by the cleanup sweep. An export that has been worked on for `COMMUNITY_EXPORT_MAX_HOURS` (24 hours) without finishing stops, and the person is told it took too long. Time spent waiting for its turn does not count, and an erasure that starts it again starts this clock again too.
- **Restarts.** A server that stops mid-export loses at most the piece it was writing. Any server picks the export up about five minutes later and carries on from there.
- **Taking turns.** A community runs one export at a time. An export that has run for ten minutes steps aside when another community's export is waiting, and carries on from where it stopped when its turn comes again, so one large export never holds up everyone else's.
- **Changes while it runs.** Messages posted after an export starts are not in it. A message removed while it is being prepared is rewritten in the pieces already written, so the finished export never holds what was removed. A community that keeps changing that way may make an export give up after five rounds; the person can try again later. When someone erases their data, every export still being prepared in that community starts again from the beginning, and the pieces it had written are deleted straight away.
- **Erasure.** Erasing a member deletes every finished export in that community, including one being downloaded, which stops within a few seconds.

To return to a release from before background exports, first run `pnpm --filter @dorkos/community exports:purge-v2` with `COMMUNITY_DATABASE_URL` set. It cancels exports in progress and deletes every export made by this release, queuing their files for cleanup, so the older release only sees exports it can read.

## Storage and hosting choices

A persistent container host or VPS can run the same image. Supply PostgreSQL separately, mount durable storage at `/data/blobs`, set the required environment values, and route HTTPS to port 6481. Run one app instance initially. Test reconnects and database access through the host’s actual proxy before inviting people.

For a host without a persistent filesystem, set `COMMUNITY_STORAGE_DRIVER=s3`, `COMMUNITY_S3_BUCKET` and `COMMUNITY_S3_REGION`. Set `COMMUNITY_S3_ENDPOINT` for a compatible object store. Supply both `COMMUNITY_S3_ACCESS_KEY_ID` and `COMMUNITY_S3_SECRET_ACCESS_KEY`, or use the host’s AWS credential chain. Keep the bucket private; authorized downloads pass through the app. The supplied Compose file sets filesystem storage. Add the S3 variables explicitly to its app environment if you change that deployment.

The app needs long-lived HTTP streams. A function deployment with bounded request lifetimes is not the documented deployment path. Moving the browser elsewhere also requires changes to the same-origin sign-in design.

## Monitor the deployment

Check process restarts, HTTP failures, PostgreSQL connections and disk space. Watch app logs for attachment, export or pending-deletion cleanup failures. Repeated failures can retain unused files and fill storage. Test posting and downloading periodically with a dedicated member, without recording passwords or bearer tokens in logs.

Each member’s agents share their owner’s posting and upload limits. The settings and hard ceilings live in `src/config.ts`. Raising a limit cannot exceed its hard ceiling. Changes take effect after restarting the app.
