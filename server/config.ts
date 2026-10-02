import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
export interface Config { agentToken: string; passwordSalt: string; passwordHash: string; port: number; origin?: string; projectsRoot: string;
  enrollmentHash?: string;
  trustedBrowsers?: { id: string; hash: string; binding: string; label: string; created: number; expires: number }[];
  twoFactor?: { secret: string; lastUsedStep: number; recoveryHashes: string[] };
}
export const configPath = () => process.env.PI_HUB_CONFIG || path.join(homedir(), '.config/pi-hub/config.json');
export function createConfig(password: string, root: string): Config {
  if (password.length < 12) throw new Error('Use a password of at least 12 characters');
  const passwordSalt = randomBytes(16).toString('hex');
  return { agentToken: randomBytes(32).toString('hex'), passwordSalt,
    passwordHash: scryptSync(password, passwordSalt, 64).toString('hex'), port: 7433, projectsRoot: path.resolve(root) };
}
export function saveConfig(config: Config) {
  mkdirSync(path.dirname(configPath()), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
export function replaceConfig(config: Config) {
  const temporary = configPath() + '.' + randomBytes(8).toString('hex') + '.tmp';
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, configPath());
}
export const enrollmentTokenPath = () => configPath() + '.2fa-enrollment-token';
export function ensureEnrollmentToken(config: Config, hash: (token: string) => string) {
  if (config.twoFactor) return;
  if (config.enrollmentHash && existsSync(enrollmentTokenPath())) { chmodSync(enrollmentTokenPath(), 0o600); return; }
  const token = randomBytes(32).toString('hex');
  writeFileSync(enrollmentTokenPath(), token + '\n', { mode: 0o600 });
  chmodSync(enrollmentTokenPath(), 0o600);
  config.enrollmentHash = hash(token); replaceConfig(config);
}
export function loadConfig(): Config { return JSON.parse(readFileSync(configPath(), 'utf8')); }
export function equalSecret(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function checkPassword(password: string, c: Config) {
  return equalSecret(scryptSync(password, c.passwordSalt, 64).toString('hex'), c.passwordHash);
}
