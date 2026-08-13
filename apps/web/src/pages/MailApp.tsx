import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import type { EmailInfo } from '../lib/api';

export function MailApp({
  emailId,
  onBack,
  onOpenEmail,
}: {
  emailId?: string;
  onBack: () => void;
  onOpenEmail?: (emailId: string) => void;
}) {
  const [emails, setEmails] = useState<EmailInfo[]>([]);
  const [loading, setLoading] = useState(!emailId);
  const [currentEmail, setCurrentEmail] = useState<EmailInfo | null>(null);

  useEffect(() => {
    if (!emailId) loadEmails();
    else loadEmailDetail(emailId);
  }, [emailId]);

  const loadEmails = async () => {
    try {
      const data = await api.getEmails();
      setEmails(data.emails);
    } catch { /* ignore */ }
    setLoading(false);
  };

  const loadEmailDetail = async (id: string) => {
    try {
      const data = await api.getEmails();
      const email = data.emails.find((e) => e.id === id);
      if (email) {
        setCurrentEmail(email);
        if (email.is_read === 0) {
          await api.readEmail(id);
        }
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  if (emailId) {
    if (loading) return <div className="id-app"><div className="id-appbar"><button className="id-appbar-back" onClick={onBack}>←</button><span className="id-appbar-title">邮件</span></div><div className="id-loading">加载中…</div></div>;
    return (
      <div className="id-app">
        <div className="id-appbar">
          <button className="id-appbar-back" onClick={onBack}>←</button>
          <span className="id-appbar-title">{currentEmail?.subject || '邮件'}</span>
        </div>
        <div className="id-app-scroll">
          <div className="id-email-detail">
            <h2>{currentEmail?.subject}</h2>
            <div className="id-email-meta">
              {currentEmail?.sender_type === 'deity' ? '主神' : '系统'}
              {' · '}
              {currentEmail ? new Date(currentEmail.created_at).toLocaleString('zh-CN') : ''}
            </div>
            <div className="id-email-body">{currentEmail?.body}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">邮件</span>
      </div>
      <div className="id-app-scroll no-pad">
        {loading ? (
          <div className="id-loading">加载中…</div>
        ) : emails.length === 0 ? (
          <div className="id-empty"><span>📭</span><span>没有邮件</span></div>
        ) : (
          <div className="id-email-list">
            {emails.map((email) => (
              <button
                key={email.id}
                className={`id-email-item ${email.is_read === 0 ? 'unread' : ''}`}
                onClick={() => onOpenEmail?.(email.id)}
              >
                <div className="id-email-subject">{email.subject || '(无标题)'}</div>
                <div className="id-email-preview">{email.body.slice(0, 60)}</div>
                <div className="id-email-date">{new Date(email.created_at).toLocaleString('zh-CN')}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
