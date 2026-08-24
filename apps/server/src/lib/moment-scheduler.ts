/**
 * NPC 行程驱动触发器（后台独立运行，不依赖玩家在线）
 *
 * proactive.ts 的 checkScheduleChange 实现意愿累积机制：
 *   - 每次行程变更累积 sms_urge / moment_urge（base=1% × 性格倍率 × 随机扰动）
 *   - 累积后摇骰子，命中则发短信/朋友圈，发完清零
 *   - 排除进行中约会的 NPC
 *   - 用 last_schedule_slot 存位置指纹
 *
 * 但它只在玩家打开短信列表时触发。
 * 本模块用后台定时器遍历所有有好友的玩家，调 checkScheduleChange，
 * 让 NPC 的行程短信/朋友圈不再依赖玩家在线。
 *
 * 约会结束后 60% 概率发朋友圈（scene-end.ts 既有逻辑不变）
 */

import { db } from '../db';
import { checkScheduleChange } from './proactive';
import { checkNpcTaskInvite, sweepSoloMissions } from './npc-task';

const TICK_INTERVAL = 5 * 60 * 1000; // 5 分钟扫一次

let started = false;
export function startMomentScheduler(): void {
  if (started) return;
  started = true;
  // 启动后延迟 30s 再首次扫描（避免启动时和在线检查撞车）
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_INTERVAL).unref();
  }, 30_000).unref();
}

async function tick(): Promise<void> {
  // NPC 任务 solo 到点回归（全局扫一次，不依赖玩家遍历）
  try {
    await sweepSoloMissions();
  } catch (err) {
    console.error('[moment-scheduler] sweepSoloMissions failed', err instanceof Error ? err.message : err);
  }

  // 遍历所有有好友关系的玩家（去重）
  const playerIds = db.prepare(`
    SELECT DISTINCT player_id FROM friendships WHERE status = 'active'
  `).all() as { player_id: string }[];

  for (const { player_id: playerId } of playerIds) {
    try {
      await checkScheduleChange(playerId);
    } catch (err) {
      console.error('[moment-scheduler] checkScheduleChange failed for', playerId, err instanceof Error ? err.message : err);
    }
    // NPC 任务邀请（温馨向）——与主动短信并列，各自独立触发
    try {
      await checkNpcTaskInvite(playerId);
    } catch (err) {
      console.error('[moment-scheduler] checkNpcTaskInvite failed for', playerId, err instanceof Error ? err.message : err);
    }
  }
}
