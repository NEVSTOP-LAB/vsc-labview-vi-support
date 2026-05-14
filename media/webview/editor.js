// LabVIEW VI Support — WebView 客户端。
// 纯原生 JS，零运行时依赖。通过 vscode.postMessage / window 'message' 事件
// 与扩展宿主通信。
//
// 入站消息（host → webview）：
//   { type: 'state', viPath, hash, fpImage, bdImage, props, errors, loading }
//   { type: 'error', message }
// 出站消息（webview → host）：
//   { type: 'ready' }
//   { type: 'reload' }
//   { type: 'saveProps', updates: { 属性名: 值, ... } }

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  /** @type {Record<string, {original: string|null, current: string, type: string, writable: boolean}>} */
  const propRows = {};
  let displayMode = 'both';      // 'fp' | 'bd' | 'both'
  let tableVisible = true;
  /** @type {Record<'fp'|'bd', { scale: number, x: number, y: number, naturalW: number, naturalH: number }>} */
  const viewState = {
    fp: { scale: 1, x: 0, y: 0, naturalW: 0, naturalH: 0 },
    bd: { scale: 1, x: 0, y: 0, naturalW: 0, naturalH: 0 },
  };
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 5.0;
  const ZOOM_STEP = 1.2;
  /** Which pane the zoom toolbar buttons act on. Always the first visible pane. */
  function activePane() {
    if (displayMode === 'fp') { return 'fp'; }
    if (displayMode === 'bd') { return 'bd'; }
    return 'fp';
  }

  // Enum metadata for known number-typed properties (mirrors read_vi_props.py).
  const NUMBER_ENUMS = {
    ReentrantType: [
      { value: 0, label: '0 (不可重入)' },
      { value: 1, label: '1 (预分配副本)' },
      { value: 2, label: '2 (共享副本)' },
    ],
    Priority: [
      { value: 0, label: '0 (后台)' },
      { value: 1, label: '1 (正常)' },
      { value: 2, label: '2 (较高)' },
      { value: 3, label: '3 (高)' },
      { value: 4, label: '4 (时间关键)' },
      { value: 5, label: '5 (子程序)' },
    ],
  };

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const btnFp     = $('#btn-fp');
  const btnBd     = $('#btn-bd');
  const btnBoth   = $('#btn-both');
  const btnTable  = $('#btn-table');
  const btnSave   = $('#btn-save');
  const btnReload = $('#btn-reload');
  const btnZoomIn  = $('#btn-zoom-in');
  const btnZoomOut = $('#btn-zoom-out');
  const btnZoomReset = $('#btn-zoom-reset');
  const zoomLabel = $('#zoom-label');
  const errorsEl  = $('#errors');
  const tbody     = $('#props-tbody');
  const tableArea = $('#table-area');
  const imageArea = $('#image-area');

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

  // -------------------------------------------------------------------------
  // Message I/O
  // -------------------------------------------------------------------------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') { return; }
    if (msg.type === 'state') {
      applyState(msg);
    } else if (msg.type === 'error') {
      appendError(msg.message);
    }
  });

  function applyState(state) {
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
      // Cache-bust on hash change is implicit via different URI; force reload
      // when the same URI comes back after Reload by appending a timestamp.
      const cacheBust = uri.includes('?') ? '&' : '?';
      img.src = uri + cacheBust + 't=' + Date.now();
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
    const scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(sx, sy, 1)));
    vs.scale = scale;
    vs.x = Math.max(0, (rect.width - vs.naturalW * scale) / 2);
    vs.y = Math.max(0, (rect.height - vs.naturalH * scale) / 2);
    applyTransform(panel);
    refreshZoomLabel();
  }

  function applyTransform(panel) {
    const vs = viewState[panel];
    const img = images[panel];
    img.style.transform = 'translate(' + vs.x + 'px, ' + vs.y + 'px) scale(' + vs.scale + ')';
  }

  function refreshZoomLabel() {
    const vs = viewState[activePane()];
    zoomLabel.textContent = Math.round(vs.scale * 100) + '%';
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
    refreshZoomLabel();
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
    fitToViewport('fp');
    fitToViewport('bd');
  });

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------
  function setMode(mode) {
    displayMode = mode;
    btnFp.classList.toggle('active',   mode === 'fp');
    btnBd.classList.toggle('active',   mode === 'bd');
    btnBoth.classList.toggle('active', mode === 'both');
    panes.fp.classList.toggle('hidden', mode === 'bd');
    panes.bd.classList.toggle('hidden', mode === 'fp');
    // Refit on layout change (after the next paint).
    requestAnimationFrame(() => {
      fitToViewport('fp');
      fitToViewport('bd');
      refreshZoomLabel();
    });
  }
  btnFp.addEventListener('click',   () => setMode('fp'));
  btnBd.addEventListener('click',   () => setMode('bd'));
  btnBoth.addEventListener('click', () => setMode('both'));

  btnTable.addEventListener('click', () => {
    tableVisible = !tableVisible;
    btnTable.classList.toggle('active', tableVisible);
    tableArea.classList.toggle('hidden', !tableVisible);
    imageArea.style.flex = tableVisible ? '' : '1 1 100%';
  });

  btnZoomIn.addEventListener('click',    () => zoomBy(activePane(), ZOOM_STEP));
  btnZoomOut.addEventListener('click',   () => zoomBy(activePane(), 1 / ZOOM_STEP));
  btnZoomReset.addEventListener('click', () => fitToViewport(activePane()));

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
  function renderTable(props) {
    // Reset row tracking; rebuild from scratch each refresh.
    Object.keys(propRows).forEach((k) => delete propRows[k]);
    tbody.innerHTML = '';

    const names = Object.keys(props);
    if (names.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">没有可显示的属性。</td></tr>';
      return;
    }

    for (const name of names) {
      const entry = props[name];
      const tr = document.createElement('tr');
      tr.dataset.prop = name;
      const writable = !!entry.writable;
      if (!writable) { tr.classList.add('row-readonly'); }

      const tdName = document.createElement('td'); tdName.textContent = name;
      const tdType = document.createElement('td'); tdType.textContent = entry.type || '';
      const tdRw   = document.createElement('td'); tdRw.textContent   = writable ? '读写' : '只读';
      const tdVal  = document.createElement('td');
      const tdDesc = document.createElement('td'); tdDesc.textContent = entry.description || '';

      if (!entry.ok) {
        tdVal.textContent = '[不可用] ' + (entry.error || '');
        tdVal.style.opacity = '0.6';
      } else {
        const value = entry.value == null ? '' : String(entry.value);
        if (writable) {
          buildEditor(tdVal, name, entry.type, value);
          propRows[name] = {
            original: value,
            current: value,
            type: entry.type,
            writable: true,
          };
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
    updateSaveButton();
  }

  function buildEditor(td, name, type, value) {
    const onChange = (raw) => {
      const slot = propRows[name];
      if (!slot) { return; }
      slot.current = raw;
      const tr = td.parentElement;
      if (tr) {
        tr.classList.toggle('dirty', raw !== slot.original);
      }
      updateSaveButton();
    };

    if (type === 'Boolean') {
      const select = document.createElement('select');
      // 显示中文，但 value 仍用 'True' / 'False'，便于后续序列化时与 VBScript
      // 输出（"True" / "False"）保持一致。
      [['True', '是 (True)'], ['False', '否 (False)']].forEach(([val, label]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        select.appendChild(opt);
      });
      // 规范化输入值：VBScript 输出 "True"/"False"；同时容忍 -1/0/1。
      const normalized = (value === 'True' || value === '1' || value === '-1') ? 'True' : 'False';
      select.value = normalized;
      select.addEventListener('change', () => onChange(select.value));
      td.appendChild(select);
      // 用规范化后的值填回原始/当前态，确保脏检查可靠。
      const slot = propRows[name];
      if (slot) { slot.original = normalized; slot.current = normalized; }
    } else if (type === 'Number' && NUMBER_ENUMS[name]) {
      const select = document.createElement('select');
      NUMBER_ENUMS[name].forEach((opt) => {
        const o = document.createElement('option');
        o.value = String(opt.value);
        o.textContent = opt.label;
        select.appendChild(o);
      });
      // Tolerate annotated values like "1 (预分配副本)".
      const head = String(value).trim().split(/\s+/)[0];
      select.value = head;
      select.addEventListener('change', () => onChange(select.value));
      td.appendChild(select);
      const slot = propRows[name];
      if (slot) { slot.original = head; slot.current = head; }
    } else if (type === 'Number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.value = value;
      input.addEventListener('input', () => onChange(input.value));
      td.appendChild(input);
    } else if (type === 'String' && (name === 'Description' || name === 'HistoryText'
                                  || name === 'PrintHeader' || name === 'PrintFooter')) {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.addEventListener('input', () => onChange(ta.value));
      td.appendChild(ta);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.addEventListener('input', () => onChange(input.value));
      td.appendChild(input);
    }
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
    const dirty = Object.values(propRows).some((s) => s.writable && s.current !== s.original);
    btnSave.disabled = !dirty;
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------
  vscode.postMessage({ type: 'ready' });
})();
