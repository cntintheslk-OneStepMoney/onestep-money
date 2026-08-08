import test from 'node:test';
import assert from 'node:assert/strict';
import { installPdfCompatibilityGlobals } from '../pdf-service.js';

test('PDF compatibility installs DOMMatrix without loading the native canvas binding', () => {
  const original = globalThis.DOMMatrix;
  try {
    delete globalThis.DOMMatrix;
    installPdfCompatibilityGlobals();
    assert.equal(typeof globalThis.DOMMatrix, 'function');
    const matrix = new globalThis.DOMMatrix([1, 0, 0, 1, 12, 34]);
    assert.equal(matrix.e, 12);
    assert.equal(matrix.f, 34);
  } finally {
    if (original) globalThis.DOMMatrix = original;
    else delete globalThis.DOMMatrix;
  }
});
