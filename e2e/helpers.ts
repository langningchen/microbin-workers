import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

export interface CreateOptions {
  text?: string;
  privacy?: 'public' | 'unlisted' | 'readonly' | 'private' | 'secret';
  password?: string;
  expiration?: string;
  burn?: string;
  syntax?: string;
  files?: { name: string; mimeType: string; buffer: Buffer }[];
}

/** Fills in the create form like a person would and returns the id of the new upload. */
export async function createUpload(page: Page, options: CreateOptions = {}): Promise<string> {
  await page.goto('/');
  if (options.text !== undefined) await page.fill('#content-input', options.text);
  if (options.expiration) await page.selectOption('#expiration', options.expiration);
  if (options.burn) await page.selectOption('#burn_after', options.burn);
  if (options.syntax) await page.selectOption('#syntax', options.syntax);
  if (options.privacy) await page.selectOption('#privacy', options.privacy);
  if (options.password) await page.fill('#password', options.password);
  if (options.files) {
    // Playwright refuses in-memory buffers above 50 MB: hand big files over as real files.
    const prepared = await Promise.all(
      options.files.map(async (file) => {
        if (file.buffer.length < 40 * 1024 * 1024) return file;
        const path = join(await mkdtemp(join(tmpdir(), 'microbin-e2e-')), file.name);
        await writeFile(path, file.buffer);
        return path;
      }),
    );
    const allPaths = prepared.every((entry) => typeof entry === 'string');
    await page.setInputFiles('#file', allPaths ? (prepared as string[]) : (prepared as never));
  }
  await page.click('#submit-button');
  await page.waitForURL(/\/upload\/[^/?]+/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split('/')[2];
  expect(id).toBeTruthy();
  return id!;
}

export const sha256 = (data: Buffer | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

/** Deterministic pseudo-random bytes, so failures are reproducible. */
export function randomBuffer(length: number, seed = 1): Buffer {
  const out = Buffer.allocUnsafe(length);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** A valid 1x1 PNG, so browsers can really render the preview. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Saves a full-page screenshot for manual review when E2E_SHOTS=1 (never fails a test). */
export async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.E2E_SHOTS) return;
  await page
    .screenshot({ path: `test-results/shots/${name}.png`, fullPage: true })
    .catch(() => undefined);
}
