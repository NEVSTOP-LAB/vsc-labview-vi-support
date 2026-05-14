export const VIEW_MODE_CONFIGURATION_SECTION = 'labview-vi-support';
export const VIEW_MODE_CONFIGURATION_KEY = 'viewMode';
export const VIEW_MODE_FULL_CONFIGURATION_KEY =
  `${VIEW_MODE_CONFIGURATION_SECTION}.${VIEW_MODE_CONFIGURATION_KEY}`;

export const VIEW_MODES = ['both', 'table-only', 'preview-only'] as const;

export type ViewMode = (typeof VIEW_MODES)[number];

export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === 'string' && VIEW_MODES.includes(value as ViewMode);
}

export function normalizeViewMode(value: unknown): ViewMode {
  return isViewMode(value) ? value : 'both';
}

export function preferWorkspaceConfigurationTarget(
  hasWorkspaceFile: boolean,
  workspaceFolderCount: number,
): boolean {
  return hasWorkspaceFile || workspaceFolderCount > 0;
}