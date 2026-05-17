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
//   { type: 'loadDynamicProps' }
//   { type: 'setViewMode', viewMode }
//   { type: 'saveProps', updates: { 属性名: 值, ... } }

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  /** @type {Record<string, {original: string|null, current: string, type: string, writable: boolean, accessMode?: string, editing?: boolean, tdRw?: HTMLTableCellElement, tdVal?: HTMLTableCellElement, entry?: any}>} */
  const propRows = {};
  let viewMode = 'table-only';   // 'both' | 'table-only' | 'preview-only'
  let previewMode = 'both';      // 'fp' | 'bd' | 'both'
  let currentPropsEnvelope = null;
  let currentLoadingState = { fp: false, bd: false, props: false };
  let propsFilterText = '';
  /** @type {Record<'fp'|'bd', { scale: number, fitScale: number, x: number, y: number, naturalW: number, naturalH: number, contentBounds: { left: number, top: number, width: number, height: number } | null }>} */
  const viewState = {
    fp: { scale: 1, fitScale: 1, x: 0, y: 0, naturalW: 0, naturalH: 0, contentBounds: null },
    bd: { scale: 1, fitScale: 1, x: 0, y: 0, naturalW: 0, naturalH: 0, contentBounds: null },
  };
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 5.0;
  const ZOOM_STEP = 1.2;
  const DEFAULT_SPLIT_RATIO = 0.6;
  const MIN_SPLIT_PANE_PX = 120;
  let splitRatio = DEFAULT_SPLIT_RATIO;
  let previewLayout = 'horizontal'; // 'horizontal' | 'vertical'

  // Enum metadata for known number-typed properties (mirrors read_vi_props.py).
  const NUMBER_ENUMS = {
    VIType: [
      { value: 0, label: '0 (无效的 VI 类型)' },
      { value: 1, label: '1 (标准 VI)' },
      { value: 2, label: '2 (控件 VI)' },
      { value: 3, label: '3 (全局 VI)' },
      { value: 4, label: '4 (多态 VI)' },
      { value: 5, label: '5 (配置 VI)' },
      { value: 6, label: '6 (子系统 VI)' },
      { value: 7, label: '7 (外观 VI)' },
      { value: 8, label: '8 (方法 VI)' },
      { value: 9, label: '9 (状态图 VI)' },
    ],
    ExecState: [
      { value: 0, label: '0 (未初始化)' },
      { value: 1, label: '1 (空闲)' },
      { value: 2, label: '2 (运行中)' },
      { value: 3, label: '3 (已暂停)' },
      { value: 4, label: '4 (单步执行)' },
      { value: 5, label: '5 (保留过渡状态)' },
    ],
    FPState: [
      { value: 0, label: '0 (标准)' },
      { value: 1, label: '1 (最小化)' },
      { value: 2, label: '2 (最大化)' },
      { value: 3, label: '3 (隐藏)' },
    ],
    PreferredExecSystem: [
      { value: 1, label: '1 (用户界面)' },
      { value: 2, label: '2 (标准)' },
      { value: 3, label: '3 (仪器 I/O)' },
      { value: 4, label: '4 (数据采集)' },
      { value: 5, label: '5 (其他 1)' },
      { value: 6, label: '6 (其他 2)' },
      { value: 7, label: '7 (与调用者相同)' },
    ],
    ReentrancyType: [
      { value: 0, label: '0 (不可重入)' },
      { value: 1, label: '1 (独立副本重入)' },
      { value: 2, label: '2 (共享副本重入)' },
    ],
    WindowState: [
      { value: 0, label: '0 (正常)' },
      { value: 1, label: '1 (最小化)' },
      { value: 2, label: '2 (最大化)' },
    ],
  };
  const DEFAULT_GROUP_LABELS = {
    general: '通用信息',
    execution: '行为与执行控制',
    panel: '前面板窗口外观与行为',
    memory: '内部结构与内存信息',
    other: '其他属性',
  };
  const DEFAULT_SOURCE_DESCRIPTIONS = {
    static: '静态属性：可直接离线读取，不需要启动 LabVIEW。',
    dynamic: '动态属性：需要通过 LabVIEW VI Server 读取，按需加载时可能触发 LabVIEW 窗口。',
  };

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const modeSelect = $('#view-mode');
  const btnFp     = $('#btn-fp');
  const btnBd     = $('#btn-bd');
  const btnBoth   = $('#btn-both');
  const btnLoadDynamic = $('#btn-load-dynamic');
  const btnSave   = $('#btn-save');
  const btnLayout = $('#btn-layout');
  const btnReload = $('#btn-reload');
  const propsSearch = $('#props-search');
  const statusEl  = $('#status');
  const previewControls = $('#preview-controls');
  const tableControls = $('#table-controls');
  const errorsEl  = $('#errors');
  const main      = $('#main');
  const propsTable = $('#props-table');
  const tbody     = $('#props-tbody');
  const tableArea = $('#table-area');
  const imageArea = $('#image-area');
  const splitter  = $('#main-splitter');
  const sourceTooltip = document.createElement('div');
  sourceTooltip.id = 'prop-source-tooltip';
  sourceTooltip.hidden = true;
  sourceTooltip.setAttribute('role', 'tooltip');
  document.body.appendChild(sourceTooltip);
  let activeTooltipTarget = null;

  function readInitialPropsEnvelope() {
    const node = document.getElementById('initial-props-envelope');
    if (!(node instanceof HTMLScriptElement)) {
      return null;
    }
    const text = node.textContent || '';
    if (!text.trim()) {
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || !parsed.props || typeof parsed.props !== 'object') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  const initialPropsEnvelope = readInitialPropsEnvelope();

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
  const propsTableCols = propsTable ? {
    name: propsTable.querySelector('col.col-name'),
    type: propsTable.querySelector('col.col-type'),
    rw: propsTable.querySelector('col.col-rw'),
    value: propsTable.querySelector('col.col-value'),
    desc: propsTable.querySelector('col.col-desc'),
  } : null;
  const RESIZABLE_PROP_COLUMNS = ['name', 'type', 'rw', 'value'];
  const PROP_COLUMN_ORDER = ['name', 'type', 'rw', 'value', 'desc'];
  const PROP_COLUMN_MIN_WIDTHS = {
    name: 140,
    type: 88,
    rw: 68,
    value: 180,
    desc: 180,
  };
  const DEFAULT_PROPS_TABLE_MIN_WIDTH = 940;
  const propsTableColumnWidths = {
    name: 0,
    type: 0,
    rw: 0,
    value: 0,
  };
  let propsTableColumnsInitialized = false;
  let propsTableColumnsCustomized = false;

  function getPropsTableHeaderCells() {
    if (!propsTable || !propsTable.tHead || propsTable.tHead.rows.length === 0) {
      return [];
    }
    return Array.from(propsTable.tHead.rows[0].cells);
  }

  function isPropsTableVisible() {
    return !!tableArea
      && !tableArea.classList.contains('hidden')
      && tableArea.getBoundingClientRect().width > 0;
  }

  function applyPropsTableColumnWidths() {
    if (!propsTable || !propsTableCols) {
      return;
    }

    for (const column of RESIZABLE_PROP_COLUMNS) {
      const col = propsTableCols[column];
      if (!col) {
        continue;
      }
      col.style.width = Math.round(propsTableColumnWidths[column]) + 'px';
    }

    if (propsTableCols.desc) {
      propsTableCols.desc.style.width = '';
    }

    const requiredMinWidth = RESIZABLE_PROP_COLUMNS.reduce(
      (sum, column) => sum + Math.max(PROP_COLUMN_MIN_WIDTHS[column], propsTableColumnWidths[column]),
      0,
    ) + PROP_COLUMN_MIN_WIDTHS.desc;
    propsTable.style.minWidth = Math.max(DEFAULT_PROPS_TABLE_MIN_WIDTH, requiredMinWidth) + 'px';
  }

  function measurePropsTableColumnWidths() {
    if (!propsTable || !propsTableCols || !isPropsTableVisible()) {
      return false;
    }

    const headerCells = getPropsTableHeaderCells();
    if (headerCells.length < PROP_COLUMN_ORDER.length) {
      return false;
    }

    RESIZABLE_PROP_COLUMNS.forEach((column, index) => {
      propsTableColumnWidths[column] = Math.max(
        PROP_COLUMN_MIN_WIDTHS[column],
        Math.round(headerCells[index].getBoundingClientRect().width),
      );
    });

    propsTableColumnsInitialized = true;
    applyPropsTableColumnWidths();
    return true;
  }

  function ensurePropsTableColumnWidths() {
    if (!propsTable || !propsTableCols || !isPropsTableVisible()) {
      return;
    }

    if (!propsTableColumnsInitialized || !propsTableColumnsCustomized) {
      measurePropsTableColumnWidths();
      return;
    }

    applyPropsTableColumnWidths();
  }

  function beginPropsTableColumnResize(event, column) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (!propsTableColumnsInitialized && !measurePropsTableColumnWidths()) {
      return;
    }

    const startX = event.clientX;
    const startWidth = propsTableColumnWidths[column];
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    propsTableColumnsCustomized = true;
    document.body.classList.add('column-resizing');
    if (handle && typeof handle.setPointerCapture === 'function') {
      handle.setPointerCapture(pointerId);
    }

    const onPointerMove = (moveEvent) => {
      const nextWidth = Math.max(
        PROP_COLUMN_MIN_WIDTHS[column],
        Math.round(startWidth + (moveEvent.clientX - startX)),
      );
      if (nextWidth === propsTableColumnWidths[column]) {
        return;
      }
      propsTableColumnWidths[column] = nextWidth;
      applyPropsTableColumnWidths();
    };

    const stopResize = () => {
      document.body.classList.remove('column-resizing');
      if (handle && typeof handle.releasePointerCapture === 'function' && handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
      if (handle) {
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', stopResize);
        handle.removeEventListener('pointercancel', stopResize);
      }
    };

    if (handle) {
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', stopResize);
      handle.addEventListener('pointercancel', stopResize);
    }
  }

  function installPropsTableColumnResizers() {
    const headerCells = getPropsTableHeaderCells();
    if (headerCells.length < PROP_COLUMN_ORDER.length) {
      return;
    }

    RESIZABLE_PROP_COLUMNS.forEach((column, index) => {
      const th = headerCells[index];
      if (!th || th.querySelector('.column-resizer')) {
        return;
      }
      th.dataset.columnKey = column;
      const handle = document.createElement('div');
      handle.className = 'column-resizer';
      handle.dataset.columnKey = column;
      handle.setAttribute('role', 'presentation');
      handle.addEventListener('pointerdown', (event) => beginPropsTableColumnResize(event, column));
      th.appendChild(handle);
    });
  }

  installPropsTableColumnResizers();

  // @include protocol.js
  function hideSourceTooltip(target) {
    if (target && activeTooltipTarget !== target) {
      return;
    }
    activeTooltipTarget = null;
    sourceTooltip.hidden = true;
    sourceTooltip.classList.remove('visible');
    sourceTooltip.textContent = '';
    sourceTooltip.removeAttribute('data-placement');
    sourceTooltip.style.left = '';
    sourceTooltip.style.top = '';
  }

  function positionSourceTooltip(target) {
    if (!target || sourceTooltip.hidden) {
      return;
    }
    const tooltipGap = 10;
    const viewportMargin = 12;
    const targetRect = target.getBoundingClientRect();
    const tooltipRect = sourceTooltip.getBoundingClientRect();

    let placement = 'top';
    let top = targetRect.top - tooltipRect.height - tooltipGap;
    if (top < viewportMargin) {
      placement = 'bottom';
      top = targetRect.bottom + tooltipGap;
    }
    if (top + tooltipRect.height > window.innerHeight - viewportMargin) {
      top = Math.max(viewportMargin, window.innerHeight - tooltipRect.height - viewportMargin);
    }

    let left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
    left = Math.max(viewportMargin, Math.min(left, window.innerWidth - tooltipRect.width - viewportMargin));

    sourceTooltip.dataset.placement = placement;
    sourceTooltip.style.left = Math.round(left) + 'px';
    sourceTooltip.style.top = Math.round(top) + 'px';
  }

  function showSourceTooltip(target) {
    const tooltip = target && target.dataset ? target.dataset.tooltip : '';
    if (!tooltip) {
      return;
    }
    activeTooltipTarget = target;
    sourceTooltip.textContent = tooltip;
    sourceTooltip.hidden = false;
    sourceTooltip.classList.add('visible');
    positionSourceTooltip(target);
  }

  // @include zoom.js

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
      ensurePropsTableColumnWidths();
    });
  }

  function updateToolbarVisibility() {
    const previewVisible = isPreviewVisible();
    const tableVisible = isTableVisible();
    previewControls.classList.toggle('hidden', !previewVisible);
    tableControls.classList.toggle('hidden', !tableVisible && !hasDirtyChanges());
    if (btnLayout) {
      const showPreviewLayoutButton = previewVisible && previewMode === 'both';
      btnLayout.classList.toggle('hidden', !showPreviewLayoutButton);
      const horizontal = previewLayout === 'horizontal';
      btnLayout.textContent = horizontal ? '上下布局' : '左右布局';
      btnLayout.title = horizontal
        ? '切换为上下布局（前面板在上，程序框图在下）'
        : '切换为左右布局（前面板在左，程序框图在右）';
    }
    updateDynamicUi();
  }

  function hasDynamicPropsEnvelope() {
    const props = currentPropsEnvelope && currentPropsEnvelope.props;
    return !!props && Object.values(props).some((entry) => entry && entry.source === 'dynamic');
  }

  function hasPendingPropsEnvelope() {
    const props = currentPropsEnvelope && currentPropsEnvelope.props;
    return !!props && Object.values(props).some((entry) => entry && entry.pending === true);
  }

  function updateDynamicUi() {
    const loading = !!(currentLoadingState && currentLoadingState.props);
    const hasDynamicProps = hasDynamicPropsEnvelope();
    const hasPendingProps = hasPendingPropsEnvelope();
    const dynamicLoaded = !!(currentPropsEnvelope && currentPropsEnvelope.dynamicPropsLoaded === true);
    const showLoadButton = isTableVisible() && hasDynamicProps && !dynamicLoaded;

    btnLoadDynamic.classList.toggle('hidden', !showLoadButton);
    btnLoadDynamic.disabled = !showLoadButton || loading;
    btnLoadDynamic.textContent = loading ? '读取中…' : '读取动态属性';

    if (!isTableVisible() || !hasDynamicProps) {
      statusEl.hidden = true;
      statusEl.textContent = '';
      statusEl.classList.remove('status-info', 'status-loading');
      return;
    }

    if (loading) {
      statusEl.hidden = false;
      statusEl.textContent = hasPendingProps ? '正在读取属性…' : '正在读取动态属性…';
      statusEl.classList.add('status-loading');
      statusEl.classList.remove('status-info');
      return;
    }

    if (!dynamicLoaded) {
      statusEl.hidden = false;
      statusEl.textContent = '当前仅显示静态属性。点击“读取动态属性”后将通过 LabVIEW 读取其余属性，可编辑项也会在读取后启用。';
      statusEl.classList.add('status-info');
      statusEl.classList.remove('status-loading');
      return;
    }

    statusEl.hidden = true;
    statusEl.textContent = '';
    statusEl.classList.remove('status-info', 'status-loading');
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
    updateToolbarVisibility();
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
  if (btnLayout) {
    btnLayout.addEventListener('click', () => {
      previewLayout = previewLayout === 'horizontal' ? 'vertical' : 'horizontal';
      updateToolbarVisibility();
      refreshLayout();
    });
  }

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
    hideSourceTooltip();
    clearErrors();
    vscode.postMessage({ type: 'reload' });
  });

  btnLoadDynamic.addEventListener('click', () => {
    hideSourceTooltip();
    clearErrors();
    vscode.postMessage({ type: 'loadDynamicProps' });
  });

  btnSave.addEventListener('click', () => {
    hideSourceTooltip();
    const updates = collectUpdates();
    if (Object.keys(updates).length === 0) { return; }
    clearErrors();
    btnSave.disabled = true;
    vscode.postMessage({ type: 'saveProps', updates });
  });

  if (propsSearch) {
    propsSearch.addEventListener('input', () => {
      propsFilterText = String(propsSearch.value || '');
      applyPropsFilter();
    });
  }

  // @include table.js

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------
  if (initialPropsEnvelope && initialPropsEnvelope.props) {
    currentPropsEnvelope = initialPropsEnvelope;
    currentLoadingState = { fp: false, bd: false, props: true };
    renderTable(initialPropsEnvelope.props);
  }
  setViewMode(viewMode, { persist: false });
  updateDynamicUi();
  vscode.postMessage({ type: 'ready' });
})();
