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
//   { type: 'setSaveAvailable', available }
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
  let savePending = false;
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
    } else if (msg.type === 'command') {
      handleHostCommand(msg.command);
    } else if (msg.type === 'error') {
      appendError(msg.message);
    }
  });

  function handleHostCommand(command) {
    if (command === 'reload') {
      hideSourceTooltip();
      clearErrors();
      vscode.postMessage({ type: 'reload' });
      return;
    }
    if (command === 'save') {
      hideSourceTooltip();
      const updates = collectUpdates();
      if (Object.keys(updates).length === 0) { return; }
      clearErrors();
      savePending = true;
      updateSaveButton();
      vscode.postMessage({ type: 'saveProps', updates });
      return;
    }
    if (command === 'preview-fp' || command === 'preview-bd') {
      setViewMode('preview-only', { persist: true });
      setPreviewMode(command === 'preview-fp' ? 'fp' : 'bd');
    }
  }

  function applyState(state) {
    savePending = false;
    currentPropsEnvelope = state.props || null;
    currentLoadingState = state.loading || { fp: false, bd: false, props: false };
    if (isKnownViewMode(state.viewMode)) {
      setViewMode(state.viewMode, { persist: false });
    }
    setImage('fp', state.fpImage, state.loading && state.loading.fp);
    setImage('bd', state.bdImage, state.loading && state.loading.bd);
    if (state.props && state.props.props) {
      renderTable(state.props.props);
      applyPropsFilter();
    } else if (state.loading && state.loading.props) {
      renderLoadingTable();
    } else {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">没有可显示的属性。</td></tr>';
    }
    if (Array.isArray(state.errors) && state.errors.length > 0) {
      state.errors.forEach(appendError);
    }
    updateDynamicUi();
    updateSaveButton();
  }

  function appendError(message) {
    savePending = false;
    errorsEl.hidden = false;
    const div = document.createElement('div');
    div.textContent = message;
    errorsEl.appendChild(div);
    updateSaveButton();
  }

  function clearErrors() {
    errorsEl.innerHTML = '';
    errorsEl.hidden = true;
  }


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

  function clampSplitSize(totalSize, desiredSize) {
    const minPanePx = Math.min(MIN_SPLIT_PANE_PX, Math.floor(totalSize / 2));
    return Math.max(minPanePx, Math.min(totalSize - minPanePx, desiredSize));
  }

  function applyPreviewPaneLayout() {
    const isVertical = isPreviewVisible() && previewMode === 'both' && previewLayout === 'vertical';
    panes.fp.style.flex = '';
    panes.bd.style.flex = '';
    imageArea.classList.toggle('image-area-vertical', isVertical);
    imageArea.dataset.previewLayout = isVertical ? 'vertical' : 'horizontal';
  }

  function getPanelContentBounds(panel) {
    const vs = viewState[panel];
    if (vs.contentBounds && vs.contentBounds.width > 0 && vs.contentBounds.height > 0) {
      return vs.contentBounds;
    }
    if (!vs.naturalW || !vs.naturalH) {
      return null;
    }
    return { left: 0, top: 0, width: vs.naturalW, height: vs.naturalH };
  }

  function getFitPadding(rect) {
    if (!isPreviewVisible() || previewMode !== 'both') {
      return { x: 0, y: 0 };
    }

    const shortestSide = Math.min(rect.width, rect.height);
    const padding = Math.max(16, Math.min(32, Math.round(shortestSide * 0.06)));
    return {
      x: Math.min(padding, Math.max(0, rect.width / 4)),
      y: Math.min(padding, Math.max(0, rect.height / 4)),
    };
  }

  function applyMainLayout() {
    const previewVisible = isPreviewVisible();
    const tableVisible = isTableVisible();
    const bothVisible = previewVisible && tableVisible;

    imageArea.classList.toggle('hidden', !previewVisible);
    tableArea.classList.toggle('hidden', !tableVisible);
    splitter.classList.toggle('hidden', !bothVisible);
    main.classList.remove('main-horizontal');
    splitter.setAttribute('aria-orientation', 'horizontal');
    splitter.setAttribute('aria-label', '调整预览区域和属性表的高度');

    if (!previewVisible) {
      imageArea.style.flex = '';
      tableArea.style.flex = '1 1 100%';
      applyPreviewPaneLayout();
      return;
    }

    if (!tableVisible) {
      imageArea.style.flex = '1 1 100%';
      tableArea.style.flex = '';
      applyPreviewPaneLayout();
      return;
    }

    const splitterSize = splitter.getBoundingClientRect().height || 10;
    const availableSize = main.clientHeight - splitterSize;
    if (availableSize <= 0) {
      imageArea.style.flex = '1 1 60%';
      tableArea.style.flex = '1 1 40%';
      applyPreviewPaneLayout();
      return;
    }

    const imageSize = clampSplitSize(
      availableSize,
      Math.round(availableSize * splitRatio),
    );
    const tableSize = Math.max(0, availableSize - imageSize);
    splitRatio = imageSize / availableSize;
    imageArea.style.flex = `0 0 ${imageSize}px`;
    tableArea.style.flex = `0 0 ${tableSize}px`;
    applyPreviewPaneLayout();
  }

  function updateSplitRatioFromPointer(clientX, clientY) {
    const splitterSize = splitter.getBoundingClientRect().height || 10;
    const availableSize = main.clientHeight - splitterSize;
    if (availableSize <= 0) { return; }
    const mainRect = main.getBoundingClientRect();
    const rawImageSize = clientY - mainRect.top - splitterSize / 2;
    const imageSize = clampSplitSize(availableSize, rawImageSize);
    splitRatio = imageSize / availableSize;
    applyMainLayout();
  }

  // -------------------------------------------------------------------------
  // Image: load / fit / pan / zoom
  // -------------------------------------------------------------------------
  function resetViewportBackground(panel) {
    const viewport = viewports[panel];
    viewport.style.removeProperty('--preview-bg-color');
    viewport.style.removeProperty('--preview-bg-pattern');
  }

  function applyViewportBackground(panel, color) {
    if (!color) {
      resetViewportBackground(panel);
      return;
    }
    const viewport = viewports[panel];
    viewport.style.setProperty('--preview-bg-color', color);
    viewport.style.setProperty('--preview-bg-pattern', 'none');
  }

  function resetImageView(panel) {
    const vs = viewState[panel];
    vs.scale = 1;
    vs.fitScale = 1;
    vs.x = 0;
    vs.y = 0;
    vs.naturalW = 0;
    vs.naturalH = 0;
    vs.contentBounds = null;
    applyTransform(panel);
    refreshZoomLabel(panel);
    resetViewportBackground(panel);
  }

  function analyzeImagePresentation(img) {
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      return { backgroundColor: null, contentBounds: null };
    }

    const maxSampleSize = 256;
    const longestSide = Math.max(img.naturalWidth, img.naturalHeight);
    const sampleScale = longestSide > maxSampleSize ? (maxSampleSize / longestSide) : 1;
    const sampleWidth = Math.max(1, Math.round(img.naturalWidth * sampleScale));
    const sampleHeight = Math.max(1, Math.round(img.naturalHeight * sampleScale));
    const borderWidth = Math.max(1, Math.round(Math.min(sampleWidth, sampleHeight) * 0.08));
    const bucketStep = 16;

    const canvas = document.createElement('canvas');
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return { backgroundColor: null, contentBounds: null };
    }

    try {
      context.drawImage(img, 0, 0, sampleWidth, sampleHeight);
      const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);
      const buckets = new Map();

      const collectPixel = (offset) => {
        const alpha = data[offset + 3];
        if (alpha < 200) {
          return;
        }

        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        const key = [red, green, blue]
          .map((value) => Math.round(value / bucketStep) * bucketStep)
          .join(',');
        const bucket = buckets.get(key) || { weight: 0, r: 0, g: 0, b: 0 };
        const weight = alpha / 255;
        bucket.weight += weight;
        bucket.r += red * weight;
        bucket.g += green * weight;
        bucket.b += blue * weight;
        buckets.set(key, bucket);
      };

      const getPixelOffset = (x, y) => ((y * sampleWidth) + x) * 4;

      for (let y = 0; y < sampleHeight; y += 1) {
        for (let x = 0; x < sampleWidth; x += 1) {
          const isBorderPixel = x < borderWidth
            || y < borderWidth
            || x >= sampleWidth - borderWidth
            || y >= sampleHeight - borderWidth;
          if (!isBorderPixel) {
            continue;
          }
          collectPixel(getPixelOffset(x, y));
        }
      }

      let bestBucket = null;
      for (const bucket of buckets.values()) {
        if (!bestBucket || bucket.weight > bestBucket.weight) {
          bestBucket = bucket;
        }
      }

      if (!bestBucket || bestBucket.weight <= 0) {
        return { backgroundColor: null, contentBounds: null };
      }

      const red = Math.round(bestBucket.r / bestBucket.weight);
      const green = Math.round(bestBucket.g / bestBucket.weight);
      const blue = Math.round(bestBucket.b / bestBucket.weight);
      const background = { alpha: 255, red, green, blue };
      const tolerance = 18;
      let minX = sampleWidth;
      let minY = sampleHeight;
      let maxX = -1;
      let maxY = -1;

      const isBackgroundPixel = (offset) => {
        const alpha = data[offset + 3];
        if (alpha < 32) {
          return true;
        }
        return Math.abs(alpha - background.alpha) <= tolerance
          && Math.abs(data[offset] - background.red) <= tolerance
          && Math.abs(data[offset + 1] - background.green) <= tolerance
          && Math.abs(data[offset + 2] - background.blue) <= tolerance;
      };

      for (let y = 0; y < sampleHeight; y += 1) {
        for (let x = 0; x < sampleWidth; x += 1) {
          const offset = getPixelOffset(x, y);
          if (isBackgroundPixel(offset)) {
            continue;
          }
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }

      let contentBounds = null;
      if (maxX >= minX && maxY >= minY) {
        const scaleX = img.naturalWidth / sampleWidth;
        const scaleY = img.naturalHeight / sampleHeight;
        const left = Math.max(0, Math.floor(minX * scaleX));
        const top = Math.max(0, Math.floor(minY * scaleY));
        const right = Math.min(img.naturalWidth, Math.ceil((maxX + 1) * scaleX));
        const bottom = Math.min(img.naturalHeight, Math.ceil((maxY + 1) * scaleY));
        contentBounds = {
          left,
          top,
          width: Math.max(1, right - left),
          height: Math.max(1, bottom - top),
        };
      }

      return {
        backgroundColor: 'rgb(' + red + ', ' + green + ', ' + blue + ')',
        contentBounds,
      };
    } catch {
      return { backgroundColor: null, contentBounds: null };
    }
  }

  function syncLoadedImagePresentation(panel) {
    const img = images[panel];
    const presentation = analyzeImagePresentation(img);
    viewState[panel].contentBounds = presentation.contentBounds;
    applyViewportBackground(panel, presentation.backgroundColor);
    requestAnimationFrame(() => {
      if (previewMode === 'both' && isPreviewVisible()) {
        refreshLayout();
        return;
      }
      fitToViewport(panel);
    });
  }

  function setImage(panel, uri, loading) {
    const img = images[panel];
    const placeholder = placeholders[panel];
    if (uri) {
      img.onload = () => {
        viewState[panel].naturalW = img.naturalWidth;
        viewState[panel].naturalH = img.naturalHeight;
        img.classList.add('loaded');
        placeholder.classList.add('hidden');
        syncLoadedImagePresentation(panel);
      };
      img.onerror = () => {
        resetImageView(panel);
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
      resetImageView(panel);
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
    const bounds = getPanelContentBounds(panel);
    if (!bounds) { return; }
    const fitPadding = getFitPadding(rect);
    const availableWidth = Math.max(1, rect.width - fitPadding.x * 2);
    const availableHeight = Math.max(1, rect.height - fitPadding.y * 2);
    const sx = availableWidth / bounds.width;
    const sy = availableHeight / bounds.height;
    const scale = Math.min(1, Math.min(sx, sy));
    if (!Number.isFinite(scale) || scale <= 0) { return; }
    vs.fitScale = scale;
    vs.scale = scale;
    vs.x = fitPadding.x + ((availableWidth - bounds.width * scale) / 2) - (bounds.left * scale);
    vs.y = fitPadding.y + ((availableHeight - bounds.height * scale) / 2) - (bounds.top * scale);
    refreshZoomLabel(panel);
    applyTransform(panel);
  }

  function applyTransform(panel) {
    const vs = viewState[panel];
    const img = images[panel];
    img.style.left = vs.x + 'px';
    img.style.top = vs.y + 'px';
    img.style.transform = 'scale(' + vs.scale + ')';
  }

  function refreshZoomLabel(panel) {
    const label = zoomLabels[panel];
    if (!label) { return; }
    label.textContent = Math.round(viewState[panel].scale * 100) + '%';
  }

  function zoomBy(panel, factor, anchorX, anchorY) {
    const vs = viewState[panel];
    if (!vs.naturalW) { return; }
    const minScale = Math.min(ZOOM_MIN, vs.fitScale || ZOOM_MIN);
    const newScale = Math.max(minScale, Math.min(ZOOM_MAX, vs.scale * factor));
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
    if (activeTooltipTarget) {
      positionSourceTooltip(activeTooltipTarget);
    }
    refreshLayout();
  });

  tableArea.addEventListener('scroll', () => {
    hideSourceTooltip();
  }, { passive: true });

  splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !isPreviewVisible() || !isTableVisible()) {
      return;
    }
    event.preventDefault();
    const pointerId = event.pointerId;
    document.body.classList.add('splitter-dragging');
    splitter.setPointerCapture(pointerId);
    updateSplitRatioFromPointer(event.clientX, event.clientY);

    const onPointerMove = (moveEvent) => {
      updateSplitRatioFromPointer(moveEvent.clientX, moveEvent.clientY);
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
    savePending = true;
    updateSaveButton();
    vscode.postMessage({ type: 'saveProps', updates });
  });

  if (propsSearch) {
    propsSearch.addEventListener('input', () => {
      propsFilterText = String(propsSearch.value || '');
      applyPropsFilter();
    });
  }

  // -------------------------------------------------------------------------
  // Property table
  // -------------------------------------------------------------------------
  function propMatchesFilter(propName, entry, filter) {
    if (!filter) {
      return true;
    }
    const haystack = [
      propName,
      entry && entry.displayName,
      entry && entry.description,
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    return haystack.includes(filter);
  }

  function applyPropsFilter() {
    const filter = String(propsFilterText || '').trim().toLowerCase();
    const props = currentPropsEnvelope && currentPropsEnvelope.props ? currentPropsEnvelope.props : null;

    const existingEmpty = tbody.querySelector('tr.filter-empty-row');
    if (existingEmpty) {
      existingEmpty.remove();
    }

    const allRows = Array.from(tbody.querySelectorAll('tr'));
    if (!filter || !props) {
      allRows.forEach((tr) => tr.classList.remove('filtered-out'));
      return;
    }

    let anyVisibleProp = false;
    for (const tr of allRows) {
      const name = tr.dataset && tr.dataset.prop ? tr.dataset.prop : '';
      if (!name) {
        continue;
      }
      const entry = props[name] || {};
      const ok = propMatchesFilter(name, entry, filter);
      tr.classList.toggle('filtered-out', !ok);
      if (ok) {
        anyVisibleProp = true;
      }
    }

    const children = Array.from(tbody.children);
    let currentGroupRow = null;
    let groupHasVisible = false;
    for (const row of children) {
      if (row.classList.contains('group-row')) {
        if (currentGroupRow) {
          currentGroupRow.classList.toggle('filtered-out', !groupHasVisible);
        }
        currentGroupRow = row;
        groupHasVisible = false;
        continue;
      }
      const isPropRow = !!(row.dataset && row.dataset.prop);
      if (isPropRow && !row.classList.contains('filtered-out')) {
        groupHasVisible = true;
      }
    }
    if (currentGroupRow) {
      currentGroupRow.classList.toggle('filtered-out', !groupHasVisible);
    }

    if (!anyVisibleProp) {
      allRows.forEach((tr) => tr.classList.add('filtered-out'));
      const tr = document.createElement('tr');
      tr.className = 'filter-empty-row';
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty';
      td.textContent = '没有匹配的属性。';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

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

  function renderLoadingTable() {
    hideSourceTooltip();
    Object.keys(propRows).forEach((k) => delete propRows[k]);
    tbody.innerHTML = '';

    for (let index = 0; index < 3; index += 1) {
      const tr = document.createElement('tr');
      tr.className = 'loading-row';

      ['name', 'type', 'access', 'value', 'desc'].forEach((slot) => {
        const td = document.createElement('td');
        const line = document.createElement('div');
        line.className = 'loading-line loading-line-' + slot;
        td.appendChild(line);
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    }
  }

  function createSourceBadge(entry) {
    if (!entry || !entry.source) {
      return null;
    }
    const span = document.createElement('span');
    span.className = 'prop-source-badge prop-source-badge-' + entry.source;
    span.textContent = entry.sourceLabel || (entry.source === 'static' ? '静态' : '动态');
    const tooltip = entry.sourceDescription
      || DEFAULT_SOURCE_DESCRIPTIONS[entry.source]
      || '';
    if (tooltip) {
      span.dataset.tooltip = tooltip;
      span.setAttribute('aria-label', tooltip);
      span.tabIndex = 0;
      span.addEventListener('mouseenter', () => showSourceTooltip(span));
      span.addEventListener('mouseleave', () => hideSourceTooltip(span));
      span.addEventListener('focus', () => showSourceTooltip(span));
      span.addEventListener('blur', () => hideSourceTooltip(span));
    }
    return span;
  }

  function createReadonlyAccessBadge() {
    const span = document.createElement('span');
    span.className = 'access-badge access-badge-readonly';
    span.title = '只读属性';
    span.setAttribute('aria-label', '只读属性');
    span.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.75 7V5.75a3.25 3.25 0 1 1 6.5 0V7h.5A1.75 1.75 0 0 1 13.5 8.75v4.5A1.75 1.75 0 0 1 11.75 15h-7.5A1.75 1.75 0 0 1 2.5 13.25v-4.5A1.75 1.75 0 0 1 4.25 7h.5Zm5 0V5.75a1.75 1.75 0 1 0-3.5 0V7h3.5Zm-5.5 1.5a.25.25 0 0 0-.25.25v4.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-4.5a.25.25 0 0 0-.25-.25h-7.5Z"/></svg>';
    return span;
  }

  function createWritableAccessIndicator() {
    const span = document.createElement('span');
    span.className = 'access-badge access-badge-writable';
    span.title = '可编辑属性';
    span.setAttribute('aria-label', '可编辑属性');
    span.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.8 8.8a1.75 1.75 0 0 1-.82.452l-3.057.68a.75.75 0 0 1-.895-.895l.68-3.057a1.75 1.75 0 0 1 .452-.82l8.8-8.8Zm1.414 1.06a.25.25 0 0 0-.354 0l-.72.72 1.44 1.44.72-.72a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.732 5.707l-1.44-1.44-7.1 7.1a.25.25 0 0 0-.064.117l-.391 1.758 1.758-.391a.25.25 0 0 0 .117-.064l7.1-7.1Z"/></svg>';
    return span;
  }

  function createDeferredAccessBadge(writable) {
    const span = document.createElement('span');
    span.className = 'access-badge access-badge-deferred';
    span.title = writable
      ? '动态属性尚未读取；读取后可编辑'
      : '动态属性尚未读取';
    span.setAttribute('aria-label', span.title);
    span.textContent = '…';
    return span;
  }

  function createWritableAccessButton(editing, onToggle) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'access-badge access-badge-writable access-badge-button';
    if (editing) {
      button.classList.add('access-badge-active');
      button.title = '可编辑属性，点击完成编辑';
      button.setAttribute('aria-label', '可编辑属性，点击完成编辑');
      button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-6.25 6.25a.75.75 0 0 1-1.06 0l-3.25-3.25a.75.75 0 0 1 1.06-1.06L7 9.94l5.72-5.72a.75.75 0 0 1 1.06 0Z"/></svg>';
    } else {
      button.title = '可编辑属性，点击开始编辑';
      button.setAttribute('aria-label', '可编辑属性，点击开始编辑');
      button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.8 8.8a1.75 1.75 0 0 1-.82.452l-3.057.68a.75.75 0 0 1-.895-.895l.68-3.057a1.75 1.75 0 0 1 .452-.82l8.8-8.8Zm1.414 1.06a.25.25 0 0 0-.354 0l-.72.72 1.44 1.44.72-.72a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.732 5.707l-1.44-1.44-7.1 7.1a.25.25 0 0 0-.064.117l-.391 1.758 1.758-.391a.25.25 0 0 0 .117-.064l7.1-7.1Z"/></svg>';
    }
    button.addEventListener('click', onToggle);
    return button;
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

  function normalizeEditableValue(name, type, value, accessMode) {
    const text = value == null ? '' : String(value);
    if (accessMode === 'writeonly' && text === '') {
      if (type === 'Boolean') {
        return 'True';
      }
      return '';
    }
    if (type === 'Boolean') {
      return (text === 'True' || text === '1' || text === '-1') ? 'True' : 'False';
    }
    if (type === 'Number' && NUMBER_ENUMS[name]) {
      return text.trim().split(/\s+/)[0] || '';
    }
    return text;
  }

  function formatValueForDisplay(name, type, value, accessMode) {
    if (accessMode === 'writeonly' && (value == null || value === '')) {
      return '';
    }
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

  function restoreOtherEditableRows(activeName) {
    for (const [name, slot] of Object.entries(propRows)) {
      if (name === activeName || !slot.writable) {
        continue;
      }
      if (slot.current === slot.original && !slot.editing) {
        continue;
      }
      slot.current = slot.original;
      slot.editing = false;
      rerenderEditableRow(slot.tdRw, slot.tdVal, name, slot.entry);
    }
  }

  function renderAccessCell(td, name, tdVal, entry) {
    td.innerHTML = '';
    if (entry && entry.pending === true) {
      td.appendChild(entry.writable ? createWritableAccessIndicator() : createReadonlyAccessBadge());
      return;
    }
    if (entry && entry.loaded === false) {
      td.appendChild(createDeferredAccessBadge(!!entry.writable));
      return;
    }
    const slot = propRows[name];
    if (!slot || !slot.writable) {
      td.appendChild(createReadonlyAccessBadge());
      return;
    }
    td.appendChild(createWritableAccessButton(!!slot.editing, () => {
      if (slot.editing) {
        slot.editing = false;
      } else {
        restoreOtherEditableRows(name);
        slot.editing = true;
      }
      rerenderEditableRow(td, tdVal, name, entry);
    }));
  }

  function buildEditorControl(host, name, type, value, accessMode, onChange) {
    if (type === 'Boolean') {
      const select = document.createElement('select');
      [['True', '是 (True)'], ['False', '否 (False)']].forEach(([val, label]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        select.appendChild(opt);
      });
      select.value = value || (accessMode === 'writeonly' ? 'True' : 'False');
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
    if (type === 'String' && name === 'Description') {
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

    if (slot.editing) {
      const focusTarget = buildEditorControl(td, name, slot.type, slot.current, slot.accessMode, (raw) => {
        slot.current = raw;
        syncDirtyState(td, name);
        updateSaveButton();
      });
      syncDirtyState(td, name);
      updateSaveButton();
      if (focusTarget && typeof focusTarget.focus === 'function') {
        focusTarget.focus();
      }
      return;
    }

    const display = document.createElement('div');
    display.className = 'value-display';
    const displayValue = formatValueForDisplay(name, slot.type, slot.current, slot.accessMode);
    if (displayValue) {
      display.textContent = displayValue;
    } else {
      display.textContent = '(空)';
      display.classList.add('value-display-empty');
    }
    td.appendChild(display);
    syncDirtyState(td, name);
  }

  function rerenderEditableRow(tdRw, tdVal, name, entry) {
    if (!(tdVal instanceof HTMLElement)) {
      return;
    }
    renderAccessCell(tdRw, name, tdVal, entry);
    renderEditableValueCell(tdVal, name);
  }

  function renderDeferredValueCell(td, entry) {
    td.innerHTML = '';
    const display = document.createElement('div');
    display.className = 'value-display value-display-empty';
    display.textContent = '按需读取';
    td.appendChild(display);

    const hint = document.createElement('div');
    hint.className = 'value-hint';
    hint.textContent = entry && entry.writable
      ? '读取动态属性后可查看并编辑'
      : '读取动态属性后显示';
    td.appendChild(hint);
  }

  function renderPendingValueCell(td) {
    td.innerHTML = '';
    const display = document.createElement('div');
    display.className = 'value-display value-display-empty';
    display.textContent = '读取中…';
    td.appendChild(display);

    const hint = document.createElement('div');
    hint.className = 'value-hint';
    hint.textContent = '属性值返回后自动回填';
    td.appendChild(hint);
  }

  function renderTable(props) {
    // Reset row tracking; rebuild from scratch each refresh.
    hideSourceTooltip();
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
        const nameHeader = document.createElement('div');
        nameHeader.className = 'prop-name-header';
        const label = document.createElement('div');
        label.className = 'prop-name-label';
        label.textContent = entry.displayName || name;
        nameHeader.appendChild(label);
        const sourceBadge = createSourceBadge(entry);
        if (sourceBadge) {
          nameHeader.appendChild(sourceBadge);
        }
        tdName.appendChild(nameHeader);
        if (entry.displayName && entry.displayName !== name) {
          const alias = document.createElement('div');
          alias.className = 'prop-name-alias';
          alias.textContent = name;
          tdName.appendChild(alias);
        }

        const tdType = document.createElement('td'); appendTypeCell(tdType, entry.type);
        const tdRw   = document.createElement('td');
        const tdVal  = document.createElement('td');
        const tdDesc = document.createElement('td'); tdDesc.textContent = entry.description || '';

        if (entry.pending === true) {
          renderAccessCell(tdRw, name, tdVal, entry);
          renderPendingValueCell(tdVal);
        } else if (entry.loaded === false) {
          renderAccessCell(tdRw, name, tdVal, entry);
          renderDeferredValueCell(tdVal, entry);
        } else if (!entry.ok) {
          tdVal.textContent = '[不可用] ' + (entry.error || '');
          tdVal.style.opacity = '0.6';
        } else {
          const value = entry.value == null ? '' : String(entry.value);
          if (writable) {
            const normalizedValue = normalizeEditableValue(name, entry.type, value, entry.accessMode);
            propRows[name] = {
              original: normalizedValue,
              current: normalizedValue,
              type: entry.type,
              writable: true,
              accessMode: entry.accessMode,
              tdRw,
              tdVal,
              entry,
              editing: false,
            };
            rerenderEditableRow(tdRw, tdVal, name, entry);
          } else {
            renderAccessCell(tdRw, name, tdVal, entry);
            const display = document.createElement('div');
            display.className = 'value-display' + (value ? '' : ' value-display-empty');
            display.textContent = value || '(空)';
            tdVal.appendChild(display);
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
    applyPropsFilter();
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

  let lastSaveAvailable = false;

  function getSaveAvailability() {
    return hasDirtyChanges() && !savePending;
  }

  function updateSaveAvailability() {
    const saveAvailable = getSaveAvailability();
    btnSave.classList.toggle('hidden', !saveAvailable);
    if (lastSaveAvailable !== saveAvailable) {
      lastSaveAvailable = saveAvailable;
      vscode.postMessage({ type: 'setSaveAvailable', available: saveAvailable });
    }
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
    const saveAvailable = getSaveAvailability();
    btnSave.disabled = !saveAvailable;
    updateSaveAvailability();
    updateToolbarVisibility();
  }


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
