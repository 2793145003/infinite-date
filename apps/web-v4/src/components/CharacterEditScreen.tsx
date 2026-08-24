import React, { useState, useRef } from 'react';
import {
  ChevronLeft,
  Save,
  Plus,
  Image as ImageIcon,
  Sparkles,
  User,
  Heart,
  MessageSquare,
  Smile,
  BookOpen,
  Check,
  Shield,
  Zap,
} from 'lucide-react';
import { Character, GenderType } from '../types';

interface CharacterEditScreenProps {
  character?: Character | null;
  onBack: () => void;
  onSave: (characterData: Partial<Character>) => void;
}

export const CharacterEditScreen: React.FC<CharacterEditScreenProps> = ({
  character,
  onBack,
  onSave,
}) => {
  // Avatar & Basic Info
  const [avatar, setAvatar] = useState(character?.avatar || (character?.name?.slice(-1) || '伴'));
  const [avatarUrl, setAvatarUrl] = useState(character?.avatarUrl || '');
  const [name, setName] = useState(character?.name || '');
  const [nickname, setNickname] = useState(character?.nickname || '');
  const [gender, setGender] = useState<GenderType | string>(character?.gender || '未设定');
  const [age, setAge] = useState(character?.age || '26');
  const [appearance, setAppearance] = useState(
    character?.appearance || '身形修长挺拔，眉眼清俊深邃，神色温和从容，举手投足间带着矜贵与沉静气质。'
  );

  // Identity & Status
  const [identity, setIdentity] = useState(character?.identity || '影视总监 / 新锐导演');
  const [tag, setTag] = useState(character?.tag || '男友');
  const [status, setStatus] = useState(character?.status || '独处包厢 · 伴你身侧');
  const [relationshipStatus, setRelationshipStatus] = useState(
    character?.relationshipStatus || '相恋相伴中'
  );
  const [daysTogether, setDaysTogether] = useState(character?.daysTogether || 153);
  const [startDate, setStartDate] = useState(character?.startDate || '2026.03.18');
  const [intimacyLevel, setIntimacyLevel] = useState(character?.intimacyLevel || 88);

  // 性格: 表层, 内核, 极端
  const [personalitySurface, setPersonalitySurface] = useState(
    character?.personalitySurface || '温和得体、从容克制，对外界保持适度礼貌的疏离感。'
  );
  const [personalityCore, setPersonalityCore] = useState(
    character?.personalityCore || '极度深情专一，极度在乎你的感受，只对你一人展现无防备的温柔与占有欲。'
  );
  const [personalityExtreme, setPersonalityExtreme] = useState(
    character?.personalityExtreme || '在你遇到危险或产生疏离时，会极度焦虑克制，表现出近乎偏执的保护欲。'
  );

  // 说话风格: 概述
  const [speechStyle, setSpeechStyle] = useState(
    character?.speechStyle || '嗓音低沉温和、富有磁性，语速从容，惯用温柔肯定的短句与亲昵称谓，常带有宠溺笑意。'
  );

  // 短信风格: 概述
  const [messageStyle, setMessageStyle] = useState(
    character?.messageStyle || '秒回你的每条消息，语气专注认真，偶尔分享眼前的工作抓拍或日常小确幸。'
  );

  // 情绪信号: 紧张, 开心, 愤怒, 感动, 防御
  const [emotionNervous, setEmotionNervous] = useState(
    character?.emotionSignals?.nervous || '手指会不自觉摩挲袖扣或指环，喉结轻微滚动，说话前有极短的停顿。'
  );
  const [emotionHappy, setEmotionHappy] = useState(
    character?.emotionSignals?.happy || '眼底浮现温柔笑意，唇角微微勾起，会忍不住伸手轻揉你的发顶或轻抚你的手背。'
  );
  const [emotionAngry, setEmotionAngry] = useState(
    character?.emotionSignals?.angry || '语调瞬间压低，呼吸沉重而深吸气，眼神锐利冰冷，但绝不会对你大声或发脾气。'
  );
  const [emotionTouched, setEmotionTouched] = useState(
    character?.emotionSignals?.touched || '长时间深情凝视你，反手将你的手指紧紧握在掌心，声音微哑地呼唤你的名字。'
  );
  const [emotionDefensive, setEmotionDefensive] = useState(
    character?.emotionSignals?.defensive || '身体微微后倾，神情恢复理性冷静，用极克制的逻辑或沉默来掩盖内心的波动。'
  );

  // 背景: 出身, 经历, 现状
  const [bgOrigin, setBgOrigin] = useState(
    character?.background?.origin || '出身于书香与艺术世家，自幼受到良好的美学与文化熏陶。'
  );
  const [bgExperience, setBgExperience] = useState(
    character?.background?.experience || '海外名校影视与艺术系毕业，曾历经独自创业与低谷，凭借才华与坚韧崭露头角。'
  );
  const [bgCurrent, setBgCurrent] = useState(
    character?.background?.current || '新锐影视总监与独立制片人，作品屡获好评，生活以你为中心，期待与你共筑未来。'
  );

  // 喜好 / 厌恶 / 底线 / 目标 / 怪癖
  const [likes, setLikes] = useState(
    character?.likes || '手冲深烘咖啡、午夜黑胶唱片、安静地注视着你笑、为你下厨做甜点。'
  );
  const [dislikes, setDislikes] = useState(
    character?.dislikes || '虚伪嘈杂的社交酒局、冷暴力、看到你受委屈或逞强忍耐。'
  );
  const [boundaries, setBoundaries] = useState(
    character?.boundaries || '伤害到你、欺骗与毫无预警的不告而别。'
  );
  const [goals, setGoals] = useState(
    character?.goals || '为你打造一个永远安全、温暖且属于彼此的静谧避风港。'
  );
  const [quirks, setQuirks] = useState(
    character?.quirks || '专注看监视器或思考时会无意识轻转戒指；睡前一定要握住你的手确认你在身侧。'
  );

  // 与玩家的关系 / 擅长 / 不擅长
  const [relationshipWithPlayer, setRelationshipWithPlayer] = useState(
    character?.relationshipWithPlayer || '相恋相守的专属爱人，对你拥有毫无保留的偏爱与信任。'
  );
  const [strengths, setStrengths] = useState(
    character?.strengths || '镜头美学构图、情绪安抚与心理觉察、法式牛排烹饪、精准的时间管理与专注力。'
  );
  const [weaknesses, setWeaknesses] = useState(
    character?.weaknesses || '不擅长在他人面前展示脆弱、做甜品时容易放多糖、对你的请求毫无抵抗力。'
  );

  // WeChat & System Prompt
  const [wechatId, setWechatId] = useState(character?.wechatAccount?.id || '');
  const [wechatPwd, setWechatPwd] = useState(character?.wechatAccount?.passwordVal || '');
  const [personaPrompt, setPersonaPrompt] = useState(
    character?.personaPrompt || ''
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-compose system prompt from structured fields
  const generateCompositePrompt = () => {
    return `一. 基础档案
· 姓名：${name || '角色'}
· 称谓/昵称：${nickname || name || '亲爱的'}
· 性别：${gender}
· 年龄：${age || '未设定'}
· 身份/职业：${identity || '角色'}
· 外貌特征：${appearance}
· 当前状态：${status}

二. 性格维度
· 表层性格：${personalitySurface}
· 内核性格：${personalityCore}
· 极端状态：${personalityExtreme}

三. 沟通与交互风格
· 说话风格：${speechStyle}
· 短信风格：${messageStyle}

四. 情绪微表情与信号
· 紧张表现：${emotionNervous}
· 开心表现：${emotionHappy}
· 愤怒表现：${emotionAngry}
· 感动表现：${emotionTouched}
· 防御表现：${emotionDefensive}

五. 背景与经历
· 出身：${bgOrigin}
· 经历：${bgExperience}
· 现状：${bgCurrent}

六. 偏好与特质
· 喜好：${likes}
· 厌恶：${dislikes}
· 底线：${boundaries}
· 目标：${goals}
· 怪癖：${quirks}
· 与玩家的关系：${relationshipWithPlayer}
· 擅长领域：${strengths}
· 不擅长/软肋：${weaknesses}`;
  };

  const handleAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result) {
          setAvatarUrl(reader.result as string);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const compiledPrompt = personaPrompt.trim() || generateCompositePrompt();

    onSave({
      id: character?.id,
      name: name.trim(),
      nickname: nickname.trim() || name.trim(),
      gender,
      age: age.trim(),
      appearance: appearance.trim(),
      identity: identity.trim() || '角色',
      tag: tag.trim() || '角色',
      avatar: name.trim().slice(-1) || '伴',
      avatarUrl,
      status: status.trim() || '独处陪伴中',
      relationshipStatus: relationshipStatus.trim() || '相恋相伴中',
      daysTogether: Number(daysTogether) || 1,
      startDate: startDate.trim() || '2026.06.01',
      intimacyLevel: Number(intimacyLevel) || 80,

      // 性格
      personalitySurface: personalitySurface.trim(),
      personalityCore: personalityCore.trim(),
      personalityExtreme: personalityExtreme.trim(),

      // 说话风格 & 短信风格
      speechStyle: speechStyle.trim(),
      messageStyle: messageStyle.trim(),

      // 情绪信号
      emotionSignals: {
        nervous: emotionNervous.trim(),
        happy: emotionHappy.trim(),
        angry: emotionAngry.trim(),
        touched: emotionTouched.trim(),
        defensive: emotionDefensive.trim(),
      },

      // 背景
      background: {
        origin: bgOrigin.trim(),
        experience: bgExperience.trim(),
        current: bgCurrent.trim(),
      },

      // 偏好与特质
      likes: likes.trim(),
      dislikes: dislikes.trim(),
      boundaries: boundaries.trim(),
      goals: goals.trim(),
      quirks: quirks.trim(),
      relationshipWithPlayer: relationshipWithPlayer.trim(),
      strengths: strengths.trim(),
      weaknesses: weaknesses.trim(),

      // 账号与提示词
      wechatAccount: {
        id: wechatId.trim() || `Char_${name.trim() || '2026'}`,
        passwordVal: wechatPwd.trim() || 'Heart2026',
      },
      personaPrompt: compiledPrompt,
    });
    onBack();
  };

  return (
    <div className="w-full max-w-md mx-auto min-h-full px-3.5 pt-3 pb-24 text-ink">
      {/* Top Fixed-like Clean Header */}
      <header className="sticky top-0 z-30 bg-bg-soft backdrop-blur-md flex items-center justify-between py-2 border-b border-border/80 mb-3">
        <button
          id="btn-edit-screen-back"
          onClick={onBack}
          type="button"
          className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:bg-bg-muted transition shadow-2xs"
          aria-label="返回档案"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="text-center">
          <h1 className="text-sm font-bold text-ink">
            {character ? '编辑角色人设档案' : '新建角色人设档案'}
          </h1>
          <p className="text-[10px] text-ink">完整人设画像与深度心智定制</p>
        </div>

        <button
          id="btn-edit-screen-save-header"
          onClick={handleSubmit}
          type="button"
          className="px-3 py-1.5 rounded-lg bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft transition flex items-center gap-1 shadow-xs"
        >
          <Save className="w-3.5 h-3.5" />
          <span>保存</span>
        </button>
      </header>

      {/* Main Full Page Form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* 1. 头像 */}
        <div className="frosted-glass rounded-2xl p-3.5 border border-border/90 shadow-2xs">
          <label className="text-xs font-bold text-ink block mb-2">头像</label>
          <div className="flex items-center gap-3.5">
            <div className="relative">
              {avatarUrl ? (
                <div className="w-16 h-16 rounded-xl overflow-hidden border border-border-strong relative group shadow-xs">
                  <img
                    src={avatarUrl}
                    alt="头像预览"
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="absolute inset-0 bg-black/40 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center text-[10px] transition"
                  >
                    更换
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  id="btn-upload-avatar"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-16 h-16 rounded-xl bg-bg-muted hover:bg-bg-muted-2/80 border border-border-strong flex flex-col items-center justify-center text-ink transition shadow-2xs"
                >
                  <Plus className="w-5 h-5 text-ink mb-0.5" />
                  <span className="text-[9px] text-ink font-medium">添加照片</span>
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleAvatarFile}
                className="hidden"
              />
            </div>

            <div className="flex-1 text-xs text-ink space-y-1">
              <p className="font-medium text-ink">角色专属头像</p>
              <p className="text-[11px] leading-relaxed text-ink">
                点击 + 上传本地真实/二次元图片，或留空将自动生成单字艺术字母徽章。
              </p>
            </div>
          </div>
        </div>

        {/* 2. 基础信息卡片 (名字, 性别, 年龄, 外貌) */}
        <div className="frosted-glass rounded-2xl p-3.5 border border-border/90 shadow-2xs space-y-3">
          {/* 名字 */}
          <div>
            <label className="text-xs font-bold text-ink block mb-1">
              名字 <span className="text-rose">*</span>
            </label>
            <input
              id="input-char-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="请输入角色姓名，例如：苏烬"
              className="w-full px-3 py-2 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition"
            />
          </div>

          {/* 昵称/称谓 */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="text-xs font-bold text-ink block mb-1">昵称 / 称谓</label>
              <input
                id="input-char-nickname"
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="例如：阿烬 / 烬烬"
                className="w-full px-3 py-2 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition"
              />
            </div>

            {/* 性别 */}
            <div>
              <label className="text-xs font-bold text-ink block mb-1">性别</label>
              <select
                id="select-char-gender"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition cursor-pointer"
              >
                <option value="未设定">未设定</option>
                <option value="男">男</option>
                <option value="女">女</option>
                <option value="自定义">自定义</option>
              </select>
            </div>
          </div>

          {/* 年龄 */}
          <div>
            <label className="text-xs font-bold text-ink block mb-1">年龄</label>
            <input
              id="input-char-age"
              type="text"
              value={age}
              onChange={(e) => setAge(e.target.value)}
              placeholder="例如：26 或 28岁"
              className="w-full px-3 py-2 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition"
            />
          </div>

          {/* 外貌 */}
          <div>
            <label className="text-xs font-bold text-ink block mb-1">外貌</label>
            <textarea
              id="textarea-char-appearance"
              rows={2}
              value={appearance}
              onChange={(e) => setAppearance(e.target.value)}
              placeholder="描写角色的五官特征、身高体型、穿衣打扮风格..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>
        </div>

        {/* 3. 身份职业与状态签名 */}
        <div className="frosted-glass rounded-2xl p-3.5 border border-border/90 shadow-2xs space-y-3">
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="text-xs font-bold text-ink block mb-1">身份 / 职业</label>
              <input
                id="input-char-identity"
                type="text"
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                placeholder="例如：影视总监 / 新锐导演"
                className="w-full px-3 py-2 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-ink block mb-1">分类标签</label>
              <input
                id="input-char-tag"
                type="text"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="例如：男友 / 老公 / 青梅竹马"
                className="w-full px-3 py-2 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-bold text-ink block mb-1">当前状态签名</label>
            <input
              id="input-char-status"
              type="text"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              placeholder="例如：独处包厢 · 伴你身侧"
              className="w-full px-3 py-2 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition"
            />
          </div>
        </div>

        {/* 4. 性格 (表层, 内核, 极端) - 按照截图排版 */}
        <div className="frosted-glass rounded-2xl p-3.5 border border-border/90 shadow-2xs space-y-3">
          <div className="border-b border-border-soft pb-1.5">
            <h2 className="text-xs font-bold text-ink flex items-center gap-1.5">
              <Smile className="w-3.5 h-3.5 text-ink" />
              <span>性格</span>
            </h2>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">表层</label>
            <textarea
              id="input-personality-surface"
              rows={2}
              value={personalitySurface}
              onChange={(e) => setPersonalitySurface(e.target.value)}
              placeholder="日常待人接物的表现与外界印象..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">内核</label>
            <textarea
              id="input-personality-core"
              rows={2}
              value={personalityCore}
              onChange={(e) => setPersonalityCore(e.target.value)}
              placeholder="内心真正的信念、深层情感与只对你展现的柔软..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">极端</label>
            <textarea
              id="input-personality-extreme"
              rows={2}
              value={personalityExtreme}
              onChange={(e) => setPersonalityExtreme(e.target.value)}
              placeholder="在极度吃醋、面临危险、即将失去你时的极端反应..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>
        </div>

        {/* 5. 说话风格 */}
        <div className="frosted-glass rounded-2xl p-3.5 border border-border/90 shadow-2xs space-y-2.5">
          <div className="border-b border-border-soft pb-1.5">
            <h2 className="text-xs font-bold text-ink flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5 text-ink" />
              <span>说话风格</span>
            </h2>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">概述</label>
            <textarea
              id="input-speech-style"
              rows={2}
              value={speechStyle}
              onChange={(e) => setSpeechStyle(e.target.value)}
              placeholder="口吻语气、语速、口头禅、习惯性称呼与心理描写特征..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>
        </div>

        {/* 6. 短信风格 */}
        <div className="frosted-glass rounded-2xl p-3.5 border border-border/90 shadow-2xs space-y-2.5">
          <div className="border-b border-border-soft pb-1.5">
            <h2 className="text-xs font-bold text-ink flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5 text-ink" />
              <span>短信风格</span>
            </h2>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">概述</label>
            <textarea
              id="input-message-style"
              rows={2}
              value={messageStyle}
              onChange={(e) => setMessageStyle(e.target.value)}
              placeholder="线上聊天时的回复频率、文字长度、标点习惯与分享欲..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>
        </div>

        {/* 7. 情绪信号 (紧张, 开心, 愤怒, 感动, 防御) */}
        <div className="frosted-glass rounded-2xl p-3.5 border border-border/90 shadow-2xs space-y-3">
          <div className="border-b border-border-soft pb-1.5">
            <h2 className="text-xs font-bold text-ink flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-ink" />
              <span>情绪信号</span>
            </h2>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">紧张</label>
            <textarea
              id="input-emotion-nervous"
              rows={2}
              value={emotionNervous}
              onChange={(e) => setEmotionNervous(e.target.value)}
              placeholder="紧张时的小动作或微表情..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">开心</label>
            <textarea
              id="input-emotion-happy"
              rows={2}
              value={emotionHappy}
              onChange={(e) => setEmotionHappy(e.target.value)}
              placeholder="愉悦、心动时的神态与下意识动作..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">愤怒</label>
            <textarea
              id="input-emotion-angry"
              rows={2}
              value={emotionAngry}
              onChange={(e) => setEmotionAngry(e.target.value)}
              placeholder="愤怒或被冒犯时的压迫感与克制方式..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">感动</label>
            <textarea
              id="input-emotion-touched"
              rows={2}
              value={emotionTouched}
              onChange={(e) => setEmotionTouched(e.target.value)}
              placeholder="被你触动心弦时的眼神与动作..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">防御</label>
            <textarea
              id="input-emotion-defensive"
              rows={2}
              value={emotionDefensive}
              onChange={(e) => setEmotionDefensive(e.target.value)}
              placeholder="被触及软肋或自我防护时的反应..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>
        </div>

        {/* 8. 背景 (出身, 经历, 现状) */}
        <div className="frosted-glass rounded-2xl p-3.5 border border-border/90 shadow-2xs space-y-3">
          <div className="border-b border-border-soft pb-1.5">
            <h2 className="text-xs font-bold text-ink flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 text-ink" />
              <span>背景</span>
            </h2>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">出身</label>
            <textarea
              id="input-bg-origin"
              rows={2}
              value={bgOrigin}
              onChange={(e) => setBgOrigin(e.target.value)}
              placeholder="家庭背景、出生地、成长环境..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">经历</label>
            <textarea
              id="input-bg-experience"
              rows={2}
              value={bgExperience}
              onChange={(e) => setBgExperience(e.target.value)}
              placeholder="求学历程、重要转折点、曾经历过的挫折或光辉时刻..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-ink block mb-1">现状</label>
            <textarea
              id="input-bg-current"
              rows={2}
              value={bgCurrent}
              onChange={(e) => setBgCurrent(e.target.value)}
              placeholder="当下事业阶段、生活状态与日常重心..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>
        </div>

        {/* 9. 喜好 / 厌恶 / 底线 / 目标 / 怪癖 */}
        <div className="frosted-glass rounded-2xl p-3.5 border border-border/90 shadow-2xs space-y-3">
          <div>
            <label className="text-xs font-bold text-ink block mb-1">喜好</label>
            <textarea
              id="input-char-likes"
              rows={2}
              value={likes}
              onChange={(e) => setLikes(e.target.value)}
              placeholder="热爱的食物、兴趣爱好、珍视的事物..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-xs font-bold text-ink block mb-1">厌恶</label>
            <textarea
              id="input-char-dislikes"
              rows={2}
              value={dislikes}
              onChange={(e) => setDislikes(e.target.value)}
              placeholder="反感的事物、难以忍受的行为..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-xs font-bold text-ink block mb-1">底线</label>
            <textarea
              id="input-char-boundaries"
              rows={2}
              value={boundaries}
              onChange={(e) => setBoundaries(e.target.value)}
              placeholder="绝对不可触碰的原则与雷区..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-xs font-bold text-ink block mb-1">目标</label>
            <textarea
              id="input-char-goals"
              rows={2}
              value={goals}
              onChange={(e) => setGoals(e.target.value)}
              placeholder="人生理想、近期的心愿、与你共同的向往..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-xs font-bold text-ink block mb-1">怪癖</label>
            <textarea
              id="input-char-quirks"
              rows={2}
              value={quirks}
              onChange={(e) => setQuirks(e.target.value)}
              placeholder="专属小习惯、独特强迫症、反差萌行为..."
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>
        </div>

        {/* 10. 与玩家的关系 / 擅长 / 不擅长 */}
        <div className="frosted-glass rounded-2xl p-3.5 border border-border/90 shadow-2xs space-y-3">
          <div>
            <label className="text-xs font-bold text-ink block mb-1">与玩家的关系</label>
            <textarea
              id="input-relationship-player"
              rows={2}
              value={relationshipWithPlayer}
              onChange={(e) => setRelationshipWithPlayer(e.target.value)}
              placeholder="无特殊关系则留空"
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-xs font-bold text-ink block mb-1">擅长</label>
            <textarea
              id="input-char-strengths"
              rows={2}
              value={strengths}
              onChange={(e) => setStrengths(e.target.value)}
              placeholder="战斗、生活技能、知识领域、社交特长……"
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>

          <div>
            <label className="text-xs font-bold text-ink block mb-1">不擅长</label>
            <textarea
              id="input-char-weaknesses"
              rows={2}
              value={weaknesses}
              onChange={(e) => setWeaknesses(e.target.value)}
              placeholder="软肋、不感兴趣、总做不好的事……"
              className="w-full p-2.5 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition leading-relaxed"
            />
          </div>
        </div>

        {/* 11. 恋爱契约与微信账号绑定 (折叠/扩展面板) */}
        <div className="frosted-glass rounded-2xl p-3.5 border border-border/90 shadow-2xs space-y-3">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full flex items-center justify-between text-xs font-bold text-ink"
          >
            <span className="flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-ink" />
              <span>角色契约属性与系统提示词</span>
            </span>
            <span className="text-[11px] text-ink font-normal">
              {showAdvanced ? '收起 ▲' : '展开 ▼'}
            </span>
          </button>

          {showAdvanced && (
            <div className="space-y-3 pt-2 border-t border-border-soft">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-[11px] text-ink block mb-1">相伴相恋状态</label>
                  <input
                    type="text"
                    value={relationshipStatus}
                    onChange={(e) => setRelationshipStatus(e.target.value)}
                    placeholder="例如：相恋相伴中"
                    className="w-full px-3 py-1.5 text-xs bg-bg-soft rounded-lg border border-border-strong outline-none"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-ink block mb-1">相伴天数</label>
                  <input
                    type="number"
                    value={daysTogether}
                    onChange={(e) => setDaysTogether(Number(e.target.value))}
                    className="w-full px-3 py-1.5 text-xs bg-bg-soft rounded-lg border border-border-strong outline-none font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-[11px] text-ink block mb-1">专属微信号</label>
                  <input
                    type="text"
                    value={wechatId}
                    onChange={(e) => setWechatId(e.target.value)}
                    placeholder="Su.Jin_2026"
                    className="w-full px-3 py-1.5 text-xs bg-bg-soft rounded-lg border border-border-strong outline-none font-mono"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-ink block mb-1">专属通讯密码</label>
                  <input
                    type="text"
                    value={wechatPwd}
                    onChange={(e) => setWechatPwd(e.target.value)}
                    placeholder="Heart2026"
                    className="w-full px-3 py-1.5 text-xs bg-bg-soft rounded-lg border border-border-strong outline-none font-mono"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-bold text-ink">AI 系统提示词 (自动合成)</label>
                  <button
                    type="button"
                    onClick={() => setPersonaPrompt(generateCompositePrompt())}
                    className="text-[10px] text-ink bg-bg-muted hover:bg-bg-muted-2 px-2 py-0.5 rounded border border-border-strong transition"
                  >
                    一键同步上方设定
                  </button>
                </div>
                <textarea
                  rows={4}
                  value={personaPrompt || generateCompositePrompt()}
                  onChange={(e) => setPersonaPrompt(e.target.value)}
                  className="w-full p-2 text-[11px] bg-bg-soft rounded-lg border border-border-strong text-ink leading-relaxed font-mono outline-none"
                />
              </div>
            </div>
          )}
        </div>

        {/* Bottom Save & Cancel Action Bar */}
        <div className="pt-2 flex items-center justify-end gap-2.5">
          <button
            type="button"
            id="btn-edit-screen-cancel"
            onClick={onBack}
            className="px-4 py-2 rounded-xl frosted-glass border border-border text-xs font-medium text-ink hover:bg-bg-muted transition shadow-2xs"
          >
            取消返回
          </button>

          <button
            type="submit"
            id="btn-edit-screen-save"
            className="px-6 py-2 rounded-xl bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft transition flex items-center gap-1.5 shadow-sm"
          >
            <Save className="w-3.5 h-3.5" />
            <span>保存角色档案</span>
          </button>
        </div>
      </form>
    </div>
  );
};
