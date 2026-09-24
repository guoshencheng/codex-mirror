import { expectedAppOrigin } from '../auth/csrf';

export function collectorPublicOrigin(): string {
  const raw = process.env.COLLECTOR_PUBLIC_ORIGIN || expectedAppOrigin();
  const url = new URL(raw);
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('INVALID_COLLECTOR_PUBLIC_ORIGIN');
  }
  return url.origin;
}
