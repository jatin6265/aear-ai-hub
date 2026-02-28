/**
 * Shared utility functions for the worker runtime.
 */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sanitizeName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function truncateErrorText(value: unknown, max = 500): string {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

export function isRetryableStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  const err = error as { name?: string; message?: string };
  const name = typeof err.name === 'string' ? err.name.toLowerCase() : '';
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : String(error).toLowerCase();
  return (
    name === 'aborterror' ||
    message.includes('fetch failed') ||
    message.includes('enotfound') ||
    message.includes('eai_again') ||
    message.includes('connect timeout') ||
    message.includes('und_err_connect_timeout') ||
    message.includes('etimedout') ||
    message.includes('econnreset') ||
    message.includes('socket hang up')
  );
}
