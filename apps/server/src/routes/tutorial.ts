/**
 * 教程路由
 * 简化版：新用户首次进入时发欢迎邮件 + 创建主神短信线程
 * 不再有步骤解锁机制，所有功能一开始就可用
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now } from '../lib/util';
import { sendEmail } from './email';
import { DEITY_ID } from '@idate/shared';

/** 初始化欢迎内容：发邮件 + 建主神线程 + 设 step=4 */
export function initTutorialData(playerId: string, playerName: string): void {
  // 发欢迎邮件
  sendEmail(
    playerId,
    'deity',
    '欢迎来到主城',
    `${playerName}，你醒了。

这里是万界枢纽——主城。来自不同世界的人在这里交汇，你大概已经发现了。

几件你需要知道的事：
• 手机上的应用都已经可以用了——地图、短信、邮件、待办，随便点
• 完成任务能获取「权限」，权限是这个世界的通用货币，召唤新角色、创建地点都需要它
• 打开地图去各处转转，遇到的人可以搭话、约会
• 有事随时给我发短信，不用客气

先到处逛逛吧。`,
  );

  // 创建主神短信线程
  const existing = db.prepare('SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?').get(playerId, DEITY_ID) as { id: string } | undefined;
  if (!existing) {
    const threadId = genId();
    const ts = now();
    db.prepare(`
      INSERT INTO message_threads (id, player_id, character_id, last_message_at, unread_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(threadId, playerId, DEITY_ID, ts, ts, ts);

    const msgId = genId();
    db.prepare(`
      INSERT INTO text_messages (id, thread_id, sender, body, status, created_at, delivered_at)
      VALUES (?, ?, 'npc', ?, 'delivered', ?, ?)
    `).run(msgId, threadId, '有事可以找我。不用客气，但也别指望我什么都答。', ts, ts);
  }

  // 标记完成
  db.prepare('UPDATE players SET tutorial_step = ?, updated_at = ? WHERE id = ?')
    .run(4, now(), playerId);
}

export async function tutorialRoutes(app: FastifyInstance): Promise<void> {
  // 初始化：发欢迎邮件 + 创建主神短信线程
  app.post('/tutorial/init', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const player = db.prepare('SELECT name, tutorial_step FROM players WHERE id = ?').get(playerId) as {
      name: string; tutorial_step: number;
    };

    // 已初始化过则跳过
    if (player.tutorial_step >= 4) {
      return reply.send({ tutorialStep: 4, message: '已初始化' });
    }

    initTutorialData(playerId, player.name);

    return reply.send({
      tutorialStep: 4,
      message: '欢迎邮件已发送',
    });
  });
}
