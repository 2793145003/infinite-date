/**
 * AppSecret 的对称加密。
 *
 * 为什么必须加密：AppSecret 是玩家 QQ 机器人的凭据，等于「能冒充这个 bot 发消息」的钥匙。
 * 官方文档也明确警告凭证泄露风险。库里存明文 = 一次库泄露就毁掉所有玩家的机器人。
 *
 * 密钥来源：IDATE_QQ_SECRET_KEY（64 位 hex = 32 字节）。没配置时**拒绝启动加密路径**，
 * 而不是退化成一个写死的默认密钥 —— 那种「默认密钥」等于不加密。
 */
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

function loadKey(): Buffer {
  const hex = process.env.IDATE_QQ_SECRET_KEY;
  if (!hex) {
    throw new Error('缺少 IDATE_QQ_SECRET_KEY（32 字节 hex）。生成：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('IDATE_QQ_SECRET_KEY 必须是 32 字节（64 位 hex）');
  return key;
}

/** 加密：iv(12) + tag(16) + ciphertext，一起 base64 */
export function encryptSecret(plain: string): string {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(stored: string): string {
  const key = loadKey();
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
