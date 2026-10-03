import { raw } from 'hono/html';
import type { FC } from 'hono/jsx';
import type { Config } from '../config';
import type { ListItem } from '../db/pastas';
import { fileKind } from '../lib/mime';
import type { PasteBoot } from '../shared/boot';
import { Layout, Notice, Time } from './layout';

const Pager: FC<{ path: string; page: number; hasMore: boolean }> = ({ path, page, hasMore }) => (
  <p class="pager">
    {page > 1 && <a href={`${path}?page=${page - 1}`}>← Newer</a>}
    {hasMore && <a href={`${path}?page=${page + 1}`}>Older →</a>}
  </p>
);

const ContentLinks: FC<{ item: ListItem }> = ({ item }) => {
  const first = item.first_file;
  return (
    <>
      {item.has_content === 1 && <a href={`/raw/${item.id}`}>Text</a>}
      {item.file_count > 1 && <a href={`/upload/${item.id}`}>{item.file_count} Files</a>}
      {item.file_count === 1 && first && (
        <a href={`/file/${item.id}/0?preview=true`}>
          {{ image: 'Image', video: 'Video', audio: 'Audio', other: 'File' }[fileKind(first)]}
        </a>
      )}
    </>
  );
};

const Expiry: FC<{ ts: number | null }> = ({ ts }) => (ts ? <Time ts={ts} /> : <>Never</>);

export const ListPage: FC<{
  cfg: Config;
  items: ListItem[];
  page: number;
  hasMore: boolean;
}> = ({ cfg, items, page, hasMore }) => {
  const texts = items.filter((item) => item.kind === 'text');
  const urls = items.filter((item) => item.kind === 'url');
  const Row: FC<{ item: ListItem }> = ({ item }) => (
    <tr>
      <td>
        <a href={`/upload/${item.id}`}>{item.id}</a>
        <a
          class="copy-button"
          data-copy-path={item.kind === 'url' ? `/u/${item.id}` : `/p/${item.id}`}
        >
          Copy
        </a>
      </td>
      <td>
        <Time ts={item.created_at} />
      </td>
      <td>
        <Expiry ts={item.expires_at} />
      </td>
      <td class="links">
        {item.kind === 'url' ? (
          <a href={`/url/${item.id}`}>Redirect</a>
        ) : (
          <ContentLinks item={item} />
        )}
      </td>
      <td class="links">
        {item.editable === 1 && <a href={`/edit/${item.id}`}>Edit</a>}
        {item.editable === 1 && <a href={`/remove/${item.id}`}>Remove</a>}
      </td>
    </tr>
  );
  const Head: FC = () => (
    <thead>
      <tr>
        <th>Key</th>
        <th>Created</th>
        <th>Expires</th>
        <th>Contents</th>
        <th></th>
      </tr>
    </thead>
  );
  return (
    <Layout cfg={cfg} title="Uploads">
      {items.length === 0 ? (
        <p>
          No uploads yet. 😔 Create one <a href="/">here</a>.
        </p>
      ) : (
        <>
          <h3>Uploads</h3>
          <div class="table-scroll">
            <table>
              <Head />
              <tbody>
                {texts.map((item) => (
                  <Row item={item} />
                ))}
              </tbody>
            </table>
          </div>
          {urls.length > 0 && (
            <>
              <h3>URL Redirects</h3>
              <div class="table-scroll">
                <table>
                  <Head />
                  <tbody>
                    {urls.map((item) => (
                      <Row item={item} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <Pager path="/list" page={page} hasMore={hasMore} />
        </>
      )}
    </Layout>
  );
};

export const EditPage: FC<{
  cfg: Config;
  id: string;
  content: string;
  /** Re-enter password (read-only / private uploads). */
  needsPassword: boolean;
  error?: string | undefined;
}> = ({ cfg, id, content, needsPassword, error }) => (
  <Layout cfg={cfg} title={`Edit ${id}`}>
    <form method="post" action={`/edit/${id}`}>
      <h4>
        Editing upload <i>{id}</i>
      </h4>
      <input type="hidden" name="intent" value="save" />
      <label for="content">Content</label>
      <textarea id="content" name="content" class="editor" autofocus={!error}>
        {content}
      </textarea>
      {needsPassword && (
        <div>
          <label for="password">Re-enter Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="off"
            autofocus={Boolean(error)}
            required
          />
        </div>
      )}
      <Notice message={error} />
      <p>
        <button type="submit" class="primary">
          Save
        </button>{' '}
        <a href={`/upload/${id}`}>Cancel</a>
      </p>
    </form>
  </Layout>
);

export const RemovePage: FC<{
  cfg: Config;
  id: string;
  /** How the visitor proves they may delete: nothing, a password, or a browser-derived key. */
  proof: 'none' | 'password' | 'secret';
  admin: boolean;
  error?: string | undefined;
  boot?: PasteBoot;
}> = ({ cfg, id, proof, admin, error, boot }) => (
  <Layout
    cfg={cfg}
    title={`Remove ${id}`}
    {...(boot ? { scripts: ['paste.js' as const], boot } : {})}
  >
    <form
      id={proof === 'secret' ? 'secret-remove-form' : 'remove-form'}
      class="panel"
      method="post"
      action={`/remove/${id}`}
    >
      <h3>
        Remove upload <i>{id}</i>?
      </h3>
      <p>This permanently deletes its text and all attached files.</p>
      {proof === 'password' && !admin && (
        <div>
          <label for="password-field">Password</label>
          <input id="password-field" name="password" type="password" autocomplete="off" required />
        </div>
      )}
      {proof === 'secret' && !admin && (
        <div>
          <label for="password-field">Password</label>
          <input id="password-field" type="password" autocomplete="off" required />
          <noscript>
            <p class="notice error">JavaScript is required to remove secret uploads.</p>
          </noscript>
        </div>
      )}
      <Notice message={error} />
      <p>
        <button type="submit" class="danger">
          Remove{admin ? ' (administrator)' : ''}
        </button>{' '}
        <a href={`/upload/${id}`}>Cancel</a>
      </p>
      <p id="remove-status" class="notice error" role="alert" hidden></p>
    </form>
  </Layout>
);

export const QrPage: FC<{ cfg: Config; id: string; svg: string; url: string }> = ({
  cfg,
  id,
  svg,
  url,
}) => (
  <Layout cfg={cfg} title={`QR ${id}`}>
    <p>
      <a href={`/upload/${id}`}>Back to Upload</a>
    </p>
    <div class="qr">{raw(svg) /* generated by uqr: only <rect>/<path> geometry */}</div>
    <p class="center muted small">{url}</p>
  </Layout>
);
