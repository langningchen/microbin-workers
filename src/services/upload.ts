/**
 * File upload protocol (all bodies are streamed, nothing is buffered):
 *
 *   POST /api/pastas                      -> creates a *pending* paste + upload token
 *   PUT  .../files/:idx                   -> single request upload (<= 64 MiB)
 *   POST .../files/:idx/multipart         -> R2 multipart upload for bigger files
 *   PUT  .../files/:idx/multipart/:part   -> one 32 MiB part per request
 *   POST .../files/:idx/multipart/complete
 *   POST /api/pastas/:id/complete         -> publishes the paste
 *
 * Splitting big files into parts keeps every request under Cloudflare's 100 MB request body limit.
 */
import type { Config } from '../config';
import {
  deletePastas,
  findAny,
  listFiles,
  markFileUploaded,
  publish,
  setUploadId,
  type FileRow,
  type PastaRow,
} from '../db/pastas';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors';
import { openToken, type TokenPayload } from '../lib/tokens';
import { fromB64Url } from '../shared/base64url';
import { partCount } from '../shared/constants';
import { ciphertextSize, encryptStream, importAesKey } from '../shared/crypto';

type Services = Pick<Env, 'DB' | 'BUCKET'>;

export async function requireUploadToken(
  config: Config,
  id: string,
  header: string | undefined,
  now: number,
): Promise<TokenPayload> {
  const payload = await openToken(config.sessionSecret, 'upload', header, now);
  if (!payload) throw unauthorized('Upload session expired or invalid', 'bad_upload_token');
  if (payload.id !== id)
    throw forbidden('Upload token belongs to another upload', 'bad_upload_token');
  return payload;
}

async function loadPendingFile(
  env: Services,
  id: string,
  idx: number,
): Promise<{ pasta: PastaRow; file: FileRow }> {
  const pasta = await findAny(env.DB, id);
  if (!pasta) throw notFound();
  if (pasta.status !== 'pending')
    throw conflict('This upload is already published', 'already_published');
  const file = (await listFiles(env.DB, id)).find((candidate) => candidate.idx === idx);
  if (!file) throw notFound('No such file in this upload');
  return { pasta, file };
}

/** Single-request upload of one file. */
export async function putFile(
  env: Services,
  config: Config,
  token: TokenPayload,
  id: string,
  idx: number,
  source: { body: ReadableStream<Uint8Array> | null; length: number | null },
): Promise<{ size: number }> {
  const { pasta, file } = await loadPendingFile(env, id, idx);
  if (file.uploaded) throw conflict('File already uploaded', 'already_uploaded');
  if (file.size > config.singlePutMaxBytes) {
    throw badRequest('This file is too large for a single request; use a multipart upload');
  }

  if (source.length === null) throw badRequest('Content-Length header is required');
  if (source.length !== file.size) {
    throw badRequest(
      `Body is ${source.length} bytes but ${file.size} were announced`,
      'size_mismatch',
    );
  }

  const body = source.body ?? new Blob([]).stream();
  let stored: R2Object | null;
  if (pasta.privacy === 'private') {
    // Server-side encryption, streamed straight into R2 with a precomputed length.
    if (!token.k) throw forbidden('Upload token cannot encrypt files', 'bad_upload_token');
    const rawKey = fromB64Url(token.k);
    if (!rawKey) throw forbidden('Upload token is damaged', 'bad_upload_token');
    const key = await importAesKey(rawKey);
    const sealed = new FixedLengthStream(ciphertextSize(file.size));
    const [, object] = await Promise.all([
      body.pipeThrough(encryptStream(key)).pipeTo(sealed.writable),
      env.BUCKET.put(file.r2_key, sealed.readable),
    ]);
    stored = object;
  } else {
    stored = await env.BUCKET.put(file.r2_key, body);
  }

  const expected = pasta.privacy === 'private' ? ciphertextSize(file.size) : file.size;
  if (!stored || stored.size !== expected) {
    await env.BUCKET.delete(file.r2_key);
    throw badRequest('Stored file size does not match the announced size', 'size_mismatch');
  }
  await markFileUploaded(env.DB, id, idx, stored.size);
  return { size: stored.size };
}

export async function startMultipart(
  env: Services,
  config: Config,
  id: string,
  idx: number,
): Promise<{ uploadId: string; partSize: number; parts: number }> {
  const { pasta, file } = await loadPendingFile(env, id, idx);
  if (pasta.privacy === 'private') {
    throw badRequest('Private uploads must be sent in a single request');
  }
  if (file.uploaded) throw conflict('File already uploaded', 'already_uploaded');
  if (file.size <= config.singlePutMaxBytes) {
    throw badRequest('This file is small enough for a single request');
  }
  const info = { partSize: config.partBytes, parts: partCount(file.size, config.partBytes) };
  if (file.upload_id) return { uploadId: file.upload_id, ...info }; // idempotent for retries
  const upload = await env.BUCKET.createMultipartUpload(file.r2_key);
  await setUploadId(env.DB, id, idx, upload.uploadId);
  return { uploadId: upload.uploadId, ...info };
}

export async function putPart(
  env: Services,
  config: Config,
  id: string,
  idx: number,
  partNumber: number,
  source: { body: ReadableStream<Uint8Array> | null; length: number | null },
): Promise<{ partNumber: number; etag: string }> {
  const { file } = await loadPendingFile(env, id, idx);
  if (!file.upload_id) throw conflict('Multipart upload has not been started', 'no_multipart');
  const total = partCount(file.size, config.partBytes);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > total) {
    throw badRequest(`Part number must be between 1 and ${total}`);
  }
  // R2 needs equally sized parts (all but the last), so the length is fully determined.
  const expected =
    partNumber < total ? config.partBytes : file.size - config.partBytes * (total - 1);
  if (source.length !== expected) {
    throw badRequest(`Part ${partNumber} must be exactly ${expected} bytes`, 'size_mismatch');
  }
  const upload = env.BUCKET.resumeMultipartUpload(file.r2_key, file.upload_id);
  const part = await upload.uploadPart(partNumber, source.body ?? new Blob([]).stream());
  return { partNumber: part.partNumber, etag: part.etag };
}

export async function completeMultipart(
  env: Services,
  config: Config,
  id: string,
  idx: number,
  parts: { partNumber: number; etag: string }[],
): Promise<{ size: number }> {
  const { file } = await loadPendingFile(env, id, idx);
  if (!file.upload_id) throw conflict('Multipart upload has not been started', 'no_multipart');
  const total = partCount(file.size, config.partBytes);
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  if (sorted.length !== total || sorted.some((part, i) => part.partNumber !== i + 1)) {
    throw badRequest(`Expected parts 1..${total}`);
  }
  const upload = env.BUCKET.resumeMultipartUpload(file.r2_key, file.upload_id);
  const object = await upload.complete(sorted);
  if (object.size !== file.size) {
    await env.BUCKET.delete(file.r2_key);
    throw badRequest('Assembled file size does not match the announced size', 'size_mismatch');
  }
  await markFileUploaded(env.DB, id, idx, object.size);
  return { size: object.size };
}

export async function completeUpload(env: Services, id: string, now: number): Promise<void> {
  if (!(await publish(env.DB, id, now))) {
    const pasta = await findAny(env.DB, id);
    if (!pasta) throw notFound();
    throw conflict(
      pasta.status === 'active' ? 'Already published' : 'Not all files have been uploaded',
      pasta.status === 'active' ? 'already_published' : 'incomplete',
    );
  }
}

/** Cancels a pending upload; its R2 objects are removed through the outbox. */
export async function abortUpload(env: Services, id: string, now: number): Promise<void> {
  const pasta = await findAny(env.DB, id);
  if (!pasta) return;
  if (pasta.status !== 'pending') throw conflict('Only unfinished uploads can be aborted');
  await deletePastas(env.DB, [id], now);
}
