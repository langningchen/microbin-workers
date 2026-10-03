/**
 * Stateless, tamper-proof tokens: AES-256-GCM "sealed" JSON, keyed from SESSION_SECRET.
 * Used for upload sessions, short-lived file links and the admin session cookie. Because the
 * payload is encrypted (not just signed) it can safely carry a file encryption key.
 */
import { fromB64Url, toB64Url } from '../shared/base64url';
import { IV_BYTES, randomBytes, utf8 } from '../shared/crypto';

export type TokenKind = 'upload' | 'file' | 'admin';

export interface TokenPayload {
  /** Paste id (or "admin"). */
  id: string;
  /** Expiry, unix seconds. */
  exp: number;
  /** base64url AES key of a private paste, so its files can be decrypted for this token holder. */
  k?: string;
}

async function tokenKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8('microbin/v1/token-salt'),
      info: utf8('microbin/v1/token'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealToken(
  secret: string,
  kind: TokenKind,
  payload: TokenPayload,
): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(`token:${kind}`), tagLength: 128 },
      await tokenKey(secret),
      utf8(JSON.stringify(payload)),
    ),
  );
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv, 0);
  out.set(sealed, IV_BYTES);
  return toB64Url(out);
}

/** Returns the payload, or `null` if the token is malformed, forged, of another kind or expired. */
export async function openToken(
  secret: string,
  kind: TokenKind,
  token: string | undefined | null,
  now: number,
): Promise<TokenPayload | null> {
  if (!token || token.length > 4096) return null;
  const raw = fromB64Url(token);
  if (!raw || raw.length < IV_BYTES + 16) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: raw.subarray(0, IV_BYTES),
        additionalData: utf8(`token:${kind}`),
        tagLength: 128,
      },
      await tokenKey(secret),
      raw.subarray(IV_BYTES),
    );
    const payload = JSON.parse(new TextDecoder().decode(plain)) as Partial<TokenPayload>;
    if (typeof payload.id !== 'string' || typeof payload.exp !== 'number' || payload.exp <= now) {
      return null;
    }
    return { id: payload.id, exp: payload.exp, ...(payload.k ? { k: payload.k } : {}) };
  } catch {
    return null;
  }
}
