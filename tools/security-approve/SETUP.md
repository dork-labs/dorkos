# Security App setup (Dorian, once)

This sets up the one program that can mark a PR "Security approved". Its key lives in a separate
Mac user, `dorkos-approver`. No agent runs as that user, so no agent can read the key, use it, or
pop up a prompt for it.

It takes two short sittings, about 15 minutes in all:

- **Part A (about 8 minutes):** make the user, check sudo, create the App, send two numbers.
- **Part B (about 7 minutes):** after the PR that pins those numbers is reviewed, build, install
  and store the key.

Type every command yourself, in Terminal. Never paste the key into a chat or a file.

## Part A

### 0. Take org-owner power away from agents (1 minute, do this today)

In your own Terminal:

```sh
gh auth refresh --remove-scopes admin:org,gist
```

### 1. Make the approver user (3 minutes)

In your own Terminal. It asks for your password, then for a new password for the new user. Pick a
strong one you use nowhere else.

```sh
sudo sysadminctl -addUser dorkos-approver -fullName "DorkOS Approver" -password -
```

Check it is **not** an admin. This must print `no`:

```sh
dseditgroup -o checkmember -m dorkos-approver admin | cut -d' ' -f1
```

Now switch to it once so macOS finishes making it: Apple menu → **Lock Screen**, then pick
**DorkOS Approver**. Skip iCloud and every optional step. (Every "switch" below works the same way.) Then switch back to yourself and lock
its home folder:

```sh
sudo chmod 700 /Users/dorkos-approver
ls -ld /Users/dorkos-approver
```

The second line must start with `drwx------`.

### 2. Make sure agents cannot use sudo (30 seconds)

```sh
sudo -k; sudo -n true 2>/dev/null && echo "STOP: sudo works without a password" || echo "OK"
```

It must print `OK`. If it prints `STOP`, tell @dorkos-2 and stop here.

### 3. Create the App (3 minutes)

Switch to **DorkOS Approver**. Open Safari there, sign in to GitHub as yourself, and go to
<https://github.com/organizations/dork-labs/settings/apps/new>. Fill in only these values (they
are the ones in `ci/security-review-app.manifest.json`):

| Field                                    | Value                                 |
| ---------------------------------------- | ------------------------------------- |
| GitHub App name                          | `DorkOS Security Review`              |
| Homepage URL                             | `https://github.com/dork-labs/dorkos` |
| Webhook → Active                         | **unchecked**                         |
| Repository permissions → Commit statuses | **Read and write**                    |
| Repository permissions → Metadata        | Read-only (set for you)               |
| Everything else                          | No access                             |
| Where can this App be installed?         | **Only on this account**              |

Click **Create GitHub App**. Do **not** make a private key yet. Then:

1. Write down the **App ID** from the top of the page.
2. Left menu → **Install App** → `dork-labs` → **Only select repositories** → `dorkos` → **Install**.
3. Get the bot's user number. In the approver's Terminal:

   ```sh
   curl -s 'https://api.github.com/users/dorkos-security-review%5Bbot%5D' | grep '"id"'
   ```

Sign out of GitHub in that Safari, then switch back to yourself. Send @dorkos-2 the **App ID** and
the **bot id**. Those two numbers are not secret. A small PR pins them; Security reviews it and
names the reviewed SHA.

## Part B (after Security names the reviewed SHA)

### 4. Build, sign and install (4 minutes)

In your own Terminal. Put the SHA Security named in the first line. Run the block in one go. Your
Developer ID key may ask once to let `codesign` use it: click **Allow**, never **Always Allow**.
If any line prints an error, stop and tell @dorkos-2.

```sh
REVIEWED=paste-the-40-character-sha-here
B=$(mktemp -d) && cd "$B" && git init -q && git fetch -q --depth 1 https://github.com/dork-labs/dorkos.git "$REVIEWED" && git checkout -q FETCH_HEAD && test "$(git rev-parse HEAD)" = "$REVIEWED" && echo "source OK"
tools/security-approve/build.sh "$B/security-approve"
tools/security-approve/build-provisioner.sh "$B/security-approve-provision"
ID=$(security find-identity -v -p codesigning | grep -m1 'Developer ID Application' | sed 's/.*"\(.*\)"/\1/'); echo "$ID"
codesign --force --options runtime --timestamp --sign "$ID" --identifier ai.dorkos.security-approve "$B/security-approve"
codesign --force --options runtime --timestamp --sign "$ID" --identifier ai.dorkos.security-approve-provision "$B/security-approve-provision"
sudo mkdir -p /usr/local/libexec/dorkos-approve
sudo install -o root -g wheel -m 755 "$B/security-approve" "$B/security-approve-provision" /usr/local/libexec/dorkos-approve/
sudo chown root:wheel /usr/local/libexec /usr/local/libexec/dorkos-approve && sudo chmod 755 /usr/local/libexec /usr/local/libexec/dorkos-approve
sudo -k; rm -rf "$B"; cd
codesign -dv --verbose=4 /usr/local/libexec/dorkos-approve/security-approve 2>&1 | sed -n 's/^CDHash=//p'
```

The last line prints the helper's fingerprint (40 letters and numbers). Copy it for step 5.

Then make the shared inbox Security drops approvals into:

```sh
mkdir -p /Users/Shared/dorkos-approve/reviews && chmod 755 /Users/Shared/dorkos-approve /Users/Shared/dorkos-approve/reviews
```

### 5. Store the key (3 minutes)

Switch to **DorkOS Approver**. In Safari, sign in to GitHub, open the App's settings page, and
click **Generate a private key**. It downloads to that user's Downloads folder. Sign out of
GitHub. Then, in the approver's Terminal (put the fingerprint from step 4 in the second line):

```sh
echo 'export PATH="/usr/local/libexec/dorkos-approve:$PATH"' >> ~/.zshrc && export PATH="/usr/local/libexec/dorkos-approve:$PATH"
security-approve-provision ~/Library/Keychains/login.keychain-db paste-the-fingerprint-here
```

Confirm the password or Touch ID prompt. When it says "Paste App private PEM", run nothing else:
open the downloaded `.pem` file in TextEdit, copy all of it, paste it into Terminal, press
Return, then Ctrl-D. Then delete the file and clear the clipboard:

```sh
rm ~/Downloads/dorkos-security-review.*.private-key.pem; pbcopy </dev/null
```

Check it works (it should say "Nothing to approve." or list PRs):

```sh
security-approve --batch
```

Switch back to yourself. Setup is done.

## Daily use (about 1 minute, twice a day)

Security queues each reviewed PR head with `tools/security-approve/enqueue.sh <pr> <sha>`. That
only adds a line to a list. It approves nothing.

To approve the list: switch to **DorkOS Approver**, open Terminal, and run:

```sh
security-approve --batch
```

It reads the list, then asks GitHub for each PR's title, current head and changed files. It shows
you only what GitHub says. It leaves out any PR whose head moved, that has no Security review for
that exact head, or that is already approved. Read the list, then confirm **one** password or
Touch ID prompt. Right before each post it checks the head again and skips any that moved.

Some PRs are never in the batch: anything touching `.github/`, `CODEOWNERS`, rulesets or required
checks, or this approver. The batch prints the command for each one. Run it, read the file list
it shows (lines starting with `!` are the sensitive files), and confirm that PR on its own:

```sh
security-approve 1234 0123456789abcdef0123456789abcdef01234567
```

Switch back to yourself when done.

## After a rebuild

Every new build has a new fingerprint. Repeat step 4 from the newly reviewed SHA, then, as
**DorkOS Approver**:

```sh
security-approve-provision --repin ~/Library/Keychains/login.keychain-db paste-the-new-fingerprint-here
```

This re-points the key at the new build without exporting it.

## What this does not fix

Agents still act on GitHub as you. Step 0 removes org-owner power from their token, but your
signed-in browser can still do anything you can.
