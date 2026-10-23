import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "mem_";

export interface IssuedApiKey {
  /** Shown once. Never stored. */
  readonly token: string;
  /** What is stored and looked up. */
  readonly hash: string;
}

export function generateApiKey(): IssuedApiKey {
  const token = API_KEY_PREFIX + randomBytes(24).toString("base64url");
  return { token, hash: hashApiKey(token) };
}

export function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX) && token.length > API_KEY_PREFIX.length + 16;
}
