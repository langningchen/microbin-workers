const encoder = new TextEncoder();

/**
 * Constant-time string comparison. Both values are hashed to a fixed size first so neither the
 * content nor the length of the expected value leaks through timing.
 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}
