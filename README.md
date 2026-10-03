# MicroBin for Cloudflare Workers

A **complete Cloudflare Workers rewrite** of [MicroBin](https://github.com/szabodanika/microbin) (a self-hosted pastebin, file sharing, and URL redirection service written in Rust / actix-web).
It offers the same features and UI style, but runs on Workers + D1 + R2: serverless, zero-maintenance, and distributed globally at the edge.

- **Backend**: TypeScript + [Hono](https://hono.dev), with pages server-side rendered via `hono/jsx` (automatic escaping, no template engine).
- **Storage**: D1 (metadata), R2 (files, with multipart large file upload support), Workers Static Assets (CSS/JS).
- **Encryption**: Web Crypto (AES-256-GCM + PBKDF2 + HKDF); server-side mode and browser-side end-to-end mode share the exact same codebase.
- **Quality**: 142 integration tests executed inside real workerd instances + 14 end-to-end browser tests (Chromium). ESLint (including `no-floating-promises`) and `tsc --strict` pass with zero warnings/errors.

> License: **AGPL-3.0-or-later** (GNU Affero General Public License v3.0 or later).
> Retains upstream [MicroBin](https://github.com/szabodanika/microbin) BSD-3-Clause copyright notices (see [LICENSE](LICENSE)). The logo and favicon are sourced from upstream.

---

## Table of Contents

1. [Features Overview](#features-overview)
2. [Architecture](#architecture)
3. [Quick Start (Local Development)](#quick-start-local-development)
4. [Deploying to Cloudflare](#deploying-to-cloudflare)
5. [Configuration](#configuration)
6. [Privacy Levels & Cryptographic Design](#privacy-levels--cryptographic-design)
7. [Large File Uploads](#large-file-uploads)
8. [Security Design](#security-design)
9. [HTTP API](#http-api)
10. [Operations & Maintenance](#operations--maintenance)
11. [Development & Testing](#development--testing)
12. [Workers Best Practices Checklist](#workers-best-practices-checklist)
13. [Differences from Upstream & Migration](#differences-from-upstream--migration)
14. [Frequently Asked Questions](#frequently-asked-questions)

---

## Features Overview

| Feature | Description |
| --- | --- |
| Text / Files / Shortlinks | Text containing only an `http(s)` URL automatically turns into a short link (`/u/<id>` 302 redirect; other protocols like `javascript:` are never redirected). |
| Multi-file Support | Three views: Gallery, Stream, and List. Inline preview for images, video, and audio; streaming ZIP bundling via `/archive/<id>`. |
| 5 Privacy Levels | `public` · `unlisted` · `readonly` · `private` (server-side encrypted) · `secret` (browser end-to-end encrypted). |
| Expiration | 14 intervals ranging from 1 minute to 16 years + `never`, constrained by `MAX_EXPIRY` / `ETERNAL_PASTA`; garbage-collected via Cron. |
| Burn After Reading | Deletion after the 1st/10th/100th/1,000th/10,000th read. Counting is **atomic**; concurrent reads will never cause over-deliveries. |
| Syntax Highlighting | Browser-side highlight.js (31 languages + auto-detection), lazy-loaded on demand. |
| QR Code, Raw, Edit, Delete, List | Consistent with upstream; QR codes are server-rendered inline SVGs. |
| Admin Dashboard | `/admin`: Login sessions, view all pastes (including unlisted/encrypted), deletion, manual cleanup. |
| Site-wide Basic Auth | Protects "create / list / edit / delete / admin"; **reading** via a direct link remains public (consistent with upstream). |
| Upload Password (`READONLY`) | Only users who provide `UPLOADER_PASSWORD` can create uploads. |
| curl Compatibility | `POST /upload` accepts the same form fields as upstream; legacy scripts require no modifications. |
| **New Features** | Multipart chunked uploads (bypassing the 100 MB body size limit), Range/conditional requests, rate limiting, CSP & sandboxed file downloads, JSON API, structured logging. |

---

## Architecture

```
Browser ──HTTPS──► Cloudflare Edge
                         │
        ┌────────────────┴───────────────┐
  Workers Static Assets             Worker (Hono, TypeScript)
  /static/*  Hashed filenames        ├─ D1   pastas / pasta_files / r2_gc (outbox)
  Immutable cache, bypasses Worker   ├─ R2   File contents (single or multipart)
                                     ├─ Rate Limiting bindings (password attempts, creates)
                                     └─ Cron Trigger (reclaims expired data every 30 mins)
```

Data Model (`migrations/0001_init.sql`):

- `pastas`: One row per paste/upload (`kind` = `text`/`url`, `privacy`, key derivation parameters `kdf_salt`/`kdf_iter`/`verifier`, expiration, read counts, `status` = `pending`/`active`).
- `pasta_files`: One row per file; `r2_key` points to the R2 object.
- `r2_gc`: **Transactional outbox pattern**. When a paste is deleted, its R2 object keys are inserted into this outbox within the same atomic `batch`. `waitUntil` and the Cron job perform the actual deletions asynchronously → no orphan objects are left behind due to mid-operation failures, and full-bucket scans are never needed.

Request Flow Highlights:

- Reading an entry = A single `UPDATE … RETURNING` query (atomic counter increment + fetch row) combined with the file list query in the same `batch` (a single round-trip).
- File downloads are streamed directly from R2 to the client through the Worker **without buffering**; encryption, decryption, and ZIP bundling are completely streamed.
- HTML pages contain no inline scripts or inline styles; initial state is passed to client scripts via `<script type="application/json" id="boot">`.

---

## Quick Start (Local Development)

Requires **Node.js ≥ 24** (wrangler requirement).

```bash
pnpm install                     # The prepare script builds client assets and generates Env types
cp .dev.vars.example .dev.vars  # Edit this file; SESSION_SECRET must be configured
pnpm run db:migrate:local        # Run database migrations against local D1
pnpm run dev                     # http://localhost:8787
```

`wrangler dev` uses local workerd to emulate D1, R2, Rate Limiting, and Static Assets; local state is stored under `.wrangler/state/`.
Modifying any file under `src/` triggers automatic rebuilds and hot reloads.

Trigger Cron manually: `curl "http://localhost:8787/cdn-cgi/local/scheduled"`

---

## Deploying to Cloudflare

### Prerequisites

- A Cloudflare account; run `pnpm exec wrangler login` (or configure `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`).
- **A Workers Paid plan is strongly recommended**. The free tier provides only 10 ms CPU time per request: password verification (PBKDF2; ~17 ms for 100k iterations locally), server-side encryption, and ZIP compression can easily exceed this limit. Plain text or unencrypted file sharing without passwords usually works fine on the free plan, but **this cannot be guaranteed across all edge hardware**. Please test on a small scale first. See [FAQ](#frequently-asked-questions).

### First Deployment

Resource IDs for D1 and R2 are intentionally omitted in `wrangler.jsonc`: wrangler ≥ 4.45 will **automatically provision** the D1 database `microbin` and the R2 bucket `microbin-files` during `deploy` and bind them (writing the IDs back into your configuration file).

```bash
# 1. Prepare your secrets file (do not commit this; .secrets* is ignored by .gitignore)
cat > .secrets.env <<EOF
SESSION_SECRET=$(openssl rand -base64 48)
ADMIN_PASSWORD=$(openssl rand -base64 18)
# BASIC_AUTH_PASSWORD=...     # Paired with BASIC_AUTH_USERNAME in wrangler.jsonc
# UPLOADER_PASSWORD=...       # Required if READONLY=true
EOF

# 2. Deploy (uploads secrets simultaneously; avoids runtime errors from missing SESSION_SECRET)
pnpm exec wrangler deploy --secrets-file .secrets.env

# 3. Apply schema migrations to remote D1
pnpm run db:migrate:remote

# 4. Remove the temporary secrets file
rm .secrets.env
```

Subsequent updates only require:

```bash
pnpm run db:migrate:remote   # Always migrate first (migrations are backward-compatible)
pnpm run deploy
```

Prefer manual resource creation? Create them manually and paste the generated IDs into `wrangler.jsonc`:

```bash
pnpm exec wrangler d1 create microbin          # Put the database_id into d1_databases[0].database_id
pnpm exec wrangler r2 bucket create microbin-files
```

### Custom Domains

Uncomment and configure the route in `wrangler.jsonc` (the Worker acts as the origin; DNS and SSL certificates are handled automatically):

```jsonc
"routes": [{ "pattern": "bin.example.com", "custom_domain": true }],
```

### GitHub Actions

- `.github/workflows/ci.yml`: Type checking, ESLint, Prettier, unit/integration tests, and Chromium E2E tests.
- `.github/workflows/deploy.yml`: Triggered manually or by pushing tags matching `v*`. Runs `d1 migrations apply` followed by `wrangler deploy`.
  Requires repository secrets: `CLOUDFLARE_API_TOKEN` (permissions: Workers Scripts:Edit, D1:Edit, Workers R2 Storage:Edit) and `CLOUDFLARE_ACCOUNT_ID`.
  Worker secrets (`SESSION_SECRET`, etc.) only need to be configured once during initial deployment; they persist across deployments.

---

## Configuration

Non-sensitive configurations reside under `vars` in `wrangler.jsonc` (booleans, numbers, or strings). Passwords and credentials must be set as Worker secrets.
Variable names follow upstream conventions with the `MICROBIN_` prefix removed. **If any configuration value is invalid, the application refuses to start and lists all configuration errors at once in the logs** (rather than silently falling back to defaults).

### Secrets (`pnpm exec wrangler secret put <NAME>`)

| Name | Required | Description |
| --- | --- | --- |
| `SESSION_SECRET` | ✅ | A random string of ≥ 32 characters, used to seal upload tokens, file download tokens, and admin session cookies. Rotating this invalidates all ongoing uploads and active admin sessions. |
| `ADMIN_PASSWORD` | | Enables `/admin` when configured (username defined by `ADMIN_USERNAME`). **There are no default credentials**; if unset, `/admin` returns a 404. |
| `BASIC_AUTH_PASSWORD` | | Must be set alongside `BASIC_AUTH_USERNAME` to enable Basic Auth. Setting only one throws a configuration validation error (fails fast instead of silently disabling auth). |
| `UPLOADER_PASSWORD` | | Password required to create uploads when `READONLY=true`. If unset, **uploads are completely disabled**. |

### Vars

| Variable | Default | Description |
| --- | --- | --- |
| `TITLE` | `""` | Site title. |
| `FOOTER_TEXT` | `""` | Custom footer text; may contain HTML (rendered unescaped; administrator responsibility). |
| `HIDE_HEADER` `HIDE_FOOTER` `HIDE_LOGO` | `false` | Hide corresponding UI elements. |
| `WIDE` | `false` | Wide layout (1080px). |
| `CUSTOM_CSS` | `""` | Additional stylesheet (URL or `/path`), loaded **after** the default styles. External origins are automatically allowed in CSP. |
| `PUBLIC_URL` | `""` | Public base URL (used for QR code generation). Derived from request headers if blank. Upstream alias `PUBLIC_PATH` is also supported. |
| `SHORT_URL` | `""` | Short domain used when copying links and generating QR codes. Upstream alias `SHORT_PATH` is also supported. |
| `NO_LISTING` | `false` | Disables `/list`. |
| `NO_FILE_UPLOAD` | `false` | Disallows file uploads. |
| `QR` | `true` | Enables QR code pages. |
| `SHOW_READ_STATS` | `true` | Displays read counts and expiration times. |
| `HIGHLIGHT_SYNTAX` | `true` | Enables syntax highlighting menu (upstream alias `HIGHLIGHTSYNTAX` is also supported). |
| `EDITABLE` | `true` | Whether new uploads can be edited/deleted (stored at creation; not affected by subsequent config changes). |
| `ENABLE_BURN_AFTER` / `DEFAULT_BURN_AFTER` | `true` / `0` | Burn-after-reading; default options: 0/1/10/100/1000/10000. |
| `HASH_IDS` | `false` | Use short random strings (base58) instead of animal name IDs. |
| `ID_LENGTH` | `0` | `0` = auto: 4 words for animal names, 8 chars for hash IDs. **`unlisted` and `readonly` (where the URL is the sole secret) enforce at least 8 words (48 bits of entropy) or 12 characters**. |
| `DEFAULT_VIEW` | `gallery` | Default file list view: `gallery` / `stream` / `list`. |
| `PRIVATE` | `true` | Enables the `unlisted` privacy level. |
| `ENABLE_READONLY` | `true` | Enables the `readonly` privacy level. |
| `ENCRYPTION_SERVER_SIDE` | `true` | Enables the `private` privacy level. |
| `ENCRYPTION_CLIENT_SIDE` | `true` | Enables the `secret` privacy level. |
| `DEFAULT_PRIVACY` | `public` | Default privacy level in upload forms (falls back to `public` if the chosen level is disabled). |
| `DEFAULT_EXPIRY` / `MAX_EXPIRY` | `24hour` / `1week` | Choices: `1min 10min 1hour 24hour 3days 1week 1month 6months 1year 2years 4years 8years 16years never`. |
| `ETERNAL_PASTA` | `false` | Allows the `never` expiration option (also requires `MAX_EXPIRY=never`). |
| `GC_DAYS` | `90` | Pastes not read within N days are purged (0 = disabled). |
| `MAX_TEXT_KB` | `1024` | Maximum text size in KiB (1–1400; D1 limits individual rows to 2 MB). |
| `MAX_FILES` | `20` | Maximum number of files per paste (1–100). |
| `MAX_FILE_SIZE_UNENCRYPTED_MB` | `2048` | Maximum file size for unencrypted files. |
| `MAX_FILE_SIZE_ENCRYPTED_MB` | `256` | Maximum file size for encrypted files (`private` is further constrained by `UPLOAD_SINGLE_MAX_MB`). |
| `UPLOAD_SINGLE_MAX_MB` | `64` | Threshold under which files are uploaded in a single request; larger files use chunked multipart uploads (1–90; body limit is 100 MB). |
| `UPLOAD_PART_MB` | `32` | Multipart upload part size (5–90; R2 requires parts to be ≥ 5 MiB except the last part). |
| `PBKDF2_ITERATIONS` | `100000` | Number of PBKDF2 iterations for server-side key derivation, clamped between 10,000 and 100,000 (**Cloudflare Workers production rejects values > 100,000**). Lower this value if CPU time limits are exceeded on the free plan. |
| `READONLY` | `false` | Read-only instance: requires `UPLOADER_PASSWORD` to create pastes. |
| `BASIC_AUTH_USERNAME` | `""` | Username for site-wide Basic Authentication. |
| `ADMIN_USERNAME` | `admin` | Username for the admin dashboard. |

The admin panel footer displays the active runtime configuration and highlights configuration warnings (e.g., auto-clamped parameters).

---

## Privacy Levels & Cryptographic Design

| Level | Listed in `/list` | Who Can Read | Who Can Edit / Delete | Encryption | Server Visibility |
| --- | --- | --- | --- | --- | --- |
| `public` | Yes | Anyone | Anyone (if `EDITABLE=true`) | None | Plaintext |
| `unlisted` | No | Anyone with the link | Anyone (if `EDITABLE=true`) | None | Plaintext |
| `readonly` | No | Anyone with the link | Password required | None | Plaintext; password transient during request |
| `private` | No | Password required | Password required | **Server-side** AES-256-GCM | Password/plaintext visible transiently during request; **only ciphertext is persisted** |
| `secret` | No | Password required | Password required | **Browser-side** AES-256-GCM (text, files, and **filenames** encrypted) | Ciphertext, salt, and verification hash only; **server never sees the password or plaintext** |

> Note: `unlisted` does not mean cryptographically secret: anyone with the URL can view it. This is why its ID default entropy is enforced at 48 bits. Use `private` or `secret` if confidential data is shared.

### Cryptographic Implementation Details (`src/shared/crypto.ts`)

```
password ─PBKDF2-SHA256(random salt, N iters)─► master (256-bit)
master ─HKDF("…/enc") ─► encKey    AES-256-GCM key (encrypts text and files)
master ─HKDF("…/auth")─► authKey   Proves password knowledge to the server
verifier = SHA-256(authKey)        Stored on the server for authentication
```

- **Text**: Formatted as `mbx1.` + base64url(random 12-byte IV ‖ ciphertext ‖ GCM authentication tag).
- **Files**: 16-byte header + 64 KiB chunks of AES-GCM stream (STREAM construction). Nonce = 7-byte random prefix ‖ chunk counter ‖ "last chunk" flag. **Reordering, dropping, or truncating chunks is immediately detected**. Encryption and decryption run inside `TransformStream`, maintaining a memory footprint of just one 64 KiB chunk.
- **Iterations**: Server-side modes (`readonly`/`private`) = 100,000 iterations (maximum permitted in Workers production environments); `secret` mode runs PBKDF2 inside the browser using **600,000** iterations (OWASP recommendation). The server never runs PBKDF2 for `secret` pastes.
- Passwords undergo NFKC normalization before derivation, ensuring identical keys across different input methods or operating systems.
- **`secret` password verification exposes zero offline attack surface**: The salt is public, but guessing attempts can only be verified against the unlock endpoint (which enforces rate limiting before checking). Ciphertext is only delivered after supplying a valid short-lived token acquired from a successful unlock.
- All password and secret comparisons are strictly constant-time (`crypto.subtle.timingSafeEqual`, pre-hashed to fixed lengths).

---

## Large File Uploads

Cloudflare's HTTP request body limits (100 MB on Free/Pro, 200 MB on Business) prevent Workers from accepting 2 GB single-request uploads directly. This project implements chunked streaming uploads:

```
POST /api/pastas                  Create a pending paste; returns a sealed token and upload instructions
PUT  …/files/:idx                 Files ≤ 64 MiB: direct single PUT request streamed to R2
POST …/files/:idx/multipart       Files > 64 MiB: initialize an R2 multipart upload
PUT  …/multipart/:n               Upload 32 MiB parts (browser concurrency: 3; exponential backoff retries)
POST …/multipart/complete         Complete multipart upload
POST /api/pastas/:id/complete     Publish the paste (expiration timer starts here; slow uploads won't eat validity)
```

- All request bodies are processed as streams; the Worker never buffers an entire file in memory.
- `private` mode performs on-the-fly encryption in the Worker (`FixedLengthStream` with precalculated ciphertext length), so it is capped at the single-request size limit.
- `secret` mode encrypts into Blobs on the client side before uploading; the chunks are opaque bytes to the server.
- Unpublished pending pastes are invisible; pending uploads older than 24 hours are automatically aborted and deleted by the Cron cleanup job. In addition, R2 lifecycle rules clean up unfinished multipart uploads older than 7 days.
- A single R2 multipart upload supports up to 10,000 parts, far exceeding `MAX_FILE_SIZE_UNENCRYPTED_MB`.

---

## Security Design

Fixes for upstream vulnerabilities alongside additional security hardening:

| Upstream Vulnerability / Design | This Implementation |
| --- | --- |
| Random IDs were 16-bit; `unlisted` pastes could be easily enumerated | Cryptographically secure PRNG; public pastes use 4 words (24-bit), **`unlisted`/`readonly` default to 48-bit minimum** (configurable); automatic retry on insertion collisions. |
| AES-CTR with fixed counters, no integrity auth, `#`-padded keys; magic-crypt with no salt or key stretching | AES-GCM + random IV/nonce + PBKDF2 + HKDF, with authenticated data and truncation protection. |
| `GET /remove/<id>` deleted pastes immediately (vulnerable to CSRF and crawler pre-fetching) | `GET` shows a confirmation page; actual deletion requires `POST` protected by cross-site origin checks. |
| Default administrative credentials `admin / m1cr0b1n` | No hardcoded credentials; admin dashboard returns 404 unless `ADMIN_PASSWORD` is explicitly set. |
| Admin credentials sent on every request | Sealed session cookies on login (`HttpOnly; SameSite=Strict`, `Secure` over HTTPS, 2-hour lifetime). |
| Variable-time string comparisons for passwords | Constant-time comparisons everywhere. |
| Link-unfurling crawlers accidentally consumed burn-after-reading pastes | `GET` requests never burn a paste; an intermediate confirmation screen requires explicit user interaction before counting a view. |
| Burn-after-reading files were immediately unreachable (404) after viewing the page | Files remain downloadable for up to 1 hour using sealed, signed page tokens after the final view; access without a valid token is rejected. |
| askama template engine with unescaped HTML injection risks | JSX automatic escaping; strict Content Security Policy (no inline scripts or inline styles). |
| Entire database loaded into an in-memory `Mutex<Vec>` | Powered by Cloudflare D1 with fully parameterized SQL queries; views increment atomically via `UPDATE … RETURNING`. |
| Uploaded HTML/SVG files rendered inline on the same origin (stored XSS) | Only safe images, audio, video, and plain text can render inline. File downloads enforce `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`; all other file types are forced to download via `attachment`. |

Additional hardening: `X-Frame-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `X-Robots-Tag: noindex`, HSTS (over HTTPS).
Filename sanitization strips directory traversal, control characters, Windows-reserved filenames, and **Unicode bidirectional override characters**.
HTTP Range requests are parsed strictly according to RFC 9110 (preventing R2 from returning entire objects on malformed range headers).
Password verification endpoints are protected by Cloudflare Rate Limiting bindings (`RL_AUTH`: 10 requests/minute per upload per Cloudflare colo, **rate-limited before verification**; `RL_WRITE`: 30 creations/minute per IP).

> Note: The `namespace_id` values (`7101`, `7102`) in `wrangler.jsonc` are arbitrary integers unique within your Cloudflare account. If they conflict with existing Worker bindings, change them to any available integer.
>
> Cloudflare Rate Limiting bindings are **per-colo and eventually consistent**, intended for abuse deterrence rather than strict billing accounting. For public deployments, complement this with Cloudflare WAF rate-limiting rules, Turnstile, Cloudflare Access, or by enabling `READONLY` / Basic Auth.

---

## HTTP API

The web UI interacts with the Worker via these exact endpoints, which can also be called directly using `curl`. Errors return JSON: `{"error":{"code","message"}}`.

### Simple Uploads: Upstream Form-data Compatibility

```bash
# Text upload
curl -L -F 'content=Hello from curl' -F 'expiration=1hour' https://bin.example.com/upload

# File upload (parsed in-memory; limited to 25 MB. Use the JSON API below for larger files)
curl -L -F 'file=@photo.jpg' -F 'privacy=unlisted' -F 'expiration=1week' https://bin.example.com/upload

# Request JSON output
curl -H 'Accept: application/json' -F 'content=hi' https://bin.example.com/upload
# {"id":"viper-deer-duck-bison","url":"/upload/viper-deer-duck-bison"}

# Password-protected upload, fetch raw output
curl -F 'content=secret' -F 'privacy=private' -F 'plain_key=hunter2' -H 'Accept: application/json' https://bin.example.com/upload
curl -d 'password=hunter2' https://bin.example.com/raw/<id>
```

Form fields: `content`, `expiration`, `burn_after`, `syntax_highlight` (file extensions such as `py` or `rs` are supported), `privacy` (excluding `secret`), `plain_key` (password), `uploader_password`, and `file` (can be specified multiple times).
Add `-u user:password` if Basic Auth is enabled.

### JSON API (Arbitrary File Sizes)

```bash
HOST=https://bin.example.com
SIZE=$(stat -c%s backup.zip)

# 1. Initialize paste
curl -s $HOST/api/pastas -H 'content-type: application/json' \
  -d "{\"expiration\":\"1week\",\"content\":\"nightly backup\",\"files\":[{\"name\":\"backup.zip\",\"size\":$SIZE}]}" > created.json
ID=$(jq -r .id created.json); TOKEN=$(jq -r .token created.json)

# 2. Upload file (if ≤ UPLOAD_SINGLE_MAX_MB; larger files use POST …/files/0/multipart, see table below)
curl -s -X PUT $HOST/api/pastas/$ID/files/0 -H "x-upload-token: $TOKEN" --data-binary @backup.zip

# 3. Finalize and publish
curl -s -X POST $HOST/api/pastas/$ID/complete -H "x-upload-token: $TOKEN"
```

| Method & Route | Description |
| --- | --- |
| `POST /api/pastas` | Create a paste. Body parameters: `content`, `expiration`, `burnAfter`, `syntax`, `privacy`, `password`, `kdf`, `files[{name,size}]`, `uploaderPassword`. Returns `201 {id,url,complete,token?,files:[{idx,mode}]}`. Pastes without attached files are completed immediately (`complete:true`). |
| `PUT /api/pastas/:id/files/:idx` | Direct single-file upload; requires `X-Upload-Token` and an accurate `Content-Length`. |
| `POST /api/pastas/:id/files/:idx/multipart` | Initialize a multipart upload → `{uploadId,partSize,parts}`. |
| `PUT …/multipart/:n` | Upload part `n` (part size must match `partSize` exactly, except for the final part) → `{partNumber,etag}`. |
| `POST …/multipart/complete` | Complete multipart upload: `{"parts":[{partNumber,etag},…]}`. |
| `POST /api/pastas/:id/complete` | Publish the paste. |
| `POST /api/pastas/:id/abort` | Discard an uncompleted upload. |
| `GET /api/pastas/:id` | Read paste data as JSON (**increments read counter**). `private` requires `X-Password`; `secret` requires `X-Auth-Key` (returns encrypted payloads and temporary file download tokens). |
| `POST /api/pastas/:id/remove` | Delete a paste (`readonly`/`private` requires `X-Password`; `secret` requires `X-Auth-Key`). |
| `GET /raw/:id` · `/u/:id` · `/file/:id/:idx` · `/archive/:id` · `/qr/:id` | Raw text view · Shortlink redirect · File access (supports Range requests) · ZIP archive download · Inline SVG QR code. |
| `GET /healthz` | Health check probe (verifies D1 connectivity). |

When Basic Auth is active, all requests under `/api/*` (except `GET` endpoints) require authentication.

---

## Operations & Maintenance

- **Logs**: Every request produces a single JSON line containing HTTP method, path, status, duration, `cf-ray`, and country. Query strings are stripped to avoid leaking short-lived download tokens (`observability.redact_query_string` is enabled). Monitor real-time logs via `pnpm exec wrangler tail` or inspect them in Cloudflare Workers Observability.
- **Garbage Collection**: Cron executes `src/services/gc.ts` every 30 minutes: purging expired/burned pastes, pastes unread for `GC_DAYS`, pending uploads abandoned for > 24 hours, and R2 keys recorded in the GC outbox. Each run operates under a bounded batch size (D1 limits free tiers to 50 queries per call); remaining tasks rollover to the next run. An on-demand "Run cleanup now" button is available in the admin panel.
- **Backups**: D1 supports automatic Time Travel (30 days on Paid / 7 days on Free): `pnpm exec wrangler d1 time-travel info microbin`. Export SQL dumps via: `pnpm exec wrangler d1 export microbin --remote --output backup.sql`. Uploaded files reside directly in R2.
- **Credential Rotation**: Update passwords with `pnpm exec wrangler secret put ADMIN_PASSWORD` (takes effect immediately). Rotating `SESSION_SECRET` invalidates pending in-flight uploads and admin sessions; existing active pastes are unaffected.
- **Database Limits (D1)**: 2 MB maximum row size, 100 bound parameters per query, 500 MB database size on the free tier. `MAX_TEXT_KB` is capped at 1400 KiB (because ciphertext in `secret`/`private` pastes expands by ~1.4x).
- **Cost**: Static asset requests are free; R2 has zero egress fees; primary costs are Workers request volume, D1 read/write units, and R2 storage usage. Refer to Cloudflare's pricing structure for details.

---

## Development & Testing

```bash
pnpm run dev            # Start local development server (with hot reload)
pnpm run check          # Run typecheck + lint + format:check + test
pnpm test               # Run 142 integration tests in workerd (@cloudflare/vitest-plugin)
pnpm run e2e            # Run 14 Chromium E2E tests (run pnpm exec playwright install chromium first)
pnpm run format         # Format codebase with Prettier
pnpm run types          # Regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

- Integration tests invoke the Worker inside workerd: D1, R2, Cron, multipart uploads, and Rate Limiting bindings are fully emulated. Test suites cover: cryptography (tampering, truncation, chunk reordering), atomic concurrency on burn-after-reading, HTTP Range/conditional headers, chunked streaming, expiration/GC, Basic Auth, admin sessions, CSRF protection, security headers, XSS prevention, and access permission matrices.
- `test/privacy.test.ts` includes a **production limit replay test**: Local workerd allows arbitrary PBKDF2 iteration counts, but Cloudflare's production runtime throws a `NotSupportedError` when exceeding 100,000 iterations. The test wraps `deriveBits` to simulate production limits, preventing "green locally, 500 in production" scenarios.
- End-to-end tests launch an isolated `wrangler dev` instance with dedicated state directories. They validate form interactions in real browsers: drag-and-drop/clipboard pasting, syntax highlighting, copy buttons, gallery/list layouts, multipart uploads (with threshold lowered to 5 MB for fast testing), `secret` end-to-end encryption (**verifying that no plaintext, passwords, filenames, or raw bytes are transmitted over the network**), burn-after-reading flows, and admin actions. Set `E2E_SHOTS=1` to write screenshots to `test-results/shots/`.

### Directory Structure

```
wrangler.jsonc            Worker configuration: bindings, vars, Cron, rate limits, observability
migrations/               D1 SQL migrations
public/                   Static assets root (_headers, logo, favicon; static/ holds built bundles)
scripts/build-client.mjs  esbuild script: bundles src/client → public/static (hashed), outputs src/generated/assets.json
src/index.ts              Worker entrypoint: fetch + scheduled handlers
src/app.tsx               Hono application setup: middleware pipeline, route definitions, error handling
src/config.ts             Strict configuration loader and schema validation (reports all errors at once)
src/middleware/           context (config/session) · logging · security (CSP) · csrf · auth · ratelimit
src/routes/               view · files · manage · admin · api · compat (curl compatibility) · pages
src/services/             create · upload (multipart) · access · modify · credentials · gc · schemas
src/db/pastas.ts          Database queries and transactional operations
src/lib/                  ids · expiry · mime · range · tokens · url · safe-equal · …
src/shared/               Shared between client and Worker: crypto · base64url · constants · filenames
src/views/                JSX templates (layouts, create, view, manage, admin, guides)
src/client/               Client-side browser scripts (create page, view page, highlighter) and styles
test/  e2e/               workerd integration test suites · Playwright browser tests
```

---

## Workers Best Practices Checklist

Aligned with Cloudflare's [Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) (September 2026 edition):

| Best Practice | Implementation in This Project |
| --- | --- |
| Pin modern `compatibility_date` and enable `nodejs_compat` | Set to `2026-10-01` (latest runtime date) with `nodejs_compat` enabled. |
| Use `wrangler types` to generate `Env` types | `pnpm run types` (runs automatically in `prepare`). Bindings and vars are derived strictly from generated definitions; secrets are typed in `src/types.ts`. |
| Keep secrets in `wrangler secret`, out of source code | All credentials are set as secrets (`.dev.vars.example` documents keys); initial deployment uses `--secrets-file`. Missing `SESSION_SECRET` aborts with an actionable error. |
| Use Workers bindings instead of external REST APIs | D1, R2, and Rate Limiting use native bindings. |
| Stream request and response bodies; enforce size limits | File uploads, downloads, cryptographic transforms, and ZIP packaging are 100% streamed. JSON and form-data parsing enforce maximum size limits on streaming bodies. |
| Handle post-response execution with `ctx.waitUntil` | Post-deletion R2 object purging is scheduled via `ctx.waitUntil` without destructuring context. |
| Avoid storing request state in global scope | State is held strictly within the Hono request context. The only module-level cache is an `env`-derived configuration mapped via a `WeakMap`. |
| Eliminate unhandled floating promises | ESLint rules `@typescript-eslint/no-floating-promises` and `no-misused-promises` are set to `error`. |
| Use Web Crypto for randomness; `timingSafeEqual` for secrets | All random numbers use `crypto.getRandomValues`. Hashes are pre-computed to equal lengths before constant-time comparison. |
| Avoid `passThroughOnException` | Handled via an explicit `onError` handler returning structured error responses without leaking internal stack traces. |
| Use Workers Static Assets for static resources | Configured via `assets.directory` with hashed filenames and `immutable` caching headers (`_headers`). Static hits never invoke the Worker. |
| Enable Workers Logs / Traces with structured JSON | `observability` enabled, `redact_query_string` enabled, output structured via `console.log(JSON.stringify(…))`. |
| Test inside workerd via `@cloudflare/vitest-plugin` | 142 integration tests executed directly within the Workers runtime, including regression tests for local vs. production differences (e.g., PBKDF2 iteration limits). |
| Automatic resource provisioning | D1 and R2 IDs are omitted in configuration, allowing automatic provisioning on initial `wrangler deploy`. |
| Custom domains configuration | Production-ready custom domain routes demonstrated in `wrangler.jsonc`. |

---

## Differences from Upstream & Migration

**Unsupported Options** (irrelevant to serverless Workers or removed for security/privacy): `PORT`, `BIND`, `THREADS`, `DATA_DIR`, `JSON_DB` (local filesystem and flat-file storage), `PURE_HTML`, telemetry and update checks (`DISABLE_TELEMETRY`, `DISABLE_UPDATE_CHECKING`), `LIST_SERVER`.

**Behavioral Changes**:

- The web creation interface requires JavaScript enabled (chunked file uploads and client-side encryption run in the browser). If running in a headless or script-only environment, use `curl` or the JSON API.
- `CUSTOM_CSS` is **appended** after the default stylesheet rather than replacing water.css.
- File URLs are structured as `/file/<id>/<index>`; `/file/<id>` defaults to the first file. The `/secure_file` and `/auth*` endpoints have been superseded by inline authentication forms.
- Paste deletion requires an explicit HTTP `POST`. Administrators authenticate via `/admin` sessions rather than providing passwords in paste forms.
- Burn-after-reading links present an explicit confirmation prompt prior to viewing. `unlisted` and `readonly` IDs have longer default lengths.
- `readonly` passwords store a PBKDF2-derived verification hash (replacing upstream's reversible encryption), utilizing random salts and constant-time comparisons.

**Data Migration**: No automated migration path is provided. The underlying storage architecture (local SQLite + disk directories → Cloudflare D1 + R2) and cryptographic envelopes are completely different; historical encrypted pastes cannot be imported. Unencrypted data can be re-uploaded using `curl -F` or the JSON API.

---

## Frequently Asked Questions

**Can I run this on the Workers Free plan?**
The Workers Free tier provides 10 ms of CPU time per request and allows up to 50 D1 queries per invocation. Plain text pastes and direct file sharing typically consume minimal CPU. Operations that incur CPU spikes are: PBKDF2 key derivation for `readonly`/`private` uploads (~17 ms for 100k iterations on typical hardware), server-side encryption for `private` files, and ZIP bundling (due to JavaScript CRC32 calculations).
If you encounter `Error 1102` (Worker exceeded resource limits), the CPU limit was exceeded. To mitigate: upgrade to Workers Paid (default 30-second CPU limit), reduce `PBKDF2_ITERATIONS` (minimum 10,000), or stick to `public`, `unlisted`, and `secret` privacy levels—since `secret` mode executes PBKDF2 in the client's browser, it consumes zero Worker CPU time.

**Why does everything work locally, but fail with a 500 error in production?**
Local `wrangler dev` behavior can occasionally diverge from production workerd limits. The most common difference is Web Crypto PBKDF2: Cloudflare's production edge rejects iteration counts > 100,000, whereas local environments do not. This project enforces an iteration limit of ≤ 100,000 on the server and includes regression test coverage simulating this exact constraint.

**I forgot the password to my `secret` paste. Can it be recovered?**
No. The server never receives or stores the decryption key. Administrators can only delete the paste from `/admin`.

**Large file uploads are failing. What should I check?**
Check your `MAX_FILE_SIZE_*` configuration and your Cloudflare plan's request body limits. Single-request limits (100 MB on Free/Pro) are bypassed by the frontend's automatic chunked multipart uploader, which also handles chunk retries. However, `private` pastes must be encrypted on the fly within a single Worker request, meaning they are capped by `UPLOAD_SINGLE_MAX_MB` (default 64 MB). For larger encrypted files, use `secret` mode.

**Can I use a local SQLite database or disk storage?**
This project is built specifically for Cloudflare's edge platform. If you require standard self-hosted Linux server deployments with local disks, upstream [MicroBin](https://github.com/szabodanika/microbin) is the recommended solution.

**How do I completely reset local development state?**
Run: `rm -rf .wrangler/state && pnpm run db:migrate:local`
