import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { equalSecret, type Config } from './config.js';
export const TRUST_LIFETIME = 30 * 24 * 3600_000;
export const hashTrusted = (token: string) => createHash('sha256').update(token).digest('hex');
const binding = (config: Config) => hashTrusted(JSON.stringify([config.passwordHash, config.twoFactor?.secret, config.origin]));
export function trustedBrowsers(config: Config, now = Date.now()) {
  return config.twoFactor ? (config.trustedBrowsers || []).filter(b => b.expires > now && equalSecret(b.binding, binding(config))) : [];
}
export function trustedBrowser(config: Config, token: string, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
  const hash = hashTrusted(token);
  return trustedBrowsers(config, now).find(b => equalSecret(b.hash, hash));
}
export function browserLabel(userAgent: string) {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\/|CriOS\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser';
  const device = /iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows' : /Macintosh/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : '';
  return browser + (device ? ` · ${device}` : '');
}
/** Only issue after fresh password + second-factor verification. Persist before setting the cookie. */
export function newTrustedBrowser(config: Config, userAgent: string, now = Date.now()) {
  if (!config.twoFactor) throw new Error('Enable 2FA before trusting a browser.');
  const token = randomBytes(32).toString('hex');
  const record = { id: randomUUID(), hash: hashTrusted(token), binding: binding(config), label: browserLabel(userAgent), created: now, expires: now + TRUST_LIFETIME };
  return { token, record, records: [...trustedBrowsers(config, now).slice(-19), record] };
}
