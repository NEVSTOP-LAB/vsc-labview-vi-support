import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildDirectoryMarkerFileName,
  clearDirectoryLabVIEWMarkers,
  formatLabVIEWDisplayName,
  parseDirectoryMarkerFileName,
  parseLvprojVersion,
  resolveDirectoryLabVIEWVersion,
  resolveLabVIEWVersionForPath,
  writeDirectoryLabVIEWMarker,
} from '../../scripts/labviewVersionResolver';

suite('labviewVersionResolver', () => {
  let tempRoot = '';

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-version-resolver-'));
  });

  teardown(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('parses marker file names with the compatible x86/x64 marker formats', () => {
    assert.deepStrictEqual(parseDirectoryMarkerFileName('DEV ENVIRONMENT LabVIEW 2020'), {
      major: 20,
      minor: 0,
      architecture: 'x86',
    });
    assert.deepStrictEqual(parseDirectoryMarkerFileName('DEV ENVIRONMENT LabVIEW 2020(64bit)'), {
      major: 20,
      minor: 0,
      architecture: 'x64',
    });
    assert.deepStrictEqual(parseDirectoryMarkerFileName('DEV ENVIRONMENT LabVIEW 2020（64bit)'), {
      major: 20,
      minor: 0,
      architecture: 'x64',
    });
    assert.deepStrictEqual(parseDirectoryMarkerFileName('DEV ENVIRONMENT LabVIEW 2019 (32bit)'), {
      major: 19,
      minor: 0,
      architecture: 'x86',
    });
    assert.strictEqual(buildDirectoryMarkerFileName({ major: 25, minor: 0 }, 'x86'), 'DEV ENVIRONMENT LabVIEW 2025');
    assert.strictEqual(buildDirectoryMarkerFileName({ major: 25, minor: 0 }, 'x64'), 'DEV ENVIRONMENT LabVIEW 2025(64bit)');
  });

  test('parses lvproj versions from common XML forms', () => {
    assert.deepStrictEqual(
      parseLvprojVersion('<Project Type="Project" LVVersion="20008000"></Project>'),
      { major: 20, minor: 0 },
    );
    assert.deepStrictEqual(
      parseLvprojVersion('<Project><Property Name="LVVersion" Type="Str">17.0</Property></Project>'),
      { major: 17, minor: 0 },
    );
  });

  test('prefers a directory marker over lvproj and VI saved version fallback', async () => {
    const projectRoot = path.join(tempRoot, 'project');
    const childDir = path.join(projectRoot, 'subdir');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'DEV ENVIRONMENT LabVIEW 2020'), '');
    fs.writeFileSync(path.join(childDir, 'demo.lvproj'), '<Project LVVersion="25008000"></Project>');

    const resolved = await resolveLabVIEWVersionForPath(
      path.join(childDir, 'demo.vi'),
      async () => ({ major: 17, minor: 0 }),
    );

    assert.ok(resolved);
    assert.strictEqual(resolved?.source, 'directory-marker');
    assert.strictEqual(resolved?.major, 20);
    assert.strictEqual(resolved?.scopeDirectory, projectRoot);
  });

  test('prefers the nearest marker across ancestor directories', async () => {
    const projectRoot = path.join(tempRoot, 'project');
    const childDir = path.join(projectRoot, 'subdir');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'DEV ENVIRONMENT LabVIEW 2020'), '');
    fs.writeFileSync(path.join(childDir, 'DEV ENVIRONMENT LabVIEW 2025(64bit)'), '');

    const resolved = await resolveDirectoryLabVIEWVersion(childDir);

    assert.ok(resolved);
    assert.strictEqual(resolved?.source, 'directory-marker');
    assert.strictEqual(resolved?.major, 25);
    assert.strictEqual(resolved?.architecture, 'x64');
    assert.strictEqual(resolved?.scopeDirectory, childDir);
  });

  test('falls back to lvproj when no marker exists', async () => {
    const projectRoot = path.join(tempRoot, 'project');
    const childDir = path.join(projectRoot, 'subdir');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'demo.lvproj'), '<Project Type="Project" LVVersion="17008000"></Project>');

    const resolved = await resolveLabVIEWVersionForPath(
      path.join(childDir, 'demo.vi'),
      async () => ({ major: 25, minor: 0 }),
    );

    assert.ok(resolved);
    assert.strictEqual(resolved?.source, 'lvproj');
    assert.strictEqual(resolved?.major, 17);
    assert.strictEqual(resolved?.scopeDirectory, projectRoot);
  });

  test('falls back to the VI saved version when no directory hints exist', async () => {
    const projectRoot = path.join(tempRoot, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });

    const resolved = await resolveLabVIEWVersionForPath(
      path.join(projectRoot, 'demo.vi'),
      async () => ({ major: 18, minor: 0 }),
    );

    assert.ok(resolved);
    assert.strictEqual(resolved?.source, 'vi');
    assert.strictEqual(resolved?.major, 18);
  });

  test('writes a marker file and clears stale markers', async () => {
    const projectRoot = path.join(tempRoot, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'DEV ENVIRONMENT LabVIEW 2020'), '');

    const markerPath = await writeDirectoryLabVIEWMarker(projectRoot, { major: 25, minor: 0 }, 'x64');

    assert.strictEqual(path.basename(markerPath), buildDirectoryMarkerFileName({ major: 25, minor: 0 }, 'x64'));
    assert.ok(fs.existsSync(markerPath));
    assert.ok(!fs.existsSync(path.join(projectRoot, 'DEV ENVIRONMENT LabVIEW 2020')));

    const removed = await clearDirectoryLabVIEWMarkers(projectRoot);
    assert.deepStrictEqual(removed, [markerPath]);
    assert.ok(!fs.existsSync(markerPath));
  });

  test('formats user-facing version labels', () => {
    assert.strictEqual(formatLabVIEWDisplayName({ major: 20, minor: 0 }), 'LabVIEW 2020');
    assert.strictEqual(formatLabVIEWDisplayName({ major: 20, minor: 0 }, 'x64'), 'LabVIEW 2020 64bit');
    assert.strictEqual(formatLabVIEWDisplayName({ major: 8, minor: 6 }), 'LabVIEW 8.6');
  });
});