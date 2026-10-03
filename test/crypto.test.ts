import { describe, expect, it } from 'vitest';
import { fromB64Url, toB64Url } from '../src/shared/base64url';
import {
  CHUNK_SIZE,
  ciphertextSize,
  CryptoError,
  decryptStream,
  decryptText,
  deriveSecrets,
  encryptStream,
  encryptText,
  importAesKey,
  KDF_SERVER_MAX_ITERATIONS,
  plaintextSize,
  randomBytes,
  verifierFor,
  type Bytes,
} from '../src/shared/crypto';

const ITER = 1000; // fast; the real value only changes the cost of PBKDF2

async function testKey(password = 'correct horse', salt: Bytes = new Uint8Array(16)) {
  const secrets = await deriveSecrets(password, salt, ITER);
  return { secrets, key: await importAesKey(secrets.encKey) };
}

function streamOf(bytes: Uint8Array, piece: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + piece));
      offset += piece;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function pattern(length: number): Bytes {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

async function encryptAll(key: CryptoKey, plain: Uint8Array, piece = 10_000): Promise<Uint8Array> {
  return collect(streamOf(plain, piece).pipeThrough(encryptStream(key)));
}

async function decryptAll(key: CryptoKey, cipher: Uint8Array, piece = 10_000): Promise<Uint8Array> {
  return collect(streamOf(cipher, piece).pipeThrough(decryptStream(key)));
}

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding', () => {
    for (const length of [0, 1, 2, 3, 4, 31, 32, 33, 1000, 70_000]) {
      const bytes = randomBytes(length);
      const encoded = toB64Url(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(fromB64Url(encoded)).toEqual(bytes);
    }
  });

  it('rejects invalid input instead of throwing', () => {
    expect(fromB64Url('abc$')).toBeNull();
    expect(fromB64Url('a')).toBeNull(); // length % 4 === 1 can never be valid
    expect(fromB64Url('ab==')).toBeNull(); // padding is not accepted
  });
});

describe('key derivation', () => {
  it('is deterministic and separates the encryption and auth keys', async () => {
    const salt = randomBytes(16);
    const a = await deriveSecrets('pw', salt, ITER);
    const b = await deriveSecrets('pw', salt, ITER);
    expect(a.encKey).toEqual(b.encKey);
    expect(a.authKey).toEqual(b.authKey);
    expect(a.encKey).not.toEqual(a.authKey);
    expect(a.encKey).toHaveLength(32);
    expect(a.authKey).toHaveLength(32);
  });

  it('depends on password, salt and iteration count', async () => {
    const salt = new Uint8Array(16);
    const base = await deriveSecrets('pw', salt, ITER);
    expect((await deriveSecrets('pw2', salt, ITER)).authKey).not.toEqual(base.authKey);
    expect((await deriveSecrets('pw', randomBytes(16), ITER)).authKey).not.toEqual(base.authKey);
    expect((await deriveSecrets('pw', salt, ITER + 1)).authKey).not.toEqual(base.authKey);
  });

  it('normalises passwords (NFKC) so different keyboards agree', async () => {
    const salt = new Uint8Array(16);
    const composed = await deriveSecrets('caf\u00e9', salt, ITER);
    const decomposed = await deriveSecrets('cafe\u0301', salt, ITER);
    expect(composed.authKey).toEqual(decomposed.authKey);
  });

  it('produces a stable verifier that does not reveal the keys', async () => {
    const { secrets } = await testKey();
    const verifier = await verifierFor(secrets.authKey);
    expect(verifier).toBe(await verifierFor(secrets.authKey));
    expect(verifier).toHaveLength(43); // 32 bytes, base64url
    expect(verifier).not.toBe(toB64Url(secrets.authKey));
  });

  it('keeps the server-side PBKDF2 ceiling at the Workers production limit', () => {
    // Local workerd accepts more, production rejects it with NotSupportedError.
    expect(KDF_SERVER_MAX_ITERATIONS).toBe(100_000);
  });
});

describe('text envelopes', () => {
  it('round-trips text including unicode and the empty string', async () => {
    const { key } = await testKey();
    for (const text of [
      '',
      'hello',
      '日本語のテキスト 🔐',
      'a'.repeat(200_000),
      'line1\r\nline2\n',
    ]) {
      expect(await decryptText(key, await encryptText(key, text))).toBe(text);
    }
  });

  it('uses a fresh IV every time', async () => {
    const { key } = await testKey();
    expect(await encryptText(key, 'same')).not.toBe(await encryptText(key, 'same'));
  });

  it('fails with the wrong key or after tampering', async () => {
    const { key } = await testKey('right');
    const { key: wrong } = await testKey('wrong');
    const envelope = await encryptText(key, 'secret');
    await expect(decryptText(wrong, envelope)).rejects.toThrow(CryptoError);

    const flipped = envelope.slice(0, -2) + (envelope.endsWith('AA') ? 'BB' : 'AA');
    await expect(decryptText(key, flipped)).rejects.toThrow(CryptoError);
    await expect(decryptText(key, 'mbx1.')).rejects.toThrow(CryptoError);
    await expect(decryptText(key, 'plain text')).rejects.toThrow(CryptoError);
  });
});

describe('file stream encryption', () => {
  const sizes = [
    0,
    1,
    15,
    16,
    CHUNK_SIZE - 1,
    CHUNK_SIZE,
    CHUNK_SIZE + 1,
    2 * CHUNK_SIZE,
    3 * CHUNK_SIZE + 123,
  ];

  it.each(sizes)('round-trips %i bytes and matches the size formulas', async (size) => {
    const { key } = await testKey();
    const plain = pattern(size);
    const cipher = await encryptAll(key, plain, 7_777);
    expect(cipher.length).toBe(ciphertextSize(size));
    expect(plaintextSize(cipher.length)).toBe(size);
    expect(await decryptAll(key, cipher, 5_003)).toEqual(plain);
  });

  it('does not depend on how the input is chunked', async () => {
    const { key } = await testKey();
    const plain = pattern(CHUNK_SIZE * 2 + 5);
    for (const piece of [1000, CHUNK_SIZE, CHUNK_SIZE * 3]) {
      const cipher = await encryptAll(key, plain, piece);
      for (const readPiece of [997, CHUNK_SIZE + 16, cipher.length]) {
        expect(await decryptAll(key, cipher, readPiece)).toEqual(plain);
      }
    }
  });

  it('handles a header and chunks that arrive split into single bytes', async () => {
    const { key } = await testKey();
    const plain = pattern(40);
    const cipher = await encryptAll(key, plain, 1);
    expect(await decryptAll(key, cipher, 1)).toEqual(plain);
  });

  it('uses a random nonce prefix per file', async () => {
    const { key } = await testKey();
    const plain = pattern(100);
    const a = await encryptAll(key, plain);
    const b = await encryptAll(key, plain);
    expect(a).not.toEqual(b);
  });

  it('rejects the wrong key', async () => {
    const { key } = await testKey('one');
    const { key: other } = await testKey('two');
    const cipher = await encryptAll(key, pattern(5000));
    await expect(decryptAll(other, cipher)).rejects.toThrow();
  });

  it('detects a modified byte in any chunk', async () => {
    const { key } = await testKey();
    const cipher = await encryptAll(key, pattern(CHUNK_SIZE * 3));
    for (const position of [20, CHUNK_SIZE + 100, cipher.length - 3]) {
      const tampered = cipher.slice();
      tampered[position] = tampered[position]! ^ 0x01;
      await expect(decryptAll(key, tampered)).rejects.toThrow();
    }
  });

  it('detects truncation, even at a chunk boundary', async () => {
    const { key } = await testKey();
    const cipher = await encryptAll(key, pattern(CHUNK_SIZE * 3 + 10));
    const full = CHUNK_SIZE + 16;
    // drop the final (short) chunk → remaining last chunk was not sealed as "last"
    await expect(decryptAll(key, cipher.slice(0, 16 + 3 * full))).rejects.toThrow();
    // cut in the middle of a chunk
    await expect(decryptAll(key, cipher.slice(0, 16 + full + 500))).rejects.toThrow();
    // header only / partial header / nothing at all
    await expect(decryptAll(key, cipher.slice(0, 16))).rejects.toThrow();
    await expect(decryptAll(key, cipher.slice(0, 8))).rejects.toThrow();
    await expect(decryptAll(key, new Uint8Array(0))).rejects.toThrow();
  });

  it('detects reordered chunks and trailing garbage', async () => {
    const { key } = await testKey();
    const cipher = await encryptAll(key, pattern(CHUNK_SIZE * 3 + 10));
    const full = CHUNK_SIZE + 16;
    const header = cipher.slice(0, 16);
    const c0 = cipher.slice(16, 16 + full);
    const c1 = cipher.slice(16 + full, 16 + 2 * full);
    const rest = cipher.slice(16 + 2 * full);
    const swapped = new Uint8Array([...header, ...c1, ...c0, ...rest]);
    await expect(decryptAll(key, swapped)).rejects.toThrow();
    await expect(decryptAll(key, new Uint8Array([...cipher, 1, 2, 3]))).rejects.toThrow();
  });

  it('rejects data that is not an MBX1 file', async () => {
    const { key } = await testKey();
    await expect(decryptAll(key, pattern(1000))).rejects.toThrow();
  });

  it('plaintextSize rejects impossible ciphertext sizes', () => {
    expect(plaintextSize(0)).toBeNull();
    expect(plaintextSize(16)).toBeNull();
    expect(plaintextSize(31)).toBeNull();
    expect(plaintextSize(32)).toBe(0);
    expect(plaintextSize(ciphertextSize(CHUNK_SIZE) + 1)).toBeNull();
  });
});
