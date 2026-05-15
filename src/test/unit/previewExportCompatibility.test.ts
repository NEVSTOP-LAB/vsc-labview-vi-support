import * as assert from 'assert';

import { getUnsafePreviewExportReason } from '../../scripts/labviewRuntime';

suite('previewExportCompatibility', () => {
  test('allows preview export for LabVIEW 2020', () => {
    assert.strictEqual(getUnsafePreviewExportReason({ major: 20, minor: 0 }), null);
  });

  test('allows preview export for newer LabVIEW versions', () => {
    assert.strictEqual(getUnsafePreviewExportReason({ major: 25, minor: 0 }), null);
    assert.strictEqual(getUnsafePreviewExportReason({ major: 24, minor: 0 }), null);
  });
});