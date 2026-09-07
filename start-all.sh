#!/bin/bash
# 无限心动 全栈启动脚本（容器重启后一键拉起所有服务）
# 用法：bash /output/infinite-date-v2/start-all.sh
# 幂等：已在运行的服务自动跳过，可反复执行
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE=/tmp/idate_env.sh
ENV_BACKUP="$ROOT_DIR/idate_env.sh"

echo "== 无限心动 全栈启动 =="

# 1. 恢复环境变量（/tmp 在容器重启后被清空，从项目备份找回）
if [ ! -f "$ENV_FILE" ] && [ -f "$ENV_BACKUP" ]; then
  cp "$ENV_BACKUP" "$ENV_FILE"
  echo "[env] 已从项目备份恢复 $ENV_FILE"
elif [ ! -f "$ENV_FILE" ]; then
  echo "[env] ⚠ 未找到 $ENV_FILE 及备份，后端将用默认配置（生图关闭、cookie 随机）"
fi

port_up() { ss -tlnp 2>/dev/null | grep -q ":$1 "; }

# 2. embedding（8001，先起小模型占少量显存）
if port_up 8001; then
  echo "[embedding] 已在运行（8001）"
else
  echo "[embedding] 启动 bge-base-zh（8001）..."
  cd "$ROOT_DIR/apps/server"
  nohup /opt/venv/bin/python embedding_server.py > /tmp/idate_embedding.log 2>&1 &
fi

# 3. vLLM（8000，gemma-4-26b；勿加 --enforce-eager，否则慢约 8 倍）
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

# 4. 后端（3000）
if port_up 3000; then
  echo "[后端] 已在运行（3000）"
else
  echo "[后端] 启动（3000）..."
  [ -f "$ENV_FILE" ] && source "$ENV_FILE"
  cd "$ROOT_DIR/apps/server"
  nohup npm run start > /tmp/idate_backend.log 2>&1 &
fi

# 5. web（8080）
if port_up 8080; then
  echo "[web] 已在运行（8080）"
else
  echo "[web] 启动 vite（8080）..."
  cd "$ROOT_DIR/apps/web"
  nohup ./node_modules/.bin/vite --host 0.0.0.0 --port 8080 > /tmp/idate_web.log 2>&1 &
fi

# 6. web-v4（3001）
if port_up 3001; then
  echo "[web-v4] 已在运行（3001）"
else
  echo "[web-v4] 启动（3001）..."
  cd "$ROOT_DIR/apps/web-v4"
  nohup ./node_modules/.bin/tsx server.ts > /tmp/idate_webv4.log 2>&1 &
fi

# 7. 健康检查
echo ""
echo "== 等待服务就绪 =="
wait_http() {
  local name="$1" url="$2" timeout="$3"
  local t=0
  while [ "$t" -lt "$timeout" ]; do
    if curl -s -m 8 -o /dev/null "$url" 2>/dev/null; then
      echo "  ✓ $name ($url)"
      return 0
    fi
    sleep 2
    t=$((t + 2))
  done
  echo "  ✗ $name 未就绪（${timeout}s 超时），查看日志"
  return 1
}
wait_http embedding http://127.0.0.1:8001/health     30
wait_http 后端     http://127.0.0.1:3000/api/health  40
wait_http web      http://127.0.0.1:8080/            30
wait_http web-v4   http://127.0.0.1:3001/            40
wait_http vLLM     http://127.0.0.1:8000/v1/models   300

echo ""
echo "== 完成。前端：8080（旧）/ 3001（心动终端 v4）；后端：3000 =="
echo "日志：/tmp/idate_{vllm,embedding,backend,web,webv4}.log"
