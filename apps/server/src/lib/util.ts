/**
 * 通用工具
 */
import crypto from 'node:crypto';

export function genId(): string {
  return crypto.randomUUID();
}

export function now(): number {
  return Date.now();
}

export function jsonParse<T>(str: string, fallback: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}
