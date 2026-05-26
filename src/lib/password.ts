/**
 * 密码哈希 — Node.js 内置 scrypt，不引入外部依赖
 *
 * 格式：salt:hash（base64）
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;
const SALT_LEN = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN).toString("base64url");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEYLEN, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return `${salt}:${derived.toString("base64url")}`;
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEYLEN, (err, k) => {
      if (err) reject(err);
      else resolve(k);
    });
  });
  const keyBuf = Buffer.from(key, "base64url");
  return timingSafeEqual(derived, keyBuf);
}
