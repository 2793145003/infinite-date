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
# ── 环境变量加载 ────────────────────────────────────────────
# 项目根的 idate_env.sh 是**唯一真源**，/tmp/idate_env.sh 只是运行时镜像
# （容器重启会被清空）。旧写法把 /tmp 当主源，导致「改了项目根却不生效」，
# 所以这里反过来：每次启动把项目根同步到 /tmp，再统一 source。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_ENV="$ROOT_DIR/idate_env.sh"
ENV_FILE=/tmp/idate_env.sh
missing=""

if [ -f "$ROOT_ENV" ] && [ -f "$ENV_FILE" ] && ! cmp -s "$ROOT_ENV" "$ENV_FILE"; then
  missing=$(comm -13 <(grep -oE '^export [A-Za-z_]+=' "$ROOT_ENV" | sort -u) \
                     <(grep -oE '^export [A-Za-z_]+=' "$ENV_FILE" | sort -u) | sed 's/^export //' | tr -d '=' | tr '\n' ' ')
  if [ -n "$missing" ]; then
    echo "[env] ⚠ $ENV_FILE 里有 $ROOT_ENV 没有的变量：$missing"
    echo "[env]   已跳过覆盖以免丢配置；请把这几项补进 $ROOT_ENV 后再重启"
  fi
fi

if [ -f "$ROOT_ENV" ] && [ -z "$missing" ]; then
  cp "$ROOT_ENV" "$ENV_FILE"
  echo "[env] 已从项目根同步 $ENV_FILE"
fi

[ -f "$ROOT_ENV" ] && source "$ROOT_ENV"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

cd "$SERVER_DIR"
setsid nohup npm run start > "$BACKEND_LOG" 2>&1 < /dev/null &
echo "[restart] $(date '+%H:%M:%S') 已触发启动，日志 $BACKEND_LOG" >> "$RLOG"
