/**
 * Prompt模板加载器
 * 从外部文件读取prompt文本，不硬编码。修改prompt不需要重新部署——改文件重启即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

const cache = new Map<string, string>();

export function loadPrompt(name: string): string {
  if (cache.has(name)) return cache.get(name)!;

  const filepath = path.join(config.promptTemplatesDir, `${name}.txt`);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Prompt template not found: ${name} (${filepath})`);
  }
  const content = fs.readFileSync(filepath, 'utf-8');
  cache.set(name, content);
  return content;
}

export function clearPromptCache(): void {
  cache.clear();
}

/**
 * 读取 greeting 提示词里指定情境（circumstance）的小节。
 * 文件用 "[名字]" 分节；无匹配时回退到 [default]。
 * 返回渲染后的文本（已替换 {{vars}}）。
 */
export function loadGreetingSection(
  section: string,
  vars?: Record<string, string>,
): string {
  const tpl = loadPrompt('scene.greeting');
  // 拆节：以行首 [xxx] 为界
  const sections: Record<string, string> = {};
  let currentKey: string | null = null;
  const lines = tpl.split('\n');
  for (const raw of lines) {
    const m = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
    if (m) {
      currentKey = m[1]!.trim();
      sections[currentKey] = sections[currentKey] ?? '';
      continue;
    }
    if (currentKey) sections[currentKey] = (sections[currentKey] ?? '') + raw + '\n';
  }
  // [default] 是任何开场情境都共用的基础纪律（玩家还没说话 → 主动开场、别观察反应）
  const base = (sections['default'] ?? '').trim();
  let body: string;
  if (section === 'default') {
    body = base;
  } else {
    const specific = (sections[section] ?? '').trim() || (sections['default'] ?? '').trim();
    body = specific ? `${base}\n\n【本场情境】\n${specific}` : base;
  }
  return renderPrompt(body, vars ?? {});
}

/**
 * 简单模板替换：{{key}} → value
 */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}
