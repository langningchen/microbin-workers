import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/index';
import { toB64Url } from '../src/shared/base64url';
import {
  deriveSecrets,
  encryptText,
  importAesKey,
  randomBytes,
  verifierFor,
} from '../src/shared/crypto';

export const BASE = 'https://microbin.test';

let counter = 0;
/** Every request comes from a fresh "client" so rate limits never interfere between tests. */
export const uniqueIp = (): string => `10.${(counter >> 8) & 255}.${counter++ & 255}.7`;

export interface CallResult {
  response: Response;
  /** Waits for ctx.waitUntil() work (e.g. R2 cleanup). Call after consuming streaming bodies. */
  settle: () => Promise<void>;
}

/** Runs the Worker in-process with optional per-test configuration overrides. */
export async function callWith(
  path: string,
  init: RequestInit = {},
  overrides: Record<string, unknown> = {},
): Promise<CallResult> {
  const headers = new Headers(init.headers);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', uniqueIp());
  const request = new Request(BASE + path, { ...init, headers, redirect: 'manual' });
  const ctx = createExecutionContext();
  const testEnv = { ...env, ...overrides } as unknown as Env;
  const response = await worker.fetch(request, testEnv, ctx);
  return { response, settle: () => waitOnExecutionContext(ctx) };
}

export async function call(
  path: string,
  init: RequestInit = {},
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const { response, settle } = await callWith(path, init, overrides);
  // Plain responses are fully read by tests; background work is awaited when the body is small.
  if (!response.body || (response.headers.get('content-type') ?? '').match(/text|json/)) {
    const clone = response.clone();
    await clone.arrayBuffer();
    await settle();
  }
  return response;
}

export const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export interface Created {
  id: string;
  url: string;
  complete: boolean;
  token?: string;
  files: { idx: number; mode: 'single' | 'multipart' }[];
}

/** Creates an upload through the JSON API; extra fields override the defaults. */
export async function create(
  fields: Record<string, unknown> = {},
  overrides = {},
): Promise<Created> {
  const response = await call(
    '/api/pastas',
    json({ content: 'hello world', expiration: '1hour', ...fields }),
    overrides,
  );
  if (response.status !== 201)
    throw new Error(`create failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 131 + seed * 17) & 0xff;
  return out;
}

/** Uploads one file with a single PUT and publishes the paste. */
export async function uploadFile(created: Created, data: Uint8Array, idx = 0): Promise<void> {
  const put = await call(`/api/pastas/${created.id}/files/${idx}`, {
    method: 'PUT',
    headers: { 'x-upload-token': created.token ?? '', 'content-length': String(data.length) },
    body: data,
  });
  if (put.status !== 200) throw new Error(`PUT failed: ${put.status} ${await put.text()}`);
}

export async function publish(created: Created): Promise<Response> {
  return call(`/api/pastas/${created.id}/complete`, {
    method: 'POST',
    headers: { 'x-upload-token': created.token ?? '' },
  });
}

/** What the browser does for "secret" uploads: derive keys, encrypt, send only the verifier. */
export async function secretFields(password: string, text: string) {
  const salt = randomBytes(16);
  const iterations = 20_000;
  const secrets = await deriveSecrets(password, salt, iterations);
  const key = await importAesKey(secrets.encKey);
  return {
    secrets,
    key,
    fields: {
      privacy: 'secret',
      content: await encryptText(key, text),
      kdf: { salt: toB64Url(salt), iter: iterations, verifier: await verifierFor(secrets.authKey) },
    },
    authHeader: toB64Url(secrets.authKey),
  };
}

export function form(values: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString(),
  };
}

export const basic = (user: string, pass: string): string => `Basic ${btoa(`${user}:${pass}`)}`;

// ── database / storage / cron helpers ──

import { createScheduledController } from 'cloudflare:test';

export async function row<T = Record<string, unknown>>(
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...params)
    .first<T>();
}

export async function run(sql: string, ...params: unknown[]): Promise<void> {
  await env.DB.prepare(sql)
    .bind(...params)
    .run();
}

export async function r2Exists(key: string): Promise<boolean> {
  return (await env.BUCKET.head(key)) !== null;
}

export async function fileKeys(id: string): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT r2_key FROM pasta_files WHERE paste_id = ?')
    .bind(id)
    .all<{ r2_key: string }>();
  return results.map((r) => r.r2_key);
}

/** Fires the Cron Trigger like Cloudflare would. */
export async function runCron(overrides: Record<string, unknown> = {}): Promise<void> {
  const ctx = createExecutionContext();
  // scheduled() hands its work to ctx.waitUntil(), which is what we wait for
  worker.scheduled?.(
    createScheduledController({ scheduledTime: Date.now(), cron: '*/30 * * * *' }),
    { ...env, ...overrides } as unknown as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Minimal ZIP reader (stored entries only) used to verify /archive responses. */
export function parseZip(zip: Uint8Array): { name: string; data: Uint8Array }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    if (method !== 0) throw new Error('only stored entries are supported');
    entries.push({ name, data: zip.slice(start, start + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
