/**
 * 服务健康探针：容器重启后验证 embedding(8001) 与 vLLM(8000) 的集成链路。
 * 用法：cd apps/server && npx tsx verify_services.ts
 */
import { embedBatch } from './src/lib/embedding';
import { config } from './src/config';

async function main() {
  let ok = true;

  // 1. embedding 集成链（走 lib/embedding.ts 真实调用）
  try {
    const t0 = Date.now();
    const vecs = await embedBatch(['林夏在图书馆遇见了那个总穿黑风衣的人', '完全无关的句子：今天菜市场的番茄很新鲜']);
    if (!vecs || vecs.length !== 2) throw new Error(`返回异常: ${vecs}`);
    const [v1, v2] = vecs;
    const dim = v1.length;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += v1[i] * v2[i];
    console.log(`[embedding] ✓ dim=${dim} 耗时=${Date.now() - t0}ms 相似度(相关句/无关句)=${dot.toFixed(4)}`);
    if (dim !== 768) throw new Error(`dim 异常: ${dim}`);
  } catch (e: any) {
    ok = false;
    console.log(`[embedding] ✗ ${e.message}`);
  }

  // 2. vLLM 集成链（走项目 config 的 LLM_BASE_URL）
  try {
    const t0 = Date.now();
    const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemma-4-26b',
        messages: [{ role: 'user', content: '只回复两个字：正常' }],
        max_tokens: 16,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json();
    console.log(`[vLLM] ✓ ${config.llmBaseUrl} 耗时=${Date.now() - t0}ms 回复=「${j.choices[0].message.content.trim()}」`);
  } catch (e: any) {
    ok = false;
    console.log(`[vLLM] ✗ ${e.message}`);
  }

  console.log(ok ? '\n全部通过' : '\n存在失败项');
  process.exit(ok ? 0 : 1);
}
main();
