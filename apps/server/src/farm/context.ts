/**
 * 临时上下文（星落定：「成熟写进临时记忆或上下文，说不说看角色自己」）。
 *
 * 所以这里没有"提醒推送"——成熟 / 被偷 / 收到菜 只会变成一条**有保质期的状态**，
 * 挂到那个男主的身上；他下次开口（主动消息 / 聊天）时把这条拼进**当前这条 user 消息**，
 * 至于说不说、怎么说，由模型按人设自己决定。
 *
 * ⚠️ 注入位置铁律：必须拼进「当前这条 user 消息」，**不能追加在 system prompt 末尾**。
 *    项目实测：拼进 user 消息有效（组间相似度差 +0.201），放 system 末尾几乎无效（+0.024）——
 *    强人设会把末尾注入完全盖过。见 docs/MEMORY_NOTES.md 心绪章节。
 */
export type FarmNoteKind = 'ripe' | 'stolen' | 'gift';

export interface FarmNote {
  kind: FarmNoteKind;
  /** 一句话事实（第三人称，写给模型看） */
  text: string;
  createdAt: number;
  ttlMs: number;
}

/** 保质期：熟了记得一天；被偷记久一点（他会念叨）；收到菜一天 */
export const NOTE_TTL: Record<FarmNoteKind, number> = {
  ripe: 24 * 3600 * 1000,
  stolen: 72 * 3600 * 1000,
  gift: 24 * 3600 * 1000,
};

export function makeNote(kind: FarmNoteKind, text: string, now: number): FarmNote {
  return { kind, text, createdAt: now, ttlMs: NOTE_TTL[kind] };
}

/** 熟了（他院子里自己的作物） */
export function makeRipeNote(cropName: string, now: number): FarmNote {
  return makeNote('ripe', `你院子里的${cropName}熟了，还没来得及摘。`, now);
}

/** 收成少了（事实里没有"谁"） */
export function makeStolenNote(cropName: string, lost: number, times: number, now: number): FarmNote {
  return makeNote(
    'stolen',
    `你院子里的${cropName}少了 ${lost} 个${times > 1 ? `（最近第 ${times} 次）` : ''}，你不知道是谁拿的。`,
    now,
  );
}

/** 收到了玩家做的菜 / 送的东西 */
export function makeGiftNote(dish: string, now: number): FarmNote {
  return makeNote('gift', `有人给你送来一份${dish}。`, now);
}

export function isFresh(note: FarmNote, now: number): boolean {
  return now - note.createdAt < note.ttlMs;
}

/** 取出这个男主当前有效的临时状态（新的在前） */
export function freshNotes(notes: readonly FarmNote[], now: number): FarmNote[] {
  return notes.filter((n) => isFresh(n, now)).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 拼进当前 user 消息的那段文本。
 * 「说不说随你」这句是刻意的：星落要的是"说不说看角色自己"，不是系统催他去提。
 */
export function noteInjection(notes: readonly FarmNote[]): string {
  const fresh = notes.filter((n) => n.text);
  if (fresh.length === 0) return '';
  return `（你最近的事：${fresh.map((n) => n.text).join('')}这些只是你自己的近况，说不说、什么时候说都由你自己决定，别刻意提起。）`;
}
