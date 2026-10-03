import { expect, test } from '@playwright/test';
import { PNG_1X1, createUpload, randomBuffer, sha256, shot } from './helpers';

test.describe('text uploads', () => {
  test('create page renders, a text upload round-trips and shows line numbers', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('#pasta-form')).toBeVisible();
    await expect(page.locator('#expiration')).toHaveValue('24hour');
    await expect(page.locator('#password-box')).toBeHidden();
    await shot(page, 'create');

    const id = await createUpload(page, {
      text: 'first line\nsecond line <b>not bold</b>\n\nfourth',
    });
    await expect(page.locator('#code .line')).toHaveCount(4);
    await expect(page.locator('#code')).toContainText('second line <b>not bold</b>');
    await expect(page.locator('#code b')).toHaveCount(0); // escaped, never interpreted
    await expect(page.locator('#copy-url-button')).toBeVisible();
    await shot(page, 'upload');

    // the creator's redirect does not count as a read, the next visit does
    await expect(page.locator('.status')).toContainText('Read 0 times');
    await page.reload();
    await expect(page.locator('.status')).toContainText('Read 1 time,');
    const raw = await page.request.get(`/raw/${id}`);
    expect(await raw.text()).toBe('first line\nsecond line <b>not bold</b>\n\nfourth');
  });

  test('highlights code in the browser, including multi-line constructs', async ({ page }) => {
    await createUpload(page, {
      syntax: 'python',
      text: 'def hello(name):\n    """a docstring\n    spanning lines"""\n    return f"hi {name}"  # comment\n',
    });
    await expect(page.locator('#code .hljs-keyword').first()).toBeVisible();
    await expect(page.locator('#code .line')).toHaveCount(4);
    // the multi-line string is re-opened on every line it spans
    await expect(page.locator('#code .line').nth(2).locator('.hljs-string')).toBeVisible();
    await expect(page.locator('#code .hljs-comment')).toContainText('# comment');
    await shot(page, 'highlight');
  });

  test('copy buttons put the right text on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const id = await createUpload(page, { text: 'copy me\nplease' });
    await page.click('#copy-text-button');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('copy me\nplease');
    await page.click('#copy-url-button');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${new URL(page.url()).origin}/p/${id}`,
    );
  });

  test('turns a lone URL into a short link that redirects', async ({ page }) => {
    const id = await createUpload(page, { text: 'https://example.com/landing?x=1' });
    await expect(page.getByText('Follow this short link')).toBeVisible();
    const response = await page.request.get(`/u/${id}`, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers().location).toBe('https://example.com/landing?x=1');
  });

  test('validates the form before talking to the server', async ({ page }) => {
    await page.goto('/');
    await page.click('#submit-button');
    await expect(page.locator('#form-status')).toContainText('Type something');
    await page.fill('#content-input', 'x');
    await page.selectOption('#privacy', 'private');
    await expect(page.locator('#password-box')).toBeVisible();
    await page.click('#submit-button');
    await expect(page.locator('#form-status')).toContainText('choose a password');
  });
});

test.describe('files', () => {
  test('several files: gallery, list view, previews and a ZIP of everything', async ({ page }) => {
    const photo = PNG_1X1;
    const notes = Buffer.from('notes for the trip\n');
    const data = randomBuffer(200_000, 5);
    const id = await createUpload(page, {
      text: 'holiday',
      files: [
        { name: 'photo.png', mimeType: 'image/png', buffer: photo },
        { name: 'notes.txt', mimeType: 'text/plain', buffer: notes },
        { name: 'data.bin', mimeType: 'application/octet-stream', buffer: data },
      ],
    });
    await expect(page.locator('.file-card')).toHaveCount(3);
    await expect(page.locator('.file-card img.embed-media')).toHaveCount(1);
    await expect(page.locator('.file-card img.embed-media')).toHaveJSProperty('complete', true);
    expect(
      await page.locator('.file-card img').evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBe(1);
    await shot(page, 'gallery');

    await page.selectOption('#view-selector', 'list');
    await expect(page.locator('#list-view')).toBeVisible();
    await expect(page.locator('#gallery-view')).toBeHidden();
    expect(page.url()).toContain('view=list');
    await page.selectOption('#view-selector', 'stream');
    await expect(page.locator('#gallery-view')).toHaveClass(/stream-view/);

    const download = page.waitForEvent('download');
    await page
      .locator('.file-card', { hasText: 'data.bin' })
      .getByRole('link', { name: 'Download' })
      .click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('data.bin');
    const path = await file.path();
    expect(path).toBeTruthy();

    const zip = await page.request.get(`/archive/${id}`);
    expect(zip.status()).toBe(200);
    expect((await zip.body()).length).toBeGreaterThan(data.length);
    const bytes = await (await page.request.get(`/file/${id}/2`)).body();
    expect(sha256(bytes)).toBe(sha256(data));
  });

  test('a file above the single-request limit is uploaded in parts and arrives intact', async ({
    page,
  }) => {
    // the e2e server splits at 5 MB (see playwright.config.ts): three parts of 5 + 5 + 2 MB
    const big = randomBuffer(12 * 1024 * 1024 + 321, 9);
    const partSize = 5 * 1024 * 1024;
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT') requests.push(new URL(request.url()).pathname);
    });
    const id = await createUpload(page, {
      text: 'big one',
      files: [{ name: 'big.bin', mimeType: 'application/octet-stream', buffer: big }],
    });
    expect(requests.filter((path) => path.includes('/multipart/'))).toHaveLength(3);

    const body = await (await page.request.get(`/file/${id}/0`)).body();
    expect(body.length).toBe(big.length);
    expect(sha256(body)).toBe(sha256(big));
    // a range straddling the boundary between two parts
    const ranged = await page.request.get(`/file/${id}/0`, {
      headers: { range: `bytes=${partSize - 5}-${partSize + 4}` },
    });
    expect(ranged.status()).toBe(206);
    expect(sha256(await ranged.body())).toBe(sha256(big.subarray(partSize - 5, partSize + 5)));
  });
});

test.describe('privacy levels', () => {
  test('private uploads need the password, and wrong guesses are rejected', async ({ page }) => {
    const id = await createUpload(page, {
      text: 'only for you',
      privacy: 'private',
      password: 'open sesame',
    });
    // the creator is sent to the password form as well
    await expect(page.locator('#auth-form')).toBeVisible();
    await expect(page.getByText('only for you')).toHaveCount(0);
    await page.fill('#password-field', 'wrong');
    await page.click('#auth-form button');
    await expect(page.getByText('Incorrect password')).toBeVisible();
    await page.fill('#password-field', 'open sesame');
    await page.click('#auth-form button');
    await expect(page.locator('#code')).toContainText('only for you');
    await shot(page, 'private');
    expect(await (await page.request.get(`/raw/${id}`)).text()).toContain('password-field');
  });

  test('burn after reading: a preview does not burn, the reveal does', async ({ page }) => {
    const id = await createUpload(page, { text: 'self-destructing note', burn: '1' });
    await expect(page.getByText('Upload created')).toBeVisible();
    await expect(page.getByText('self-destructing note')).toHaveCount(0);
    await shot(page, 'burn');
    // a chat app unfurling the link only does GETs: still intact
    expect((await page.request.get(`/upload/${id}`)).status()).toBe(200);
    await page.click('text=Open it now');
    await expect(page.locator('#code')).toContainText('self-destructing note');
    await expect(page.getByText('last allowed read')).toBeVisible();
    expect((await page.request.get(`/upload/${id}`)).status()).toBe(404);
    expect((await page.request.get(`/raw/${id}`)).status()).toBe(404);
  });

  test('secret uploads are encrypted in the browser: the server never sees plaintext or password', async ({
    page,
  }) => {
    const secretText = 'the vault code is 8-1-5-9';
    const password = 'correct horse battery staple';
    const attachment = randomBuffer(300_000, 3);
    const photo = PNG_1X1;

    const sent: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET') {
        sent.push(request.postData() ?? '');
        const body = request.postDataBuffer();
        if (body) sent.push(body.toString('latin1'));
      }
    });

    const id = await createUpload(page, {
      text: secretText,
      privacy: 'secret',
      password,
      files: [
        { name: 'vault-plans.pdf', mimeType: 'application/pdf', buffer: attachment },
        { name: 'photo.png', mimeType: 'image/png', buffer: photo },
      ],
    });
    const everything = sent.join('\n');
    expect(everything).not.toContain(secretText);
    expect(everything).not.toContain(password);
    expect(everything).not.toContain('vault-plans');
    expect(everything).not.toContain(attachment.subarray(1000, 1100).toString('latin1'));

    // locked: only a form, no content, no file names
    await expect(page.locator('#unlock-form')).toBeVisible();
    await expect(page.getByText(secretText)).toHaveCount(0);
    await expect(page.getByText('vault-plans')).toHaveCount(0);
    await shot(page, 'secret-locked');

    await page.fill('#password-field', 'wrong password');
    await page.click('#unlock-button');
    await expect(page.locator('#unlock-status')).toContainText('Incorrect password');

    await page.fill('#password-field', password);
    await page.click('#unlock-button');
    await expect(page.locator('#code')).toContainText(secretText, { timeout: 30_000 });
    await expect(page.locator('.file-card')).toHaveCount(2);
    await expect(page.locator('.file-card small[title="vault-plans.pdf"]')).toBeVisible();
    // the image preview was decrypted into a blob: URL
    await expect(page.locator('.file-card img.embed-media')).toHaveAttribute('src', /^blob:/);
    await shot(page, 'secret-unlocked');

    const download = page.waitForEvent('download');
    await page
      .locator('.file-card', { hasText: 'vault-plans.pdf' })
      .getByRole('button', { name: 'Download' })
      .click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('vault-plans.pdf');
    const fs = await import('node:fs/promises');
    expect(sha256(await fs.readFile((await file.path())!))).toBe(sha256(attachment));

    const zipDownload = page.waitForEvent('download');
    await page.click('#download-all-button');
    const zip = await zipDownload;
    expect(zip.suggestedFilename()).toBe(`${id}.zip`);
    expect((await fs.readFile((await zip.path())!)).length).toBeGreaterThan(attachment.length);

    // what the server stores is opaque
    const raw = await page.request.get(`/raw/${id}`);
    expect(raw.status()).toBe(403);
    const direct = await page.request.get(`/file/${id}/0`);
    expect(direct.status()).toBe(401);
  });

  test('a secret upload can be removed with its password only', async ({ page }) => {
    const id = await createUpload(page, {
      text: 'short lived secret',
      privacy: 'secret',
      password: 'pw-1234',
    });
    await page.goto(`/remove/${id}`);
    await page.fill('#password-field', 'nope');
    await page.click('#secret-remove-form button[type=submit]');
    await expect(page.locator('#remove-status')).toContainText('Incorrect password');
    await page.fill('#password-field', 'pw-1234');
    await page.click('#secret-remove-form button[type=submit]');
    await page.waitForURL('**/list');
    expect((await page.request.get(`/upload/${id}`)).status()).toBe(404);
  });
});

test.describe('listing, editing and administration', () => {
  test('public uploads are listed and can be edited and removed', async ({ page }) => {
    const id = await createUpload(page, { text: 'list me' });
    await page.goto('/list');
    await expect(page.getByRole('link', { name: id })).toBeVisible();
    await shot(page, 'list');

    await page.goto(`/edit/${id}`);
    await page.fill('#content', 'edited text');
    await page.click('button[type=submit]');
    await expect(page.locator('#code')).toContainText('edited text');

    await page.goto(`/remove/${id}`);
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#remove-form button[type=submit]');
    await page.waitForURL('**/list');
    await expect(page.getByRole('link', { name: id })).toHaveCount(0);
  });

  test('administrators can sign in, review everything and clean up', async ({ page }) => {
    const hidden = await createUpload(page, {
      text: 'unlisted but visible to admins',
      privacy: 'unlisted',
    });
    await page.goto('/admin');
    await page.waitForURL('**/admin/login');
    await page.fill('#username', 'admin');
    await page.fill('#password', 'wrong');
    await page.click('#auth-form button');
    await expect(page.getByText('Incorrect username or password')).toBeVisible();
    await page.fill('#password', 'admin-pass');
    await page.click('#auth-form button');
    await page.waitForURL('**/admin');
    await expect(page.getByRole('link', { name: hidden })).toBeVisible();
    await shot(page, 'admin');

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('tr', { hasText: hidden }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Upload removed.')).toBeVisible();
    await page.click('text=Run cleanup now');
    await expect(page.getByText('Cleanup finished')).toBeVisible();
  });

  test('guide, QR code and error pages work', async ({ page }) => {
    await page.goto('/guide');
    await expect(page.getByRole('heading', { name: 'HTTP API' })).toBeVisible();
    await shot(page, 'guide');
    const id = await createUpload(page, { text: 'qr test' });
    await page.goto(`/qr/${id}`);
    await expect(page.locator('.qr svg')).toBeVisible();
    await page.goto('/upload/does-not-exist');
    await expect(page.getByText('Upload not found')).toBeVisible();
    await shot(page, '404');
  });
});
