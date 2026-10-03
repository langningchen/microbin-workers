/** Small helpers shared by the page scripts. */

export function $<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T | null {
  return root.querySelector<T>(selector);
}

export function must<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T {
  const element = $<T>(selector, root);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
}

/** Data rendered by the server into <script type="application/json" id="boot">. */
export function readBoot<T>(): T | null {
  const element = document.getElementById('boot');
  return element?.textContent ? (JSON.parse(element.textContent) as T) : null;
}

/** Base for copied links: the operator's SHORT_URL, else this site. */
export function shareBase(): string {
  const meta = $<HTMLMetaElement>('meta[name="short-url"]');
  return meta?.content || location.origin;
}

export async function copyText(text: string, button?: HTMLElement, done = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Non-secure contexts have no clipboard API: fall back to a temporary textarea.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  if (button) {
    const original = button.textContent;
    button.textContent = done;
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  }
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = unit === 0 || value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[unit]}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiOptions {
  json?: unknown;
  headers?: Record<string, string>;
}

/** JSON request helper. Throws ApiError with the server's message on non-2xx responses. */
export async function api<T>(method: string, url: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.json !== undefined) headers['content-type'] = 'application/json';
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (options.json !== undefined) init.body = JSON.stringify(options.json);
  const response = await fetch(url, init);
  if (response.ok) return (await response.json()) as T;
  let message = `Request failed (${response.status})`;
  let code = 'error';
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    message = body.error?.message ?? message;
    code = body.error?.code ?? code;
  } catch {
    /* not JSON */
  }
  throw new ApiError(message, response.status, code);
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
