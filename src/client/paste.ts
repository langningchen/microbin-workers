// The upload page: copy buttons, file views, syntax highlighting and the in-browser decryption
// of "secret" uploads (the password and the plaintext never leave the browser).
import { fromB64Url, toB64Url } from '../shared/base64url';
import type { PasteBoot } from '../shared/boot';
import type { SecretManifest } from '../shared/constants';
import { decryptStream, decryptText, deriveSecrets, importAesKey } from '../shared/crypto';
import { uniqueNames, extensionOf } from '../shared/filenames';
import { $, copyText, formatBytes, must, readBoot, saveBlob, shareBase } from './util';

const boot = readBoot<PasteBoot>();
if (boot) init(boot);

function init(boot: PasteBoot): void {
  // "?new=1" only tells the server not to count the creator's first view: drop it from the
  // address bar so that reloads and copied links behave like everybody else's.
  const url = new URL(location.href);
  if (url.searchParams.has('new')) {
    url.searchParams.delete('new');
    history.replaceState(null, '', url);
  }

  // ── copy buttons ──
  const copy = (selector: string, text: () => string) => {
    const button = $(selector);
    button?.addEventListener('click', () => void copyText(text(), button));
  };
  copy('#copy-url-button', () => `${shareBase()}/p/${boot.id}`);
  copy('#copy-redirect-button', () => `${shareBase()}/u/${boot.id}`);
  copy('#copy-text-button', readCode);
  const shareLink = $('#share-link');
  if (shareLink) shareLink.textContent = `${shareBase()}/p/${boot.id}`;

  // ── gallery / stream / list ──
  const selector = $<HTMLSelectElement>('#view-selector');
  if (selector) {
    const wanted = new URLSearchParams(location.search).get('view') ?? boot.view;
    selector.value = ['gallery', 'stream', 'list'].includes(wanted) ? wanted : 'gallery';
    applyView(selector.value);
    selector.addEventListener('change', () => {
      const url = new URL(location.href);
      url.searchParams.set('view', selector.value);
      history.replaceState(null, '', url);
      applyView(selector.value);
    });
  }

  // ── text ──
  const code = $('#code');
  if (code && boot.mode !== 'secret') {
    void highlight(code, readCode(), boot.syntax);
  }

  // The remove page shares this script but has no unlock form.
  if (boot.mode === 'secret' && boot.secret && $('#unlock-form')) {
    setupSecretView(boot, boot.secret);
  }
  setupSecretRemoval(boot);
}

function applyView(mode: string): void {
  const gallery = $('#gallery-view');
  const list = $('#list-view');
  if (!gallery || !list) return;
  gallery.classList.remove('stream-view', 'view-stream', 'view-gallery', 'view-list');
  gallery.hidden = mode === 'list';
  list.hidden = mode !== 'list';
  if (mode === 'stream') gallery.classList.add('stream-view');
}

// ── code rendering ──────────────────────────────────────────────────────

function readCode(): string {
  const code = $('#code');
  return code
    ? [...code.querySelectorAll('.line')].map((line) => line.textContent ?? '').join('\n')
    : '';
}

function trimTrailingEmpty<T>(lines: T[], isEmpty: (line: T) => boolean): T[] {
  const last = lines[lines.length - 1];
  return lines.length > 1 && last !== undefined && isEmpty(last) ? lines.slice(0, -1) : lines;
}

function renderLines(code: HTMLElement, lines: string[], html: boolean): void {
  code.replaceChildren(
    ...lines.map((line) => {
      const element = document.createElement('span');
      element.className = 'line';
      if (html)
        element.innerHTML = line; // highlight.js output: escaped text in <span class="hljs-*">
      else element.textContent = line;
      return element;
    }),
  );
}

function showText(code: HTMLElement, text: string, syntax: string): void {
  renderLines(
    code,
    trimTrailingEmpty(text.split(/\r\n|\r|\n/), (line) => line === ''),
    false,
  );
  void highlight(code, text, syntax);
}

async function highlight(code: HTMLElement, text: string, syntax: string): Promise<void> {
  if (syntax === 'none' || text === '') return;
  const { highlightLines } = await import('./highlight');
  const lines = highlightLines(text, syntax);
  if (lines)
    renderLines(
      code,
      trimTrailingEmpty(lines, (line) => line === ''),
      true,
    );
}

// ── secret uploads ──────────────────────────────────────────────────────

class UserError extends Error {}

interface Unlocked {
  id: string;
  key: CryptoKey;
  /** Proves to the file endpoint that this browser unlocked the upload. */
  token: string;
}

const fileUrl = (unlocked: Unlocked, idx: number): string =>
  `/file/${unlocked.id}/${idx}?t=${encodeURIComponent(unlocked.token)}`;

async function fetchPlain(unlocked: Unlocked, idx: number, type: string): Promise<Blob> {
  const response = await fetch(fileUrl(unlocked, idx), { credentials: 'same-origin' });
  if (!response.ok || !response.body) throw new UserError(`Download failed (${response.status})`);
  return new Response(response.body.pipeThrough(decryptStream(unlocked.key)), {
    headers: { 'content-type': type || 'application/octet-stream' },
  }).blob();
}

function setupSecretView(boot: PasteBoot, secret: NonNullable<PasteBoot['secret']>): void {
  const form = must<HTMLFormElement>('#unlock-form');
  const input = must<HTMLInputElement>('#password-field');
  const button = must<HTMLButtonElement>('#unlock-button');
  const message = must('#unlock-status');

  const fail = (text: string) => {
    message.textContent = text;
    message.hidden = false;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      message.hidden = true;
      button.disabled = true;
      button.textContent = 'Deriving key…';
      try {
        await new Promise((resolve) => setTimeout(resolve, 20)); // let the label paint
        const salt = fromB64Url(secret.salt);
        if (!salt) throw new UserError('This upload has damaged encryption parameters.');
        const keys = await deriveSecrets(input.value, salt, secret.iter);
        const authKey = toB64Url(keys.authKey);
        const response = await fetch(`/api/pastas/${boot.id}`, {
          headers: { 'x-auth-key': authKey },
          credentials: 'same-origin',
        });
        if (response.status === 401) throw new UserError('Incorrect password.');
        if (response.status === 404) {
          throw new UserError('This upload no longer exists (it expired or was already read).');
        }
        if (!response.ok) throw new UserError(`Server error (${response.status})`);
        if (response.status === 429)
          throw new UserError('Too many attempts, please wait a minute.');
        const data = (await response.json()) as { content: string; token?: string };
        const key = await importAesKey(keys.encKey);
        const manifest = JSON.parse(await decryptText(key, data.content)) as SecretManifest;
        if (manifest.v !== 1) throw new UserError('Unsupported upload format.');
        await showSecret(boot, manifest, { id: boot.id, key, token: data.token ?? '' });
      } catch (error) {
        fail(error instanceof UserError ? error.message : 'Could not decrypt this upload.');
        button.disabled = false;
        button.textContent = 'Decrypt';
      }
    })();
  });
}

const PREVIEW_IMAGE_LIMIT = 15 * 1024 * 1024;
const PREVIEW_MEDIA_LIMIT = 200 * 1024 * 1024;

async function showSecret(
  boot: PasteBoot,
  manifest: SecretManifest,
  unlocked: Unlocked,
): Promise<void> {
  must('#decryption').hidden = true;
  must('#secret-view').hidden = false;

  if (manifest.text !== '') {
    must('#secret-text').hidden = false;
    must('#copy-text-button').hidden = false;
    showText(must('#code'), manifest.text, boot.syntax);
  }
  if (manifest.files.length === 0) return;

  const names = uniqueNames(manifest.files.map((file) => file.name));
  const gallery = document.createElement('div');
  gallery.id = 'gallery-view';
  gallery.className = 'gallery-grid';
  const list = document.createElement('div');
  list.id = 'list-view';
  list.hidden = true;
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Filename</th><th>Size</th><th>Action</th></tr></thead>';
  const body = document.createElement('tbody');
  table.append(body);
  list.append(table);

  const previews: (() => Promise<void>)[] = [];

  manifest.files.forEach((file, idx) => {
    const download = async (trigger: HTMLElement) => {
      const original = trigger.textContent;
      trigger.textContent = 'Decrypting…';
      try {
        saveBlob(await fetchPlain(unlocked, idx, file.type), file.name);
      } catch (error) {
        alert(error instanceof Error ? error.message : 'Download failed');
      } finally {
        trigger.textContent = original;
      }
    };
    const downloadButton = () => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'small-button';
      element.textContent = 'Download';
      element.addEventListener('click', () => void download(element));
      return element;
    };

    // gallery card
    const card = document.createElement('div');
    card.className = 'file-card';
    const media = document.createElement('div');
    media.className = 'embed-media placeholder';
    media.textContent = (extensionOf(file.name) || 'file').slice(0, 5).toUpperCase();
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const label = document.createElement('div');
    label.className = 'file-name';
    const nameElement = document.createElement('small');
    nameElement.textContent = names[idx] ?? file.name;
    nameElement.title = file.name;
    const sizeElement = document.createElement('small');
    sizeElement.className = 'muted';
    sizeElement.textContent = formatBytes(file.size);
    label.append(nameElement, sizeElement);
    meta.append(label, downloadButton());
    card.append(media, meta);
    gallery.append(card);

    const kind = file.type.split('/')[0];
    if (kind === 'image' && file.size <= PREVIEW_IMAGE_LIMIT) {
      previews.push(async () => {
        const image = document.createElement('img');
        image.className = 'embed-media';
        image.alt = file.name;
        image.src = URL.createObjectURL(await fetchPlain(unlocked, idx, file.type));
        media.replaceWith(image);
      });
    } else if ((kind === 'video' || kind === 'audio') && file.size <= PREVIEW_MEDIA_LIMIT) {
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'small-button';
      play.textContent = `Load ${kind}`;
      play.addEventListener('click', () => {
        void (async () => {
          play.textContent = 'Decrypting…';
          const player = document.createElement(kind);
          player.className = 'embed-media';
          player.controls = true;
          player.src = URL.createObjectURL(await fetchPlain(unlocked, idx, file.type));
          media.replaceWith(player);
        })();
      });
      media.replaceChildren(play);
    }

    // list row
    const row = document.createElement('tr');
    for (const text of [names[idx] ?? file.name, formatBytes(file.size)]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    const action = document.createElement('td');
    action.append(downloadButton());
    row.append(action);
    body.append(row);
  });

  must('#secret-files').append(gallery, list);
  applyView($<HTMLSelectElement>('#view-selector')?.value ?? boot.view);

  const all = $<HTMLButtonElement>('#download-all-button');
  if (all) {
    all.hidden = false;
    all.addEventListener('click', () => {
      void (async () => {
        const original = all.textContent;
        all.disabled = true;
        all.textContent = 'Building ZIP…';
        try {
          const { makeZip } = await import('client-zip');
          const entries = async function* () {
            for (const [idx, file] of manifest.files.entries()) {
              const response = await fetch(fileUrl(unlocked, idx));
              if (!response.ok || !response.body) throw new UserError('Download failed');
              yield {
                name: names[idx] ?? file.name,
                lastModified: new Date(),
                input: response.body.pipeThrough(decryptStream(unlocked.key)),
              };
            }
          };
          saveBlob(await new Response(makeZip(entries())).blob(), `${boot.id}.zip`);
        } catch (error) {
          alert(error instanceof Error ? error.message : 'Could not build the ZIP');
        } finally {
          all.disabled = false;
          all.textContent = original;
        }
      })();
    });
  }

  // Previews load one after another to keep memory bounded.
  for (const preview of previews) {
    try {
      await preview();
    } catch {
      /* the download button still works */
    }
  }
}

// ── removing a secret upload ────────────────────────────────────────────

function setupSecretRemoval(boot: PasteBoot): void {
  const form = $<HTMLFormElement>('#secret-remove-form');
  const secret = boot.secret;
  if (!form || !secret) return;
  const input = must<HTMLInputElement>('#password-field', form);
  const message = must('#remove-status');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      message.hidden = true;
      try {
        const salt = fromB64Url(secret.salt);
        if (!salt) throw new UserError('Damaged encryption parameters.');
        const keys = await deriveSecrets(input.value, salt, secret.iter);
        const response = await fetch(`/api/pastas/${boot.id}/remove`, {
          method: 'POST',
          headers: { 'x-auth-key': toB64Url(keys.authKey) },
          credentials: 'same-origin',
        });
        if (response.status === 401) throw new UserError('Incorrect password.');
        if (!response.ok) throw new UserError(`Could not remove the upload (${response.status}).`);
        location.href = '/list';
      } catch (error) {
        message.textContent = error instanceof UserError ? error.message : 'Something went wrong.';
        message.hidden = false;
      }
    })();
  });
}
