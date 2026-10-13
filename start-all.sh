#!/bin/bash
# 无限心动 全栈启动脚本（容器重启后一键拉起所有服务）
# 用法：bash /output/infinite-date-v2/start-all.sh
# 幂等：已在运行的服务自动跳过，可反复执行
#
# 启动顺序（顺序有意义，勿随意调整）：
#   1 env 恢复 → 2 依赖自愈 → 3 embedding(8001，小模型先占少量显存)
#   → 4 vLLM(8000) → 5 等 vLLM 就绪 → 6 后端(3000) → 7 web(8080) → 8 web-v4(3001)
# 说明：embedding 必须早于 vLLM（否则 0.9 显存占比被 vLLM 吃掉，小模型可能 OOM）；
#       后端必须晚于 vLLM 就绪（后端启动时会调模型，太早起会刷 checkScheduleChange failed）。
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE=/tmp/idate_env.sh
ENV_BACKUP="$ROOT_DIR/idate_env.sh"

# 可覆盖，便于离线测试：VLLM_HEALTH=<url> VLLM_WAIT_TIMEOUT=<秒>
VLLM_HEALTH="${VLLM_HEALTH:-http://127.0.0.1:8000/v1/models}"
VLLM_WAIT_TIMEOUT="${VLLM_WAIT_TIMEOUT:-300}"

echo "== 无限心动 全栈启动 =="

# 1. 恢复环境变量
# 项目根 idate_env.sh 是**唯一真源**，/tmp/idate_env.sh 只是运行时镜像
# （容器重启会被清空）。旧写法只做单向恢复：/tmp 一旦存在就不再同步，
# 于是「改了项目根却不生效」。现在每次启动都从项目根同步过来。
ENV_MISSING=""
if [ -f "$ENV_BACKUP" ] && [ -f "$ENV_FILE" ] && ! cmp -s "$ENV_BACKUP" "$ENV_FILE"; then
  ENV_MISSING=$(comm -13 <(grep -oE '^export [A-Za-z_]+=' "$ENV_BACKUP" | sort -u) \
                          <(grep -oE '^export [A-Za-z_]+=' "$ENV_FILE" | sort -u) | sed 's/^export //' | tr -d '=' | tr '\n' ' ')
  if [ -n "$ENV_MISSING" ]; then
    echo "[env] ⚠ $ENV_FILE 里有 $ENV_BACKUP 没有的变量：$ENV_MISSING"
    echo "[env]   已跳过覆盖以免丢配置；请把这几项补进 $ENV_BACKUP 后再启动"
  fi
fi

if [ -f "$ENV_BACKUP" ] && [ -z "$ENV_MISSING" ]; then
  cp "$ENV_BACKUP" "$ENV_FILE"
  echo "[env] 已从项目根同步 $ENV_FILE"
elif [ ! -f "$ENV_FILE" ]; then
  echo "[env] ⚠ 未找到 $ENV_FILE 及备份，后端将用默认配置（生图关闭、cookie 随机）"
fi

port_up() { ss -tlnp 2>/dev/null | grep -q ":$1 "; }

# 轮询等待 HTTP 就绪；成功返回 0，超时返回 1
wait_http() {
  local name="$1" url="$2" timeout="$3"
  local t=0
  while [ "$t" -lt "$timeout" ]; do
    if curl -s -m 8 -o /dev/null "$url" 2>/dev/null; then
      echo "  ✓ $name ($url)${4:+  [$4]}"
      return 0
    fi
    sleep 2
    t=$((t + 2))
  done
  echo "  ✗ $name 未就绪（${timeout}s 超时），查看日志"
  return 1
}

# 2. embedding 依赖自愈：sentence-transformers 装在 /opt/venv（overlay 层，容器重建会丢）
WHEEL_DIR="$ROOT_DIR/.wheels"
if ! /opt/venv/bin/python -c "import sentence_transformers" >/dev/null 2>&1; then
  echo "[embedding] /opt/venv 缺少 sentence_transformers，尝试安装..."
  if ls "$WHEEL_DIR"/sentence_transformers*.whl >/dev/null 2>&1; then
    /opt/venv/bin/pip install -q --no-index --find-links "$WHEEL_DIR" sentence-transformers \
      || /opt/venv/bin/pip install -q "$WHEEL_DIR"/sentence_transformers*.whl
  else
    /opt/venv/bin/pip install -q sentence-transformers
  fi
  if /opt/venv/bin/python -c "import sentence_transformers" >/dev/null 2>&1; then
    echo "[embedding] ✓ 安装成功"
    mkdir -p "$WHEEL_DIR"
    /opt/venv/bin/pip download -q --no-deps sentence-transformers -d "$WHEEL_DIR" >/dev/null 2>&1 \
      && echo "[embedding] 已缓存 wheel 到 $WHEEL_DIR（下次断网也能装）"
  else
    echo "[embedding] ⚠ 安装失败：embedding 不可用，记忆检索将降级（对话仍可进行）"
  fi
fi

# 3. embedding（8001，先起小模型占少量显存）
if port_up 8001; then
  echo "[embedding] 已在运行（8001）"
else
  echo "[embedding] 启动 bge-base-zh（8001）..."
  cd "$ROOT_DIR/apps/server"
  nohup /opt/venv/bin/python embedding_server.py > /tmp/idate_embedding.log 2>&1 &
fi

# 4. vLLM（8000，gemma-4-26b；勿加 --enforce-eager，否则慢约 8 倍）
if port_up 8000; then
  echo "[vLLM] 已在运行（8000）"
else
  echo "[vLLM] 启动 gemma-4-26b（8000），首次加载约 2-3 分钟..."
  cd /
  nohup /opt/venv/bin/vllm serve /input0/models/gemma-4-26B-A4B-it \
    --host 0.0.0.0 --port 8000 \
    --served-model-name gemma-4-26b \
    --trust-remote-code --dtype bfloat16 \
    --max-model-len 16384 \
    --gpu-memory-utilization 0.9 \
    > /tmp/idate_vllm.log 2>&1 &
fi

# 5. 等 vLLM 就绪再起后端（后端启动时即会调模型；超时不阻塞，降级启动并提示）
echo "[vLLM] 等待就绪（最多 ${VLLM_WAIT_TIMEOUT}s）..."
if wait_http vLLM "$VLLM_HEALTH" "$VLLM_WAIT_TIMEOUT"; then
  :
else
  echo "[vLLM] ⚠ 未就绪，仍继续启动后端；模型相关功能（对话/续写）会在 vLLM 恢复后可用"
fi

# 6. 后端（3000）
if port_up 3000; then
  echo "[后端] 已在运行（3000）"
else
  echo "[后端] 启动（3000）..."
  [ -f "$ENV_FILE" ] && source "$ENV_FILE"
  cd "$ROOT_DIR/apps/server"
  nohup npm run start > /tmp/idate_backend.log 2>&1 &
fi

# 6.5 QQ 桥（没有监听端口，用 pid 文件判存活）
# 这是**一个进程服务所有绑定**的常驻桥：每 20s 扫一轮出站、每 60s 扫一轮新绑定并接网关。
# 所以别人扫码绑定时不需要你手动起桥 —— 桥最多 60s 内自己会把那条绑定的连接接上。
#
# 判活为什么用 pid 文件而不是 pgrep：pgrep -f "qq-bridge/main.ts" 会把「命令行里含这个字串的
# 调用方 shell」也算成目标，于是出现「明明没在跑却说已在运行」。pid 文件 + kill -0 不会误判。
QQBRIDGE_PIDFILE=/tmp/idate_qqbridge.pid
bridge_running() {
  [ -f "$QQBRIDGE_PIDFILE" ] && kill -0 "$(cat "$QQBRIDGE_PIDFILE" 2>/dev/null)" 2>/dev/null
}
if bridge_running; then
  echo "[QQ桥] 已在运行（pid $(cat "$QQBRIDGE_PIDFILE")）"
elif [ ! -f "$ENV_FILE" ]; then
  echo "[QQ桥] ⚠ 未找到 $ENV_FILE，跳过启动"
elif ! grep -q '^export IDATE_QQ_SECRET_KEY=' "$ENV_FILE"; then
  # 没这把密钥就没法解密绑定里的 AppSecret —— 起了也发不出去，不如明确说清楚
  echo "[QQ桥] ⚠ $ENV_FILE 缺少 IDATE_QQ_SECRET_KEY，跳过启动（QQ 推送会全部失败）"
else
  echo "[QQ桥] 启动（一个进程服务所有绑定；需能出网连 QQ 网关）..."
  source "$ENV_FILE"
  cd "$ROOT_DIR/apps/server"
  # 用 setsid 脱离当前进程组 —— 和 restart.sh 起后端用的是同一套写法。
  setsid nohup ./node_modules/.bin/tsx src/qq-bridge/main.ts > /tmp/idate_qqbridge.log 2>&1 < /dev/null &
  # 等它把 pid 文件写出来，确认真的起来了（而不是只留下一个空壳）
  for _ in $(seq 1 15); do
    sleep 1
    bridge_running && break
  done
  if bridge_running; then
    echo "[QQ桥] ✓ 已启动（pid $(cat "$QQBRIDGE_PIDFILE")）"
  else
    echo "[QQ桥] ✗ 启动失败，看 /tmp/idate_qqbridge.log"
  fi
fi

# 7. web（8080）
if port_up 8080; then
  echo "[web] 已在运行（8080）"
else
  echo "[web] 启动 vite（8080）..."
  cd "$ROOT_DIR/apps/web"
  nohup ./node_modules/.bin/vite --host 0.0.0.0 --port 8080 > /tmp/idate_web.log 2>&1 &
fi

# 8. web-v4（3001）
if port_up 3001; then
  echo "[web-v4] 已在运行（3001）"
else
  echo "[web-v4] 启动（3001）..."
  cd "$ROOT_DIR/apps/web-v4"
  nohup ./node_modules/.bin/tsx server.ts > /tmp/idate_webv4.log 2>&1 &
fi

# 9. 健康检查
echo ""
echo "== 等待服务就绪 =="
wait_http embedding http://127.0.0.1:8001/health     30
wait_http 后端     http://127.0.0.1:3000/api/health  40
wait_http web      http://127.0.0.1:8080/            30
wait_http web-v4   http://127.0.0.1:3001/            40
wait_http vLLM     "$VLLM_HEALTH"                    60
if [ -f /tmp/idate_qqbridge.pid ] && kill -0 "$(cat /tmp/idate_qqbridge.pid 2>/dev/null)" 2>/dev/null; then
  echo "  ✓ QQ桥（pid $(cat /tmp/idate_qqbridge.pid)，无监听端口）"
else
  echo "  ✗ QQ桥 未启动（检查 $ENV_FILE 与 /tmp/idate_qqbridge.log）"
fi

echo ""
echo "== 完成。前端：8080（旧）/ 3001（心动终端 v4）；后端：3000；QQ桥：常驻进程 =="
echo "日志：/tmp/idate_{vllm,embedding,backend,web,webv4,qqbridge}.log"
