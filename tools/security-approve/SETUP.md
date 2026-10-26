# Security App setup (Dorian, once)

This sets up the one program that can mark a PR "Security approved". Its key lives in a separate
Mac user, `dorkos-approver`. No agent runs as that user, so no agent can read the key, use it, or
pop up a prompt for it. Everything that builds, signs or stores the key also happens in that
user, because agents can change programs in your own account.

It takes two short sittings, about 15 minutes in all:

- **Part A (about 8 minutes):** make the user, check sudo, create the App, send two numbers.
- **Part B (about 7 minutes):** after Security reviews the PR that pins those numbers, build,
  install and store the key.

"Switch to DorkOS Approver" always means: Apple menu → **Lock Screen**, then pick **DorkOS
Approver**. "Switch back" is the same, picking yourself. Never paste the key into a chat or a file.

## Part A

### 1. Make the approver user (4 minutes)

System Settings → **Users & Groups** → **Add User**. Choose **Standard** (not Administrator).
Full name `DorkOS Approver`, account name `dorkos-approver`, and a strong password you use nowhere
else. Then switch to DorkOS Approver once, skip iCloud and every optional step, open Terminal and
lock its home folder:

```sh
/bin/chmod 700 ~ && /bin/ls -ld ~
```

The line must start with `drwx------`. Switch back.

### 2. Make sure agents cannot use sudo (30 seconds)

In your own Terminal:

```sh
/usr/bin/sudo -k; /usr/bin/sudo -n /usr/bin/true 2>/dev/null && echo "STOP: sudo works without a password" || echo "OK"
```

It must print `OK`. If it prints `STOP`, tell @dorkos-2 and stop here.

### 3. Create the App (3 minutes)

Switch to DorkOS Approver. Open Safari there, sign in to GitHub as yourself, and go to
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
   /usr/bin/curl -s 'https://api.github.com/users/dorkos-security-review%5Bbot%5D' | /usr/bin/grep '"id"'
   ```

Sign out of GitHub in that Safari, then switch back. Send @dorkos-2 the **App ID** and the **bot
id**, and keep your note. A small PR pins them. Security checks both numbers against GitHub before
it merges; you check the merged numbers match your note.

## Part B (after Security names the reviewed SHA)

Everything here runs as DorkOS Approver, in its Terminal.

### 4. Build, sign and install (4 minutes)

First start a clean shell. It ignores every settings file, so nothing left in this user's
account can change what the commands below run:

```sh
exec /bin/zsh -f
```

Paste the SHA Security named into the fourth line, then run the block. `set -e` stops at the
first failed check. If Terminal ever says `[Process completed]`, a check failed: stop and tell
@dorkos-2.

```sh
set -e
export PATH=/usr/bin:/bin:/usr/sbin:/sbin DEVELOPER_DIR=/Library/Developer/CommandLineTools
test "$(stat -f %Su:%Sg /Library/Developer/CommandLineTools)" = root:wheel
REVIEWED=paste-the-40-character-sha-here
printf %s "$REVIEWED" | grep -Eqx '[0-9a-f]{40}'
B=~/build-$REVIEWED; mkdir -m 700 "$B"; cd "$B"
git init -q; git fetch -q --depth 1 https://github.com/dork-labs/dorkos.git "$REVIEWED"; git checkout -q FETCH_HEAD
test "$(git rev-parse HEAD)" = "$REVIEWED"; echo "source OK"
tools/security-approve/build.sh "$B/security-approve"; tools/security-approve/build-provisioner.sh "$B/security-approve-provision"; echo "build OK"
codesign --force -s - --options runtime -i ai.dorkos.security-approve "$B/security-approve"
codesign --force -s - --options runtime -i ai.dorkos.security-approve-provision "$B/security-approve-provision"
H=$(codesign -dv --verbose=4 "$B/security-approve" 2>&1 | sed -n 's/^CDHash=//p'); echo "$H"
```

Now install. macOS asks for an administrator: type your own name and password into that box.

```sh
osascript -e "do shell script \"/usr/bin/install -d -o root -g wheel -m 755 /usr/local/libexec/dorkos-approve && /usr/sbin/chown root:wheel /usr/local/libexec && /bin/chmod 755 /usr/local/libexec && /usr/bin/install -o root -g wheel -m 755 $B/security-approve $B/security-approve-provision /usr/local/libexec/dorkos-approve/\" with administrator privileges"
test "$H" = "$(codesign -dv --verbose=4 /usr/local/libexec/dorkos-approve/security-approve 2>&1 | sed -n 's/^CDHash=//p')"; echo "installed build matches"
echo 'export PATH=/usr/local/libexec/dorkos-approve:/usr/bin:/bin:/usr/sbin:/sbin' >> ~/.zshrc
```

It must print `installed build matches`.

### 5. Store the key (3 minutes)

In Safari (still DorkOS Approver), sign in to GitHub, open the App's settings page and click
**Generate a private key**. It downloads to this user's Downloads folder. Sign out of GitHub. Then,
in the same Terminal:

```sh
/usr/local/libexec/dorkos-approve/security-approve-provision ~/Library/Keychains/login.keychain-db "$H"
```

Confirm the password or Touch ID prompt. When it says "Paste App private PEM": open the downloaded
`.pem` file in TextEdit, copy all of it, paste it into Terminal, press Return, then Ctrl-D. Then
let only this exact build read the key (it asks for this user's password), delete the file and
clear the clipboard:

```sh
security set-generic-password-partition-list -s ai.dorkos.security-review -a github-app-private-key -S "cdhash:$H" ~/Library/Keychains/login.keychain-db
rm ~/Downloads/dorkos-security-review.*.private-key.pem; pbcopy </dev/null; cd; rm -rf "$B"
/usr/local/libexec/dorkos-approve/security-approve --batch
```

The last line should say "Nothing to approve." Switch back. Setup is done.

## Daily use (about 2 minutes, twice a day)

Security queues each reviewed head with `tools/security-approve/enqueue.sh <pr> <sha>`, then posts
in #dorkos one `#pr sha` line per PR and the **list digest**: four groups of four letters and
numbers, like `c0c7 9cf8 1e8d 8eea`. Queueing approves nothing.

Switch to DorkOS Approver, open Terminal, and run:

```sh
security-approve --batch
```

1. **Check the digest and the PR numbers.** The top line shows `List digest: …`. If any of its 16
   characters differ from Security's post, or the PRs listed are not the ones Security posted,
   stop: someone else changed the list. Press Ctrl-C.
2. **Read every PR.** Each shows its title, full SHA and changed files, all straight from GitHub.
   `*` marks a file the security gate treats as sensitive. Stop if anything looks unlike what
   Security described.
3. **Confirm once.** The digest is printed again just above the prompt, and the prompt shows it
   too. Right before each post the program checks the head again and skips any that moved.

It leaves out PRs that are closed, not aimed at `main`, moved since Security queued them, already
approved, or have no Security review file for that exact head. That last check only catches honest
mistakes: agents can write that file, so your reading in step 2 is the real check.

Some PRs are never in the batch: anything touching `.github/`, `CODEOWNERS`, rulesets or required
checks, or this approver, and any PR with 300 or more files. The batch prints the command for each
one. Run it, read the files it shows (`!` marks the ones that kept it out of the batch), and
confirm that PR on its own:

```sh
security-approve 1234 0123456789abcdef0123456789abcdef01234567
```

Switch back when done. Security then clears the queue.

## After a rebuild

Every new build has a new fingerprint. As DorkOS Approver, repeat step 4 (clean shell first) from
the newly reviewed SHA, then, in the same shell:

```sh
/usr/local/libexec/dorkos-approve/security-approve-provision --repin ~/Library/Keychains/login.keychain-db "$H"
security set-generic-password-partition-list -s ai.dorkos.security-review -a github-app-private-key -S "cdhash:$H" ~/Library/Keychains/login.keychain-db
cd; rm -rf "$B"
```

This points the key at the new build without exporting it.

## What this does not fix

Agents still act on GitHub as you, and your signed-in browser can do anything you can. This page
protects the approval key only.
