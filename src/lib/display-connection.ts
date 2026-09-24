export const DISPLAY_TOKEN_PATTERN = /^(?:[23456789abcdefghjkmnpqrstvwxyz]{8}|cdu_[A-Za-z0-9_-]{43})$/;

export function normalizeApiOrigin(input: string): string {
  const url = new URL(input.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('INVALID_API_ORIGIN');
  }
  return url.origin;
}
