import type { FC } from 'hono/jsx';
import type { Config } from '../config';
import type { ListItem } from '../db/pastas';
import { formatAgo } from '../lib/time';
import { formatBytes } from '../lib/bytes';
import { fileKind } from '../lib/mime';
import { Layout, Notice, Time } from './layout';
import pkg from '../../package.json';

export const AdminLoginPage: FC<{
  cfg: Config;
  error?: string | undefined;
  username?: string | undefined;
}> = ({ cfg, error, username }) => (
  <Layout cfg={cfg} title="Administrator">
    <form id="auth-form" class="panel" method="post" action="/admin/login">
      <label for="username">Administrator username</label>
      <input
        id="username"
        name="username"
        placeholder="Username"
        autocomplete="username"
        value={username}
        required
      />
      <label for="password">Administrator password</label>
      <input
        id="password"
        name="password"
        type="password"
        placeholder="Password"
        autocomplete="current-password"
        required
      />
      <button type="submit">Sign in</button>
      <Notice message={error} />
    </form>
  </Layout>
);

const yesNo = (value: boolean) => (value ? 'true' : 'false');

function settings(cfg: Config): [string, string][] {
  const set = (value: unknown) => (value ? 'set' : 'unset');
  return [
    ['TITLE', cfg.title || 'unset'],
    ['PUBLIC_URL', cfg.publicUrl || 'unset'],
    ['SHORT_URL', cfg.shortUrl || 'unset'],
    ['CUSTOM_CSS', cfg.customCss || 'unset'],
    ['WIDE', yesNo(cfg.wide)],
    ['NO_LISTING', yesNo(cfg.noListing)],
    ['NO_FILE_UPLOAD', yesNo(cfg.noFileUpload)],
    ['QR', yesNo(cfg.qr)],
    ['EDITABLE', yesNo(cfg.editable)],
    ['HASH_IDS / ID_LENGTH', `${yesNo(cfg.hashIds)} / ${cfg.idLength}`],
    ['PRIVATE (unlisted)', yesNo(cfg.privateEnabled)],
    ['ENABLE_READONLY', yesNo(cfg.enableReadonly)],
    ['ENCRYPTION_SERVER_SIDE', yesNo(cfg.encryptionServerSide)],
    ['ENCRYPTION_CLIENT_SIDE', yesNo(cfg.encryptionClientSide)],
    ['DEFAULT_PRIVACY', cfg.defaultPrivacy],
    ['DEFAULT_EXPIRY / MAX_EXPIRY', `${cfg.defaultExpiry} / ${cfg.maxExpiry}`],
    ['ETERNAL_PASTA', yesNo(cfg.eternalPasta)],
    ['GC_DAYS', String(cfg.gcDays)],
    ['ENABLE_BURN_AFTER', yesNo(cfg.enableBurnAfter)],
    ['MAX_TEXT_KB', String(cfg.maxTextBytes / 1024)],
    ['MAX_FILES', String(cfg.maxFiles)],
    [
      'MAX_FILE_SIZE (plain / encrypted)',
      `${formatBytes(cfg.maxFileBytesUnencrypted)} / ${formatBytes(cfg.maxFileBytesEncrypted)}`,
    ],
    ['PBKDF2_ITERATIONS', String(cfg.pbkdf2Iterations)],
    ['READONLY', yesNo(cfg.readonlyMode)],
    ['UPLOADER_PASSWORD', set(cfg.uploaderPassword)],
    ['BASIC_AUTH_*', set(cfg.basicAuth)],
    ['ADMIN_*', set(cfg.admin)],
  ];
}

export const AdminPage: FC<{
  cfg: Config;
  items: ListItem[];
  page: number;
  hasMore: boolean;
  now: number;
  stats: { pastas: number; bytes: number; pending: number; queued: number };
  message?: string | undefined;
}> = ({ cfg, items, page, hasMore, now, stats, message }) => (
  <Layout cfg={cfg} title="Administration">
    <h2>Administration</h2>
    <div class="admin-summary">
      <table>
        <tbody>
          <tr>
            <td>
              <b>Version</b>
            </td>
            <td>{pkg.version}</td>
          </tr>
          <tr>
            <td>
              <b>Uploads</b>
            </td>
            <td>
              {stats.pastas} ({formatBytes(stats.bytes)})
            </td>
          </tr>
          <tr>
            <td>
              <b>Unfinished uploads</b>
            </td>
            <td>{stats.pending}</td>
          </tr>
          <tr>
            <td>
              <b>Files waiting for deletion</b>
            </td>
            <td>{stats.queued}</td>
          </tr>
        </tbody>
      </table>
      <form method="post" action="/admin/cleanup">
        <button type="submit" class="small-button">
          Run cleanup now
        </button>{' '}
        <button type="submit" formaction="/admin/logout" class="small-button">
          Sign out
        </button>
      </form>
    </div>

    <Notice kind="ok" message={message} />
    {cfg.warnings.length > 0 && (
      <>
        <h4>Warnings</h4>
        <ul>
          {cfg.warnings.map((warning) => (
            <li>{warning}</li>
          ))}
        </ul>
      </>
    )}

    <h3>Uploads</h3>
    <div class="table-scroll">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Valid</th>
            <th>Size</th>
            <th>Privacy</th>
            <th>Content</th>
            <th>Hits</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr>
              <td>
                <a href={`/upload/${item.id}`}>{item.id}</a>
                {item.kind === 'url' && <small class="muted"> (link)</small>}
              </td>
              <td>
                <Time ts={item.created_at} /> →{' '}
                {item.expires_at ? <Time ts={item.expires_at} /> : 'never'}
              </td>
              <td>{formatBytes(item.total_size)}</td>
              <td>
                {item.privacy}
                {item.privacy === 'private' && ' (server-encrypted)'}
                {item.privacy === 'secret' && ' (client-encrypted)'}
              </td>
              <td class="links">
                {item.has_content === 1 &&
                  item.privacy !== 'secret' &&
                  item.privacy !== 'private' && <a href={`/raw/${item.id}`}>Text</a>}
                {item.file_count > 0 && (
                  <a href={`/upload/${item.id}`}>
                    {item.file_count === 1 && item.first_file
                      ? { image: 'Image', video: 'Video', audio: 'Audio', other: 'File' }[
                          fileKind(item.first_file)
                        ]
                      : `${item.file_count} Files`}
                  </a>
                )}
              </td>
              <td>
                <small>
                  {item.read_count} hits
                  <br />
                  last {formatAgo(item.last_read_at, now)}
                </small>
              </td>
              <td>
                <form
                  method="post"
                  action={`/admin/remove/${item.id}`}
                  data-confirm={`Remove ${item.id}?`}
                >
                  <button type="submit" class="small-button danger">
                    Remove
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <p class="pager">
      {page > 1 && <a href={`/admin?page=${page - 1}`}>← Newer</a>}
      {hasMore && <a href={`/admin?page=${page + 1}`}>Older →</a>}
    </p>

    <h3>Configuration</h3>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Setting</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {settings(cfg).map(([name, value]) => (
            <tr>
              <td>{name}</td>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Layout>
);
