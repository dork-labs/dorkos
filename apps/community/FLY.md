# Deploy Community on Fly.io

Run your own Community on Fly.io with one persistent Machine, PostgreSQL, and a private Tigris bucket for files. Members use local Community accounts. DorkOS Cloud is not required.

This guide describes the current server: **one community per deployment**. Connecting DorkOS to several deployments already works. Hosting several communities inside one deployment is separate, planned work.

This is a deployment recipe, not a claim that a production Fly deployment has been verified. Complete the acceptance checks below before inviting people.

## Use guided setup

The packaged CLI can create and verify the Fly app, a separate Neon project, and a private Tigris bucket. It resolves an exact signed Community image, shows the full plan, and waits for you to type the planned app name before it creates anything.

Install and sign in to the required command-line tools first:

```sh
gh auth login
fly auth login
neonctl auth
dorkos community deploy --help
```

Setup uses those saved sign-ins unless you export a token first. If you do, it hands the token to `fly` or `neonctl` unchanged, says in one line which one it is using, and never writes it to the recovery journal or to anything it prints. An empty variable is ignored.

- **Fly:** set `FLY_API_TOKEN` (or `FLY_ACCESS_TOKEN`, which Fly reads first). Setup creates a new app, so it needs an organization token from `fly tokens create org` for the organization you pass to `--fly-org`. A deploy token from `fly tokens create deploy` belongs to one existing app and cannot create apps.
- **Neon:** set `NEON_API_KEY` to a key for the organization you pass to `--neon-org`. A key limited to one project cannot create the new project setup makes.

If a token or key cannot do what setup needs, setup stops and says so, naming the variable and the organization. It never prints the token. When the check before the plan is refused, nothing has been created. When a create is refused, that create made nothing. If it was the first one, setup keeps no record, so get a token that can and run setup again. If something was already made, setup prints the resume command; use it once you have a token that can.

Setup has not yet been tested end to end with a limited Fly token. Until it has, signing in with `fly auth login` is the tested path.

The one-time owner handoff needs a working desktop clipboard session: `pbcopy` on macOS, `wl-copy` in an active Wayland session on Linux, or `clip.exe` on Windows. Before consent, the launcher checks that the local command and desktop session are available. After consent and before it creates any resources, it asks before replacing your current clipboard with harmless test text and runs the exact copy command. It offers to open the browser, but always prints the non-secret owner setup URL if no opener is available.

Choose the organizations and nearby regions yourself. The command does not silently select an account or region. Run a read-only preview first:

```sh
dorkos community deploy \
  --fly-org your-fly-org \
  --fly-region ord \
  --neon-org your-neon-org-id \
  --neon-region aws-us-east-2 \
  --app-name your-community-app \
  --dry-run
```

Remove `--dry-run` to start setup. The command creates a recovery journal under your DorkOS data directory and prints its path. If setup stops, it keeps every confirmed resource and prints its owner, possible charges and stored data, read-only inspection commands, provider pages, and a complete command with `--resume <run-id>`. It never deletes a paid resource unless it can prove your launch made it and you confirm. Pressing Control-C stops the current bounded operation before returning and saves the last confirmed state. List saved work with `dorkos community deploy --list-incomplete`.

Before it creates each resource, setup saves a random code in the recovery journal and attaches it to what it creates. The Fly app gets its own private network named `dorkos-` plus that code, and the Neon database role is named `community_` plus a code of its own. The codes are not secret. They let DorkOS check later that a leftover resource came from your launch and not from someone else. Because of the separate network, the app cannot reach your other Fly apps over Fly's private network. Community does not need to. Fly may keep a custom network after its app is destroyed, which would leave one empty network named `dorkos-…` behind in your Fly organization for each launch attempt, including an attempt you removed and started again. This has not been checked: Fly offers no way for DorkOS to look a network up once its app is gone, so check your organization in the Fly dashboard if it matters to you.

Sometimes setup cannot tell whether a create worked, for example when a request times out. It stops and says the outcome is uncertain. If it had already saved the new resource's id, `--resume` checks that resource itself. If it had not, the recovery text gives a second command:

```sh
dorkos community deploy --remove-uncertain <run-id>
```

It reads the one unresolved resource, a Fly app, a Neon project or a Tigris file bucket, and removes it only when DorkOS can prove your launch made it. For an app or a project, the proof is the code that setup saved before the create, read back from that resource, plus a creation time within a few minutes of the request. A bucket has no code of its own. Instead, it must be attached to your launch's Fly app, and that app must still carry your launch's code. When DorkOS can prove it, it shows the resource, its owner, when it was made and what it holds, and asks you to type the resource's id: for a Fly app, its internal id (never its name); for a Neon project, the project id; for a bucket, the add-on id. Just before deleting, it checks everything again. Removing a bucket deletes every file in it, and takes the bucket's access key (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`) off your Fly app. The files cannot be recovered. Tigris keeps the access key itself, and it still works: Fly does not delete it with the bucket, and DorkOS cannot. After the removal, DorkOS shows you how to delete it. Run `fly storage dashboard --org <your-org>`, open Access Keys, and delete the key named after the bucket (usually `<bucket>_access_key`). Or use the Tigris command-line tool: `tigris login oauth` (choose "Sign in with Fly"), `tigris access-keys list` to find the key's id (it starts with `tid_`), then `tigris access-keys delete <id>`. When it finds nothing by that name, and your launch had made nothing else, it deletes that launch's recovery journal, so `--list-incomplete` stops listing it. It waits until the create is at least 12 minutes old, because a create that was cut off can still finish; before that, it keeps the journal and tells you when to run it again. When it cannot prove it, it removes nothing and prints the reason with the commands to check and remove it yourself. A launch started before these codes existed can never be proved. Outside a terminal, add `--confirm <id>` with the id it printed; the same checks still apply. After a removal, `--resume` continues the same launch. If Fly is still releasing the app name, wait a few minutes and resume again.

Fly may require you to accept the Tigris terms separately. The command checks the current terms state and pauses for an explicit second confirmation before creating the bucket. Owner signup remains in Community's own browser page. After signup, the command applies a replacement Setup secret and asks you to confirm one post and one private attachment round trip.

An exact DorkOS release is available to this command only after its Community image and signed release manifest finish publishing. A not-ready version stops before the resource consent step. Use `--version X.Y.Z` to request an exact version; there is no mutable-tag fallback.

The final screen distinguishes a healthy deployment from recovery readiness. The launcher checks the pinned image, one Machine, applied secrets, and `/health`. It does not rehearse a restore. Tigris snapshots are a separate operator choice; configure and rehearse matching Neon database and Tigris file restores before relying on recovery.

The manual recipe below remains available for recovery and audit.

## Prepare the app manually

Install [flyctl](https://fly.io/docs/flyctl/install/), sign in with `fly auth login`, and choose the Fly organization that will own the app and bucket. You also need access to the PostgreSQL account you choose below. Each service bills its owning account.

Use a checkout of the DorkOS release you intend to deploy. Run every command below from the repository root. The Docker build needs the whole monorepo, not just `apps/community`. See Fly's [monorepo deployment guide](https://fly.io/docs/launch/monorepo/).

```sh
fly apps create your-community-app --org your-org
mkdir -p .temp
cp apps/community/fly.toml.example .temp/community-fly.toml
```

Keep the copied file in `.temp`; its Dockerfile path is relative to that directory. Edit it there, then replace the app name, public origin, bucket name, and region. Keep the origin exactly `https://<your-app-name>.fly.dev` for initial setup. Choose a region close to your members and database.

The template uses one shared CPU and 1 GiB of memory as a starting point, not a measured capacity promise. Watch resource use and adjust it for your community.

Keep one Machine. This is the verified application topology; multiple app processes have not been validated. Admission-attempt limits also use process-local memory. Shared PostgreSQL and object storage alone do not establish safe horizontal scaling. Use `--ha=false` on deployment to avoid Fly's default spare Machine. Use rolling updates; expect a brief reconnect during replacement. Do not use a strategy that runs old and new app processes side by side. See [Fly deployment behavior](https://fly.io/docs/launch/deploy/).

Automatic stopping is disabled so live streams and cleanup work keep running. The proxy idle timeout allows long-lived connections. The app's heartbeat still needs to reach browsers through the public URL. See [Fly app configuration](https://fly.io/docs/reference/configuration/).

## Choose PostgreSQL and create private file storage

Create a database and role used only by this Community. Keep its credentials separate from your other apps. Choose one of these options:

| Database             | Setup                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fly Managed Postgres | Create a [Managed Postgres database](https://fly.io/docs/mpg/create-and-connect/) in the same Fly organization and region. In its Connect screen, copy the **direct** connection URL into your secret store. Do not use `fly mpg attach`: it supplies a pooled URL. See Fly's [client configuration](https://fly.io/docs/mpg/client-configuration/).                                                                                                                        |
| Neon                 | Create a separate [Neon project](https://neon.com/docs/manage/projects) and database role. Choose a Neon region close to the Fly app region. The app reaches Neon over its public TLS address, not Fly's private network. In Neon's Connect dialog, turn **Connection pooling** off and copy the direct URL. Keep its TLS settings. See Neon's [Node.js guide](https://neon.com/docs/guides/node) and [connection guide](https://neon.com/docs/connect/connection-pooling). |

Community applies migrations before startup. A direct URL is recommended for migrations. The current server uses the same URL at runtime. Save it as `COMMUNITY_DATABASE_URL` in the next section.

Live channel streams query PostgreSQL often, and background cleanup also uses the database. Do not assume a database that can suspend when idle will stay suspended. Check its compute use and billing during the acceptance tests.

Create a private file bucket:

```sh
fly storage create --app your-community-app --org your-org \
  --name your-private-community-bucket
```

Do not add `--public`. Save the generated credentials privately. In an app context, Fly sets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` on the app. Community's S3 client can read that credential pair. The template supplies the separate `COMMUNITY_S3_BUCKET`, `COMMUNITY_S3_REGION`, and `COMMUNITY_S3_ENDPOINT` settings that Community needs. `BUCKET_NAME` alone does not configure Community.

Downloads pass through Community's membership checks. Do not publish the bucket or serve attachment URLs directly. See [Fly's Tigris guide](https://fly.io/docs/tigris/).

## Set secrets

Generate three different secrets with `openssl rand -hex 32`. Save them and the direct database URL in your secret manager. The bootstrap secret is the Setup secret you will enter in the browser.

Create a private file **outside the checkout**, readable only by you, with these values. Replace every placeholder. Preserve any TLS settings in the database URL.

```dotenv
COMMUNITY_DATABASE_URL=<direct PostgreSQL connection URL>
COMMUNITY_AUTH_SECRET=<first generated secret>
COMMUNITY_INVITE_SECRET=<second generated secret>
COMMUNITY_BOOTSTRAP_SECRET=<third generated secret>
```

Import the file without putting the values in command history:

```sh
chmod 600 /absolute/private/path/community-fly.env
fly secrets import --app your-community-app --stage \
  < /absolute/private/path/community-fly.env
fly secrets list --app your-community-app
```

The list shows names and digests, not secret values. Confirm the four Community secrets and both AWS credential names are present. If you created the bucket outside the Fly app context, also import `COMMUNITY_S3_ACCESS_KEY_ID` and `COMMUNITY_S3_SECRET_ACCESS_KEY` from its credentials. Supply both or neither.

[`--stage`](https://fly.io/docs/flyctl/secrets-import/) saves secrets without starting a deployment. Optional Google and GitHub sign-in settings are covered in [deployment settings](DEPLOYMENT.md#optional-google-and-github-sign-in).

## Deploy and create the community

```sh
fly config validate --strict --config .temp/community-fly.toml
fly deploy --config .temp/community-fly.toml --ha=false
fly status --app your-community-app
fly checks list --app your-community-app
curl --fail https://your-community-app.fly.dev/health
```

Confirm the status lists exactly one application Machine. Startup applies database migrations before opening port 6481. There is no separate release command to add.

Open the HTTPS address. Enter the Setup secret, then create the first owner account, community name, and channel. Replace the bootstrap secret afterward as described in [operations](OPERATIONS.md#secrets-and-account-recovery).

To add a custom domain, follow [Fly's custom-domain guide](https://fly.io/docs/networking/custom-domain/). After its certificate is ready, change `COMMUNITY_PUBLIC_URL` to that exact HTTPS origin and redeploy. Update any Google or GitHub callback URLs too. Use the new origin consistently for browser sign-in, invitations, and DorkOS connections.

## Verify the deployed service

`/health` proves only that the process responds. Run these checks through the public HTTPS address:

1. Create the owner and first channel. Invite another person and join in a separate browser profile.
2. Exchange posts and a thread reply. Upload and download a file; compare its bytes.
3. Disconnect and reconnect one browser. Confirm ordered history and live updates, without duplicate posts.
4. Connect a local DorkOS installation. Add an agent to the channel and verify a mention produces one reply. Then stop its participation.
5. Redeploy the same revision. Verify sign-in, history, and the uploaded file still work.
6. Remove a member. Verify that their old browser and credentials cannot read the channel or download its files.
7. Restore a matching database and file backup into a private test deployment. Verify history and attachment bytes there.

Record the source revision, image, region, configuration, and results without secrets. The repository's isolated check is useful before deploying:

```sh
bash apps/community/acceptance/run.sh
```

That test exercises the packaged apps without access to DorkOS hosts. It does not test Fly's proxy, your hosted PostgreSQL service, or Tigris. The public-host checks above remain necessary.

## Backups, upgrades, and troubleshooting

If guided setup made your community, follow [Back up and upgrade a community made with guided setup](#back-up-and-upgrade-a-community-made-with-guided-setup). Otherwise, use the [operations guide](OPERATIONS.md) for coordinated database/file backups and recovery. Its Docker Compose commands are for Compose deployments. Use your database host's export or restore tools and your object-store backup tools here. Stop app writes while taking a matching backup pair. A Neon restore point covers PostgreSQL, not Tigris files. Do not assume a bucket created with `fly storage create` has Tigris snapshots enabled. Choose and rehearse a file backup method before storing irreplaceable data. See Neon's [backup guide](https://neon.com/docs/postgres/backup-restore/backups) if you use Neon.

Database migrations only move forward. Before upgrading, save a tested backup and the running source/image revision. Roll back by restoring the matching database, files, and image together.

| Symptom                              | Check                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| The app never becomes healthy        | Inspect `fly logs --app your-community-app`; check all required secrets and the direct database URL.                           |
| Uploads fail                         | Check the private bucket name, `auto` region, endpoint, and both credential names. Never fix this by making the bucket public. |
| Sign-in or invitations fail          | Check the exact public HTTPS origin and any social sign-in callbacks.                                                          |
| Live posts appear only after refresh | Confirm one app Machine, then test reconnects and streaming through the public origin.                                         |
| Files disappear after redeploy       | Confirm `COMMUNITY_STORAGE_DRIVER=s3`; the Machine's ordinary filesystem is temporary.                                         |

A Fly Volume is another possible storage choice, but it attaches to one Machine and is not replicated automatically. The bucket recipe avoids relying on that local disk. See [Fly Volumes](https://fly.io/docs/volumes/overview/).

### Pause writes for a matching backup

Stopping a Machine is not enough if Fly proxy autostart can start it again when a request arrives. For a single-Machine deployment, first disable autostart and stop the Machine:

```bash
fly machine update <machine-id> --app <app-name> --autostart=false --skip-start --yes
fly machine list --app <app-name>
```

Confirm it stays stopped after a request to the public address. While it is stopped, export the database and copy the private file bucket. Keep both copies, their checksums, and the application image revision as one protected recovery set. Store the matching application secrets separately in protected storage, as described in the [operations guide](./OPERATIONS.md).

When the matching pair is complete, restore autostart and start the service:

```bash
fly machine update <machine-id> --app <app-name> --autostart=true --yes
```

Check `/health` and sign-in afterward. This procedure causes a service interruption. If capture fails, treat that backup pair as incomplete; resuming service does not make a partial backup usable. Rehearse the restore in an isolated environment before relying on it.

## Back up and upgrade a community made with guided setup

Guided setup gives you a running community. It does not give you a backup. The completion screen means the service is healthy, not that a copy of your data exists anywhere else. Guided setup also does not turn on Tigris snapshots for the file bucket. Until you follow the steps below, the live community is your only copy.

What has been tried so far:

- The same approach (pause writes, export the database, copy every file, restore both into Docker on your own computer) worked once on September 20, 2026, on a community set up by hand with the same three services: Fly, Neon and Tigris.
- Steps 1 through 6 were followed on October 1, 2026 (UTC), on a community made with guided setup (v0.94.0), with the database role's real name, the correction below, folded in. From step 7, only `fly config save` (with its own correction below) and a redeploy of the same release (same image digest) were tried; the next release's manifest was not downloaded or checked, its `migrationCompatibilityId` was not compared, and no actual version upgrade was made.
- The cross-version upgrade in step 7, and the roll-back in step 8, are **not yet rehearsed on guided setup**.
- Every `fly` and `neonctl` command in steps 1 through 6, plus `fly config save` and `fly deploy` of the same image in step 7, was checked against the help output of flyctl 0.4.104 and neonctl 5.0.0, the lowest versions the current release accepts, and also run live against flyctl 0.4.110 and neonctl 7.0.1. The Tigris CLI commands in step 4 were run live against Tigris CLI 3.14.0.

You need the same `fly`, `neonctl` and `gh` tools guided setup asked for, plus `jq`, PostgreSQL 17 client tools (`pg_dump`, `pg_restore`), an S3 command-line client such as the [AWS CLI](https://aws.amazon.com/cli/), and Docker for the restore rehearsal. Replace every `<placeholder>` with your own value.

### 1. Find what is running

Guided setup keeps a record of what it made, called the setup journal. It printed the journal's path when it started. The file is `launches/community/<run-id>.json` inside your DorkOS data directory: `~/.dork` for a normal install, or wherever `DORK_HOME` points. The journal holds names and IDs, never secrets. List what you need from it, including the database role guided setup created:

```bash
journal=~/.dork/launches/community/<run-id>.json
jq '{version: .recoveryContext.version, app: .recoveryContext.appName,
  bucket: .recoveryContext.bucketName, releaseDigest, imagePlatformDigest,
  neonProject: .resources.neonProjectId, neonBranch: .resources.neonBranchId,
  neonRole: .resources.neonRoleId}' "$journal"
database_role="$(jq -er '.resources.neonRoleId // empty' "$journal")"
```

Guided setup names this role `community_` plus a code of its own. A launch started before these codes existed used the fixed name `community_owner` instead. Either way, the journal holds whichever name yours got. The commands below call it `$database_role`.

`journal` and `database_role` are shell variables: they last only for this terminal. In any new terminal, re-run the `journal=` and `database_role=` lines above before steps 3, 6, 7 or 8.

The journal describes the day of setup. After an upgrade, ask Fly what is running now:

```bash
fly releases --app <app-name> --image
fly machine list --app <app-name> --json \
  | jq -r '.[] | "\(.id) \(.state) \(.image_ref.digest)"'
```

Expect exactly one Machine. Two digests name the same release. `releaseDigest` covers the whole release image, for every kind of computer. Fly reports the digest of the one piece that runs on its Machines (Linux on Intel-compatible chips); the journal saves that as `imagePlatformDigest`. Write down the version, both digests, the database role and the Machine ID. They belong with your backup.

### 2. Pause writes

Make a private folder for this backup, and note the time:

```bash
umask 077
backup_dir="$(mktemp -d "$HOME/community-backup.XXXXXXXX")"
```

Now follow [Pause writes for a matching backup](#pause-writes-for-a-matching-backup) until the Machine stays stopped. Then record the time, which a roll-back can use later:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ > "$backup_dir/paused-at"
```

Do steps 3 and 4 while the Machine is stopped.

### 3. Export the database

Guided setup made a Neon database named `community`, owned by `$database_role` from step 1. The app reaches it through the Fly secret `COMMUNITY_DATABASE_URL`, but Fly never shows a secret's value again. Ask Neon for the same direct address instead. The command writes it to a private file, so the password never lands in your shell history:

```bash
: "${database_role:?Run step 1 first}" && \
neonctl connection-string <neon-branch-id> --project-id <neon-project-id> \
  --database-name community --role-name "$database_role" \
  --no-pooled --ssl require > "$backup_dir/database-url"
```

You can also copy it from Neon's **Connect** dialog, with **Connection pooling** turned off.

A password typed into a command can be seen by other programs on your computer while the command runs. So split the address: the password goes into a private password file that `pg_dump` reads, and the command gets the address without it. Then export, and check that the export opens:

```bash
database_url="$(cat "$backup_dir/database-url")"
database_password="${database_url#*://*:}"; database_password="${database_password%%@*}"
database_host="${database_url#*@}"; database_host="${database_host%%/*}"
printf '%s:5432:community:%s:%s\n' "$database_host" "$database_role" "$database_password" \
  > "$backup_dir/pgpass"
unset database_url database_password
export PGPASSFILE="$backup_dir/pgpass"
pg_dump --format=custom --file="$backup_dir/database.dump" \
  --dbname="postgresql://$database_role@$database_host/community?sslmode=require&channel_binding=require"
pg_restore --list "$backup_dir/database.dump" > /dev/null
```

If the password contains `:` or `\`, put a `\` in front of each one in the `pgpass` file.

Your `pg_dump` must be version 17 or newer, because guided setup creates a PostgreSQL 17 database. The address and the `pgpass` file both hold the password. Delete them when you finish, or keep them only in encrypted storage.

### 4. Copy every file

Community keeps uploaded files in the private Tigris bucket named in the journal. The app's own keys are the Fly secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, and Fly will not show them again. Make a separate key for backups instead, from the dashboard or the command line. Read-only access is enough for a backup; a roll-back (step 8) needs write access.

**From the dashboard:**

1. Run `fly storage dashboard <bucket-name>` to open the bucket in the Tigris dashboard.
2. Create an access key limited to this bucket.
3. Save the key in your password manager.

**From the command line:** install the Tigris CLI, then sign in with `tigris login oauth` (choose "Sign in with Fly"):

```bash
npm install -g @tigrisdata/cli
tigris login oauth
```

A roll-back (step 8) needs write access instead: use `--role ReadWrite` in place of `--role ReadOnly` below, which is enough to put files back. Run `umask 077` first in the same shell, or `chmod 600` the file afterward, so only you can read it. Create a read-only key for this bucket:

```bash
umask 077
tigris access-keys create community-backup --bucket <bucket-name> --role ReadOnly \
  --env ~/.community-backup-tigris.env --for aws
```

Copy the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` values out of that file and into the credentials file below, then delete it: `rm ~/.community-backup-tigris.env`. Once this recovery set is complete and checked (through step 6), delete the key from Tigris too if you do not want to keep a standing one: find its id with `tigris access-keys list` (it starts with `tid_`), then run `tigris access-keys delete <id>`. The next recovery set needs a new key.

Never make the bucket public to copy it. Put the key in a private credentials file outside the backup folder, then copy the bucket:

```bash
cat > ~/.community-backup-credentials <<'KEY'
[community-backup]
aws_access_key_id = <access-key-id>
aws_secret_access_key = <secret-access-key>
KEY
chmod 600 ~/.community-backup-credentials
export AWS_SHARED_CREDENTIALS_FILE=~/.community-backup-credentials AWS_PROFILE=community-backup

aws s3 sync s3://<bucket-name> "$backup_dir/files" \
  --endpoint-url https://t3.storage.dev --region auto
```

This is the same address and region the app itself uses. Community stores each file under a random 64-character name in one flat list, so the copy is one flat folder. Compare the counts, then record a checksum for every file:

```bash
aws s3 ls s3://<bucket-name> --recursive --summarize \
  --endpoint-url https://t3.storage.dev --region auto | tail -n 2
find "$backup_dir/files" -type f | wc -l
(cd "$backup_dir/files" && find . -type f -exec shasum -a 256 {} + | sort -k 2) \
  > "$backup_dir/files.sha256"
```

The `Total Objects` line and the local count must match. If they do not, treat the backup as incomplete.

### 5. Resume service

Finish [Pause writes for a matching backup](#pause-writes-for-a-matching-backup): turn autostart back on, then check `/health` and sign-in. Keep the database dump, the file folder, `files.sha256`, `paused-at` and the notes from step 1 together, encrypted, somewhere other than this computer. That is one recovery set. A dump without its matching files, or files without their dump, cannot restore the community.

### 6. Rehearse a restore

A backup you have never restored is a guess. Follow [Rehearse a restore](OPERATIONS.md#rehearse-a-restore) on this computer with Docker, with four changes:

- Check out the release that was running: `git checkout v<version>`.
- Pack the copied files into the archive that section expects: `tar -C "$backup_dir/files" -czf "$backup_dir/blobs.tar.gz" .`
- Add `--no-owner --no-acl` to its `pg_restore` command. The dump belongs to `$database_role` from step 1, a role the local database does not have.
- Use fresh random values for the three secrets. Guided setup made the sign-in and invitation secrets itself and stored them only in Fly.

Fresh secrets change a few things in the copy. Passwords still work, because they do not depend on those secrets. Browser sessions from the live community will not carry over, and unused invitation links will not open. The same is true if you ever restore onto a new Fly app.

Then check sign-in, channel history, a thread, and a removed member's denial. Download one attachment and compare its checksum with `files.sha256`. Keep the rehearsal private, and delete its containers and volumes when you finish, since they hold real member data.

### 7. Upgrade

**Not yet rehearsed on guided setup.** An upgrade is where a backup matters most, because database changes only go forward.

First read the next release's signed release manifest. This is the same file guided setup reads, and `gh` checks its signature the same way:

```bash
next=<next-version>
gh release download "v$next" --repo dork-labs/dorkos --pattern "community-release-v$next.json"
gh attestation verify "community-release-v$next.json" --repo dork-labs/dorkos \
  --signer-workflow dork-labs/dorkos/.github/workflows/publish-community.yml \
  --source-ref "refs/tags/v$next"
jq . "community-release-v$next.json"
```

Stop if the check fails. From the manifest, note `image.digest`, `minimumFlyctlVersion`, `minimumNeonCliVersion` and `migrationCompatibilityId`. Check the image with the same command, using `oci://ghcr.io/dork-labs/dorkos-community@<image.digest>` in place of the file name. Then confirm `fly version` and `neonctl --version` meet the minimums.

Take and check a fresh recovery set (steps 2 to 6), and write down its folder path: a roll-back needs exactly this set. Then download the manifest for the version running now into that set, and check it the same way:

```bash
current=<running-version>
gh release download "v$current" --repo dork-labs/dorkos \
  --pattern "community-release-v$current.json" --dir "$backup_dir"
gh attestation verify "$backup_dir/community-release-v$current.json" --repo dork-labs/dorkos \
  --signer-workflow dork-labs/dorkos/.github/workflows/publish-community.yml \
  --source-ref "refs/tags/v$current"
```

If its `migrationCompatibilityId` differs from the next release's, the upgrade changes the database. From then on, only your backup can take you back.

Next, save the configuration Fly holds for your app. Guided setup deployed with a temporary configuration file and deleted it afterward, so this is how you get one:

```bash
(cd "$backup_dir" && fly config save --app <app-name>)
```

Check that the file still has one `[[vm]]` section, `COMMUNITY_STORAGE_DRIVER = "s3"` and your bucket name. Deploy the new release by its exact digest, the way guided setup does, and keep one Machine:

```bash
fly deploy --app <app-name> --config "$backup_dir/fly.toml" \
  --image ghcr.io/dork-labs/dorkos-community@<image.digest> --ha=false
```

Never deploy a tag such as `latest`. Afterward:

1. Run `fly machine list --app <app-name>` and confirm exactly one Machine, started.
2. Confirm its digest is the new release's Linux Intel digest. The manifest lists it under `image.platforms` when it has one. Otherwise run `docker buildx imagetools inspect ghcr.io/dork-labs/dorkos-community@<image.digest>` and read the `linux/amd64` line.
3. Run the checks in [Upgrade and roll back](OPERATIONS.md#upgrade-and-roll-back): `/health`, sign-in, posting, live updates and one attachment.

The setup journal still names the original version. That is expected: it records setup, not what runs today. The manifest for the release you ran before this upgrade is in the recovery set. Its `image.digest` is what a roll-back deploys.

### 8. Roll back

**Not yet rehearsed on guided setup.** Never start an older image against a database an upgrade has changed. To go back, restore the database, the files and the image together, all from the recovery set you took before the upgrade. Everything written after that backup is lost, so save it first.

Start by naming the two folders. `pre_upgrade` is the recovery set you took in step 7, just before this upgrade. `current_copy` is a new, empty folder for what the community holds now. Do not reuse `backup_dir`: step 2 points it at a new folder every time you run it.

```bash
pre_upgrade=<path to the recovery set from step 7>
current_copy="$(mktemp -d "$HOME/community-current.XXXXXXXX")"
```

1. Pause writes. Then take a copy of the current state by following steps 3 and 4 with `backup_dir="$current_copy"`. Set `backup_dir="$pre_upgrade"` again when you finish.
2. Return the Neon database to the moment you paused before the upgrade. Neon keeps the current state as a separate branch under the name you give:

   ```bash
   neonctl branches restore <neon-branch-id> "^self@$(cat "$pre_upgrade/paused-at")" \
     --project-id <neon-project-id> --preserve-under-name before-rollback
   ```

   This works only within your Neon project's history window. See Neon's [restore guide](https://neon.com/docs/guides/branch-restore). Outside that window, `$pre_upgrade/database.dump` is your copy. Restoring it over the live Neon database is not written up here yet. Ask for help before trying it.

3. Put the files back, with a key that can write. `--delete` removes files added after the backup, which the restored database no longer knows about. They are still in `$current_copy`:

   ```bash
   aws s3 sync "$pre_upgrade/files" s3://<bucket-name> --delete \
     --endpoint-url https://t3.storage.dev --region auto
   ```

4. Deploy the release you ran before this upgrade. Use `image.digest` from `$pre_upgrade/community-release-v<previous-version>.json`, the manifest you saved in step 7, not the digest in the setup journal: the journal names the version from setup day, which may be older still.

   ```bash
   fly deploy --app <app-name> --config "$pre_upgrade/fly.toml" \
     --image ghcr.io/dork-labs/dorkos-community@<previous image.digest> --ha=false
   ```

5. Resume service as in step 5. If `fly machine list` shows the Machine still stopped, run `fly machine start <machine-id> --app <app-name>`. Then run the same checks as after an upgrade.
