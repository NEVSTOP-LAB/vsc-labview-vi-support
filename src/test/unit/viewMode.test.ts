import * as assert from 'assert';

import {
  isViewMode,
  normalizeViewMode,
  preferWorkspaceConfigurationTarget,
} from '../../editor/viewMode';

suite('viewMode', () => {
  test('normalizeViewMode falls back to table-only for invalid values', () => {
    assert.strictEqual(normalizeViewMode('both'), 'both');
    assert.strictEqual(normalizeViewMode('table-only'), 'table-only');
    assert.strictEqual(normalizeViewMode('preview-only'), 'preview-only');
    assert.strictEqual(normalizeViewMode('preview'), 'table-only');
    assert.strictEqual(normalizeViewMode(undefined), 'table-only');
  });

  test('isViewMode accepts only supported values', () => {
    assert.strictEqual(isViewMode('both'), true);
    assert.strictEqual(isViewMode('table-only'), true);
    assert.strictEqual(isViewMode('preview-only'), true);
    assert.strictEqual(isViewMode('preview'), false);
    assert.strictEqual(isViewMode(1), false);
  });

  test('preferWorkspaceConfigurationTarget uses workspace scope when available', () => {
    assert.strictEqual(preferWorkspaceConfigurationTarget(false, 0), false);
    assert.strictEqual(preferWorkspaceConfigurationTarget(true, 0), true);
    assert.strictEqual(preferWorkspaceConfigurationTarget(false, 1), true);
  });
});