import * as assert from 'assert';

import { ActiveEditorAvailabilityTracker } from '../../editor/activeEditorAvailabilityTracker';

suite('activeEditorAvailabilityTracker', () => {
  test('reports availability for the active editor only', () => {
    const tracker = new ActiveEditorAvailabilityTracker<object>();
    const first = {};
    const second = {};

    tracker.setAvailable(first, true);
    tracker.setAvailable(second, false);

    assert.deepStrictEqual(tracker.setActive(first), { active: true, available: true });
    assert.deepStrictEqual(tracker.setActive(second), { active: true, available: false });
  });

  test('clears availability when the active editor is deleted', () => {
    const tracker = new ActiveEditorAvailabilityTracker<object>();
    const editor = {};

    tracker.setAvailable(editor, true);
    tracker.setActive(editor);

    assert.deepStrictEqual(tracker.delete(editor), { active: false, available: false });
  });
});