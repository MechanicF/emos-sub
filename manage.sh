#!/bin/bash
# emos-sub 控制脚本 — 安装 / 卸载 / 启动 / 停止 / 重启 / 端口 / 自启 / 状态 / 日志 / 更新 / 备份
#
# 用法（在仓库目录里，或安装后任意目录）：
#   ./manage.sh install [选项]     安装到服务器并启动（默认 /opt/emos-sub，需 root 或 sudo）
#   ./manage.sh uninstall          停止并卸载（会先备份配置到 /tmp）
#   ./manage.sh start|stop|restart 启动 / 停止 / 重启
#   ./manage.sh status             查看当前状态（运行、端口、健康、节点数、版本）
#   ./manage.sh logs [-f]          查看日志（-f 实时跟随）
#   ./manage.sh port <端口>        改端口并重启（1-65535）
#   ./manage.sh autostart on|off   开机自启 开 / 关
#   ./manage.sh update             更新到 GitHub 最新版并重启（先备份配置；.env、节点、设置保留，代码文件被新版覆盖）
#   ./manage.sh backup             备份配置到 ./backups/
#   ./manage.sh config             查看当前配置（ADMIN_TOKEN 只显示前 4 位）
#   ./manage.sh set-token <口令>   改后台口令并重启
#   ./manage.sh set-url <域名>     改公开访问域名（PUBLIC_URL，如 https://sub.example.com）并重启
#   ./manage.sh health             只测一次健康检查
#   ./manage.sh help               帮助
#
# 安装选项（只对 install 有效）：
#   --dir <路径>        安装目录，默认 /opt/emos-sub（非 root 时默认 $HOME/emos-sub）
#   --port <端口>       端口，默认 3000
#   --admin-token <口令> 后台口令；不给则随机生成并打印一次（请记好）
#   --public-url <域名>  公开域名，如 https://sub.example.com（EMOS 回跳用）
#   --no-autostart      安装后不开机自启
#   --no-start          只安装，不启动
#
# 环境变量（也可替代选项）：EMOS_INSTALL_DIR、EMOS_PORT、EMOS_ADMIN_TOKEN、EMOS_PUBLIC_URL
# 配置存在安装目录的 .env（600 权限），systemd 服务用它启动；无 systemd 的机器自动退回 nohup 后台运行。
set -u
PROG="${0##*/}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_DIR="/opt/emos-sub"
[ "$(id -u)" -ne 0 ] && DEFAULT_DIR="$HOME/emos-sub"
INSTALL_DIR="${EMOS_INSTALL_DIR:-$DEFAULT_DIR}"
ENV_FILE="$INSTALL_DIR/.env"
SERVICE="emos-sub"
UNIT="/etc/systemd/system/$SERVICE.service"
BACKUP_DIR="$INSTALL_DIR/backups"

# ---------- 小工具 ----------
say()  { printf '%s\n' "$*"; }
err()  { printf '错误：%s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || { err "没找到 $1，请先安装"; return 1; }; }
has_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }
is_root() { [ "$(id -u)" -eq 0 ]; }
sudo_if_needed() { if is_root; then "$@"; elif command -v sudo >/dev/null 2>&1; then sudo "$@"; else err "需要 root 权限，请用 root 或安装 sudo 后再试"; return 1; fi; }

port_of() { # 从 .env 读 PORT，默认 3000
  local p=3000
  [ -f "$ENV_FILE" ] && p="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' "')"
  [ -n "${p:-}" ] && [ "$p" -eq "$p" ] 2>/dev/null && echo "$p" || echo 3000
}
valid_port() { case "$1" in ''|*[!0-9]*) return 1;; *) [ "$1" -ge 1 ] && [ "$1" -le 65535 ];; esac; }
port_free() { # 0=空闲
  if command -v ss >/dev/null 2>&1; then ! ss -ltn 2>/dev/null | grep -q ":$1 "; return $?
  elif command -v lsof >/dev/null 2>&1; then ! lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; return $?
  else return 0; fi
}
running_pid() { # 打印 node server.js 的 pid（安装目录里的）
  pgrep -f "node .*server\.js" 2>/dev/null | while read -r pid; do
    [ -n "$pid" ] && readlink "/proc/$pid/cwd" 2>/dev/null | grep -qx "$INSTALL_DIR" && echo "$pid"
  done | head -1
}
health_json() { curl -fsS -m 5 "http://127.0.0.1:$(port_of)/health" 2>/dev/null; }
write_env() { # write_env KEY VALUE：更新 .env 里一项（不存在则追加），文件 600
  local key="$1" val="$2" tmp
  [ -f "$ENV_FILE" ] || : > "$ENV_FILE"
  tmp="$(mktemp)"
  grep -v -E "^${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"; chmod 600 "$ENV_FILE"
}
gen_token() { head -c 24 /dev/urandom 2>/dev/null | base64 | tr -d '/+=' | head -c 24; echo; }

# ---------- 状态 / 健康 ----------
cmd_status() {
  say "== emos-sub 状态 =="
  say "安装目录：$INSTALL_DIR  $([ -d "$INSTALL_DIR" ] && echo "（已安装）" || echo "（未安装）")"
  if [ -f "$INSTALL_DIR/server.js" ]; then
    local v; v="$(cd "$INSTALL_DIR" && git rev-parse --short origin/main 2>/dev/null)"
    if [ -n "$v" ]; then say "版本：origin/main $v"
    else say "版本：$(cd "$INSTALL_DIR" && git log --oneline -1 2>/dev/null || echo "未用 git 安装")"; fi
    local av; av="$(grep -o "VERSION = '[^']*'" "$INSTALL_DIR/server.js" 2>/dev/null | cut -d"'" -f2)"
    [ -n "$av" ] && say "程序版本：v$av"
  fi
  local pid; pid="$(running_pid)"
  if has_systemd && [ -f "$UNIT" ]; then
    systemctl is-enabled "$SERVICE" >/dev/null 2>&1 && say "开机自启：已开启" || say "开机自启：未开启"
    say "systemd：$(systemctl is-active "$SERVICE" 2>/dev/null || echo "未运行")"
  elif has_systemd; then say "systemd：未安装服务"; else say "systemd：本机无 systemd（用 nohup 方式运行）"; fi
  if [ -n "$pid" ]; then
    say "进程：运行中，pid $pid，启动于 $(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')"
  else say "进程：未运行"; fi
  local port; port="$(port_of)"; say "端口：$port  $(port_free "$port" && echo "（空闲）" || echo "（被占用）")"
  local h; h="$(health_json)"
  if [ -n "$h" ]; then say "健康检查：正常  $h"; else say "健康检查：失败（服务没起来或端口不对）"; fi
  say "控制台：http://127.0.0.1:$port/   后台：http://127.0.0.1:$port/admin"
  local url; url="$(grep -E '^PUBLIC_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
  [ -n "$url" ] && say "公开域名：$url"
}
cmd_health() { health_json && echo && say "健康检查通过" || { err "健康检查失败：http://127.0.0.1:$(port_of)/health 没响应"; return 1; }; }
cmd_config() {
  [ -f "$ENV_FILE" ] || { err "没有配置文件 $ENV_FILE（还没安装？）"; return 1; }
  say "== 当前配置（$ENV_FILE）=="
  while IFS='=' read -r k v; do
    [ -z "$k" ] && continue
    case "$k" in ADMIN_TOKEN) say "$k=${v:0:4}****（已隐藏）";; *) say "$k=$v";; esac
  done < "$ENV_FILE"
}

# ---------- 启动 / 停止 / 重启 ----------
do_start() {
  [ -f "$INSTALL_DIR/server.js" ] || { err "安装目录里没有 server.js：$INSTALL_DIR（先 install）"; return 1; }
  need node || return 1
  local major; major="$(node -v | sed 's/^v//; s/\..*//')"
  [ "$major" -ge 18 ] || { err "Node 版本太低：$(node -v)，需要 >= 18"; return 1; }
  local port; port="$(port_of)"
  valid_port "$port" || { err "PORT 无效：$port"; return 1; }
  if [ -n "$(running_pid)" ]; then say "已经在运行了（pid $(running_pid)），不用重复启动"; return 0; fi
  if ! port_free "$port"; then err "端口 $port 已被别的程序占用，先换端口（./manage.sh port <新端口>）或停掉占用的程序"; return 1; fi
  if has_systemd && [ -f "$UNIT" ]; then
    sudo_if_needed systemctl start "$SERVICE" || return 1
  else
    (cd "$INSTALL_DIR" && set -a && . ./.env 2>/dev/null; set +a
     nohup node server.js > "$INSTALL_DIR/server.log" 2>&1 &
     echo $! > "$INSTALL_DIR/.pid")
  fi
  sleep 2
  health_json >/dev/null && say "已启动：http://127.0.0.1:$port/（后台 /admin）" || { err "启动后健康检查失败，看日志：./manage.sh logs"; return 1; }
}
do_stop() {
  local pid; pid="$(running_pid)"
  local was_systemd=0
  if has_systemd && [ -f "$UNIT" ] && [ "$(systemctl is-active "$SERVICE" 2>/dev/null)" = "active" ]; then was_systemd=1; fi
  if [ "$was_systemd" -eq 1 ]; then sudo_if_needed systemctl stop "$SERVICE" 2>/dev/null || true; say "已停止（systemd 服务）"
  elif [ -n "$pid" ]; then kill "$pid" 2>/dev/null; sleep 1; kill -9 "$pid" 2>/dev/null || true; say "已停止（pid $pid）"
  else say "本来就没在运行"; fi
  rm -f "$INSTALL_DIR/.pid"
}
cmd_logs() {
  if has_systemd && [ -f "$UNIT" ]; then
    if [ "${1:-}" = "-f" ]; then sudo_if_needed journalctl -u "$SERVICE" -f --no-pager
    else sudo_if_needed journalctl -u "$SERVICE" -n 100 --no-pager; fi
  elif [ -f "$INSTALL_DIR/server.log" ]; then
    if [ "${1:-}" = "-f" ]; then tail -f "$INSTALL_DIR/server.log"; else tail -n 100 "$INSTALL_DIR/server.log"; fi
  else err "没有日志（服务没跑过，或 systemd 日志为空）"; return 1; fi
}

# ---------- 安装 / 卸载 ----------
cmd_install() {
  local port="${EMOS_PORT:-3000}" token="${EMOS_ADMIN_TOKEN:-}" url="${EMOS_PUBLIC_URL:-}" autostart=1 start=1 dir="$INSTALL_DIR"
  while [ $# -gt 0 ]; do case "$1" in
    --dir) dir="$2"; shift 2;; --port) port="$2"; shift 2;;
    --admin-token) token="$2"; shift 2;; --public-url) url="$2"; shift 2;;
    --no-autostart) autostart=0; shift;; --no-start) start=0; shift;;
    *) err "install 不认识的选项：$1"; return 1;; esac; done
  INSTALL_DIR="$dir"; ENV_FILE="$INSTALL_DIR/.env"; BACKUP_DIR="$INSTALL_DIR/backups"
  valid_port "$port" || { err "端口无效：$port（1-65535）"; return 1; }
  need node && need git || return 1
  local major; major="$(node -v | sed 's/^v//; s/\..*//')"
  [ "$major" -ge 18 ] || { err "Node 版本太低：$(node -v)，需要 >= 18"; return 1; }
  if [ -d "$INSTALL_DIR/.git" ]; then say "安装目录已有代码，改为更新"; cmd_update || return 1
  else
    say "安装到 $INSTALL_DIR ..."
    if [ "$REPO_DIR" != "$INSTALL_DIR" ] && [ -f "$REPO_DIR/server.js" ]; then
      mkdir -p "$INSTALL_DIR" && cp -a "$REPO_DIR"/. "$INSTALL_DIR"/ && rm -rf "$INSTALL_DIR/.git"
      # 把复制过来的代码先提交成本地快照，再连 origin，这样以后 update 能 fetch + 对照
      (cd "$INSTALL_DIR" && git init -q -b main && git config user.name "emos-sub" && git config user.email "emos-sub@localhost" && git add -A && git commit -qm "install snapshot" && git remote add origin https://github.com/MechanicF/emos-sub.git && git fetch -q origin main 2>/dev/null && git branch --set-upstream-to=origin/main main 2>/dev/null || true)
    else
      git clone https://github.com/MechanicF/emos-sub.git "$INSTALL_DIR" || { err "git clone 失败"; return 1; }
    fi
  fi
  [ -f "$ENV_FILE" ] || : > "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  write_env PORT "$port"
  if [ -n "$token" ]; then write_env ADMIN_TOKEN "$token"; say "后台口令：已按你给的设置"
  elif ! grep -q '^ADMIN_TOKEN=' "$ENV_FILE"; then token="$(gen_token)"; write_env ADMIN_TOKEN "$token"; say "后台口令：随机生成 $token（只显示这一次，请记好）"
  else say "后台口令：沿用原来的（没变）"; fi
  [ -n "$url" ] && write_env PUBLIC_URL "$url"
  if has_systemd; then
    say "写 systemd 服务 $UNIT ..."
    sudo_if_needed tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=emos-sub EMOS subscription gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    sudo_if_needed systemctl daemon-reload
    if [ "$autostart" -eq 1 ]; then sudo_if_needed systemctl enable "$SERVICE" && say "开机自启：已开启"; else sudo_if_needed systemctl disable "$SERVICE" 2>/dev/null || true; say "开机自启：未开启（可用 ./manage.sh autostart on 打开）"; fi
  else
    say "本机无 systemd，改用 nohup 后台运行；开机自启请用 cron @reboot（./manage.sh autostart on 会帮你加）"
    [ "$autostart" -eq 1 ] && cmd_autostart on || true
  fi
  [ "$start" -eq 1 ] && do_start || say "已安装，未启动：./manage.sh start"
}
cmd_uninstall() {
  [ -d "$INSTALL_DIR" ] || { err "没找到安装目录 $INSTALL_DIR，没什么可卸的"; return 1; }
  say "先备份配置到 /tmp/emos-sub-backup-*.tar.gz ..."
  cmd_backup /tmp || true
  printf '确定卸载吗？将停止服务并删除 %s（配置已备份到 /tmp）[y/N] ' "$INSTALL_DIR"
  read -r ans; case "$ans" in y|Y|yes) ;; *) say "已取消"; return 0;; esac
  do_stop || true
  if has_systemd && [ -f "$UNIT" ]; then sudo_if_needed systemctl disable "$SERVICE" 2>/dev/null || true; sudo_if_needed rm -f "$UNIT"; sudo_if_needed systemctl daemon-reload; fi
  (crontab -l 2>/dev/null | grep -v "emos-sub" | grep -v "$INSTALL_DIR") | crontab - 2>/dev/null || true
  rm -rf "$INSTALL_DIR"
  say "已卸载。配置备份在 /tmp/emos-sub-backup-*.tar.gz，重装时可恢复。"
}
cmd_autostart() {
  case "${1:-}" in
    on)
      if has_systemd && [ -f "$UNIT" ]; then sudo_if_needed systemctl enable "$SERVICE" && say "开机自启：已开启"
      elif has_systemd; then err "还没安装 systemd 服务，先 ./manage.sh install"; return 1
      else # 无 systemd：cron @reboot
        need crontab || return 1
        (crontab -l 2>/dev/null | grep -v "$INSTALL_DIR/manage.sh start"; echo "@reboot $INSTALL_DIR/manage.sh start >/dev/null 2>&1") | crontab -
        say "开机自启：已开启（cron @reboot 方式）"; fi;;
    off)
      if has_systemd && [ -f "$UNIT" ]; then sudo_if_needed systemctl disable "$SERVICE" && say "开机自启：已关闭"
      else (crontab -l 2>/dev/null | grep -v "$INSTALL_DIR/manage.sh start") | crontab - 2>/dev/null || true; say "开机自启：已关闭"; fi;;
    *) err "用法：./manage.sh autostart on|off"; return 1;; esac
}
cmd_port() {
  valid_port "${1:-}" || { err "用法：./manage.sh port <端口>（1-65535）"; return 1; }
  [ -f "$ENV_FILE" ] || { err "还没安装，先 ./manage.sh install"; return 1; }
  local old; old="$(port_of)"
  [ "$1" = "$old" ] && { say "端口已经是 $1，不用改"; return 0; }
  if ! port_free "$1"; then err "端口 $1 已被占用，换一个"; return 1; fi
  write_env PORT "$1"; say "端口：$old → $1，正在重启..."
  do_stop; do_start
}
cmd_update() {
  [ -d "$INSTALL_DIR" ] || { err "还没安装，先 ./manage.sh install"; return 1; }
  need git || return 1
  # 保证有 origin（复制安装的目录可能只有本地提交）
  (cd "$INSTALL_DIR" && git remote get-url origin >/dev/null 2>&1) || (cd "$INSTALL_DIR" && git remote add origin https://github.com/MechanicF/emos-sub.git)
  cmd_backup || true
  (cd "$INSTALL_DIR" && git fetch origin main) || { err "git fetch 失败，检查网络和 GitHub 连通性"; return 1; }
  local ver; ver="$(cd "$INSTALL_DIR" && git rev-parse --short origin/main)"
  # 用户数据不参与更新，更新前先保住：.env、后台改过的节点和设置
  local keep; keep="$(mktemp -d)"
  [ -f "$INSTALL_DIR/.env" ] && cp "$INSTALL_DIR/.env" "$keep/.env"
  [ -f "$INSTALL_DIR/config/nodes.json" ] && cp "$INSTALL_DIR/config/nodes.json" "$keep/nodes.json"
  [ -f "$INSTALL_DIR/config/settings.json" ] && cp "$INSTALL_DIR/config/settings.json" "$keep/settings.json"
  # 只更新代码文件（不 pull、不 reset --hard，避免本地节点配置被冲掉；
  # 本地改过 server.js 等代码文件会被新版覆盖，改之前已备份）
  (cd "$INSTALL_DIR" && git checkout origin/main -- server.js README.md manage.sh start.sh .gitignore config/templates) || { err "更新代码文件失败"; rm -rf "$keep"; return 1; }
  [ -f "$keep/.env" ] && cp "$keep/.env" "$INSTALL_DIR/.env"
  [ -f "$keep/nodes.json" ] && cp "$keep/nodes.json" "$INSTALL_DIR/config/nodes.json"
  [ -f "$keep/settings.json" ] && cp "$keep/settings.json" "$INSTALL_DIR/config/settings.json"
  rm -rf "$keep"
  chmod +x "$INSTALL_DIR/manage.sh" "$INSTALL_DIR/start.sh" 2>/dev/null || true
  say "已更新到 origin/main $ver（.env、节点、设置已保留），正在重启..."
  do_stop; do_start
}
cmd_backup() {
  local dest="${1:-$INSTALL_DIR/backups}"; mkdir -p "$dest"
  local f="$dest/emos-sub-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
  tar -czf "$f" -C "$INSTALL_DIR" .env config 2>/dev/null || tar -czf "$f" -C "$INSTALL_DIR" .env 2>/dev/null
  say "备份完成：$f（.env + config/）"
}
cmd_set_token() {
  [ -n "${1:-}" ] || { err "用法：./manage.sh set-token <新口令>"; return 1; }
  [ -f "$ENV_FILE" ] || { err "还没安装，先 ./manage.sh install"; return 1; }
  write_env ADMIN_TOKEN "$1"; say "后台口令已改，正在重启..."; do_stop; do_start
}
cmd_set_url() {
  [ -n "${1:-}" ] || { err "用法：./manage.sh set-url <域名>，如 https://sub.example.com（空字符串传 '' 表示清除）"; return 1; }
  [ -f "$ENV_FILE" ] || { err "还没安装，先 ./manage.sh install"; return 1; }
  write_env PUBLIC_URL "$1"; say "公开域名已改成 $1，正在重启..."; do_stop; do_start
}
cmd_help() {
  sed -n '2,30p' "$0" | sed 's/^# //; s/^#//'
}

# ---------- 入口 ----------
case "${1:-help}" in
  install) shift; cmd_install "$@";;
  uninstall) cmd_uninstall;;
  start) do_start;;
  stop) do_stop;;
  restart) do_stop; do_start;;
  status) cmd_status;;
  logs) shift; cmd_logs "${1:-}";;
  port) shift; cmd_port "${1:-}";;
  autostart) shift; cmd_autostart "${1:-}";;
  update) cmd_update;;
  backup) cmd_backup;;
  config) cmd_config;;
  set-token) shift; cmd_set_token "${1:-}";;
  set-url) shift; cmd_set_url "${1:-}";;
  health) cmd_health;;
  help|--help|-h) cmd_help;;
  *) err "不认识的命令：$1"; cmd_help; exit 1;;
esac
