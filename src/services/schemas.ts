// zod/mini keeps the Worker small: the classic API ships every locale and validator (~700 KiB
// minified), the tree-shakeable mini API only what is used here (~20 KiB). Without a locale zod
// reports "Invalid input" for everything, so describeIssue() writes the messages itself.
import * as z from 'zod/mini';
import { badRequest } from '../errors';
import { PRIVACY_LEVELS } from '../shared/constants';
import { KDF_MAX_ITERATIONS, KDF_MIN_ITERATIONS } from '../shared/crypto';

const text = (max: number, min = 0) => z.string().check(z.minLength(min), z.maxLength(max));
const integer = (min: number, max: number) => z.int().check(z.minimum(min), z.maximum(max));

export const createSchema = z.strictObject({
  content: z._default(z.string(), ''),
  expiration: text(20, 1),
  burnAfter: z._default(integer(0, 10_000), 0),
  syntax: z._default(text(32), 'none'),
  privacy: z._default(z.enum(PRIVACY_LEVELS), 'public'),
  /** readonly / private: plain password (TLS-protected; hashed server side). */
  password: z.optional(text(1024, 1)),
  /** secret: parameters produced by the browser, the password never leaves it. */
  kdf: z.optional(
    z.strictObject({
      salt: text(64, 1),
      iter: integer(KDF_MIN_ITERATIONS, KDF_MAX_ITERATIONS),
      verifier: text(64, 1),
    }),
  ),
  files: z._default(
    z
      .array(
        z.strictObject({
          name: text(1024),
          size: integer(0, Number.MAX_SAFE_INTEGER),
        }),
      )
      .check(z.maxLength(100)),
    [],
  ),
  uploaderPassword: z.optional(text(1024)),
});
export type CreateInput = z.infer<typeof createSchema>;

export const completeMultipartSchema = z.strictObject({
  parts: z
    .array(
      z.strictObject({
        partNumber: integer(1, 10_000),
        etag: text(200, 1),
      }),
    )
    .check(z.minLength(1), z.maxLength(10_000)),
});

export const editSchema = z.strictObject({
  content: z.string(),
  password: z.optional(text(1024)),
});

interface LooseIssue {
  code: string;
  path: PropertyKey[];
  message: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  expected?: string;
  values?: unknown[];
  keys?: string[];
}

/** The value the client sent at `path` (zod issues do not carry it unless asked to). */
function valueAt(root: unknown, path: PropertyKey[]): unknown {
  let current = root;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/** Human readable description of one zod issue ("must be at least 1 characters" ...). */
export function describeIssue(issue: LooseIssue, received: unknown): string {
  const unit = issue.origin === 'string' ? ' characters' : issue.origin === 'array' ? ' items' : '';
  switch (issue.code) {
    case 'too_small':
      return `must be at least ${issue.minimum}${unit}`;
    case 'too_big':
      return `must be at most ${issue.maximum}${unit}`;
    case 'invalid_type':
      if (received === undefined) return 'is required';
      return issue.expected === 'int' ? 'must be a whole number' : `must be a ${issue.expected}`;
    case 'invalid_value':
      return `must be one of: ${(issue.values ?? []).join(', ')}`;
    case 'unrecognized_keys':
      return `unknown field${(issue.keys?.length ?? 0) > 1 ? 's' : ''}: ${(issue.keys ?? []).join(', ')}`;
    default:
      return issue.message;
  }
}

/** Parses with zod and turns the first issue into a friendly 400. */
export function parseOrThrow<T>(schema: z.ZodMiniType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0] as LooseIssue | undefined;
  if (!issue) throw badRequest('Invalid request', 'invalid_request');
  const where = issue.path.length > 0 ? `${issue.path.join('.')} ` : '';
  throw badRequest(
    `${where}${describeIssue(issue, valueAt(value, issue.path))}`,
    'invalid_request',
  );
}
