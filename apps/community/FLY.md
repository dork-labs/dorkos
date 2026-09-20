# Deploy Community on Fly.io

Run your own Community on Fly.io with one persistent Machine, PostgreSQL, and a private Tigris bucket for files. Members use local Community accounts. DorkOS Cloud is not required.

This guide describes the current server: **one community per deployment**. Connecting DorkOS to several deployments already works. Hosting several communities inside one deployment is separate, planned work.

This is a deployment recipe, not a claim that a production Fly deployment has been verified. Complete the acceptance checks below before inviting people.

## Prepare the app

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

Use the [operations guide](OPERATIONS.md) for coordinated database/file backups and recovery. Its Docker Compose commands are for Compose deployments. Use your database host's export or restore tools and your object-store backup tools here. Stop app writes while taking a matching backup pair. A Neon restore point covers PostgreSQL, not Tigris files. Do not assume a bucket created with `fly storage create` has Tigris snapshots enabled. Choose and rehearse a file backup method before storing irreplaceable data. See Neon's [backup guide](https://neon.com/docs/postgres/backup-restore/backups) if you use Neon.

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
