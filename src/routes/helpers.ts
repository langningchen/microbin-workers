import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { badRequest, tooLarge } from '../errors';
import { MIB } from '../shared/constants';
import type { AppEnv } from '../types';

type Node = Parameters<Context['html']>[0];

/** HTML responses are personal (counters, tokens, decrypted text): never cache them. */
export function page(
  c: Context<AppEnv>,
  node: Node,
  status: ContentfulStatusCode = 200,
): Response | Promise<Response> {
  return c.html(node, status, { 'Cache-Control': 'no-store' });
}

/**
 * Returns a request whose body is guaranteed to be at most `maxBytes`.
 *
 * A declared Content-Length is checked up front. Bodies without one (chunked transfer) are read
 * with a running byte count and aborted as soon as the limit is exceeded, so a client can never
 * make the Worker buffer more than it agreed to.
 */
async function boundedRequest(c: Context<AppEnv>, maxBytes: number): Promise<Request> {
  const raw = c.req.raw;
  const declared = raw.headers.get('content-length');
  const limitMessage = `Request body is larger than ${Math.floor(maxBytes / MIB) || 1} MiB`;
  if (declared !== null && /^\d+$/.test(declared)) {
    if (Number(declared) > maxBytes) throw tooLarge(limitMessage);
    return raw;
  }
  if (!raw.body) return raw;

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = (raw.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge(limitMessage);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(raw.url, { method: raw.method, headers: raw.headers, body });
}

export type FormFields = Record<string, string | File | (string | File)[]>;

export async function readForm(c: Context<AppEnv>, maxBytes = 2 * MIB): Promise<FormFields> {
  const type = c.req.header('content-type') ?? '';
  // A body-less POST (curl -X POST, fetch without body) is simply an empty form.
  if (!/^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(type)) return {};
  const request = await boundedRequest(c, maxBytes);
  let data: FormData;
  try {
    data = await request.formData();
  } catch {
    throw badRequest('Malformed form data');
  }
  const fields: FormFields = {};
  for (const [name, value] of data.entries()) {
    const previous = fields[name];
    fields[name] =
      previous === undefined
        ? value
        : [...(Array.isArray(previous) ? previous : [previous]), value];
  }
  return fields;
}

export async function readJson(c: Context<AppEnv>, maxBytes = 3 * MIB): Promise<unknown> {
  const request = await boundedRequest(c, maxBytes);
  try {
    return await request.json<unknown>();
  } catch {
    throw badRequest('Request body must be valid JSON', 'invalid_json');
  }
}

/** First string value of a form field (ignores files and repeated fields). */
export function field(form: FormFields, name: string): string | undefined {
  const value = form[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
}

export function wantsJson(c: Context<AppEnv>): boolean {
  return (
    c.req.path.startsWith('/api/') || (c.req.header('accept') ?? '').includes('application/json')
  );
}
