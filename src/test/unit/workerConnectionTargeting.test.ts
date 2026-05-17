import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function readWorkerScript(fileName: string): string {
  const workspaceRoot = path.resolve(__dirname, '../../..');
  return fs.readFileSync(path.join(workspaceRoot, 'workers', fileName), 'utf8');
}

function getSubBody(scriptText: string, name: string): string {
  const match = scriptText.match(new RegExp(`Sub ${name}\\([\\s\\S]*?End Sub`));
  assert.ok(match, `${name} should exist in the worker script`);
  return match[0];
}

suite('worker connection targeting', () => {
  const cases = [
    { fileName: 'labview_session_host.vbs', subroutine: 'EnsureLabVIEWConnected' },
  ];

  for (const { fileName, subroutine } of cases) {
    test(`${fileName} skips generic COM activation when targetExe is pinned`, () => {
      const body = getSubBody(readWorkerScript(fileName), subroutine);
      const match = body.match(/If Len\(targetExe\) > 0 And Not CanUseGenericComActivationForTarget\(targetExe\) Then([\s\S]*?)Else([\s\S]*?)End If/);

      assert.ok(match, 'targetExe guard should wrap the CreateObject path');
      assert.ok(match[1].includes('Timed out waiting for the requested LabVIEW target to register for COM reuse.'));
      assert.ok(!match[1].includes('CreateObject("LabVIEW.Application")'));
      assert.ok(match[2].includes('CreateObject("LabVIEW.Application")'));
      assert.ok(body.includes('CanUseGenericComActivationForTarget(targetExe)'));
    });

    test(`${fileName} launches a pinned target at most once per request`, () => {
      const body = getSubBody(readWorkerScript(fileName), subroutine);

      assert.ok(body.includes('launchIssued = False'));
      assert.ok(body.includes('If Not launchIssued And ShouldActivateTargetInstance(attempts) Then'));
      assert.ok(body.includes('launchIssued = True'));
      assert.ok(body.includes('If launchIssued Then'));
    });
  }
});
