#!/usr/bin/env bash
# 把当前仓库推到 GitHub（维护者用）。
#
# 用前先建一个空仓库：https://github.com/new
#   仓库名 dsh-session-forward，Public，不要勾 README / .gitignore / license。
#
# 用法：
#   bash scripts/publish-to-github.sh                 # 默认 apollodsh/dsh-session-forward，HTTPS
#   bash scripts/publish-to-github.sh --ssh           # 用 SSH 远程（需要先把公钥加到 GitHub）
#   bash scripts/publish-to-github.sh <owner> [repo]
#
# 认证提醒：GitHub 早已关闭「账号密码」推代码。HTTPS 方式里
#   Username = 你的 GitHub 用户名（apollodsh）
#   Password = Personal Access Token（不是登录密码），见 https://github.com/settings/tokens
# 更省事的是 SSH：ssh-keygen 生成后把 ~/.ssh/id_ed25519.pub 贴到
#   https://github.com/settings/ssh/new，再用 --ssh 跑本脚本。
set -euo pipefail

use_ssh=0
args=()
for arg in "$@"; do
  case "$arg" in
    --ssh) use_ssh=1 ;;
    *) args+=("$arg") ;;
  esac
done
owner="${args[0]:-apollodsh}"
repo="${args[1]:-dsh-session-forward}"

cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "这里不是 git 仓库" >&2
  exit 1
fi

if [ "$use_ssh" = 1 ]; then
  url="git@github.com:${owner}/${repo}.git"
else
  url="https://github.com/${owner}/${repo}.git"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$url"
else
  git remote add origin "$url"
fi

echo "远程：$url"

# HTTPS 的公开仓库可以匿名 ls-remote，用来看仓库在不在；
# SSH 必须先有公钥，这里不做预检（否则「没加公钥」会被误报成「仓库不存在」）。
if [ "$use_ssh" = 0 ] && ! git ls-remote "$url" >/dev/null 2>&1; then
  echo
  echo "连不上这个远程仓库。请确认：" >&2
  echo "  1. https://github.com/${owner}/${repo} 已经建好（空仓库即可）" >&2
  echo "  2. 用的是正确的 GitHub 用户名（不是邮箱）：${owner}" >&2
  exit 1
fi

echo "推送到 $url"
if ! push_log=$(git push -u origin main 2>&1); then
  echo "$push_log" >&2
  echo >&2
  case "$push_log" in
    *"Permission denied (publickey)"*)
      echo "SSH 公钥还没加到 GitHub（或加错了账号）。" >&2
      echo "  把 ~/.ssh/id_ed25519.pub 的内容贴到 https://github.com/settings/ssh/new" >&2
      echo "  然后 ssh -T git@github.com 看到 \"Hi ${owner}!\" 就说明通了。" >&2
      ;;
    *"port 22"*|*"Connection timed out"*|*"Connection refused"*|*"Operation timed out"*)
      echo "连不上 github.com 的 22 端口（很多网络会封 SSH）。两个办法：" >&2
      echo >&2
      echo "A) 改用 HTTPS + Personal Access Token（不动网络配置，最省事）" >&2
      echo "   https://github.com/settings/tokens  → Generate new token (classic) → 勾 repo" >&2
      echo "   git config --global credential.helper osxkeychain" >&2
      echo "   git push -u origin main     # Username: ${owner}   Password: 粘贴 token" >&2
      echo >&2
      echo "B) 继续用 SSH，但走 443 端口：" >&2
      echo "   mkdir -p ~/.ssh" >&2
      echo "   cat >> ~/.ssh/config <<'EOF'" >&2
      echo "   Host github.com" >&2
      echo "     HostName ssh.github.com" >&2
      echo "     Port 443" >&2
      echo "     User git" >&2
      echo "   EOF" >&2
      echo "   ssh -T git@github.com   # 看到 Hi ${owner}! 后再跑 bash scripts/publish-to-github.sh --ssh" >&2
      ;;
    *"Password authentication is not supported"*|*"could not read Username"*|*"Authentication failed"*|*"Invalid username or token"*)
      echo "HTTPS 需要 Personal Access Token，不是登录密码；用户名是 ${owner}（不是邮箱）。" >&2
      echo "   https://github.com/settings/tokens  → Generate new token (classic) → 勾 repo" >&2
      echo "   git config --global credential.helper osxkeychain   # 让 macOS 记住" >&2
      ;;
    *"Repository not found"*|*"not found"*)
      echo "GitHub 上找不到 ${owner}/${repo}，或者当前账号没有权限。" >&2
      echo "  先确认 https://github.com/${owner}/${repo} 已建好（空仓库即可）。" >&2
      ;;
    *)
      echo "推送失败，请把上面的报错发给我。" >&2
      ;;
  esac
  exit 1
fi

git push origin --tags
echo
echo "完成：https://github.com/${owner}/${repo}"
