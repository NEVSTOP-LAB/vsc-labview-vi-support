import * as assert from 'assert';

import { getUnsafePreviewExportReason } from '../../scripts/labviewRuntime';
import { isRetryableImageWorkerFailure } from '../../scripts/runtime/viPropsRuntime';

suite('previewExportCompatibility', () => {
  test('allows preview export for LabVIEW 2020', () => {
    assert.strictEqual(getUnsafePreviewExportReason({ major: 20, minor: 0 }), null);
  });

  test('allows preview export for newer LabVIEW versions', () => {
    assert.strictEqual(getUnsafePreviewExportReason({ major: 25, minor: 0 }), null);
    assert.strictEqual(getUnsafePreviewExportReason({ major: 24, minor: 0 }), null);
  });

  test('does not retry deterministic target mismatch failures', () => {
    assert.strictEqual(isRetryableImageWorkerFailure({
      selection: 'failed-to-match-target-labview-application',
      reason: 'Connected to C:\\Program Files (x86)\\National Instruments\\LabVIEW 2020, which does not match the requested target.',
    }), false);

    assert.strictEqual(isRetryableImageWorkerFailure({
      selection: 'failed-to-create-labview-application',
      reason: 'Timed out waiting for the requested LabVIEW target to register for COM reuse.',
    }), false);
  });

  test('keeps retries for generic worker export failures', () => {
    assert.strictEqual(isRetryableImageWorkerFailure({
      selection: 'failed-to-export-panels',
      reason: 'Image export worker failed for panels=fp,bd.',
    }), true);
  });
});