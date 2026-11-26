#!/bin/sh
# emos-sub 一键启动：PORT 自定义端口，ADMIN_TOKEN 是后台口令
# 用法：PORT=8080 ADMIN_TOKEN=你的口令 ./start.sh
set -eu
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
case "$PORT" in
  ''|*[!0-9]*) echo "PORT 必须是数字，当前是: $PORT" >&2; exit 1 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node，需要 Node >= 18" >&2; exit 1
fi
NODE_MAJOR=$(node -v | sed 's/^v//; s/\..*//')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node 版本太低：$(node -v)，需要 >= 18" >&2; exit 1
fi

if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "提示：没设 ADMIN_TOKEN，后台 /admin 不可用，只启动用户控制台"
fi

# 端口占用检查（ss 不可用时跳过）
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "端口 $PORT 已被占用，换一个 PORT 再试" >&2; exit 1
fi

echo "启动 emos-sub：http://127.0.0.1:$PORT/  后台：http://127.0.0.1:$PORT/admin"
exec node server.js
