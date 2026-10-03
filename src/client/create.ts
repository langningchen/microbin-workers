// The "new upload" form: validation, optional client-side encryption and chunked uploads.
import type { CreateBoot } from '../shared/boot';
import { toB64Url } from '../shared/base64url';
import { type Privacy, type SecretManifest, partCount } from '../shared/constants';
import {
  SALT_BYTES,
  ciphertextSize,
  deriveSecrets,
  encryptBlob,
  encryptText,
  importAesKey,
  randomBytes,
  verifierFor,
} from '../shared/crypto';
import { $, ApiError, api, formatBytes, must, readBoot } from './util';

const boot = readBoot<CreateBoot>();
if (!boot) throw new Error('Missing boot data');

interface Created {
  id: string;
  url: string;
  complete: boolean;
  token?: string;
  files: { idx: number; mode: 'single' | 'multipart' }[];
}

const form = must<HTMLFormElement>('#pasta-form');
const content = must<HTMLTextAreaElement>('#content-input');
const submit = must<HTMLButtonElement>('#submit-button');
const status = must('#form-status');
const progress = must<HTMLProgressElement>('#progress');
const fileInput = $<HTMLInputElement>('#file');
const attachText = $('#attach-text');
const fileList = must('#file-list');
const privacySelect = $<HTMLSelectElement>('#privacy');
const passwordBox = $('#password-box');
const password = $<HTMLInputElement>('#password');
const uploaderPassword = $<HTMLInputElement>('#uploader-password');

const PASSWORD_LEVELS: Privacy[] = ['readonly', 'private', 'secret'];
const currentPrivacy = (): Privacy => (privacySelect?.value as Privacy | undefined) ?? 'public';

function setStatus(message: string, isError = false): void {
  status.textContent = message;
  status.className = isError ? 'notice error' : 'muted';
}

// ── choosing files ──────────────────────────────────────────────────────

let files: File[] = [];

function renderFiles(): void {
  fileList.replaceChildren(
    ...files.map((file, index) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${file.name} (${formatBytes(file.size)})`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = 'Remove';
      remove.addEventListener('click', () => {
        files = files.filter((_, i) => i !== index);
        renderFiles();
      });
      item.append(label, remove);
      return item;
    }),
  );
  if (attachText) {
    attachText.textContent =
      files.length === 0 ? 'Select or drop file attachment' : 'Add more files (or drop them here)';
  }
}

function addFiles(incoming: Iterable<File>): void {
  if (boot?.noFileUpload) return;
  for (const file of incoming) {
    const duplicate = files.some(
      (f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified,
    );
    if (!duplicate) files.push(file);
  }
  if (boot && files.length > boot.limits.maxFiles) {
    files = files.slice(0, boot.limits.maxFiles);
    setStatus(`At most ${boot.limits.maxFiles} files per upload.`, true);
  }
  renderFiles();
}

fileInput?.addEventListener('change', () => {
  addFiles(Array.from(fileInput.files ?? []));
  fileInput.value = '';
});
form.addEventListener('dragover', (event) => {
  event.preventDefault();
  form.classList.add('drag');
});
form.addEventListener('dragleave', () => form.classList.remove('drag'));
form.addEventListener('drop', (event) => {
  event.preventDefault();
  form.classList.remove('drag');
  addFiles(Array.from(event.dataTransfer?.files ?? []));
});
document.addEventListener('paste', (event) => {
  const pasted = Array.from(event.clipboardData?.files ?? []);
  if (pasted.length > 0) {
    event.preventDefault();
    addFiles(pasted);
  }
});

function syncPrivacy(): void {
  if (passwordBox) passwordBox.hidden = !PASSWORD_LEVELS.includes(currentPrivacy());
}
privacySelect?.addEventListener('change', syncPrivacy);
syncPrivacy();

// ── uploading ───────────────────────────────────────────────────────────

class Meter {
  private done = 0;
  private readonly inflight = new Map<string, number>();
  constructor(private readonly total: number) {}

  update(key: string, loaded: number): void {
    this.inflight.set(key, loaded);
    this.render();
  }
  finish(key: string, size: number): void {
    this.inflight.delete(key);
    this.done += size;
    this.render();
  }
  private render(): void {
    const sent = this.done + [...this.inflight.values()].reduce((a, b) => a + b, 0);
    const percent = this.total === 0 ? 100 : Math.min(100, Math.floor((sent / this.total) * 100));
    progress.hidden = false;
    progress.value = percent;
    setStatus(`Uploading… ${percent}% (${formatBytes(sent)} of ${formatBytes(this.total)})`);
  }
}

function xhrPut<T>(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress: (loaded: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onerror = () => reject(new ApiError('Network error', 0, 'network'));
    xhr.onload = () => {
      let parsed: { error?: { code?: string; message?: string } } = {};
      try {
        parsed = JSON.parse(xhr.responseText || '{}') as typeof parsed;
      } catch {
        /* keep empty */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as T);
      else {
        reject(
          new ApiError(
            parsed.error?.message ?? `Upload failed (${xhr.status})`,
            xhr.status,
            parsed.error?.code ?? 'error',
          ),
        );
      }
    };
    xhr.send(body);
  });
}

/** Retries network hiccups and 5xx answers with exponential backoff; client errors fail fast. */
async function withRetry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retryable = error instanceof ApiError && (error.status === 0 || error.status >= 500);
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
}

async function uploadFile(
  created: Created,
  idx: number,
  mode: 'single' | 'multipart',
  blob: Blob,
  meter: Meter,
): Promise<void> {
  const base = `/api/pastas/${created.id}/files/${idx}`;
  const headers = { 'x-upload-token': created.token ?? '' };

  if (mode === 'single') {
    const key = `${idx}`;
    await withRetry(() => xhrPut(base, blob, headers, (loaded) => meter.update(key, loaded)));
    meter.finish(key, blob.size);
    return;
  }

  const started = await api<{ uploadId: string; partSize: number; parts: number }>(
    'POST',
    `${base}/multipart`,
    { headers },
  );
  const total = partCount(blob.size, started.partSize);
  const parts: { partNumber: number; etag: string }[] = [];
  let next = 1;

  const worker = async (): Promise<void> => {
    for (let n = next++; n <= total; n = next++) {
      const slice = blob.slice(
        (n - 1) * started.partSize,
        Math.min(blob.size, n * started.partSize),
      );
      const key = `${idx}:${n}`;
      const part = await withRetry(() =>
        xhrPut<{ partNumber: number; etag: string }>(
          `${base}/multipart/${n}`,
          slice,
          headers,
          (loaded) => meter.update(key, loaded),
        ),
      );
      meter.finish(key, slice.size);
      parts.push({ partNumber: part.partNumber, etag: part.etag });
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
  await withRetry(() => api('POST', `${base}/multipart/complete`, { headers, json: { parts } }));
}

// ── submitting ──────────────────────────────────────────────────────────

let busy = false;
window.addEventListener('beforeunload', (event) => {
  if (busy) event.preventDefault();
});

function setBusy(value: boolean): void {
  busy = value;
  submit.disabled = value;
  submit.textContent = value ? 'Working…' : 'Save';
}

function fileLimit(privacy: Privacy): number {
  if (!boot) return 0;
  if (privacy === 'private') return boot.limits.private;
  return privacy === 'secret' ? boot.limits.secret : boot.limits.unencrypted;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!busy) void handleSubmit();
});

async function handleSubmit(): Promise<void> {
  if (!boot) return;
  const privacy = currentPrivacy();
  const text = content.value;
  setStatus('');
  progress.hidden = true;

  if (text.trim() === '' && files.length === 0) {
    content.focus();
    return setStatus('Type something or attach a file first.', true);
  }
  if (new TextEncoder().encode(text).length > boot.limits.maxTextBytes) {
    return setStatus(`The text is larger than ${formatBytes(boot.limits.maxTextBytes)}.`, true);
  }
  const tooBig = files.find((file) => file.size > fileLimit(privacy));
  if (tooBig) {
    return setStatus(
      `${tooBig.name} is larger than the ${formatBytes(fileLimit(privacy))} limit for ${privacy} uploads.`,
      true,
    );
  }
  const needsPassword = PASSWORD_LEVELS.includes(privacy);
  if (needsPassword && !password?.value) {
    password?.focus();
    return setStatus('Please choose a password for this privacy level.', true);
  }
  if (privacy === 'secret' && !globalThis.isSecureContext) {
    return setStatus('Secret uploads need a secure (HTTPS) connection.', true);
  }

  setBusy(true);
  let created: Created | undefined;
  try {
    const request: Record<string, unknown> = {
      expiration: must<HTMLSelectElement>('#expiration').value,
      burnAfter: Number($<HTMLSelectElement>('#burn_after')?.value ?? 0),
      syntax: $<HTMLSelectElement>('#syntax')?.value ?? 'none',
      privacy,
    };
    if (uploaderPassword?.value) request.uploaderPassword = uploaderPassword.value;

    let encryptionKey: CryptoKey | undefined;
    if (privacy === 'secret' && password) {
      setStatus('Deriving the encryption key…');
      await new Promise((resolve) => setTimeout(resolve, 20)); // let the message paint
      const salt = randomBytes(SALT_BYTES);
      const secrets = await deriveSecrets(password.value, salt, boot.kdfIterations);
      encryptionKey = await importAesKey(secrets.encKey);
      const manifest: SecretManifest = {
        v: 1,
        text,
        files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
      };
      request.content = await encryptText(encryptionKey, JSON.stringify(manifest));
      request.kdf = {
        salt: toB64Url(salt),
        iter: boot.kdfIterations,
        verifier: await verifierFor(secrets.authKey),
      };
      request.files = files.map((f) => ({ name: '', size: ciphertextSize(f.size) }));
    } else {
      request.content = text;
      if (needsPassword && password) request.password = password.value;
      request.files = files.map((f) => ({ name: f.name, size: f.size }));
    }

    setStatus('Creating…');
    created = await api<Created>('POST', '/api/pastas', { json: request });

    if (!created.complete) {
      const sizes = (request.files as { size: number }[]).map((f) => f.size);
      const meter = new Meter(sizes.reduce((a, b) => a + b, 0));
      for (const target of created.files) {
        const original = files[target.idx];
        if (!original) throw new Error('Internal error: file index mismatch');
        if (encryptionKey) setStatus(`Encrypting ${original.name}…`);
        const blob = encryptionKey ? await encryptBlob(encryptionKey, original) : original;
        await uploadFile(created, target.idx, target.mode, blob, meter);
      }
      setStatus('Finishing…');
      await withRetry(() =>
        api('POST', `/api/pastas/${created?.id}/complete`, {
          headers: { 'x-upload-token': created?.token ?? '' },
        }),
      );
    }
    busy = false; // allow the navigation without the "unsaved work" prompt
    location.href = `${created.url}?new=1`;
  } catch (error) {
    if (created && !created.complete) {
      // Best effort: drop the half-finished upload; the server also sweeps it after 24 hours.
      void fetch(`/api/pastas/${created.id}/abort`, {
        method: 'POST',
        headers: { 'x-upload-token': created.token ?? '' },
      }).catch(() => undefined);
    }
    progress.hidden = true;
    setBusy(false);
    if (error instanceof ApiError && error.code === 'incorrect_uploader_password') {
      uploaderPassword?.focus();
    }
    setStatus(error instanceof Error ? error.message : 'Upload failed', true);
  }
}
