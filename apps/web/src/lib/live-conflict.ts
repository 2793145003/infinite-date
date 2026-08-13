/**
 * 全局「现场互斥」弹窗控制器。
 *
 * 后端所有创建现场（约会/群聊/剧本/旧探索/任务）的入口，当玩家已有进行中的其它现场时，
 * 统一返回 409 + { live }。api.ts 的 request 捕获到 live 后调用 raiseLiveConflict(live)，
 * 由 App 顶层挂载的 <LiveConflictModal> 弹窗，让玩家选择「继续原现场」或「结束它进入新的」。
 *
 * 这是纯事件总线：请求方只负责「提出」，弹窗动作（导航 / 结束原现场 / 重做）由
 * App 提供的回调完成。
 */

export type LiveSlotType =
  | 'scene-date'   // 新地图约会/群约
  | 'conversation' // 旧约会/群聊
  | 'explore'      // 旧探索
  | 'scenario'     // 剧本
  | 'mission';     // 任务

export interface LiveSlotPayload {
  type: LiveSlotType;
  sessionId?: string;          // scene-date / conversation / explore
  scenarioSessionId?: string;  // scenario
  missionId?: string;          // mission
  isGroup?: boolean;           // conversation 群聊标记
}

export interface LiveConflictRequest {
  live: LiveSlotPayload;
  /** 期望进入的现场类型（用于判断"继续"是否就是目标） */
  targetType?: LiveSlotType;
  /** 触发冲突的原始请求（供"结束原现场后重做"用）：结束时重新发起它 */
  redo?: { path: string; opts: RequestInit };
}

type Listener = (req: LiveConflictRequest) => void;

let current: LiveConflictRequest | null = null;
const listeners = new Set<Listener>();

/** 由 api.ts 在捕获 409 + live 时调用，提出一次弹窗请求 */
export function raiseLiveConflict(req: LiveConflictRequest): void {
  current = req;
  listeners.forEach(l => l(req));
}

/** 关闭弹窗（不导航、不结束，玩家取消） */
export function dismissLiveConflict(): void {
  current = null;
  listeners.forEach(l => l(null as unknown as LiveConflictRequest));
}

/** 订阅弹窗请求；返回取消订阅函数 */
export function subscribeLiveConflict(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** 读取当前请求（供组件初始化时用） */
export function getLiveConflict(): LiveConflictRequest | null {
  return current;
}

/** 给弹窗展示用的现场中文名 */
export function liveTypeLabel(live: LiveSlotPayload): string {
  switch (live.type) {
    case 'scene-date': return live.isGroup ? '场景群约' : '场景约会';
    case 'conversation': return live.isGroup ? '群聊' : '约会';
    case 'explore': return '探索';
    case 'scenario': return '剧本';
    case 'mission': return '任务';
  }
}
