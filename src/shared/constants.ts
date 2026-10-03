/** Constants shared by the Worker (validation) and the browser (form rendering / uploads). */

export const MIB = 1024 * 1024;

export const PRIVACY_LEVELS = ['public', 'unlisted', 'readonly', 'private', 'secret'] as const;
export type Privacy = (typeof PRIVACY_LEVELS)[number];

export const PRIVACY_LABELS: Record<Privacy, string> = {
  public: 'Public',
  unlisted: 'Unlisted',
  readonly: 'Read-only',
  private: 'Private',
  secret: 'Secret',
};

export const EXPIRY_OPTIONS = [
  { id: '1min', label: '1 minute', seconds: 60 },
  { id: '10min', label: '10 minutes', seconds: 600 },
  { id: '1hour', label: '1 hour', seconds: 3_600 },
  { id: '24hour', label: '24 hours', seconds: 86_400 },
  { id: '3days', label: '3 days', seconds: 259_200 },
  { id: '1week', label: '1 week', seconds: 604_800 },
  { id: '1month', label: '1 month', seconds: 2_592_000 },
  { id: '6months', label: '6 months', seconds: 15_552_000 },
  { id: '1year', label: '1 year', seconds: 31_536_000 },
  { id: '2years', label: '2 years', seconds: 63_072_000 },
  { id: '4years', label: '4 years', seconds: 126_144_000 },
  { id: '8years', label: '8 years', seconds: 252_288_000 },
  { id: '16years', label: '16 years', seconds: 504_576_000 },
  { id: 'never', label: 'Never expire', seconds: null },
] as const;
export type ExpiryId = (typeof EXPIRY_OPTIONS)[number]['id'];
export const EXPIRY_IDS = EXPIRY_OPTIONS.map<ExpiryId>((option) => option.id);

export const BURN_OPTIONS = [
  { value: 0, label: 'No limit' },
  { value: 1, label: 'First read' },
  { value: 10, label: '10th read' },
  { value: 100, label: '100th read' },
  { value: 1000, label: '1000th read' },
  { value: 10000, label: '10000th read' },
] as const;
export const BURN_VALUES: readonly number[] = BURN_OPTIONS.map((option) => option.value);

/** Values are highlight.js language names (see src/client/highlight.ts). */
export const SYNTAX_OPTIONS = [
  { value: 'bash', label: 'Bash Shell' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'css', label: 'CSS' },
  { value: 'delphi', label: 'Delphi' },
  { value: 'diff', label: 'Diff' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'erlang', label: 'Erlang' },
  { value: 'go', label: 'Go' },
  { value: 'haskell', label: 'Haskell' },
  { value: 'xml', label: 'HTML / XML' },
  { value: 'java', label: 'Java' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'json', label: 'JSON' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'lisp', label: 'Lisp' },
  { value: 'lua', label: 'Lua' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'php', label: 'PHP' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'python', label: 'Python' },
  { value: 'r', label: 'R' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'rust', label: 'Rust' },
  { value: 'scala', label: 'Scala' },
  { value: 'sql', label: 'SQL' },
  { value: 'swift', label: 'Swift' },
  { value: 'ini', label: 'TOML / INI' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'yaml', label: 'YAML' },
] as const;
export const SYNTAX_VALUES: readonly string[] = [
  'none',
  'auto',
  ...SYNTAX_OPTIONS.map((o) => o.value),
];

// ── Upload protocol ──
/** Number of parts a file of `size` bytes is split into (at least one). */
export const partCount = (size: number, partBytes: number): number =>
  Math.max(1, Math.ceil(size / partBytes));
export const MAX_FILE_NAME_LENGTH = 200;

export const VIEW_MODES = ['gallery', 'stream', 'list'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/** Shape of the manifest that secret (client-side encrypted) pastas keep inside their ciphertext. */
export interface SecretManifest {
  v: 1;
  text: string;
  files: { name: string; type: string; size: number }[];
}
