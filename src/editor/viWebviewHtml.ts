/**
 * WebView HTML 渲染工具（纯函数，不依赖 vscode）。
 *
 * - `escapeHtml`：对 HTML 特殊字符进行转义。
 * - `formatPropTypeForHtml`：将属性类型枚举转换为界面显示用标签与别名。
 * - `renderInitialPropsTableRows`：生成属性表格的初始 HTML 行（加载占位状态）。
 */

import { buildLoadingProps } from '../scripts/propMetadata';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatPropTypeForHtml(type: string): { label: string; alias: string } {
  switch (type) {
    case 'String':
      return { label: '字符串', alias: 'String' };
    case 'Boolean':
      return { label: '布尔值', alias: 'Boolean' };
    case 'Number':
      return { label: '数值', alias: 'Number' };
    default:
      return { label: type, alias: '' };
  }
}

export function renderInitialPropsTableRows(): string {
  const props = buildLoadingProps();
  const groups: Array<{ label: string; rows: string[] }> = [];
  const seen = new Map<string, { label: string; rows: string[] }>();

  for (const [name, entry] of Object.entries(props)) {
    const groupKey = typeof entry.group === 'string' && entry.group ? entry.group : 'other';
    let group = seen.get(groupKey);
    if (!group) {
      group = {
        label: entry.groupLabel || '其他属性',
        rows: [],
      };
      seen.set(groupKey, group);
      groups.push(group);
    }

    const type = formatPropTypeForHtml(String(entry.type || ''));
    const displayName = escapeHtml(entry.displayName || name);
    const alias = entry.displayName && entry.displayName !== name
      ? `<div class="prop-name-alias">${escapeHtml(name)}</div>`
      : '';
    const source = entry.source === 'dynamic' ? 'dynamic' : 'static';
    const sourceLabel = escapeHtml(entry.sourceLabel || (source === 'dynamic' ? '动态' : '静态'));
    const sourceDescription = entry.sourceDescription
      ? ` aria-label="${escapeHtml(entry.sourceDescription)}" data-tooltip="${escapeHtml(entry.sourceDescription)}"`
      : '';
    const accessBadge = entry.writable
      ? '<span class="access-badge access-badge-writable" title="可编辑属性" aria-label="可编辑属性"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.8 8.8a1.75 1.75 0 0 1-.82.452l-3.057.68a.75.75 0 0 1-.895-.895l.68-3.057a1.75 1.75 0 0 1 .452-.82l8.8-8.8Zm1.414 1.06a.25.25 0 0 0-.354 0l-.72.72 1.44 1.44.72-.72a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.732 5.707l-1.44-1.44-7.1 7.1a.25.25 0 0 0-.064.117l-.391 1.758 1.758-.391a.25.25 0 0 0 .117-.064l7.1-7.1Z"/></svg></span>'
      : '<span class="access-badge access-badge-readonly" title="只读属性" aria-label="只读属性"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.75 7V5.75a3.25 3.25 0 1 1 6.5 0V7h.5A1.75 1.75 0 0 1 13.5 8.75v4.5A1.75 1.75 0 0 1 11.75 15h-7.5A1.75 1.75 0 0 1 2.5 13.25v-4.5A1.75 1.75 0 0 1 4.25 7h.5Zm5 0V5.75a1.75 1.75 0 1 0-3.5 0V7h3.5Zm-5.5 1.5a.25.25 0 0 0-.25.25v4.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-4.5a.25.25 0 0 0-.25-.25h-7.5Z"/></svg></span>';

    group.rows.push(
      `<tr data-prop="${escapeHtml(name)}"${entry.writable ? '' : ' class="row-readonly"'}>`
      + '<td>'
      + `<div class="prop-name-header"><div class="prop-name-label">${displayName}</div><span class="prop-source-badge prop-source-badge-${source}"${sourceDescription}>${sourceLabel}</span></div>`
      + alias
      + '</td>'
      + '<td>'
      + `<div class="type-label">${escapeHtml(type.label)}</div>`
      + (type.alias && type.alias !== type.label ? `<div class="type-alias">${escapeHtml(type.alias)}</div>` : '')
      + '</td>'
      + `<td>${accessBadge}</td>`
      + '<td><div class="value-display value-display-empty">读取中…</div><div class="value-hint">属性值返回后自动回填</div></td>'
      + `<td>${escapeHtml(entry.description || '')}</td>`
      + '</tr>',
    );
  }

  return groups
    .map((group) => `<tr class="group-row"><td colspan="5">${escapeHtml(group.label)}</td></tr>${group.rows.join('')}`)
    .join('');
}
