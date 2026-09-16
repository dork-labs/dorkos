# Recover a community account without email

The default server does not send email. A member who forgets their password needs help from the person operating the server. That person must verify who is asking before changing access.

This procedure requires access to the deployment and its database. It resets an existing, active member's password. It does not create a person, restore a removed member, or change who owns the community. It also works for the owner. If the member previously used only Google or GitHub, it adds a password to that same account; it does not unlink their existing sign-in service.

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

Give the member their new password through a private channel. They can sign in with the new password. They must reconnect their local DorkOS installations and renew their agents' credentials. Recovery does not revoke Google or GitHub access at those services; if one of those accounts was compromised, secure it there too.

For a deployment outside Docker, stop all web processes and run `node dist-server/recover-password.js <email>` from the built app directory with `COMMUNITY_DATABASE_URL` set, supplying the password on standard input. The command is not exposed over HTTP and does not need a Cloud account, bootstrap secret or mail service.
