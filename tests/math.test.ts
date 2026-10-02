import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMath } from '../shared/math.js';
test('LaTeX delimiters become math while source code is preserved', () => {
  assert.equal(normalizeMath('A \\(x^2\\) here'), 'A $x^2$ here');
  assert.equal(normalizeMath('\\[x^2\\]'), '\n\n$$\nx^2\n$$\n\n');
  const code = '```tex\n\\[x^2\\]\n```\nInline `\\(x\\)` and $y$';
  assert.equal(normalizeMath(code), code);
  const tilde = '~~~tex\n\\[x^2\\]\n~~~\n\\(z\\)';
  assert.equal(normalizeMath(tilde), '~~~tex\n\\[x^2\\]\n~~~\n$z$');
});
