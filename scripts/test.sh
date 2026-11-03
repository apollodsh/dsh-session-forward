#!/usr/bin/env bash
# 跑全部测试。优先用 PATH 里的 node；没有的话借用 DSH 桌面版自带的 Node（Electron）。
set -euo pipefail

cd "$(dirname "$0")/.."

CANDIDATES=(
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
  "${HOME:-/nonexistent}/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
  "/c/Program Files/DeepSeek Harness/DeepSeek Harness.exe"
  "${LOCALAPPDATA:-/nonexistent}/Programs/DeepSeek Harness/DeepSeek Harness.exe"
)

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  for candidate in "${CANDIDATES[@]}"; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      export ELECTRON_RUN_AS_NODE=1
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "找不到 Node.js。请安装 Node.js 22.15+，或装好 DSH 桌面版（会借用它内置的 Node）。" >&2
  exit 1
fi

echo "node: $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null || echo unknown))"
status=0
for file in test/run.mjs test/html-host.mjs test/share-server.mjs test/share-integration.mjs; do
  echo
  echo "== $file"
  "$NODE_BIN" "$file" || status=1
done
exit "$status"
