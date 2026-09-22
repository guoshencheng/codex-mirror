export const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;

export function sessionCookieName(): string {
  return process.env.NODE_ENV === 'production' ? '__Host-dashboard_session' : 'dashboard_session';
}

export function serializeSessionCookie(token: string, maxAgeSeconds = SESSION_LIFETIME_SECONDS): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${sessionCookieName()}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${secure}`;
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${sessionCookieName()}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${secure}`;
}
