import { createHash, randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { equalSecret, type Config } from './config.js';
export const SESSION_LIFETIME = 12 * 3600_000;
export function hashRecovery(code: string) { return createHash('sha256').update(code.replace(/[\s-]/g, '').toLowerCase()).digest('hex'); }
export function totp(secret: string) { return new TOTP({ issuer: 'Pi Hub', label: 'Workspace', algorithm: 'SHA1', digits: 6, period: 30, secret }); }
export function newEnrollment() {
  const secret = new Secret({ size: 20 }).base32;
  return { secret, uri: totp(secret).toString() };
}
export function validTotpStep(secret: string, code: unknown, now = Date.now()): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return null;
  const delta = totp(secret).validate({ token: code.trim(), timestamp: now, window: 1 });
  return delta === null ? null : Math.floor(now / 30_000) + delta;
}
export function recoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => randomBytes(16).toString('hex').match(/.{4}/g)!.join('-'));
}
/** Call only after the password is verified. State mutations must be persisted before issuing a session. */
export function verifySecondFactor(config: Config, code: unknown, recovery: unknown, now = Date.now()): boolean {
  if (!config.twoFactor) return true;
  if (typeof recovery === 'string' && recovery.length <= 100) {
    const hash = hashRecovery(recovery);
    const index = config.twoFactor.recoveryHashes.findIndex(stored => equalSecret(hash, stored));
    if (index < 0) return false;
    config.twoFactor.recoveryHashes.splice(index, 1); return true;
  }
  const step = validTotpStep(config.twoFactor.secret, code, now);
  if (step === null || step <= config.twoFactor.lastUsedStep) return false;
  config.twoFactor.lastUsedStep = step; return true;
}
