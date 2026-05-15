import * as assert from 'assert';

import {
  buildQuickPickInstallations,
  buildQuickPickPlaceholder,
  buildStatusPresentation,
} from '../../scripts/labviewStatusPresentation';
import type { InstalledLabVIEW } from '../../scripts/labviewRuntime';
import type { ResolvedLabVIEWVersion } from '../../scripts/labviewVersionResolver';

function installation(overrides: Partial<InstalledLabVIEW> = {}): InstalledLabVIEW {
  return {
    major: 25,
    minor: 0,
    architecture: 'x64',
    registryKey: 'LabVIEW 2025',
    installDir: 'C:\\Program Files\\NI\\LabVIEW 2025',
    exePath: 'C:\\Program Files\\NI\\LabVIEW 2025\\LabVIEW.exe',
    ...overrides,
  };
}

function resolvedVersion(overrides: Partial<ResolvedLabVIEWVersion> = {}): ResolvedLabVIEWVersion {
  return {
    major: 25,
    minor: 0,
    architecture: 'x64',
    source: 'directory-marker',
    sourcePath: 'C:\\repo\\DEV ENVIRONMENT LabVIEW 2025(64bit)',
    scopeDirectory: 'C:\\repo',
    ...overrides,
  };
}

suite('labviewVersionStatus', () => {
  test('shows configured installed version without warning', () => {
    const presentation = buildStatusPresentation({
      rootDir: 'C:\\repo',
      projectVersion: resolvedVersion(),
      activeViVersion: null,
      installations: [installation()],
    });

    assert.strictEqual(presentation.warning, false);
    assert.strictEqual(presentation.text, '$(tools) LabVIEW: LabVIEW 2025 64bit');
    assert.match(presentation.tooltip, /本机安装: 已找到匹配版本/);
  });

  test('shows warning when configured version is not installed', () => {
    const presentation = buildStatusPresentation({
      rootDir: 'C:\\repo',
      projectVersion: resolvedVersion({
        major: 20,
        sourcePath: 'C:\\repo\\DEV ENVIRONMENT LabVIEW 2020(64bit)',
      }),
      activeViVersion: null,
      installations: [installation()],
    });

    assert.strictEqual(presentation.warning, true);
    assert.strictEqual(presentation.text, '$(warning) LabVIEW: LabVIEW 2020 64bit');
    assert.match(presentation.tooltip, /本机安装: 未找到匹配版本/);
  });

  test('shows multi-installation prompt when project is unset', () => {
    const presentation = buildStatusPresentation({
      rootDir: 'C:\\repo',
      projectVersion: null,
      activeViVersion: resolvedVersion({ source: 'vi', sourcePath: 'C:\\repo\\demo.vi' }),
      installations: [
        installation(),
        installation({ major: 20, architecture: 'x86', registryKey: 'LabVIEW 2020' }),
      ],
    });

    assert.strictEqual(presentation.warning, false);
    assert.strictEqual(presentation.text, '$(question) LabVIEW: 多版本可用，项目未设置');
    assert.match(presentation.tooltip, /当前活动 VI 保存版本/);
  });

  test('shows missing installation warning when nothing is available', () => {
    const presentation = buildStatusPresentation({
      rootDir: 'C:\\repo',
      projectVersion: null,
      activeViVersion: null,
      installations: [],
    });

    assert.strictEqual(presentation.warning, true);
    assert.strictEqual(presentation.text, '$(warning) LabVIEW: 未检测到可用安装');
  });

  test('prioritizes active vi match when project version is unset', () => {
    const items = buildQuickPickInstallations(
      [
        installation(),
        installation({
          major: 20,
          minor: 0,
          architecture: 'x86',
          registryKey: 'LabVIEW 2020',
          installDir: 'C:\\Program Files (x86)\\NI\\LabVIEW 2020',
          exePath: 'C:\\Program Files (x86)\\NI\\LabVIEW 2020\\LabVIEW.exe',
        }),
      ],
      null,
      resolvedVersion({
        major: 20,
        minor: 0,
        architecture: 'x86',
        source: 'vi',
        sourcePath: 'C:\\repo\\demo.vi',
      }),
    );

    assert.strictEqual(items[0].installation.major, 20);
    assert.strictEqual(items[0].installation.architecture, 'x86');
    assert.strictEqual(items[0].detail, '推荐：与当前活动 VI 保存版本一致。');
  });

  test('mentions active vi recommendation in quick pick placeholder', () => {
    const placeholder = buildQuickPickPlaceholder(
      'C:\\repo',
      null,
      2,
      resolvedVersion({
        major: 20,
        minor: 0,
        architecture: 'x86',
        source: 'vi',
        sourcePath: 'C:\\repo\\demo.vi',
      }),
    );

    assert.match(placeholder, /当前活动 VI 保存版本 LabVIEW 2020 32bit/);
  });
});
