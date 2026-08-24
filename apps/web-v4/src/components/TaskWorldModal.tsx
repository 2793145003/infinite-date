import React, { useState } from 'react';
import { X, CheckCircle, Circle, Plus, Compass, Sparkles } from 'lucide-react';
import confetti from 'canvas-confetti';
import { Character } from '../types';
import { CONFETTI_NEUTRAL } from '../constants/colors';

interface TaskWorldModalProps {
  activeCharacter: Character;
  onClose: () => void;
  onRewardClaim: (points: number) => void;
}

interface TaskItem {
  id: string;
  title: string;
  category: string;
  affinity: number;
  completed: boolean;
}

export const TaskWorldModal: React.FC<TaskWorldModalProps> = ({
  activeCharacter,
  onClose,
  onRewardClaim,
}) => {
  const [tasks, setTasks] = useState<TaskItem[]>([
    {
      id: 't-1',
      title: `与 ${activeCharacter.name} 独处并发送一条晨间私语`,
      category: '每日心动',
      affinity: 10,
      completed: true,
    },
    {
      id: 't-2',
      title: '在私人影院包厢共看一部午夜电影',
      category: '约会挑战',
      affinity: 25,
      completed: false,
    },
    {
      id: 't-3',
      title: '记录一段梦境到情侣日记',
      category: '日记记忆',
      affinity: 15,
      completed: false,
    },
    {
      id: 't-4',
      title: '在地图中探索一个新场景并打卡',
      category: '场景漫步',
      affinity: 20,
      completed: false,
    },
  ]);

  const [customTaskTitle, setCustomTaskTitle] = useState('');
  const [showAddCustom, setShowAddCustom] = useState(false);

  const toggleTask = (id: string) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === id) {
          const nextState = !t.completed;
          if (nextState) {
            confetti({
              particleCount: 15,
              spread: 40,
              origin: { y: 0.5 },
              colors: CONFETTI_NEUTRAL,
            });
            onRewardClaim(t.affinity);
          }
          return { ...t, completed: nextState };
        }
        return t;
      })
    );
  };

  const handleAddCustom = () => {
    if (!customTaskTitle.trim()) return;
    setTasks((prev) => [
      ...prev,
      {
        id: `t-custom-${Date.now()}`,
        title: customTaskTitle.trim(),
        category: '自定义心愿',
        affinity: 15,
        completed: false,
      },
    ]);
    setCustomTaskTitle('');
    setShowAddCustom(false);
  };

  const completedCount = tasks.filter((t) => t.completed).length;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-3">
      <div className="bg-panel w-full max-w-sm rounded-2xl p-4 shadow-xl border border-border flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-2.5 border-b border-border-soft">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-bg-muted border border-border-strong flex items-center justify-center text-xs font-bold text-ink">
              <Compass className="w-3.5 h-3.5" />
            </div>
            <div>
              <h2 className="text-xs font-bold text-ink">任务世界 · 待办清单</h2>
              <span className="text-[10px] text-ink">
                已完成 {completedCount}/{tasks.length} 项心动挑战
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg bg-bg-muted text-ink hover:text-ink flex items-center justify-center"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Progress Bar (Monochrome) */}
        <div className="my-2.5 bg-bg-muted rounded-full h-1.5 overflow-hidden">
          <div
            className="bg-solid h-full transition-all duration-300 rounded-full"
            style={{ width: `${(completedCount / tasks.length) * 100}%` }}
          />
        </div>

        {/* Tasks List */}
        <div className="space-y-1.5 overflow-y-auto flex-1 pr-0.5 mb-2.5">
          {tasks.map((task) => (
            <div
              key={task.id}
              onClick={() => toggleTask(task.id)}
              className={`p-2.5 rounded-xl border flex items-center justify-between cursor-pointer transition ${
                task.completed
                  ? 'bg-bg-soft border-border text-ink'
                  : 'frosted-glass border-border text-ink hover:bg-bg-soft'
              }`}
            >
              <div className="flex items-center gap-2">
                {task.completed ? (
                  <CheckCircle className="w-4 h-4 text-ink shrink-0" />
                ) : (
                  <Circle className="w-4 h-4 text-ink shrink-0" />
                )}
                <div>
                  <p
                    className={`text-xs font-medium ${
                      task.completed ? 'line-through text-ink' : 'text-ink'
                    }`}
                  >
                    {task.title}
                  </p>
                  <span className="text-[9px] px-1.5 py-0.2 rounded bg-bg-muted text-ink">
                    {task.category}
                  </span>
                </div>
              </div>

              <span className="text-[10px] font-mono font-bold text-ink bg-bg-muted px-2 py-0.5 rounded-full shrink-0">
                +{task.affinity}
              </span>
            </div>
          ))}
        </div>

        {/* Add custom form */}
        {showAddCustom ? (
          <div className="mb-2.5 p-2 bg-bg-soft rounded-xl border border-border-strong">
            <input
              type="text"
              placeholder="输入你的心动愿望..."
              value={customTaskTitle}
              onChange={(e) => setCustomTaskTitle(e.target.value)}
              className="w-full px-2.5 py-1 text-xs frosted-glass rounded-lg border border-border outline-none mb-1.5 focus:border-border-dark"
            />
            <div className="flex justify-end gap-1.5">
              <button
                onClick={() => setShowAddCustom(false)}
                className="px-2.5 py-1 text-[10px] text-ink bg-bg-muted-2 rounded-md"
              >
                取消
              </button>
              <button
                onClick={handleAddCustom}
                className="px-3 py-1 text-[10px] text-solid-contrast bg-solid rounded-md font-semibold"
              >
                确认添加
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAddCustom(true)}
            className="w-full py-1.5 rounded-lg border border-dashed border-border-strong text-ink hover:text-ink hover:border-border-strong text-xs font-medium flex items-center justify-center gap-1 mb-2.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>自定义心愿待办</span>
          </button>
        )}

        {/* Footer */}
        <div className="pt-2 border-t border-border-soft flex items-center justify-between">
          <span className="text-[10px] text-ink">完成任务可提升与TA亲密度</span>
          <button
            onClick={onClose}
            className="px-3.5 py-1 rounded-md bg-solid text-solid-contrast text-xs font-medium hover:bg-solid-soft transition"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};
