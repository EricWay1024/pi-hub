import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConfig, ensureEnrollmentToken, enrollmentTokenPath, replaceConfig, saveConfig } from '../server/config.js';
import { hashRecovery, newEnrollment } from '../server/two-factor.js';
test('enrollment token and atomic authentication configuration remain owner-only', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'hub-auth-config-')), previous = process.env.PI_HUB_CONFIG;
  process.env.PI_HUB_CONFIG = path.join(temp, 'config.json');
  try {
    const config = createConfig('test-password-long', temp); saveConfig(config);
    ensureEnrollmentToken(config, hashRecovery);
    const token = readFileSync(enrollmentTokenPath(), 'utf8').trim();
    assert.equal(token.length, 64); assert.equal(config.enrollmentHash, hashRecovery(token));
    assert.equal(statSync(enrollmentTokenPath()).mode & 0o777, 0o600);
    chmodSync(enrollmentTokenPath(), 0o644); ensureEnrollmentToken(config, hashRecovery);
    assert.equal(statSync(enrollmentTokenPath()).mode & 0o777, 0o600);
    assert.equal(readFileSync(enrollmentTokenPath(), 'utf8').trim(), token);
    config.twoFactor = { secret: newEnrollment().secret, lastUsedStep: 123, recoveryHashes: [] };
    replaceConfig(config);
    assert.equal(statSync(process.env.PI_HUB_CONFIG).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(process.env.PI_HUB_CONFIG, 'utf8')).twoFactor.lastUsedStep, 123);
    assert.ok(!readdirSync(temp).some(file => file.endsWith('.tmp')));
  } finally {
    if (previous === undefined) delete process.env.PI_HUB_CONFIG; else process.env.PI_HUB_CONFIG = previous;
    rmSync(temp, { recursive: true });
  }
});
