#!/bin/sh
# Measure which git versions run the marketplace's package fetch
# (apps/server/src/services/marketplace/lib/git-tree.ts), in Docker (DOR-2248).
#
# The fetch's git floor is a claim about other people's machines, so it is
# measured rather than assumed: this replays the exact command sequence
# git-tree.ts runs — lookup, partial-clone fetch by commit, sparse cone
# checkout, both fallbacks for a server that refuses unadvertised objects, and
# the token header passed through GIT_CONFIG_COUNT — against a local bare
# repository, once per image. Keep it in step with git-tree.ts.
#
#   scripts/git-floor-probe.sh                      # the default image list
#   scripts/git-floor-probe.sh alpine/git:v2.40.1   # one image
#
# With PROBE_TOKEN and PROBE_PRIVATE_REPO (an https://github.com/... repository
# the token can read) in the environment, each image also authenticates
# against it the way git-tree.ts would on that git — the URL-embedded token
# before 2.31, the GIT_CONFIG_COUNT header from 2.31 — fetching commits and
# trees but no file contents, and checks the token is gone once .git is.
#
# Each image prints its git version and one line per step: `ok` or `FAIL`.
# Not run in CI: it needs Docker and pulls images.
set -eu

if [ "${1:-}" != "--inside" ]; then
  images="$*"
  # alpine/git tags do not always name the git inside: 1.0.25 is git 2.30.0 and
  # v2.30.2 is git 2.32.0. Each run prints the real version.
  [ -n "$images" ] || images="alpine/git:v2.24.1 alpine/git:v2.26.2 alpine/git:1.0.25 alpine/git:v2.30.2 alpine/git:v2.34.1 alpine/git:v2.36.3 alpine/git:v2.40.1 alpine/git:v2.43.0 alpine/git:v2.45.2 alpine/git:v2.49.1"
  here=$(cd "$(dirname "$0")" && pwd)
  for image in $images; do
    echo "== $image"
    docker run --rm -v "$here:/p:ro" -e PROBE_TOKEN -e PROBE_PRIVATE_REPO --entrypoint sh "$image" /p/git-floor-probe.sh --inside || true
  done
  exit 0
fi

set +e
export GIT_CONFIG_NOSYSTEM=1 HOME=/tmp/h GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
mkdir -p /tmp/h && cd /tmp && rm -rf w b.git d*
git --version

# Fixture: a branch and a tag sharing one name on different commits, and C3,
# a commit no ref points at (only its child is a branch tip).
git init -q w && cd w && git checkout -q -b main 2>/dev/null
mkdir -p pkg other && echo 1 > pkg/f && echo 1 > other/g && git add . && git commit -qm 1
C1=$(git rev-parse HEAD)
echo 2 > pkg/f && echo 2 > other/g && git commit -qam 2
C2=$(git rev-parse HEAD)
git tag same-name "$C1" && git branch same-name "$C2"
git checkout -q -b moved && echo 3 > pkg/f && git commit -qam 3
C3=$(git rev-parse HEAD)
echo 4 > pkg/f && git commit -qam 4 && git checkout -q main
cd /tmp && git clone -q --bare w b.git && git -C b.git config uploadpack.allowFilter true
U=file:///tmp/b.git

# git-tree.ts leads every git call with the DOR-2326 hardening as `-c` settings,
# so every git below (inside `sh -c` too) goes through a wrapper that does the
# same. Fixture edits to the bare server repository use the real git: with
# safe.bareRepository=explicit, `git -C b.git` is refused, as it should be.
real_git=$(command -v git)
mkdir -p /tmp/bin
printf '#!/bin/sh\nexec %s -c safe.bareRepository=explicit -c core.fsmonitor= -c core.hooksPath=/dev/null "$@"\n' "$real_git" >/tmp/bin/git
chmod +x /tmp/bin/git
export PATH="/tmp/bin:$PATH"
export GIT_ALLOW_PROTOCOL=file

step() { name=$1; shift; out=$("$@" 2>&1); if [ $? = 0 ]; then echo "ok   $name"; else echo "FAIL $name: $(echo "$out" | tail -1)"; fi; }
fresh() { cd /tmp && rm -rf "$1" && mkdir "$1" && cd "$1" && git init -q && git remote add --end-of-options origin "$U"; }

step lookup git ls-remote --end-of-options "$U" refs/heads/main 'refs/heads/main^{}' refs/tags/main 'refs/tags/main^{}'

# The partial-clone path, on a server that serves commits by id.
fresh d1
step sparse-cone sh -c 'git sparse-checkout init --cone && git sparse-checkout set --end-of-options pkg && test "$(git config core.sparseCheckoutCone)" = true'
step partial-clone-config sh -c 'git config core.repositoryformatversion 1 && git config extensions.partialClone origin && git config remote.origin.promisor true && git config remote.origin.partialclonefilter blob:none'
step fetch-filtered-by-commit git fetch --quiet --no-tags --depth=1 --filter=blob:none --end-of-options origin "$C1"
step checkout-detach git -c advice.detachedHead=false checkout --quiet --detach "$C1"
step only-subpath-checked-out sh -c 'test -f pkg/f && test ! -e other'
step head-is-commit sh -c "test \"\$(git rev-parse --verify HEAD)\" = $C1"
step no-deleted-files sh -c 'test -z "$(git ls-files --deleted)"'

# A server that refuses unadvertised objects (protocol v0, no allow*SHA1InWant).
"$real_git" -C /tmp/b.git config uploadpack.allowReachableSHA1InWant false
"$real_git" -C /tmp/b.git config uploadpack.allowAnySHA1InWant false
# `-c protocol.version=0` rather than GIT_CONFIG_COUNT: git before 2.31 ignores the latter.
fresh d2
step refused-by-commit sh -c "git -c protocol.version=0 fetch --quiet --no-tags --depth=1 --end-of-options origin $C3 2>&1 | grep -qi 'unadvertised object\|not our ref'"
step fallback-refname git -c protocol.version=0 fetch --quiet --no-tags --depth=1 --end-of-options origin refs/heads/same-name
step refname-is-the-branch sh -c "test \"\$(git rev-parse 'FETCH_HEAD^{commit}')\" = $C2"
# A partial clone of an ADVERTISED commit on that server: the fetch succeeds,
# then checkout's lazy blob request is refused. Git 2.30–2.36 can print
# `error: invalid object` and exit 0 with the file missing; git-tree.ts must
# see the failure all the same (an exit code, an `error:` line, or
# `ls-files --deleted`) and retry unfiltered.
fresh d4
git sparse-checkout init --cone >/dev/null 2>&1 && git sparse-checkout set --end-of-options pkg >/dev/null 2>&1
git config core.repositoryformatversion 1 && git config extensions.partialClone origin &&
  git config remote.origin.promisor true && git config remote.origin.partialclonefilter blob:none
git -c protocol.version=0 fetch --quiet --no-tags --depth=1 --filter=blob:none --end-of-options origin "$C2" >/dev/null 2>&1
err=$(git -c protocol.version=0 -c advice.detachedHead=false checkout --quiet --detach "$C2" 2>&1); code=$?
deleted=$(git ls-files --deleted 2>/dev/null)
errline=$(echo "$err" | grep -c '^error:')
echo "info refused-lazy-checkout: exit=$code error-lines=$errline deleted=[$(echo $deleted)]"
step refused-lazy-checkout-detected sh -c "[ $code -ne 0 ] || [ $errline -gt 0 ] || [ -n '$deleted' ]"
fresh d3
step fallback-all-refs git -c protocol.version=0 fetch --quiet --no-tags --end-of-options origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
step pinned-commit-present git rev-parse --verify --quiet "$C3^{commit}"
step sparse-checkout-after-fallback sh -c "git sparse-checkout init --cone && git sparse-checkout set --end-of-options pkg && git -c advice.detachedHead=false checkout --quiet --detach $C3 && test \"\$(cat pkg/f)\" = 3 && test ! -e other"

# Whether this git reads config from the environment (2.31+). Where it does not,
# git-tree.ts embeds the token in the remote URL instead; FAIL here is expected.
step env-config-supported env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraHeader "GIT_CONFIG_VALUE_0=Authorization: Basic eA==" sh -c 'git config --get-urlmatch http.extraHeader https://github.com/o/r.git | grep -q Basic'

# A private GitHub repository, authenticated as git-tree.ts would on this git.
if [ -n "${PROBE_TOKEN:-}" ] && [ -n "${PROBE_PRIVATE_REPO:-}" ]; then
  unset GIT_ALLOW_PROTOCOL
  minor=$(git --version | sed -n 's/^git version 2\.\([0-9]*\).*/\1/p')
  cd /tmp && rm -rf p && mkdir p && cd p && git init -q
  if [ "${minor:-0}" -ge 31 ]; then
    echo "auth: environment header"
    basic=$(printf 'x-access-token:%s' "$PROBE_TOKEN" | base64 | tr -d '\n')
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraHeader "GIT_CONFIG_VALUE_0=Authorization: Basic $basic"
    remote=$PROBE_PRIVATE_REPO
  else
    echo "auth: token in the remote URL"
    remote=$(echo "$PROBE_PRIVATE_REPO" | sed "s#^https://#https://x-access-token:$PROBE_TOKEN@#")
  fi
  git remote add --end-of-options origin "$remote"
  step private-lookup sh -c 'git ls-remote --end-of-options origin HEAD | grep -q HEAD'
  sha=$(git ls-remote origin HEAD 2>/dev/null | cut -f1)
  git sparse-checkout init --cone >/dev/null 2>&1 && git sparse-checkout set --end-of-options no-such-dir-probe >/dev/null 2>&1
  git config core.repositoryformatversion 1 && git config extensions.partialClone origin &&
    git config remote.origin.promisor true && git config remote.origin.partialclonefilter blob:none
  step private-fetch-by-commit git fetch --quiet --no-tags --depth=1 --filter=blob:none --end-of-options origin "$sha"
  step private-checkout git -c advice.detachedHead=false checkout --quiet --detach "$sha"
  step private-head-is-commit sh -c "test \"\$(git rev-parse --verify HEAD)\" = $sha"
  if [ "${minor:-0}" -lt 31 ]; then
    step token-in-git-before-cleanup grep -qF "$PROBE_TOKEN" .git/config
  else
    step token-never-in-git sh -c '! grep -rqF "$PROBE_TOKEN" .git'
  fi
  rm -rf .git
  step token-gone-with-git sh -c '! grep -rqF "$PROBE_TOKEN" /tmp/p'
fi
