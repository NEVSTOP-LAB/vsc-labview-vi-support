// LabVIEW VI Support — WebView 客户端。
// 纯原生 JS，零运行时依赖。通过 vscode.postMessage / window 'message' 事件
// 与扩展宿主通信。
//
// 入站消息（host → webview）：
//   { type: 'state', viPath, hash, viewMode, fpImage, bdImage, props, errors, loading }
//   { type: 'viewMode', viewMode }
//   { type: 'error', message }
// 出站消息（webview → host）：
//   { type: 'ready' }
//   { type: 'reload' }
//   { type: 'setViewMode', viewMode }
//   { type: 'saveProps', updates: { 属性名: 值, ... } }

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  /** @type {Record<string, {original: string|null, current: string, type: string, writable: boolean}>} */
  const propRows = {};
  let viewMode = 'both';         // 'both' | 'table-only' | 'preview-only'
  let previewMode = 'both';      // 'fp' | 'bd' | 'both'
  /** @type {Record<'fp'|'bd', { scale: number, x: number, y: number, naturalW: number, naturalH: number }>} */
  const viewState = {
    fp: { scale: 1, x: 0, y: 0, naturalW: 0, naturalH: 0 },
    bd: { scale: 1, x: 0, y: 0, naturalW: 0, naturalH: 0 },
  };
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 5.0;
  const ZOOM_STEP = 1.2;
  const DEFAULT_SPLIT_RATIO = 0.6;
  const MIN_SPLIT_PANE_PX = 120;
  let splitRatio = DEFAULT_SPLIT_RATIO;

  // Enum metadata for known number-typed properties (mirrors read_vi_props.py).
  const NUMBER_ENUMS = {
    PreferredExecSystem: [
      { value: 1, label: '1 (用户界面)' },
      { value: 2, label: '2 (标准)' },
      { value: 3, label: '3 (仪器 I/O)' },
      { value: 4, label: '4 (数据采集)' },
      { value: 5, label: '5 (其他 1)' },
      { value: 6, label: '6 (其他 2)' },
      { value: 7, label: '7 (与调用者相同)' },
    ],
    ExecPriority: [
      { value: 0, label: '0 (后台)' },
      { value: 1, label: '1 (正常)' },
      { value: 2, label: '2 (较高)' },
      { value: 3, label: '3 (高)' },
      { value: 4, label: '4 (时间关键)' },
      { value: 5, label: '5 (子程序)' },
    ],
  };
  const DEFAULT_GROUP_LABELS = {
    identity: '基础信息',
    execution: '执行设置',
    panel: '前面板行为',
    other: '其他属性',
  };

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const modeSelect = $('#view-mode');
  const btnFp     = $('#btn-fp');
  const btnBd     = $('#btn-bd');
  const btnBoth   = $('#btn-both');
  const btnSave   = $('#btn-save');
  const btnReload = $('#btn-reload');
  const previewControls = $('#preview-controls');
  const tableControls = $('#table-controls');
  const errorsEl  = $('#errors');
  const main      = $('#main');
  const tbody     = $('#props-tbody');
  const tableArea = $('#table-area');
  const imageArea = $('#image-area');
  const splitter  = $('#main-splitter');

  const panes = {
    fp: document.querySelector('.image-pane[data-pane="fp"]'),
    bd: document.querySelector('.image-pane[data-pane="bd"]'),
  };
  const viewports = {
    fp: document.querySelector('.viewport[data-viewport="fp"]'),
    bd: document.querySelector('.viewport[data-viewport="bd"]'),
  };
  const images = {
    fp: document.querySelector('.vi-image[data-img="fp"]'),
    bd: document.querySelector('.vi-image[data-img="bd"]'),
  };
  const placeholders = {
    fp: document.querySelector('.placeholder[data-placeholder="fp"]'),
    bd: document.querySelector('.placeholder[data-placeholder="bd"]'),
  };
  const zoomLabels = {
    fp: document.querySelector('[data-zoom-label="fp"]'),
    bd: document.querySelector('[data-zoom-label="bd"]'),
  };

  // -------------------------------------------------------------------------
  // Message I/O
  // -------------------------------------------------------------------------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') { return; }
    if (msg.type === 'state') {
      applyState(msg);
    } else if (msg.type === 'viewMode') {
      if (isKnownViewMode(msg.viewMode)) {
        setViewMode(msg.viewMode, { persist: false });
      }
    } else if (msg.type === 'error') {
      appendError(msg.message);
    }
  });

  function applyState(state) {
    if (isKnownViewMode(state.viewMode)) {
      setViewMode(state.viewMode, { persist: false });
    }
    setImage('fp', state.fpImage, state.loading && state.loading.fp);
    setImage('bd', state.bdImage, state.loading && state.loading.bd);
    if (state.props && state.props.props) {
      renderTable(state.props.props);
    } else if (state.loading && state.loading.props) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">正在读取属性…</td></tr>';
    } else {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">没有可显示的属性。</td></tr>';
    }
    if (Array.isArray(state.errors) && state.errors.length > 0) {
      state.errors.forEach(appendError);
    }
    updateSaveButton();
  }

  function appendError(message) {
    errorsEl.hidden = false;
    const div = document.createElement('div');
    div.textContent = message;
    errorsEl.appendChild(div);
  }

  function clearErrors() {
    errorsEl.innerHTML = '';
    errorsEl.hidden = true;
  }

  function clampImageAreaHeight(totalHeight, desiredHeight) {
    const minPanePx = Math.min(MIN_SPLIT_PANE_PX, Math.floor(totalHeight / 2));
    return Math.max(minPanePx, Math.min(totalHeight - minPanePx, desiredHeight));
  }

  function applyMainLayout() {
    const previewVisible = isPreviewVisible();
    const tableVisible = isTableVisible();
    const bothVisible = previewVisible && tableVisible;

    imageArea.classList.toggle('hidden', !previewVisible);
    tableArea.classList.toggle('hidden', !tableVisible);
    splitter.classList.toggle('hidden', !bothVisible);

    if (!previewVisible) {
      imageArea.style.flex = '';
      tableArea.style.flex = '1 1 100%';
      return;
    }

    if (!tableVisible) {
      imageArea.style.flex = '1 1 100%';
      tableArea.style.flex = '';
      return;
    }

    const splitterHeight = splitter.getBoundingClientRect().height || 10;
    const availableHeight = main.clientHeight - splitterHeight;
    if (availableHeight <= 0) {
      imageArea.style.flex = '1 1 60%';
      tableArea.style.flex = '1 1 40%';
      return;
    }

    const imageHeight = clampImageAreaHeight(
      availableHeight,
      Math.round(availableHeight * splitRatio),
    );
    const tableHeight = Math.max(0, availableHeight - imageHeight);
    splitRatio = imageHeight / availableHeight;
    imageArea.style.flex = `0 0 ${imageHeight}px`;
    tableArea.style.flex = `0 0 ${tableHeight}px`;
  }

  function updateSplitRatioFromClientY(clientY) {
    const splitterHeight = splitter.getBoundingClientRect().height || 10;
    const availableHeight = main.clientHeight - splitterHeight;
    if (availableHeight <= 0) { return; }
    const mainRect = main.getBoundingClientRect();
    const rawImageHeight = clientY - mainRect.top - splitterHeight / 2;
    const imageHeight = clampImageAreaHeight(availableHeight, rawImageHeight);
    splitRatio = imageHeight / availableHeight;
    applyMainLayout();
  }

  // -------------------------------------------------------------------------
  // Image: load / fit / pan / zoom
  // -------------------------------------------------------------------------
  function setImage(panel, uri, loading) {
    const img = images[panel];
    const placeholder = placeholders[panel];
    if (uri) {
      img.onload = () => {
        viewState[panel].naturalW = img.naturalWidth;
        viewState[panel].naturalH = img.naturalHeight;
        img.classList.add('loaded');
        placeholder.classList.add('hidden');
        fitToViewport(panel);
      };
      img.onerror = () => {
        img.classList.remove('loaded');
        placeholder.classList.remove('hidden');
        placeholder.textContent = '图像加载失败。';
      };
      if (uri.startsWith('data:')) {
        // Data URLs cannot be cache-busted by appending query parameters.
        // Reset first so reassigning the same URI after Reload still reloads.
        img.removeAttribute('src');
        img.src = uri;
      } else {
        // Cache-bust on hash change is implicit via different URI; force reload
        // when the same URI comes back after Reload by appending a timestamp.
        const cacheBust = uri.includes('?') ? '&' : '?';
        img.src = uri + cacheBust + 't=' + Date.now();
      }
    } else {
      img.removeAttribute('src');
      img.classList.remove('loaded');
      placeholder.classList.remove('hidden');
      placeholder.textContent = loading
        ? '加载中…'
        : (panel === 'fp' ? '尚未导出前面板图像。' : '尚未导出程序框图图像。');
    }
  }

  function fitToViewport(panel) {
    const vp = viewports[panel];
    const vs = viewState[panel];
    if (!vs.naturalW || !vs.naturalH) { return; }
    const rect = vp.getBoundingClientRect();
    // 当面板被隐藏时，rect 是 0×0；此时直接返回，避免把缩放比夹到 ZOOM_MIN
    // 之后再次显示时图像近乎不可见。
    if (rect.width <= 0 || rect.height <= 0) { return; }
    const sx = rect.width / vs.naturalW;
    const sy = rect.height / vs.naturalH;
    const scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(sx, sy)));
    vs.scale = scale;
    vs.x = Math.max(0, (rect.width - vs.naturalW * scale) / 2);
    vs.y = Math.max(0, (rect.height - vs.naturalH * scale) / 2);
    applyTransform(panel);
    refreshZoomLabel(panel);
  }

  function applyTransform(panel) {
    const vs = viewState[panel];
    const img = images[panel];
    img.style.transform = 'translate(' + vs.x + 'px, ' + vs.y + 'px) scale(' + vs.scale + ')';
  }

  function refreshZoomLabel(panel) {
    const label = zoomLabels[panel];
    if (!label) { return; }
    label.textContent = Math.round(viewState[panel].scale * 100) + '%';
  }

  function zoomBy(panel, factor, anchorX, anchorY) {
    const vs = viewState[panel];
    if (!vs.naturalW) { return; }
    const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, vs.scale * factor));
    if (newScale === vs.scale) { return; }
    if (typeof anchorX === 'number' && typeof anchorY === 'number') {
      // Keep the point under the cursor stationary.
      const ratio = newScale / vs.scale;
      vs.x = anchorX - ratio * (anchorX - vs.x);
      vs.y = anchorY - ratio * (anchorY - vs.y);
    }
    vs.scale = newScale;
    applyTransform(panel);
    refreshZoomLabel(panel);
  }

  function attachPanZoom(panel) {
    const vp = viewports[panel];
    const img = images[panel];

    vp.addEventListener('wheel', (e) => {
      if (!img.classList.contains('loaded')) { return; }
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const ax = e.clientX - rect.left;
      const ay = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      zoomBy(panel, factor, ax, ay);
    }, { passive: false });

    let dragging = false;
    let lastX = 0, lastY = 0;
    vp.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !img.classList.contains('loaded')) { return; }
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      vp.classList.add('grabbing');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) { return; }
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const vs = viewState[panel];
      vs.x += dx;
      vs.y += dy;
      applyTransform(panel);
    });
    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; vp.classList.remove('grabbing'); }
    });

    img.addEventListener('dblclick', () => fitToViewport(panel));
  }

  attachPanZoom('fp');
  attachPanZoom('bd');
  window.addEventListener('resize', () => {
    refreshLayout();
  });

  splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !isPreviewVisible() || !isTableVisible()) {
      return;
    }
    event.preventDefault();
    const pointerId = event.pointerId;
    document.body.classList.add('splitter-dragging');
    splitter.setPointerCapture(pointerId);
    updateSplitRatioFromClientY(event.clientY);

    const onPointerMove = (moveEvent) => {
      updateSplitRatioFromClientY(moveEvent.clientY);
    };

    const stopDragging = () => {
      document.body.classList.remove('splitter-dragging');
      if (splitter.hasPointerCapture(pointerId)) {
        splitter.releasePointerCapture(pointerId);
      }
      splitter.removeEventListener('pointermove', onPointerMove);
      splitter.removeEventListener('pointerup', stopDragging);
      splitter.removeEventListener('pointercancel', stopDragging);
    };

    splitter.addEventListener('pointermove', onPointerMove);
    splitter.addEventListener('pointerup', stopDragging);
    splitter.addEventListener('pointercancel', stopDragging);
  });

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------
  function isKnownViewMode(mode) {
    return mode === 'both' || mode === 'table-only' || mode === 'preview-only';
  }

  function isPreviewVisible() {
    return viewMode !== 'table-only';
  }

  function isTableVisible() {
    return viewMode !== 'preview-only';
  }

  function hasDirtyChanges() {
    return Object.values(propRows).some((slot) => slot.writable && slot.current !== slot.original);
  }

  function refreshLayout() {
    requestAnimationFrame(() => {
      applyMainLayout();
      fitToViewport('fp');
      fitToViewport('bd');
    });
  }

  function updateToolbarVisibility() {
    const previewVisible = isPreviewVisible();
    const tableVisible = isTableVisible();
    previewControls.classList.toggle('hidden', !previewVisible);
    tableControls.classList.toggle('hidden', !tableVisible && !hasDirtyChanges());
  }

  function applyPreviewMode() {
    btnFp.classList.toggle('active', previewMode === 'fp');
    btnBd.classList.toggle('active', previewMode === 'bd');
    btnBoth.classList.toggle('active', previewMode === 'both');
    panes.fp.classList.toggle('hidden', !isPreviewVisible() || previewMode === 'bd');
    panes.bd.classList.toggle('hidden', !isPreviewVisible() || previewMode === 'fp');
  }

  function setPreviewMode(mode) {
    previewMode = mode;
    applyPreviewMode();
    refreshLayout();
  }

  function setViewMode(mode, options) {
    if (!isKnownViewMode(mode)) {
      return;
    }
    const persist = !!(options && options.persist);
    const changed = viewMode !== mode;
    viewMode = mode;
    modeSelect.value = mode;
    applyPreviewMode();
    updateToolbarVisibility();
    refreshLayout();
    if (persist && changed) {
      vscode.postMessage({ type: 'setViewMode', viewMode: mode });
    }
  }

  modeSelect.addEventListener('change', () => setViewMode(modeSelect.value, { persist: true }));
  btnFp.addEventListener('click',   () => setPreviewMode('fp'));
  btnBd.addEventListener('click',   () => setPreviewMode('bd'));
  btnBoth.addEventListener('click', () => setPreviewMode('both'));

  document.querySelectorAll('.pane-zoom-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const panel = button.dataset.pane;
      const action = button.dataset.action;
      if (panel !== 'fp' && panel !== 'bd') { return; }
      if (action === 'zoom-in') {
        zoomBy(panel, ZOOM_STEP);
      } else if (action === 'zoom-out') {
        zoomBy(panel, 1 / ZOOM_STEP);
      } else if (action === 'zoom-reset') {
        fitToViewport(panel);
      }
    });
  });

  btnReload.addEventListener('click', () => {
    clearErrors();
    vscode.postMessage({ type: 'reload' });
  });

  btnSave.addEventListener('click', () => {
    const updates = collectUpdates();
    if (Object.keys(updates).length === 0) { return; }
    clearErrors();
    btnSave.disabled = true;
    vscode.postMessage({ type: 'saveProps', updates });
  });

  // -------------------------------------------------------------------------
  // Property table
  // -------------------------------------------------------------------------
  function collectPropGroups(props) {
    const groups = [];
    const seen = new Map();

    for (const name of Object.keys(props)) {
      const entry = props[name] || {};
      const key = typeof entry.group === 'string' && entry.group ? entry.group : 'other';
      let bucket = seen.get(key);
      if (!bucket) {
        bucket = {
          key,
          label: (typeof entry.groupLabel === 'string' && entry.groupLabel)
            || DEFAULT_GROUP_LABELS[key]
            || DEFAULT_GROUP_LABELS.other,
          names: [],
        };
        seen.set(key, bucket);
        groups.push(bucket);
      }
      bucket.names.push(name);
    }

    return groups;
  }

  function appendGroupRow(label) {
    const tr = document.createElement('tr');
    tr.className = 'group-row';
    const td = document.createElement('td');
    td.colSpan = 5;
    td.textContent = label;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function createAccessBadge(writable) {
    const span = document.createElement('span');
    span.className = 'access-badge ' + (writable ? 'access-badge-writable' : 'access-badge-readonly');
    span.title = writable ? '可编辑' : '只读';
    span.setAttribute('aria-label', writable ? '可编辑' : '只读');
    span.innerHTML = writable
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.8 8.8a1.75 1.75 0 0 1-.82.452l-3.057.68a.75.75 0 0 1-.895-.895l.68-3.057a1.75 1.75 0 0 1 .452-.82l8.8-8.8Zm1.414 1.06a.25.25 0 0 0-.354 0l-.72.72 1.44 1.44.72-.72a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.732 5.707l-1.44-1.44-7.1 7.1a.25.25 0 0 0-.064.117l-.391 1.758 1.758-.391a.25.25 0 0 0 .117-.064l7.1-7.1Z"/></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.75 7V5.75a3.25 3.25 0 1 1 6.5 0V7h.5A1.75 1.75 0 0 1 13.5 8.75v4.5A1.75 1.75 0 0 1 11.75 15h-7.5A1.75 1.75 0 0 1 2.5 13.25v-4.5A1.75 1.75 0 0 1 4.25 7h.5Zm5 0V5.75a1.75 1.75 0 1 0-3.5 0V7h3.5Zm-5.5 1.5a.25.25 0 0 0-.25.25v4.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-4.5a.25.25 0 0 0-.25-.25h-7.5Z"/></svg>';
    return span;
  }

  function formatPropType(type) {
    switch (type) {
      case 'String':
        return { label: '字符串', alias: 'String' };
      case 'Boolean':
        return { label: '布尔值', alias: 'Boolean' };
      case 'Number':
        return { label: '数值', alias: 'Number' };
      default:
        return { label: String(type || ''), alias: '' };
    }
  }

  function appendTypeCell(td, type) {
    const formatted = formatPropType(type);
    const label = document.createElement('div');
    label.className = 'type-label';
    label.textContent = formatted.label;
    td.appendChild(label);

    if (formatted.alias && formatted.alias !== formatted.label) {
      const alias = document.createElement('div');
      alias.className = 'type-alias';
      alias.textContent = formatted.alias;
      td.appendChild(alias);
    }
  }

  function normalizeEditableValue(name, type, value) {
    const text = value == null ? '' : String(value);
    if (type === 'Boolean') {
      return (text === 'True' || text === '1' || text === '-1') ? 'True' : 'False';
    }
    if (type === 'Number' && NUMBER_ENUMS[name]) {
      return text.trim().split(/\s+/)[0] || '';
    }
    return text;
  }

  function formatValueForDisplay(name, type, value) {
    if (type === 'Boolean') {
      return value === 'True' ? '是 (True)' : '否 (False)';
    }
    if (type === 'Number' && NUMBER_ENUMS[name]) {
      const option = NUMBER_ENUMS[name].find((item) => String(item.value) === String(value));
      return option ? option.label : String(value || '');
    }
    return String(value || '');
  }

  function syncDirtyState(td, name) {
    const slot = propRows[name];
    const tr = td.parentElement;
    if (!slot || !tr) { return; }
    tr.classList.toggle('dirty', slot.current !== slot.original);
  }

  function buildEditorControl(host, name, type, value, onChange) {
    if (type === 'Boolean') {
      const select = document.createElement('select');
      [['True', '是 (True)'], ['False', '否 (False)']].forEach(([val, label]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        select.appendChild(opt);
      });
      select.value = value;
      select.addEventListener('change', () => onChange(select.value));
      host.appendChild(select);
      return select;
    }
    if (type === 'Number' && NUMBER_ENUMS[name]) {
      const select = document.createElement('select');
      NUMBER_ENUMS[name].forEach((opt) => {
        const o = document.createElement('option');
        o.value = String(opt.value);
        o.textContent = opt.label;
        select.appendChild(o);
      });
      select.value = value;
      select.addEventListener('change', () => onChange(select.value));
      host.appendChild(select);
      return select;
    }
    if (type === 'Number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.value = value;
      input.addEventListener('input', () => onChange(input.value));
      host.appendChild(input);
      return input;
    }
    if (type === 'String' && (name === 'Description' || name === 'HistoryText')) {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.addEventListener('input', () => onChange(ta.value));
      host.appendChild(ta);
      return ta;
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));
    host.appendChild(input);
    return input;
  }

  function renderEditableValueCell(td, name) {
    const slot = propRows[name];
    if (!slot) { return; }

    td.innerHTML = '';

    const shell = document.createElement('div');
    shell.className = 'value-cell-shell';
    const content = document.createElement('div');
    content.className = 'value-cell-content';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'tb-btn small value-action-btn';

    if (slot.editing) {
      const focusTarget = buildEditorControl(content, name, slot.type, slot.current, (raw) => {
        slot.current = raw;
        syncDirtyState(td, name);
        updateSaveButton();
      });
      action.textContent = '完成';
      action.title = '收起编辑器';
      action.addEventListener('click', () => {
        slot.editing = false;
        renderEditableValueCell(td, name);
      });

      shell.appendChild(content);
      shell.appendChild(action);
      td.appendChild(shell);
      syncDirtyState(td, name);
      updateSaveButton();
      if (focusTarget && typeof focusTarget.focus === 'function') {
        focusTarget.focus();
      }
      return;
    }

    const display = document.createElement('div');
    display.className = 'value-display';
    const displayValue = formatValueForDisplay(name, slot.type, slot.current);
    if (displayValue) {
      display.textContent = displayValue;
    } else {
      display.textContent = '(空)';
      display.classList.add('value-display-empty');
    }
    content.appendChild(display);

    action.textContent = '编辑';
    action.title = '启用编辑';
    action.addEventListener('click', () => {
      slot.editing = true;
      renderEditableValueCell(td, name);
    });

    shell.appendChild(content);
    shell.appendChild(action);
    td.appendChild(shell);
    syncDirtyState(td, name);
  }

  function renderTable(props) {
    // Reset row tracking; rebuild from scratch each refresh.
    Object.keys(propRows).forEach((k) => delete propRows[k]);
    tbody.innerHTML = '';

    const names = Object.keys(props);
    if (names.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">没有可显示的属性。</td></tr>';
      return;
    }

    for (const group of collectPropGroups(props)) {
      appendGroupRow(group.label);

      for (const name of group.names) {
        const entry = props[name];
        const tr = document.createElement('tr');
        tr.dataset.prop = name;
        const writable = !!entry.writable;
        if (!writable) { tr.classList.add('row-readonly'); }

        const tdName = document.createElement('td');
        const label = document.createElement('div');
        label.className = 'prop-name-label';
        label.textContent = entry.displayName || name;
        tdName.appendChild(label);
        if (entry.displayName && entry.displayName !== name) {
          const alias = document.createElement('div');
          alias.className = 'prop-name-alias';
          alias.textContent = name;
          tdName.appendChild(alias);
        }

        const tdType = document.createElement('td'); appendTypeCell(tdType, entry.type);
        const tdRw   = document.createElement('td'); tdRw.appendChild(createAccessBadge(writable));
        const tdVal  = document.createElement('td');
        const tdDesc = document.createElement('td'); tdDesc.textContent = entry.description || '';

        if (!entry.ok) {
          tdVal.textContent = '[不可用] ' + (entry.error || '');
          tdVal.style.opacity = '0.6';
        } else {
          const value = entry.value == null ? '' : String(entry.value);
          if (writable) {
            const normalizedValue = normalizeEditableValue(name, entry.type, value);
            propRows[name] = {
              original: normalizedValue,
              current: normalizedValue,
              type: entry.type,
              writable: true,
              editing: false,
            };
            renderEditableValueCell(tdVal, name);
          } else {
            tdVal.textContent = value;
          }
        }

        tr.appendChild(tdName);
        tr.appendChild(tdType);
        tr.appendChild(tdRw);
        tr.appendChild(tdVal);
        tr.appendChild(tdDesc);
        tbody.appendChild(tr);
      }
    }
    updateSaveButton();
  }

  function collectUpdates() {
    const out = {};
    for (const name of Object.keys(propRows)) {
      const slot = propRows[name];
      if (!slot.writable) { continue; }
      if (slot.current !== slot.original) {
        out[name] = serializeForType(slot.type, slot.current);
      }
    }
    return out;
  }

  function serializeForType(type, raw) {
    if (type === 'Boolean') {
      return raw === 'True' || raw === 'true' || raw === '1';
    }
    if (type === 'Number') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    return raw;
  }

  function updateSaveButton() {
    btnSave.disabled = !hasDirtyChanges();
    updateToolbarVisibility();
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------
  setViewMode(viewMode, { persist: false });
  vscode.postMessage({ type: 'ready' });
})();
