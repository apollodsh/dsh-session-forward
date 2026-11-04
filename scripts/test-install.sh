#!/usr/bin/env bash
# Exercise the real CLI against a disposable profile. Usage:
#   EXPECTED_VERSION=0.2.1 bash scripts/test-install.sh [target] [base-package-spec]
# Target may be a tarball, a fixed GitHub ref, or a local directory (default).
# An optional base spec installs and removes an older plugin before the target.
set -euo pipefail

if [ "$#" -gt 2 ]; then
  echo "Usage: $0 [target] [base-package-spec]" >&2
  exit 2
fi
for command in dsh node mktemp; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 1; }
done

repo_dir="$(cd "$(dirname "$0")/.." && pwd -P)"
target="${1:-$repo_dir}"
if [ -e "$target" ]; then target="$(cd "$(dirname "$target")" && pwd -P)/$(basename "$target")"; fi
expected_version="${EXPECTED_VERSION:-0.2.1}"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/dsh-install-test.XXXXXXXX")"
# Only remove the exact directory created above, never an inherited DSH_HOME.
cleanup() {
  if [ -n "${test_root:-}" ] && [ -d "$test_root" ] && [ ! -L "$test_root" ]; then
    rm -rf -- "$test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export DSH_HOME="$test_root/home"
profile=install-test
profile_dir="$DSH_HOME/profiles/$profile"
manifest="$profile_dir/package.json"

check_manifest() {
  node - "$manifest" "$expected_version" "$1" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [manifestPath, expected, state] = process.argv.slice(2);
const profile = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const name = 'dsh-session-forward';
const bundles = profile.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) throw new Error('profile bundles missing');
const count = bundles.filter(bundle => bundle === name).length;
if (state === 'installed') {
  if (count !== 1 || !profile.dependencies?.[name]) throw new Error('bundle not installed and selected exactly once');
  const installed = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), 'node_modules', name, 'package.json'), 'utf8'));
  if (installed.name !== name || installed.version !== expected) throw new Error(`expected ${name}@${expected}, got ${installed.name}@${installed.version}`);
} else if (count || profile.dependencies?.[name]) {
  throw new Error('bundle still selected or declared after removal');
}
NODE
}

check_config() {
  local state="$1" output="$test_root/config.txt"
  dsh --profile "$profile" --dump-config > "$output"
  node - "$output" "$state" <<'NODE'
const fs = require('node:fs');
const [file, state] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
const present = /\bsession-forward\b/.test(text);
if (present !== (state === 'installed')) throw new Error(`dump-config: session-forward ${present ? 'present' : 'absent'} after ${state}`);
NODE
}

if [ "$#" -eq 2 ]; then
  echo "Installing optional base: $2"
  dsh plugin --profile "$profile" add "$2"
  dsh plugin --profile "$profile" remove dsh-session-forward
  check_manifest removed
  check_config removed
fi
for phase in install reinstall; do
  echo "== $phase"
  dsh plugin --profile "$profile" add "$target"
  check_manifest installed
  check_config installed
  if [ "$phase" = install ]; then
    echo "== repeat installed source"
    dsh plugin --profile "$profile" add "$target"
    check_manifest installed
    check_config installed
    echo "== uninstall"
    dsh plugin --profile "$profile" remove dsh-session-forward
    check_manifest removed
    check_config removed
  fi
done
echo "Install, repeated add, uninstall, and reinstall passed for dsh-session-forward@$expected_version"
