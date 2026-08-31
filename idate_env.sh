# 无限心动后端环境变量（重建）
export HOST=0.0.0.0
export PORT=3000

## LLM（本地 vLLM）
export LLM_BASE_URL=http://127.0.0.1:8000/v1
export LLM_API_KEY=local-vllm
export LLM_MODEL=gemma-4-26b

## CORS
export CORS_ORIGINS=http://localhost:8080,http://localhost:5173,http://localhost:3001

## Cookie 签名密钥（固定值，避免每次重启随机）
export COOKIE_SECRET=45911ef822055d8ff1016a4facea31e5f39b9b9c81be63eb6549a5ccc253994c

## 向量检索（本地 embedding）
export EMBEDDING_URL=http://127.0.0.1:8001

## vLLM 最大模型长度
export VLLM_MAX_MODEL_LEN=16384

## Ideogram 4 生图服务（外部容器）
export IDEOGRAM_URL=https://openbayesalgo-3qy1nlclc7e6.gear-c1.xiaosuan.com/
export IDEOGRAM_API_KEY=IDEOGRAM@ai_agent
