#!/usr/bin/env bash
# Fixture suite for scripts/build-test-deps.sh, which test.yml runs before
# every `turbo test --only` so the builds the suites import are made in a
# turbo run with no `--` arguments (DOR-4625).
#
# What it pins: the build set is read from `turbo test <filters> --dry=json`
# and passed back to `turbo run build` as one --filter per package, with the
# caller's filters forwarded to the dry run; no build needed means no build
# run; an unreadable dry run fails; and the run summary's path comes back as
# `summary=<path>`, on stdout and in GITHUB_OUTPUT, for the cache trim.
#
# HERMETIC: turbo is a stub (TURBO) that logs its arguments and writes a
# canned dry run, and WORKSPACE_ROOT points at a temp dir.
#
#   bash scripts/test-build-test-deps.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script=$repo_root/scripts/build-test-deps.sh

work_dir=$(mktemp -d -t build-test-deps.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT

pass=0
fail=0

check() {
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' \
      "$name" "$expected" "$actual" >&2
  fi
}

# run_case <name> <dry-run stdout>
#   Leaves the stub's argument log in $work_dir/<name>/calls, the script's
#   output in .../out, its exit code in .../code and GITHUB_OUTPUT in .../gh.
run_case() {
  local name=$1 dry=$2 dir=$work_dir/$1
  mkdir -p "$dir/.turbo/runs"
  printf '%s' "$dry" > "$dir/dry.json"
  cat > "$dir/turbo" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "$dir/calls"
case " \$* " in
  *" --dry=json "*) printf '• turbo 2.10.13\n'; cat "$dir/dry.json"; if [ -e "$dir/dry-fails" ]; then exit 2; fi ;;
  *" run build "*) printf '{}' > "$dir/.turbo/runs/RunId1.json" ;;
esac
STUB
  chmod +x "$dir/turbo"
  if [ "${DRY_FAILS:-}" = 1 ]; then : > "$dir/dry-fails"; fi
  shift 2
  (cd "$dir" && TURBO="$dir/turbo" WORKSPACE_ROOT="$dir" GITHUB_OUTPUT="$dir/gh" \
    bash "$script" "$@" > "$dir/out" 2>&1)
  echo $? > "$dir/code"
}

dry_two='{"tasks":[
  {"taskId":"@a/one#build","task":"build","package":"@a/one"},
  {"taskId":"@a/one#generate:api-docs","task":"generate:api-docs","package":"@a/one"},
  {"taskId":"@a/two#build","task":"build","package":"@a/two"},
  {"taskId":"@a/one#test","task":"test","package":"@a/one"},
  {"taskId":"@a/three#test","task":"test","package":"@a/three"}]}'

# 1. Every package with a build task, once each, as --filter flags, and the
#    caller's filters forwarded to the dry run only.
run_case builds "$dry_two" --filter=@a/three
check 'builds: exit 0' 0 "$(cat "$work_dir/builds/code")"
check 'builds: dry run forwards the filters' 'test --filter=@a/three --dry=json' \
  "$(sed -n 1p "$work_dir/builds/calls")"
check 'builds: one build run, one filter per build package' \
  'run build --summarize --concurrency=1 --filter=@a/one --filter=@a/two' \
  "$(sed -n 2p "$work_dir/builds/calls")"
check 'builds: summary on stdout' "summary=$work_dir/builds/.turbo/runs/RunId1.json" \
  "$(tail -1 "$work_dir/builds/out")"
check 'builds: summary in GITHUB_OUTPUT' "summary=$work_dir/builds/.turbo/runs/RunId1.json" \
  "$(cat "$work_dir/builds/gh")"

# 2. No build task: no build run, exit 0, no summary handed on.
run_case none '{"tasks":[{"taskId":"@a/one#test","task":"test","package":"@a/one"}]}'
check 'none: exit 0' 0 "$(cat "$work_dir/none/code")"
check 'none: only the dry run' 1 "$(grep -c '' "$work_dir/none/calls")"
check 'none: no GITHUB_OUTPUT line' absent "$([ -e "$work_dir/none/gh" ] && echo present || echo absent)"

# 3. A dry run that is not JSON fails, and nothing is built.
run_case garbage 'Error: something went wrong'
check 'garbage: exit non-zero' 1 "$([ "$(cat "$work_dir/garbage/code")" -ne 0 ] && echo 1 || echo 0)"
check 'garbage: only the dry run' 1 "$(grep -c '' "$work_dir/garbage/calls")"

# 4. A dry run that exits non-zero fails, says so, and nothing is built, even
#    when it printed something JSON-shaped first.
DRY_FAILS=1 run_case dryfail "$dry_two"
check 'dryfail: exit non-zero' 1 "$([ "$(cat "$work_dir/dryfail/code")" -ne 0 ] && echo 1 || echo 0)"
check 'dryfail: only the dry run' 1 "$(grep -c '' "$work_dir/dryfail/calls")"
check 'dryfail: names the failure' 1 "$(grep -c 'the turbo test dry run failed' "$work_dir/dryfail/out")"

printf 'build-test-deps fixtures: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
