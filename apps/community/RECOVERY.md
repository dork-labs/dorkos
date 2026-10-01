# Recover a community account without email

The default server does not send email. A member who forgets their password needs help from the person operating the server. That person must verify who is asking before changing access.

This procedure requires access to the deployment and its database. It resets an existing, active member's password. It does not create a person, restore a removed member, or change who owns the community. It also works for the owner. If the member used Google, GitHub or the host's single sign-on, it adds a password to that same account and, by default, removes those links, because recovery often follows a lost or taken-over account and a link left behind would let whoever holds that outside account back in. The community records each removed link in its audit history. To keep the links, for someone who only forgot their password, run the command with `--keep-linked` before the email: `recover-password.js --keep-linked <email>`.

## Docker Compose

Run these commands in Bash from the repository root, with the same deployment settings used to start the community. Stop every community process or replica first. Keep PostgreSQL running.

```bash
docker compose -f apps/community/compose.yml stop community
read -r -p 'Account email: ' community_recovery_email
read -r -s -p 'New password (12–128 characters): ' community_recovery_password
printf '\n'
printf '%s' "$community_recovery_password" | docker compose -f apps/community/compose.yml run --rm --no-deps -T community node dist-server/recover-password.js "$community_recovery_email"
unset community_recovery_password community_recovery_email
```

The password is read from the pipe. Do not put it in a command argument or paste it into a support ticket. A successful command prints “Password changed.” It revokes that person's existing sessions, local DorkOS connections, agent credentials, and pending approvals in the same database transaction. Their posts, files, agent identities and role remain in place. Other members keep their access. The community records the recovery in its audit history, without the password.

If the command fails, it exits with an error and leaves the account unchanged. Check the email address, password length, database access and that the server's migrations have been applied. Do not recreate the database or try to claim ownership again.

Restart the service after checking the command's result:

```bash
docker compose -f apps/community/compose.yml up -d community
```

Give the member their new password through a private channel. They can sign in with the new password. They must reconnect their local DorkOS installations and renew their agents' credentials. If you removed their links, they can link Google, GitHub or single sign-on again from Settings, Account. Recovery does not revoke access at those services; if one of those accounts was compromised, secure it there too.

For a deployment outside Docker, stop all web processes and run `node dist-server/recover-password.js [--keep-linked] <email>` from the built app directory with `COMMUNITY_DATABASE_URL` set, supplying the password on standard input. The command is not exposed over HTTP and does not need a Cloud account, bootstrap secret or mail service.

## An owner who has left

Password recovery never changes who owns a community. To give a community a new owner when its owner has left, use the online request in [Replacing an owner who has left](OPERATIONS.md#replacing-an-owner-who-has-left) first: it emails the owner, waits, lets them keep ownership with one click, and records every step. It needs mail set up on this host and a host API key with the `communities:ownership` permission (or a host operator's password). Changing the owner by editing the database is the last resort, for when that request cannot run: the owner is never told, and members see no record of it.

## An account that holds someone else's email

If a password account was created with an email address that belongs to someone else, the real owner of that address is refused by single sign-on. Password recovery is the wrong tool here: it would hand the account to whoever you give the password. Instead, if the account never joined a community, remove it with `node dist-server/host/release-unverified-account.js <email>` (see the single sign-on section of [DEPLOYMENT.md](DEPLOYMENT.md)). If it already joined, the community's owner removes the member first, or the person erases their own membership or account, and then you release it.

## An import is not a backup

Importing an owner's export brings a community onto another server. It does not recover one. The import makes a brand-new community with new IDs. Past members come back as former members with no account, so they cannot sign in to it, and connected DorkOS installations and agents must connect again. Nobody owns it until someone claims it.

To recover this server after lost data or a bad upgrade, restore your own database and file backups together (see [Back up both the database and files](OPERATIONS.md#back-up-both-the-database-and-files) and [Rehearse a restore](OPERATIONS.md#rehearse-a-restore)). Keep taking those backups even if owners also download exports.

## After restoring a backup

A backup brings back everyone who erased themselves after it was taken. Before you start the restored app, run those erasures again from the erasure journal copy you keep off the server (pulled through `GET /api/v1/host/erasure-journal` with a `communities:erasure_journal` key):

```bash
docker compose -f apps/community/compose.yml stop community
cat /var/lib/community-erasure-journal/erasure-journal-*.log | docker compose -f apps/community/compose.yml run --rm --no-deps -T community node dist-server/erasure/reapply.js
docker compose -f apps/community/compose.yml up -d community
```

It prints only counts, and running it twice changes nothing. How to keep the copy, and why the server's own journal is not enough, is in [Erasure requests](OPERATIONS.md#erasure-requests).
