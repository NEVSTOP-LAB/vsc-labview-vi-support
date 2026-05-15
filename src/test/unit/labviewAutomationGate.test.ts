import * as assert from 'assert';

import { createLabVIEWAutomationGate } from '../../scripts/labviewAutomationGate';

suite('labviewAutomationGate', () => {
  test('runs queued operations strictly in submission order', async () => {
    const gate = createLabVIEWAutomationGate();
    const steps: string[] = [];

    const slow = gate.run(async () => {
      steps.push('slow:start');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      steps.push('slow:end');
      return 'slow';
    });

    const fast = gate.run(async () => {
      steps.push('fast:start');
      steps.push('fast:end');
      return 'fast';
    });

    const results = await Promise.all([slow, fast]);

    assert.deepStrictEqual(results, ['slow', 'fast']);
    assert.deepStrictEqual(steps, [
      'slow:start',
      'slow:end',
      'fast:start',
      'fast:end',
    ]);
  });

  test('continues processing after a queued operation fails', async () => {
    const gate = createLabVIEWAutomationGate();
    const steps: string[] = [];

    await assert.rejects(
      gate.run(async () => {
        steps.push('first');
        throw new Error('boom');
      }),
      /boom/,
    );

    const value = await gate.run(async () => {
      steps.push('second');
      return 42;
    });

    assert.strictEqual(value, 42);
    assert.deepStrictEqual(steps, ['first', 'second']);
  });
});