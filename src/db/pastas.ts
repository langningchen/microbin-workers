/**
 * All SQL lives here. Every statement is prepared with bound parameters (no string interpolation
 * of user data) and multi-statement changes go through `db.batch()`, which D1 runs atomically.
 *
 * D1 limits to keep in mind: 100 bound parameters per statement, 2 MB per row.
 */
import type { Privacy } from '../shared/constants';

export type PastaKind = 'text' | 'url';

export interface PastaRow {
  id: string;
  kind: PastaKind;
  content: string;
  syntax: string;
  privacy: Privacy;
  editable: number;
  kdf_salt: string | null;
  kdf_iter: number | null;
  verifier: string | null;
  created_at: number;
  expires_at: number | null;
  last_read_at: number;
  read_count: number;
  burn_after_reads: number;
  total_size: number;
  status: 'pending' | 'active';
}

export interface FileRow {
  paste_id: string;
  idx: number;
  name: string;
  size: number;
  r2_key: string;
  upload_id: string | null;
  uploaded: number;
}

export interface NewPasta {
  id: string;
  kind: PastaKind;
  content: string;
  syntax: string;
  privacy: Privacy;
  editable: boolean;
  kdfSalt: string | null;
  kdfIter: number | null;
  verifier: string | null;
  createdAt: number;
  expiresAt: number | null;
  burnAfterReads: number;
  totalSize: number;
  status: 'pending' | 'active';
}

export interface NewFile {
  idx: number;
  name: string;
  size: number;
  r2Key: string;
}

export interface ListItem {
  id: string;
  kind: PastaKind;
  privacy: Privacy;
  editable: number;
  created_at: number;
  expires_at: number | null;
  last_read_at: number;
  read_count: number;
  burn_after_reads: number;
  total_size: number;
  has_content: number;
  encrypted: number;
  file_count: number;
  first_file: string | null;
}

/** Remaining reads reached zero: the paste can no longer be viewed. */
export const isBurned = (pasta: Pick<PastaRow, 'burn_after_reads' | 'read_count'>): boolean =>
  pasta.burn_after_reads > 0 && pasta.read_count >= pasta.burn_after_reads;

/** After the last allowed read the files stay downloadable for this long (links carry a token). */
export const BURN_GRACE_SECONDS = 60 * 60;

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

const LIST_COLUMNS = `
  p.id, p.kind, p.privacy, p.editable, p.created_at, p.expires_at, p.last_read_at, p.read_count,
  p.burn_after_reads, p.total_size,
  length(p.content) > 0 AS has_content,
  p.kdf_salt IS NOT NULL AS encrypted,
  (SELECT COUNT(*) FROM pasta_files f WHERE f.paste_id = p.id) AS file_count,
  (SELECT f.name FROM pasta_files f WHERE f.paste_id = p.id ORDER BY f.idx LIMIT 1) AS first_file`;

export async function insertPasta(
  db: D1Database,
  pasta: NewPasta,
  files: NewFile[],
): Promise<void> {
  const statements = [
    db
      .prepare(
        `INSERT INTO pastas (id, kind, content, syntax, privacy, editable, kdf_salt, kdf_iter,
           verifier, created_at, expires_at, last_read_at, read_count, burn_after_reads,
           total_size, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?10, 0, ?12, ?13, ?14)`,
      )
      .bind(
        pasta.id,
        pasta.kind,
        pasta.content,
        pasta.syntax,
        pasta.privacy,
        pasta.editable ? 1 : 0,
        pasta.kdfSalt,
        pasta.kdfIter,
        pasta.verifier,
        pasta.createdAt,
        pasta.expiresAt,
        pasta.burnAfterReads,
        pasta.totalSize,
        pasta.status,
      ),
    ...files.map((file) =>
      db
        .prepare(
          'INSERT INTO pasta_files (paste_id, idx, name, size, r2_key) VALUES (?1, ?2, ?3, ?4, ?5)',
        )
        .bind(pasta.id, file.idx, file.name, file.size, file.r2Key),
    ),
  ];
  await db.batch(statements);
}

/** An existing, published paste that has not expired. (May already be burned.) */
export function findActive(db: D1Database, id: string, now: number): Promise<PastaRow | null> {
  return db
    .prepare(
      `SELECT * FROM pastas
       WHERE id = ?1 AND status = 'active' AND (expires_at IS NULL OR expires_at > ?2)`,
    )
    .bind(id, now)
    .first<PastaRow>();
}

/** Any row, including pending uploads and expired pastas awaiting garbage collection. */
export function findAny(db: D1Database, id: string): Promise<PastaRow | null> {
  return db.prepare('SELECT * FROM pastas WHERE id = ?1').bind(id).first<PastaRow>();
}

export async function listFiles(db: D1Database, id: string): Promise<FileRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM pasta_files WHERE paste_id = ?1 ORDER BY idx')
    .bind(id)
    .all<FileRow>();
  return results;
}

/**
 * Registers one read and returns the paste with its files - in a single round trip.
 *
 * The UPDATE is atomic, so two concurrent readers can never both consume the last read of a
 * "burn after reads" paste. When the final read is consumed, the expiry is pulled in to a short
 * grace period so the page that was just served can still load its files.
 */
export async function readAndCount(
  db: D1Database,
  id: string,
  now: number,
): Promise<{ pasta: PastaRow; files: FileRow[] } | null> {
  const [updated, files] = await db.batch<PastaRow | FileRow>([
    db
      .prepare(
        `UPDATE pastas
         SET read_count = read_count + 1,
             last_read_at = ?1,
             expires_at = CASE
               WHEN burn_after_reads > 0 AND read_count + 1 >= burn_after_reads
               THEN MIN(COALESCE(expires_at, ?2), ?2)
               ELSE expires_at END
         WHERE id = ?3 AND status = 'active'
           AND (expires_at IS NULL OR expires_at > ?1)
           AND (burn_after_reads = 0 OR read_count < burn_after_reads)
         RETURNING *`,
      )
      .bind(now, now + BURN_GRACE_SECONDS, id),
    db.prepare('SELECT * FROM pasta_files WHERE paste_id = ?1 ORDER BY idx').bind(id),
  ]);
  const pasta = updated?.results[0] as PastaRow | undefined;
  return pasta ? { pasta, files: (files?.results ?? []) as FileRow[] } : null;
}

export async function listPublic(
  db: D1Database,
  now: number,
  limit: number,
  offset: number,
): Promise<ListItem[]> {
  const { results } = await db
    .prepare(
      `SELECT ${LIST_COLUMNS} FROM pastas p
       WHERE p.privacy = 'public' AND p.status = 'active'
         AND (p.expires_at IS NULL OR p.expires_at > ?1)
         AND (p.burn_after_reads = 0 OR p.read_count < p.burn_after_reads)
       ORDER BY p.created_at DESC LIMIT ?2 OFFSET ?3`,
    )
    .bind(now, limit, offset)
    .all<ListItem>();
  return results;
}

export async function listAll(db: D1Database, limit: number, offset: number): Promise<ListItem[]> {
  const { results } = await db
    .prepare(
      `SELECT ${LIST_COLUMNS} FROM pastas p
       WHERE p.status = 'active' ORDER BY p.created_at DESC LIMIT ?1 OFFSET ?2`,
    )
    .bind(limit, offset)
    .all<ListItem>();
  return results;
}

export async function stats(
  db: D1Database,
  now: number,
): Promise<{ pastas: number; bytes: number; pending: number; queued: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM pastas WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?1)) AS pastas,
         (SELECT COALESCE(SUM(total_size), 0) FROM pastas WHERE status = 'active') AS bytes,
         (SELECT COUNT(*) FROM pastas WHERE status = 'pending') AS pending,
         (SELECT COUNT(*) FROM r2_gc) AS queued`,
    )
    .bind(now)
    .first<{ pastas: number; bytes: number; pending: number; queued: number }>();
  return row ?? { pastas: 0, bytes: 0, pending: 0, queued: 0 };
}

export async function setContent(
  db: D1Database,
  id: string,
  content: string,
  kind: PastaKind,
  contentBytes: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE pastas
       SET content = ?2, kind = ?3,
           total_size = ?4 + (SELECT COALESCE(SUM(size), 0) FROM pasta_files WHERE paste_id = ?1)
       WHERE id = ?1`,
    )
    .bind(id, content, kind, contentBytes)
    .run();
}

// ── Upload bookkeeping ──

export async function setUploadId(
  db: D1Database,
  id: string,
  idx: number,
  uploadId: string,
): Promise<void> {
  await db
    .prepare(
      'UPDATE pasta_files SET upload_id = ?3 WHERE paste_id = ?1 AND idx = ?2 AND uploaded = 0',
    )
    .bind(id, idx, uploadId)
    .run();
}

export async function markFileUploaded(
  db: D1Database,
  id: string,
  idx: number,
  size: number,
): Promise<void> {
  await db
    .prepare(
      'UPDATE pasta_files SET uploaded = 1, size = ?3, upload_id = NULL WHERE paste_id = ?1 AND idx = ?2',
    )
    .bind(id, idx, size)
    .run();
}

/**
 * Publishes a pending paste once every file has arrived. The expiry clock starts now, so a slow
 * multi-gigabyte upload cannot eat into the lifetime the user asked for.
 * Returns false if files are missing or the paste was already published.
 */
export async function publish(db: D1Database, id: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE pastas
       SET status = 'active',
           total_size = total_size + (SELECT COALESCE(SUM(size), 0) FROM pasta_files WHERE paste_id = ?1),
           expires_at = CASE WHEN expires_at IS NULL THEN NULL ELSE expires_at + (?2 - created_at) END,
           created_at = ?2,
           last_read_at = ?2
       WHERE id = ?1 AND status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM pasta_files WHERE paste_id = ?1 AND uploaded = 0)`,
    )
    .bind(id, now)
    .run();
  return result.meta.changes > 0;
}

// ── Deletion & garbage collection ──

// D1 allows 100 bound parameters per statement; ?1 is reserved for a timestamp in one of them.
const ID_CHUNK = 90;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** "?1, ?2, ?3" for `count` parameters, numbered from `first`. */
function placeholders(count: number, first = 1): string {
  return Array.from({ length: count }, (_, i) => `?${first + i}`).join(', ');
}

/**
 * Deletes pastas and queues their R2 objects in the same atomic batch (transactional outbox):
 * a crash can neither leave orphaned objects behind nor dangling metadata.
 */
export async function deletePastas(db: D1Database, ids: string[], now: number): Promise<void> {
  for (const group of chunked(ids, ID_CHUNK)) {
    await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO r2_gc (r2_key, upload_id, queued_at)
           SELECT r2_key, CASE WHEN uploaded = 0 THEN upload_id END, ?1
           FROM pasta_files WHERE paste_id IN (${placeholders(group.length, 2)})`,
        )
        .bind(now, ...group),
      db
        .prepare(`DELETE FROM pasta_files WHERE paste_id IN (${placeholders(group.length)})`)
        .bind(...group),
      db.prepare(`DELETE FROM pastas WHERE id IN (${placeholders(group.length)})`).bind(...group),
    ]);
  }
}

export interface GcSelection {
  expired: string[];
  stale: string[];
  abandoned: string[];
}

/** Pastas that should disappear: expired (incl. burned), unread for `gcDays`, abandoned uploads. */
export async function selectGarbage(
  db: D1Database,
  now: number,
  gcDays: number,
  pendingMaxAgeSeconds: number,
  limit: number,
): Promise<GcSelection> {
  const column = async (sql: string, ...params: unknown[]): Promise<string[]> => {
    const { results } = await db
      .prepare(sql)
      .bind(...params)
      .all<{ id: string }>();
    return results.map((row) => row.id);
  };
  const expired = await column(
    `SELECT id FROM pastas WHERE expires_at IS NOT NULL AND expires_at <= ?1 LIMIT ?2`,
    now,
    limit,
  );
  const stale =
    gcDays > 0
      ? await column(
          `SELECT id FROM pastas WHERE status = 'active' AND last_read_at < ?1 LIMIT ?2`,
          now - gcDays * 86_400,
          limit,
        )
      : [];
  const abandoned = await column(
    `SELECT id FROM pastas WHERE status = 'pending' AND created_at < ?1 LIMIT ?2`,
    now - pendingMaxAgeSeconds,
    limit,
  );
  return { expired, stale, abandoned };
}

export async function takeOutbox(
  db: D1Database,
  limit: number,
): Promise<{ r2_key: string; upload_id: string | null }[]> {
  const { results } = await db
    .prepare('SELECT r2_key, upload_id FROM r2_gc ORDER BY queued_at LIMIT ?1')
    .bind(limit)
    .all<{ r2_key: string; upload_id: string | null }>();
  return results;
}

export async function ackOutbox(db: D1Database, keys: string[]): Promise<void> {
  const statements = chunked(keys, ID_CHUNK).map((group) =>
    db.prepare(`DELETE FROM r2_gc WHERE r2_key IN (${placeholders(group.length)})`).bind(...group),
  );
  if (statements.length > 0) await db.batch(statements);
}

/** Puts keys on the outbox without deleting a row (used when an upload is aborted early). */
export async function enqueueKeys(
  db: D1Database,
  keys: { r2Key: string; uploadId: string | null }[],
  now: number,
): Promise<void> {
  const statements = keys.map((key) =>
    db
      .prepare('INSERT OR IGNORE INTO r2_gc (r2_key, upload_id, queued_at) VALUES (?1, ?2, ?3)')
      .bind(key.r2Key, key.uploadId, now),
  );
  if (statements.length > 0) await db.batch(statements);
}
