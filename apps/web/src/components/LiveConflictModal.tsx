import { useEffect, useState } from 'react';
import {
  subscribeLiveConflict,
  dismissLiveConflict,
  getLiveConflict,
  liveTypeLabel,
  type LiveConflictRequest,
} from '../lib/live-conflict';
import { api } from '../lib/api';

/**
 * 全局「现场互斥」弹窗。
 * 由 App 顶层挂载。玩家已有进行中的现场时，任何创建新现场的请求都会触发它，
 * 供玩家选择「继续原现场」还是「结束原现场并进入新的」。
 *
 * 导航由父组件通过 onNavigate 注入（App 提供），保持本组件无路由依赖。
 */
export function LiveConflictModal({ onNavigate }: {
  onNavigate: (view: unknown) => void;
  ready?: boolean;
}) {
  const [req, setReq] = useState<LiveConflictRequest | null>(getLiveConflict());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return subscribeLiveConflict((r) => {
      if (r) setReq(r);
      else setReq(null);
    });
  }, []);

  if (!req) return null;

  const live = req.live;
  const label = liveTypeLabel(live);

  // 继续 → 回到原进行中的现场对应界面（与桌面小组件/剧本相同进入逻辑）
  const handleContinue = () => {
    const v = navigateToLive(live);
    if (v) onNavigate(v);
    dismissLiveConflict();
  };

  // 结束原现场 → 然后重做触发冲突的原创建请求
  const handleEndAndRedo = async () => {
    setBusy(true);
    try {
      await endLiveBackend(live);
    } catch {
      // 结束失败不阻塞：继续尝试重做，让后端再判（若仍未结束会再弹窗）
    }
    dismissLiveConflict();
    if (req.redo) {
      try {
        await api.fetchRaw(req.redo.path, req.redo.opts);
      } catch {
        // LIVE_CONFLICT 或其它错误：静默，弹窗接管
      }
    }
    setBusy(false);
  };

  const handleCancel = () => dismissLiveConflict();

  return (
    <div className="id-modal-overlay" onClick={handleCancel}>
      <div className="id-modal" onClick={e => e.stopPropagation()}>
        <div className="id-modal-title">已有进行中的{label}</div>
        <div className="id-modal-desc">
          你正在进行一场{label}。人只有一个，同一时间只能「在场」于一个玩法现场。
          <br />要继续之前的{label}，还是结束它进入新的？
        </div>
        <div className="id-modal-actions">
          <button className="id-btn" onClick={handleContinue} disabled={busy}>继续{label}</button>
          <button className="id-btn primary" onClick={handleEndAndRedo} disabled={busy}>
            {busy ? '处理中…' : `结束${label}并进入新的`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 根据现场类型构造导航目标（复用桌面小组件/剧本的进入逻辑） */
function navigateToLive(live: { type: string; sessionId?: string; scenarioSessionId?: string; missionId?: string; isGroup?: boolean }) {
  switch (live.type) {
    case 'scene-date':
      return live.sessionId ? { type: 'scene-conversation', sessionId: live.sessionId } : null;
    case 'conversation':
      return live.sessionId
        ? live.isGroup
          ? { type: 'group-conversation', sessionId: live.sessionId, locationId: '', participants: [] }
          : { type: 'conversation', sessionId: live.sessionId, characterId: '', locationId: '' }
        : null;
    case 'explore':
      return live.sessionId ? { type: 'explore', sessionId: live.sessionId, locationId: '', locationName: '', narration: '' } : null;
    case 'scenario':
      return live.scenarioSessionId ? { type: 'scenario-conversation', scenarioSessionId: live.scenarioSessionId } : null;
    case 'mission':
      return { type: 'missions' };
    default:
      return null;
  }
}

/** 调后端结束当前现场 */
async function endLiveBackend(live: { type: string; sessionId?: string; scenarioSessionId?: string; missionId?: string }) {
  switch (live.type) {
    case 'scene-date':
      if (live.sessionId) await api.sceneEnd(live.sessionId);
      break;
    case 'conversation':
      if (live.sessionId) await api.endConversation(live.sessionId);
      break;
    case 'explore':
      if (live.sessionId) await api.endExplore(live.sessionId);
      break;
    case 'scenario':
      if (live.scenarioSessionId) await api.endScenario(live.scenarioSessionId);
      break;
    case 'mission':
      // 任务系统为原型：无专门结束接口，跳过（后端下次创建仍会判冲突）
      break;
    default:
      break;
  }
}
