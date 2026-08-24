import React, { useState, useEffect } from 'react';
import {
  ChevronLeft,
  Search,
  Mail,
  MailOpen,
  Trash2,
  Reply,
  Send,
  Sparkles,
  Gift,
  Star,
  CheckCircle2,
  Plus,
  X,
  User,
  Paperclip,
  Clock,
} from 'lucide-react';
import { Character, EmailItem } from '../types';
import { api, type ApiEmail } from '../lib/api';

interface MailboxScreenProps {
  activeCharacter: Character;
  allCharacters: Character[];
  onBack: () => void;
  userName?: string;
}

const INITIAL_EMAILS: EmailItem[] = [
  {
    id: 'mail-1',
    senderName: '饲养员',
    senderEmail: 'caretaker@serenity.private',
    recipientName: '穗穗',
    subject: 'Fwd: 您的订单 [8847291035] 已发货',
    preview:
      '给你买了个放脚边烤的，省得你天天手脚冰凉还光着脚在家乱跑。过两天就到，快递放门口记得自己去拿，听见没？...',
    body: `给你买了部放脚边烤暖的小太阳取暖器，省得你天天手脚冰凉还总光着脚在家里乱跑。

快递单号已生成：SF8847291035。
过两天就送到门口，看到短信记得自己去拿，别又丢在门外吹风。

插电前先把说明书看一遍，别把毛毯直接盖在上面。听见没？`,
    dateStr: '2025/12/6',
    timestamp: Date.now() - 1000 * 60 * 60 * 12,
    isUnread: true,
    isStarred: true,
    giftAttachment: {
      name: '恒温暖脚小太阳',
      icon: '🔥',
      description: '3秒速热，静音送暖，驱散冬日手脚冰凉。',
    },
  },
  {
    id: 'mail-2',
    senderName: '饲养员',
    senderEmail: 'caretaker@serenity.private',
    recipientName: '穗穗',
    subject: 'Re: 寒假去哪儿玩？',
    preview:
      '看了几个地方。你要去的韩国，除了买东西和看那些人造帅哥，还有啥？机票不便宜，冬天还死冷。你要真想去，我就去办签...',
    body: `看了你发过来的几个旅行备选地。

你要去的韩国，除了逛街买东西和看那些人造帅哥，还有啥？机票不便宜，首尔冬天还死冷，动不动就零下十几度。

不过——你要是真想去踩雪吃烤肉，我就抽空把签证和酒店全办了。行程你不用操心，跟着我走别走丢就行。

把护照照片发我一份。`,
    dateStr: '2025/12/5',
    timestamp: Date.now() - 1000 * 60 * 60 * 36,
    isUnread: true,
    giftAttachment: {
      name: '往返双人机票行程单',
      icon: '✈️',
      description: '头等舱双人往返，包含私人接送机与五星级雪景酒店。',
    },
  },
  {
    id: 'mail-3',
    senderName: '妈妈',
    senderEmail: 'mom@home.family',
    recipientName: '宝贝穗穗',
    subject: '穗穗，天气冷了',
    preview:
      '我的宝贝穗穗：看天气预报说S市这几天降温很厉害，你那些漂亮的小裙子先收一收，赶紧把厚外套羽绒服穿上，千万别感冒...',
    body: `我的宝贝穗穗：

看天气预报说S市这几天降温特别厉害，最低气温都跌破零度了。你那些漂亮的小裙子先收进柜子里，赶紧把厚外套羽绒服穿上，千万别冻感冒了！

妈妈给你寄了一箱自家腌的腊味还有你爱吃的红薯干，昨天已经发顺丰了。收到放冰箱冷冻，吃的时候蒸热一下。

平时工作别太拼命，按时吃饭，多喝温水。想家了随时给妈妈打电话。`,
    dateStr: '2025/12/5',
    timestamp: Date.now() - 1000 * 60 * 60 * 48,
    isUnread: true,
    isStarred: true,
    giftAttachment: {
      name: '家乡爱心补给箱',
      icon: '🍠',
      description: '满载妈妈亲手制作的蜜汁红薯干与热气腾腾的腊味。',
    },
  },
  {
    id: 'mail-4',
    senderName: '苏烬',
    senderEmail: 'sujin@fourth-district.gov',
    recipientName: '张琴',
    subject: '关于近期的安全巡查与防寒提示',
    preview:
      '夜间气温持续走低，已在你的储物柜放了防寒手套与薄荷润喉糖。结束工作后请直接回家，收到请报平安。...',
    body: `张琴：

第四分区今夜预计有暴雪降温，路面结冰严重。

巡查结束时，我已经在你玄关储物柜里备了一副加厚羊绒手套和保温杯。今晚非必要不要在室外逗留，离开工位直接回家。

如果在路上遇到任何异常或交通受阻，随时按下紧急联络终端，我会第一时间赶到。

收到后给我回个信息报平安。`,
    dateStr: '2025/12/4',
    timestamp: Date.now() - 1000 * 60 * 60 * 72,
    isUnread: false,
    giftAttachment: {
      name: '军工级加厚防寒手套',
      icon: '🧤',
      description: '防风防水，内置自发热纤维，守护双手温热。',
    },
  },
  {
    id: 'mail-5',
    senderName: '屿白',
    senderEmail: 'yubai@starlight.cafe',
    recipientName: '姐姐',
    subject: '偷偷藏在信封里的手工糖果 🍬',
    preview:
      '姐姐！今天做了你最喜欢的草莓水果软糖，装在小玻璃罐里啦。想我的时候就吃一颗，我很快就会回到你身边！...',
    body: `姐姐！

今天在初遇咖啡馆烘焙间试做了新口味的草莓软糖，甜度专门减了半糖，是你最喜欢的口感！

已经装在系着粉色缎带的玻璃罐里了，放在你包包的侧袋里啦。工作累了或者想我的时候就偷偷吃一颗，像是我在悄悄抱你一样 (>ω<)

今晚等我下班一起去吃热气腾腾的寿喜烧好不好？`,
    dateStr: '2025/12/3',
    timestamp: Date.now() - 1000 * 60 * 60 * 96,
    isUnread: false,
    giftAttachment: {
      name: '手工草莓夹心软糖罐',
      icon: '🍬',
      description: '特调低糖草莓果泥制作，入口即化，甜入心扉。',
    },
  },
];

// ─── 后端 ApiEmail → 前端 EmailItem 映射 ────────────────

function formatEmailTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function mapEmailToEmailItem(e: ApiEmail, userName: string): EmailItem {
  return {
    id: e.id,
    senderName: e.sender_name,
    subject: e.subject,
    preview: e.body.length > 75 ? e.body.slice(0, 75) + '...' : e.body,
    body: e.body,
    dateStr: formatEmailTime(e.created_at),
    timestamp: e.created_at,
    isUnread: e.is_read === 0,
    recipientName: userName,
  };
}

export const MailboxScreen: React.FC<MailboxScreenProps> = ({
  activeCharacter,
  allCharacters,
  onBack,
  userName = '穗穗',
}) => {
  // Page mode: 'inbox' | 'detail' | 'compose' (Strictly standalone pages, no modals!)
  const [currentView, setCurrentView] = useState<'inbox' | 'detail' | 'compose'>('inbox');
  const [activeEmail, setActiveEmail] = useState<EmailItem | null>(null);

  // 信件：从后端 /emails 加载
  const [emails, setEmails] = useState<EmailItem[]>([]);

  const loadEmails = async () => {
    try {
      const { emails: list } = await api.listEmails();
      setEmails(list.map((e) => mapEmailToEmailItem(e, userName)));
    } catch (e) {
      console.error('加载信箱失败', e);
    }
  };

  useEffect(() => {
    loadEmails();
  }, []);

  // Search keyword & Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'unread' | 'starred'>('all');

  // Claimed gifts set
  const [claimedGifts, setClaimedGifts] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('serenity_claimed_mail_gifts');
      if (saved) return JSON.parse(saved);
    } catch {}
    return {};
  });

  // Reply Draft State
  const [isReplying, setIsReplying] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Compose State
  const [composeRecipient, setComposeRecipient] = useState(activeCharacter.name);
  const [composeSubject, setComposeSubject] = useState('');
  const [composeBody, setComposeBody] = useState('');

  // Persist（仅礼物领取状态，信件已走后端）
  useEffect(() => {
    try {
      localStorage.setItem('serenity_claimed_mail_gifts', JSON.stringify(claimedGifts));
    } catch {}
  }, [claimedGifts]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  // Open Email Detail (Full Screen)
  const handleOpenEmail = (mail: EmailItem) => {
    setActiveEmail(mail);
    setCurrentView('detail');
    setIsReplying(false);
    setReplyText('');

    if (mail.isUnread) {
      setEmails((prev) =>
        prev.map((e) => (e.id === mail.id ? { ...e, isUnread: false } : e))
      );
      // 后端标记已读
      api.readEmail(mail.id).catch((e) => console.error('标记已读失败', e));
    }
  };

  // Toggle Star
  const handleToggleStar = (e: React.MouseEvent, mailId: string) => {
    e.stopPropagation();
    setEmails((prev) =>
      prev.map((m) => {
        if (m.id === mailId) {
          const nextVal = !m.isStarred;
          if (activeEmail && activeEmail.id === mailId) {
            setActiveEmail({ ...activeEmail, isStarred: nextVal });
          }
          return { ...m, isStarred: nextVal };
        }
        return m;
      })
    );
  };

  // Delete email
  const handleDeleteEmail = (mailId: string) => {
    setEmails((prev) => prev.filter((m) => m.id !== mailId));
    if (activeEmail?.id === mailId) {
      setActiveEmail(null);
      setCurrentView('inbox');
    }
    showToast('信件已删除');
  };

  // Claim Gift Action
  const handleClaimGift = (mailId: string) => {
    setClaimedGifts((prev) => ({ ...prev, [mailId]: true }));
    showToast('✨ 随信礼物已收入专属背包！');
  };

  // Send Reply Action
  const handleSendReply = () => {
    if (!replyText.trim() || !activeEmail) return;

    showToast(`已向「${activeEmail.senderName}」投递回信 💌`);
    setReplyText('');
    setIsReplying(false);
  };

  // Send New Composed Mail
  const handleSendCompose = () => {
    if (!composeSubject.trim() || !composeBody.trim()) {
      showToast('请填写信件主题与正文');
      return;
    }

    const newMail: EmailItem = {
      id: `mail-${Date.now()}`,
      senderName: userName || '我',
      senderEmail: 'me@serenity.space',
      recipientName: composeRecipient,
      subject: composeSubject.trim(),
      preview: composeBody.slice(0, 75) + '...',
      body: composeBody.trim(),
      dateStr: new Date().toLocaleDateString('zh-CN'),
      timestamp: Date.now(),
      isUnread: false,
    };

    setEmails([newMail, ...emails]);
    setComposeSubject('');
    setComposeBody('');
    setCurrentView('inbox');
    showToast(`信件已投递给「${composeRecipient}」📮`);
  };

  // Filtered emails
  const filteredEmails = emails.filter((mail) => {
    const matchesSearch =
      mail.senderName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      mail.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
      mail.preview.toLowerCase().includes(searchQuery.toLowerCase()) ||
      mail.body.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;

    if (filterTab === 'unread') return mail.isUnread;
    if (filterTab === 'starred') return !!mail.isStarred;
    return true;
  });

  const unreadCount = emails.filter((e) => e.isUnread).length;

  return (
    <div
      id="mailbox-screen-container"
      className="w-full max-w-md mx-auto min-h-full px-4 pt-3 pb-24 flex flex-col select-none"
    >
      {/* Global Toast Alert */}
      {toastMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-60 bg-solid text-solid-contrast text-xs px-4 py-2 rounded-xl shadow-lg border border-border-dark animate-in fade-in slide-in-from-top-2">
          {toastMessage}
        </div>
      )}

      {/* =========================================================================
          VIEW 1: 信件详情页面 (STANDALONE FULL PAGE - NO POPUP)
          ========================================================================= */}
      {currentView === 'detail' && activeEmail && (
        <div className="flex-1 flex flex-col space-y-3 animate-in fade-in duration-150">
          {/* Top Header Bar */}
          <header className="flex items-center justify-between py-1.5">
            <button
              id="btn-detail-back-to-inbox"
              onClick={() => {
                setActiveEmail(null);
                setCurrentView('inbox');
              }}
              className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:bg-bg-muted transition active:scale-95 cursor-pointer shadow-xs"
              aria-label="返回收件箱"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <span className="text-xs font-bold text-ink">信件正文</span>

            {/* TODO(待补功能)：收藏/星标、删除信件——后端无对应路由，已撤下，见 docs/UNIMPLEMENTED_FEATURES.md #3 #4
            <div className="flex items-center gap-1.5">
              <button
                onClick={(e) => handleToggleStar(e, activeEmail.id)}
                className={`w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center transition active:scale-95 cursor-pointer shadow-xs ${
                  activeEmail.isStarred ? 'text-amber' : 'text-ink hover:text-ink'
                }`}
                title="收藏信件"
              >
                <Star
                  className={`w-4 h-4 ${activeEmail.isStarred ? 'fill-amber' : ''}`}
                />
              </button>
              <button
                onClick={() => handleDeleteEmail(activeEmail.id)}
                className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:text-rose transition active:scale-95 cursor-pointer shadow-xs"
                title="删除信件"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            */}
          </header>

          {/* Email Card Container */}
          <div className="frosted-glass rounded-2xl p-4 border border-border shadow-xs space-y-3.5">
            {/* Subject */}
            <h1 className="text-sm font-bold text-ink leading-snug tracking-tight">
              {activeEmail.subject}
            </h1>

            {/* Sender & Recipient Metadata */}
            <div className="flex items-center justify-between pb-3 border-b border-border-soft">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-solid text-solid-contrast flex items-center justify-center text-xs font-bold shrink-0">
                  <span>{activeEmail.senderName.slice(0, 1)}</span>
                </div>
                <div>
                  <div className="text-xs font-bold text-ink">{activeEmail.senderName}</div>
                  <div className="text-[10px] text-ink">
                    发往：{activeEmail.recipientName || userName}
                  </div>
                </div>
              </div>

              <div className="text-[11px] text-ink font-normal">
                {activeEmail.dateStr}
              </div>
            </div>

            {/* Email Body Content */}
            <div className="bg-bg-soft rounded-xl p-3.5 border border-border-strong text-xs text-ink leading-relaxed font-sans whitespace-pre-wrap">
              {activeEmail.body}
            </div>

            {/* TODO(待补功能)：随信礼物——后端 ApiEmail 无 giftAttachment 字段，整条链路不渲染，已撤下，见 docs/UNIMPLEMENTED_FEATURES.md #5
            {activeEmail.giftAttachment && (
              <div className="bg-bg-amber-soft/80 border border-amber/80 rounded-xl p-3 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-lg bg-bg-amber-soft border border-amber flex items-center justify-center text-lg shrink-0">
                    {activeEmail.giftAttachment.icon}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-amber">
                      随信附赠：{activeEmail.giftAttachment.name}
                    </div>
                    <p className="text-[10px] text-amber/80 mt-0.5">
                      {activeEmail.giftAttachment.description}
                    </p>
                  </div>
                </div>

                {claimedGifts[activeEmail.id] ? (
                  <span className="text-[10px] font-semibold text-sage bg-bg-emerald-soft px-2.5 py-1 rounded-md shrink-0 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    已领取
                  </span>
                ) : (
                  <button
                    onClick={() => handleClaimGift(activeEmail.id)}
                    className="px-3 py-1.5 bg-solid hover:bg-solid-soft text-solid-contrast rounded-lg text-xs font-semibold shrink-0 transition active:scale-95 cursor-pointer shadow-xs"
                  >
                    领取礼物
                  </button>
                )}
              </div>
            )}
            */}

            {/* TODO(待补功能)：回信——后端无 reply 路由，回信不落库，已撤下，见 docs/UNIMPLEMENTED_FEATURES.md #1
            {isReplying ? (
              <div className="space-y-2.5 pt-2 border-t border-border-soft">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-ink">
                    回信给 {activeEmail.senderName}
                  </span>
                  <button
                    onClick={() => setIsReplying(false)}
                    className="text-xs text-ink hover:text-ink cursor-pointer"
                  >
                    取消
                  </button>
                </div>
                <textarea
                  rows={4}
                  placeholder="写下你想对TA说的话..."
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  className="w-full p-3 rounded-xl border border-border bg-bg-soft text-xs text-ink placeholder-ink-faint outline-none focus:border-border-dark resize-none font-sans"
                />
                <button
                  onClick={handleSendReply}
                  className="w-full py-2.5 rounded-xl bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 shadow-xs"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>投递回信</span>
                </button>
              </div>
            ) : (
              <button
                id="btn-trigger-reply"
                onClick={() => setIsReplying(true)}
                className="w-full py-2.5 rounded-xl bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 shadow-xs"
              >
                <Reply className="w-3.5 h-3.5" />
                <span>回复信件</span>
              </button>
            )}
            */}
          </div>
        </div>
      )}

      {/* =========================================================================
          VIEW 2: 撰写新信件页面 (STANDALONE FULL PAGE - NO POPUP)
          TODO(待补功能)：已整页撤下，见 docs/UNIMPLEMENTED_FEATURES.md #2
          ========================================================================= */}
      {false && currentView === 'compose' && (
        <div className="flex-1 flex flex-col space-y-3 animate-in fade-in duration-150">
          {/* Header Bar */}
          <header className="flex items-center justify-between py-1.5">
            <button
              id="btn-cancel-compose"
              onClick={() => setCurrentView('inbox')}
              className="text-xs font-medium text-ink hover:text-ink px-2 py-1 cursor-pointer"
            >
              取消
            </button>

            <span className="text-xs font-bold text-ink">撰写新信件</span>

            <button
              id="btn-send-composed-mail"
              onClick={handleSendCompose}
              className="px-3.5 py-1 rounded-full bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft transition active:scale-95 cursor-pointer shadow-xs"
            >
              发送
            </button>
          </header>

          {/* Form Card */}
          <div className="frosted-glass rounded-2xl p-4 border border-border shadow-xs space-y-3">
            {/* Recipient Selection */}
            <div>
              <label className="text-[10px] text-ink font-medium block mb-1">
                收件人
              </label>
              <select
                value={composeRecipient}
                onChange={(e) => setComposeRecipient(e.target.value)}
                className="w-full p-2.5 rounded-xl border border-border bg-bg-soft text-xs text-ink outline-none focus:border-border-dark cursor-pointer"
              >
                {allCharacters.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name} ({c.identity})
                  </option>
                ))}
                <option value="饲养员">饲养员</option>
                <option value="妈妈">妈妈</option>
              </select>
            </div>

            {/* Subject */}
            <div>
              <label className="text-[10px] text-ink font-medium block mb-1">
                主题
              </label>
              <input
                type="text"
                placeholder="例如：今晚的小确幸 / 假期计划"
                value={composeSubject}
                onChange={(e) => setComposeSubject(e.target.value)}
                className="w-full p-2.5 rounded-xl border border-border bg-bg-soft text-xs text-ink placeholder-ink-faint outline-none focus:border-border-dark"
              />
            </div>

            {/* Body */}
            <div>
              <label className="text-[10px] text-ink font-medium block mb-1">
                正文内容
              </label>
              <textarea
                rows={8}
                placeholder="写下你想对TA诉说的心事、温存秘密或日常叮嘱..."
                value={composeBody}
                onChange={(e) => setComposeBody(e.target.value)}
                className="w-full p-3 rounded-xl border border-border bg-bg-soft text-xs text-ink placeholder-ink-faint outline-none focus:border-border-dark resize-none font-sans leading-relaxed"
              />
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          VIEW 3: 收件箱主列表 (STANDALONE FULL PAGE - MATCHING IMAGE)
          ========================================================================= */}
      {currentView === 'inbox' && (
        <div className="space-y-3 animate-in fade-in duration-150">
          {/* Top Bar with Back Button & Compose Action */}
          <div className="flex items-center justify-between pt-1">
            <button
              id="btn-mailbox-back-home"
              onClick={onBack}
              className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:bg-bg-muted transition active:scale-95 cursor-pointer shadow-xs"
              aria-label="返回首页"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            {/* TODO(待补功能)：写新信——后端无 POST /emails 发信路由，已撤下，见 docs/UNIMPLEMENTED_FEATURES.md #2
            <button
              id="btn-open-compose-view"
              onClick={() => setCurrentView('compose')}
              className="px-2.5 py-1 rounded-lg frosted-glass border border-border text-ink text-xs font-semibold hover:bg-bg-muted flex items-center gap-1 shadow-xs transition active:scale-95 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>写新信</span>
            </button>
            */}
          </div>

          {/* Large Title: 收件箱 */}
          <div className="pt-1">
            <h1 className="text-2xl font-bold text-ink tracking-tight font-heading">
              收件箱
            </h1>
          </div>

          {/* Search Bar (Matching screenshot style) */}
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-ink">
              <Search className="w-4 h-4" />
            </div>
            <input
              id="input-search-mail"
              type="text"
              placeholder="Search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-8 py-2 rounded-xl bg-bg-muted-2/70 border border-transparent focus:border-border-strong focus:bg-bg-soft text-xs text-ink placeholder-ink-muted outline-none transition font-sans"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-ink hover:text-ink cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Filter Pills: 全部 | 未读 | 重要 */}
          <div className="flex items-center gap-1.5 pb-1">
            <button
              onClick={() => setFilterTab('all')}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition cursor-pointer ${
                filterTab === 'all'
                  ? 'bg-solid text-solid-contrast shadow-xs'
                  : 'frosted-glass border border-border text-ink hover:bg-bg-soft'
              }`}
            >
              全部 ({emails.length})
            </button>
            <button
              onClick={() => setFilterTab('unread')}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1 ${
                filterTab === 'unread'
                  ? 'bg-solid text-solid-contrast shadow-xs'
                  : 'frosted-glass border border-border text-ink hover:bg-bg-soft'
              }`}
            >
              未读 {unreadCount > 0 && `(${unreadCount})`}
            </button>
            <button
              onClick={() => setFilterTab('starred')}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1 ${
                filterTab === 'starred'
                  ? 'bg-solid text-solid-contrast shadow-xs'
                  : 'frosted-glass border border-border text-ink hover:bg-bg-soft'
              }`}
            >
              <Star className="w-3 h-3 fill-amber text-amber" />
              重要
            </button>
          </div>

          {/* Email Items List Container (Matching image design: dot, sender, date, subject, preview) */}
          <div className="frosted-glass rounded-2xl border border-border shadow-xs divide-y divide-border-soft overflow-hidden">
            {filteredEmails.length === 0 ? (
              <div className="py-12 text-center text-ink">
                <MailOpen className="w-8 h-8 mx-auto mb-2 opacity-40 text-ink" />
                <p className="text-xs">暂无匹配的信件</p>
              </div>
            ) : (
              filteredEmails.map((mail) => (
                <div
                  key={mail.id}
                  id={`mail-item-${mail.id}`}
                  onClick={() => handleOpenEmail(mail)}
                  className="p-4 hover:bg-bg-soft/80 transition cursor-pointer relative group flex items-start gap-3 select-none"
                >
                  {/* Left Unread Indicator Dot (Dark circle ● from screenshot) */}
                  <div className="w-2.5 pt-1 shrink-0 flex items-center justify-center">
                    {mail.isUnread ? (
                      <span className="w-2 h-2 rounded-full bg-solid-soft block shadow-2xs" />
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-transparent block" />
                    )}
                  </div>

                  {/* Mail Content Column */}
                  <div className="flex-1 min-w-0">
                    {/* Row 1: Sender Name on Left, Date on Right */}
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs font-bold text-ink tracking-tight">
                        {mail.senderName}
                      </span>
                      <span className="text-[11px] text-ink font-normal">
                        {mail.dateStr}
                      </span>
                    </div>

                    {/* Row 2: Subject in Bold */}
                    <div className="text-xs font-bold text-ink leading-snug mb-1 truncate">
                      {mail.subject}
                    </div>

                    {/* Row 3: Preview snippet in multi-line / gray */}
                    <p className="text-xs text-ink line-clamp-2 leading-relaxed font-sans">
                      {mail.preview}
                    </p>

                    {/* TODO(待补功能)：随信礼物 badge——后端无 giftAttachment 字段，已撤下，见 docs/UNIMPLEMENTED_FEATURES.md #5
                    {mail.giftAttachment && !claimedGifts[mail.id] && (
                      <div className="mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-bg-amber-soft border border-amber/80 text-[10px] font-medium text-amber">
                        <span>{mail.giftAttachment.icon}</span>
                        <span>含随信礼物：{mail.giftAttachment.name}</span>
                      </div>
                    )}
                    */}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
