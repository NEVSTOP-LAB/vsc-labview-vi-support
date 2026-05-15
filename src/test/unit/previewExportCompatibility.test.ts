import * as assert from 'assert';

import { getUnsafePreviewExportReason } from '../../scripts/labviewRuntime';

suite('previewExportCompatibility', () => {
  test('blocks preview export for LabVIEW 2020', () => {
    const reason = getUnsafePreviewExportReason({ major: 20, minor: 0 });

    assert.ok(reason);
    assert.match(reason ?? '', /LabVIEW 2020/);
    assert.match(reason ?? '', /自动禁用/);
  });

  test('allows preview export for newer LabVIEW versions', () => {
    assert.strictEqual(getUnsafePreviewExportReason({ major: 25, minor: 0 }), null);
    assert.strictEqual(getUnsafePreviewExportReason({ major: 24, minor: 0 }), null);
  });
});