/**
 * MicroBin crypto, shared by the Worker (server-side "private" mode) and the browser
 * (client-side "secret" mode). Only standard Web Crypto / Streams APIs are used.
 *
 *   password ──PBKDF2-SHA256(salt, iterations)──► master (256 bit)
 *   master   ──HKDF-SHA256("…/enc")  ──► encKey   AES-256-GCM key for text and files
 *   master   ──HKDF-SHA256("…/auth") ──► authKey  proves knowledge of the password
 *   verifier = SHA-256(authKey)       stored in the database
 *
 * - Text:  "mbx1." + base64url(iv || AES-GCM(ciphertext || tag))
 * - Files: 16 byte header, then AES-GCM encrypted 64 KiB chunks (STREAM construction):
 *          nonce = 7 byte random prefix || u32 chunk counter || 1 byte "last chunk" flag,
 *          which makes chunk reordering, dropping and truncation detectable.
 *
 * NOTE: Cloudflare Workers production rejects PBKDF2 > 100,000 iterations while local
 * `wrangler dev` does not. Server side code must stay <= KDF_SERVER_MAX_ITERATIONS.
 */
import { fromB64Url, toB64Url } from './base64url';

export type Bytes = Uint8Array<ArrayBuffer>;

/** Hard limit of Web Crypto PBKDF2 on Cloudflare Workers (production). */
export const KDF_SERVER_MAX_ITERATIONS = 100_000;
/** Used when the *browser* derives the key (secret mode): the server never runs PBKDF2 there. */
export const KDF_CLIENT_ITERATIONS = 600_000;
export const KDF_MIN_ITERATIONS = 10_000;
export const KDF_MAX_ITERATIONS = 5_000_000;
export const SALT_BYTES = 16;

export const CHUNK_SIZE = 64 * 1024;
export const TAG_BYTES = 16;
export const IV_BYTES = 12;
export const FILE_HEADER_BYTES = 16;
const FULL_CHUNK = CHUNK_SIZE + TAG_BYTES;
const MAX_CHUNKS = 0xffff_ffff;
const TEXT_PREFIX = 'mbx1.';

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export function utf8(text: string): Bytes {
  return Uint8Array.from(new TextEncoder().encode(text));
}

const AAD_TEXT = utf8('mbx1:text');
const AAD_FILE = utf8('mbx1:file');
const INFO_ENC = utf8('microbin/v1/enc');
const INFO_AUTH = utf8('microbin/v1/auth');
const MAGIC = [0x4d, 0x42, 0x58, 0x31]; // "MBX1"

export function randomBytes(length: number): Bytes {
  const bytes = new Uint8Array(length);
  // getRandomValues() accepts at most 65,536 bytes per call.
  for (let offset = 0; offset < length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65_536)));
  }
  return bytes;
}

// ───────────────────────────── key derivation ─────────────────────────────

export interface DerivedSecrets {
  /** Raw AES-256 key. Import with {@link importAesKey}. */
  encKey: Bytes;
  /** Raw 256 bit value that is sent to / verified by the server instead of the password. */
  authKey: Bytes;
}

export async function deriveSecrets(
  password: string,
  salt: Bytes,
  iterations: number,
): Promise<DerivedSecrets> {
  if (!Number.isInteger(iterations) || iterations < 1) throw new CryptoError('invalid iterations');
  const pwKey = await crypto.subtle.importKey(
    'raw',
    utf8(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const master = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    pwKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const expand = (info: Bytes) =>
    crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
      hkdfKey,
      256,
    );
  const [enc, auth] = await Promise.all([expand(INFO_ENC), expand(INFO_AUTH)]);
  return { encKey: new Uint8Array(enc), authKey: new Uint8Array(auth) };
}

/** What the database stores to later recognise the right password: base64url(SHA-256(authKey)). */
export async function verifierFor(authKey: Bytes): Promise<string> {
  return toB64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', authKey)));
}

export function importAesKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// ─────────────────────────────── text ───────────────────────────────

export async function encryptText(key: CryptoKey, text: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: AAD_TEXT, tagLength: 128 },
      key,
      utf8(text),
    ),
  );
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv, 0);
  out.set(sealed, IV_BYTES);
  return TEXT_PREFIX + toB64Url(out);
}

export async function decryptText(key: CryptoKey, envelope: string): Promise<string> {
  if (!envelope.startsWith(TEXT_PREFIX)) throw new CryptoError('unsupported envelope');
  const raw = fromB64Url(envelope.slice(TEXT_PREFIX.length));
  if (!raw || raw.length < IV_BYTES + TAG_BYTES) throw new CryptoError('malformed envelope');
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, IV_BYTES), additionalData: AAD_TEXT, tagLength: 128 },
      key,
      raw.subarray(IV_BYTES),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new CryptoError('decryption failed');
  }
}

// ─────────────────────────────── files ───────────────────────────────

/** Size of the encrypted file for a given plaintext size. */
export function ciphertextSize(plainSize: number): number {
  return FILE_HEADER_BYTES + plainSize + TAG_BYTES * Math.max(1, Math.ceil(plainSize / CHUNK_SIZE));
}

/** Inverse of {@link ciphertextSize}; `null` if the size cannot belong to an MBX1 file. */
export function plaintextSize(cipherSize: number): number | null {
  const body = cipherSize - FILE_HEADER_BYTES;
  if (!Number.isInteger(body) || body < TAG_BYTES) return null;
  const plain = body - TAG_BYTES * Math.ceil(body / FULL_CHUNK);
  return plain >= 0 && ciphertextSize(plain) === cipherSize ? plain : null;
}

/** Accumulates stream pieces and hands out exact-size slices without quadratic copying. */
class ChunkBuffer {
  private pieces: Uint8Array[] = [];
  private offset = 0;
  length = 0;

  push(piece: Uint8Array): void {
    if (piece.length === 0) return;
    this.pieces.push(piece);
    this.length += piece.length;
  }

  take(size: number): Bytes {
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const head = this.pieces[0];
      if (!head) throw new CryptoError('buffer underflow');
      const count = Math.min(head.length - this.offset, size - filled);
      out.set(head.subarray(this.offset, this.offset + count), filled);
      filled += count;
      this.offset += count;
      if (this.offset === head.length) {
        this.pieces.shift();
        this.offset = 0;
      }
    }
    this.length -= size;
    return out;
  }
}

function chunkNonce(prefix: Uint8Array, counter: number, last: boolean): Bytes {
  if (counter > MAX_CHUNKS) throw new CryptoError('file too large');
  const nonce = new Uint8Array(IV_BYTES);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setUint32(7, counter, false);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

function makeHeader(prefix: Bytes): Bytes {
  const header = new Uint8Array(FILE_HEADER_BYTES);
  header.set(MAGIC, 0);
  header[4] = 1; // format version
  header[5] = 16; // log2(CHUNK_SIZE)
  header.set(prefix, 9);
  return header;
}

/** Lets the cipher run a few chunks ahead of a slow consumer without unbounded buffering. */
const outputBuffer = () => new ByteLengthQueuingStrategy({ highWaterMark: 4 * FULL_CHUNK });

/** Plaintext bytes in, MBX1 ciphertext out. Memory use is bounded by one chunk. */
export function encryptStream(key: CryptoKey): TransformStream<Uint8Array, Uint8Array> {
  const prefix = randomBytes(7);
  const buffer = new ChunkBuffer();
  let counter = 0;
  let started = false;

  const seal = async (plain: Bytes, last: boolean): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: chunkNonce(prefix, counter++, last),
          additionalData: AAD_FILE,
          tagLength: 128,
        },
        key,
        plain,
      ),
    );

  return new TransformStream<Uint8Array, Uint8Array>(
    {
      async transform(chunk, controller) {
        if (!started) {
          started = true;
          controller.enqueue(makeHeader(prefix));
        }
        buffer.push(chunk);
        // Strictly greater: the final chunk (1..CHUNK_SIZE bytes) is always held back.
        while (buffer.length > CHUNK_SIZE) {
          controller.enqueue(await seal(buffer.take(CHUNK_SIZE), false));
        }
      },
      async flush(controller) {
        if (!started) controller.enqueue(makeHeader(prefix));
        controller.enqueue(await seal(buffer.take(buffer.length), true));
      },
    },
    undefined,
    outputBuffer(),
  );
}

/** MBX1 ciphertext in, plaintext out. Errors the stream on any tampering or truncation. */
export function decryptStream(key: CryptoKey): TransformStream<Uint8Array, Uint8Array> {
  const buffer = new ChunkBuffer();
  let prefix: Bytes | null = null;
  let counter = 0;

  const open = async (sealed: Bytes, last: boolean): Promise<Uint8Array> => {
    if (!prefix) throw new CryptoError('missing header');
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: chunkNonce(prefix, counter++, last),
            additionalData: AAD_FILE,
            tagLength: 128,
          },
          key,
          sealed,
        ),
      );
    } catch {
      throw new CryptoError('decryption failed');
    }
  };

  const readHeader = () => {
    if (prefix || buffer.length < FILE_HEADER_BYTES) return;
    const header = buffer.take(FILE_HEADER_BYTES);
    const magicOk = MAGIC.every((byte, i) => header[i] === byte);
    if (!magicOk || header[4] !== 1 || header[5] !== 16) throw new CryptoError('bad file header');
    prefix = header.slice(9, 16);
  };

  return new TransformStream<Uint8Array, Uint8Array>(
    {
      async transform(chunk, controller) {
        buffer.push(chunk);
        readHeader();
        if (!prefix) return;
        while (buffer.length > FULL_CHUNK) {
          controller.enqueue(await open(buffer.take(FULL_CHUNK), false));
        }
      },
      async flush(controller) {
        readHeader();
        if (!prefix || buffer.length < TAG_BYTES) throw new CryptoError('truncated file');
        controller.enqueue(await open(buffer.take(buffer.length), true));
      },
    },
    undefined,
    outputBuffer(),
  );
}

/** Convenience for the browser: encrypt a Blob/File into an encrypted Blob. */
export function encryptBlob(key: CryptoKey, blob: Blob): Promise<Blob> {
  return new Response(blob.stream().pipeThrough(encryptStream(key))).blob();
}
