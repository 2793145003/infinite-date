import { useState, useEffect } from 'react';
import { api } from '../lib/api';

export function ScenarioDream({
  scenarioSessionId,
  onBack,
  onDone,
}: {
  scenarioSessionId: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [dreamText, setDreamText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [characterName, setCharacterName] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let retries = 0;
    const MAX_RETRIES = 30; // 30次 × 2秒 = 最多等 60 秒

    const poll = async () => {
      try {
        const data = await api.getScenarioMessages(scenarioSessionId);
        if (cancelled) return;
        setCharacterName(data.characterName);

        if (data.dreamText) {
          setDreamText(data.dreamText);
          setLoading(false);
          return;
        }

        // 梦还没生成完，轮询
        const dreamData = await api.scenarioDream(scenarioSessionId);
        if (cancelled) return;
        if (dreamData.dreamText) {
          setDreamText(dreamData.dreamText);
          setLoading(false);
        } else if (retries < MAX_RETRIES) {
          retries++;
          setTimeout(poll, 2000);
        } else {
          setError(true);
          setLoading(false);
        }
      } catch {
        if (cancelled) return;
        if (retries < MAX_RETRIES) {
          retries++;
          setTimeout(poll, 2000);
        } else {
          setError(true);
          setLoading(false);
        }
      }
    };

    poll();
    return () => { cancelled = true; };
  }, [scenarioSessionId]);

  return (
    <div className="id-app id-scenario-dream">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">梦</span>
      </div>

      <div className="id-dream-content">
        <p className="id-dream-intro">
          {characterName}回到了自己的世界，对这段经历做了一个梦。
        </p>

        {loading ? (
          <div className="id-dream-loading">
            <div className="id-typing-dots"><span /><span /><span /></div>
            <span>正在做梦…</span>
          </div>
        ) : error ? (
          <>
            <div className="id-dream-display">
              <div className="id-dream-text">梦的生成似乎遇到了问题，请稍后重试。</div>
            </div>
            <button className="id-dream-done" onClick={onBack}>返回</button>
          </>
        ) : dreamText ? (
          <>
            <div className="id-dream-display">
              <div className="id-dream-text">{dreamText}</div>
            </div>
            <button className="id-dream-done" onClick={onDone}>完成</button>
          </>
        ) : null}
      </div>
    </div>
  );
}
