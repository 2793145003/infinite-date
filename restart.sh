#!/bin/bash
# 无限心动后端自重启脚本
# 触发：POST /admin/restart（鉴权后 detached spawn 本脚本）
# 手动：bash /output/infinite-date-v2/restart.sh
set -u

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/apps/server" && pwd)"
RLOG=/tmp/idate_restart.log
BACKEND_LOG=/tmp/idate_backend.log

# 1. API 触发时，等 HTTP 响应先返回再动手
sleep 2

# 2. 停旧后端：杀监听 3000 的 node（父链 npm→sh→node 会级联退出）
PID=$(ss -tlnp 2>/dev/null | grep ':3000 ' | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "${PID:-}" ]; then
  echo "[restart] $(date '+%H:%M:%S') 停止旧后端 pid=$PID" >> "$RLOG"
  kill "$PID" 2>/dev/null
  sleep 2
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
else
  echo "[restart] $(date '+%H:%M:%S') 3000 无监听，直接启动" >> "$RLOG"
fi

# 3. 等端口释放（最多 10 秒）
for _ in $(seq 1 10); do
  ss -tlnp 2>/dev/null | grep -q ':3000 ' || break
  sleep 1
done

# 4. 启动新后端（setsid 完全脱离本脚本，父进程退出后仍存活）
if [ -f /tmp/idate_env.sh ]; then
  source /tmp/idate_env.sh
else
  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$ROOT_DIR/idate_env.sh" ] && source "$ROOT_DIR/idate_env.sh"
fi
cd "$SERVER_DIR"
setsid nohup npm run start > "$BACKEND_LOG" 2>&1 < /dev/null &
echo "[restart] $(date '+%H:%M:%S') 已触发启动，日志 $BACKEND_LOG" >> "$RLOG"
