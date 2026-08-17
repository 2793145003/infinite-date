import { buildCharacterCard } from '../src/lib/character-card';
const card = buildCharacterCard('<玩家ID>', '<角色ID>');
console.log('════ 林溯 实际注入 LLM 的角色卡 ════\n' + card + '\n════ 结束 ════');
