  function clampSplitSize(totalSize, desiredSize) {
    const minPanePx = Math.min(MIN_SPLIT_PANE_PX, Math.floor(totalSize / 2));
    return Math.max(minPanePx, Math.min(totalSize - minPanePx, desiredSize));
  }

  function parsePixelSize(value) {
    const parsed = Number.parseFloat(value || '0');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function getVisiblePreviewPanes() {
    return Object.values(panes).filter((pane) => pane && !pane.classList.contains('hidden'));
  }

  function getPaneHeaderHeight() {
    return getVisiblePreviewPanes().reduce((maxHeight, pane) => {
      const header = pane.querySelector('.pane-header');
      if (!(header instanceof HTMLElement)) {
        return maxHeight;
      }
      return Math.max(maxHeight, header.getBoundingClientRect().height || 0);
    }, 0);
  }

  function getSquareDistance(width, height) {
    if (width <= 0 || height <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.abs(Math.log(width / height));
  }

  function choosePreviewLayoutDirection() {
    const visiblePanes = getVisiblePreviewPanes();
    if (!isPreviewVisible() || previewMode !== 'both' || visiblePanes.length < 2) {
      return 'row';
    }

    const styles = window.getComputedStyle(imageArea);
    const innerWidth = imageArea.clientWidth
      - parsePixelSize(styles.paddingLeft)
      - parsePixelSize(styles.paddingRight);
    const innerHeight = imageArea.clientHeight
      - parsePixelSize(styles.paddingTop)
      - parsePixelSize(styles.paddingBottom);
    if (innerWidth <= 0 || innerHeight <= 0) {
      return 'row';
    }

    const columnGap = parsePixelSize(styles.columnGap || styles.gap);
    const rowGap = parsePixelSize(styles.rowGap || styles.gap);
    const headerHeight = getPaneHeaderHeight();

    const horizontalViewportWidth = Math.max(0, (innerWidth - columnGap) / visiblePanes.length);
    const horizontalViewportHeight = Math.max(0, innerHeight - headerHeight);
    const verticalViewportWidth = Math.max(0, innerWidth);
    const verticalViewportHeight = Math.max(0, (innerHeight - rowGap) / visiblePanes.length - headerHeight);

    const horizontalDistance = getSquareDistance(horizontalViewportWidth, horizontalViewportHeight);
    const verticalDistance = getSquareDistance(verticalViewportWidth, verticalViewportHeight);

    return verticalDistance < horizontalDistance ? 'column' : 'row';
  }

  function applyPreviewPaneLayout() {
    const direction = choosePreviewLayoutDirection();
    const isVertical = direction === 'column';
    imageArea.classList.toggle('image-area-vertical', isVertical);
    imageArea.dataset.previewLayout = isVertical ? 'vertical' : 'horizontal';
  }

  function applyMainLayout() {
    const previewVisible = isPreviewVisible();
    const tableVisible = isTableVisible();
    const bothVisible = previewVisible && tableVisible;
    const horizontalSplit = bothVisible && mainLayout === 'horizontal';

    imageArea.classList.toggle('hidden', !previewVisible);
    tableArea.classList.toggle('hidden', !tableVisible);
    splitter.classList.toggle('hidden', !bothVisible);
    main.classList.toggle('main-horizontal', horizontalSplit);
    splitter.setAttribute('aria-orientation', horizontalSplit ? 'vertical' : 'horizontal');
    splitter.setAttribute('aria-label', horizontalSplit ? '调整预览区域和属性表的宽度' : '调整预览区域和属性表的高度');

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

    const splitterSize = horizontalSplit
      ? (splitter.getBoundingClientRect().width || 10)
      : (splitter.getBoundingClientRect().height || 10);
    const availableSize = (horizontalSplit ? main.clientWidth : main.clientHeight) - splitterSize;
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
    const horizontalSplit = isPreviewVisible() && isTableVisible() && mainLayout === 'horizontal';
    const splitterSize = horizontalSplit
      ? (splitter.getBoundingClientRect().width || 10)
      : (splitter.getBoundingClientRect().height || 10);
    const availableSize = (horizontalSplit ? main.clientWidth : main.clientHeight) - splitterSize;
    if (availableSize <= 0) { return; }
    const mainRect = main.getBoundingClientRect();
    const rawImageSize = horizontalSplit
      ? (clientX - mainRect.left - splitterSize / 2)
      : (clientY - mainRect.top - splitterSize / 2);
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
    applyTransform(panel);
    refreshZoomLabel(panel);
    resetViewportBackground(panel);
  }

  function detectImageBackgroundColor(img) {
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      return null;
    }

    const maxSampleSize = 128;
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
      return null;
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

      for (let y = 0; y < sampleHeight; y += 1) {
        for (let x = 0; x < sampleWidth; x += 1) {
          const isBorderPixel = x < borderWidth
            || y < borderWidth
            || x >= sampleWidth - borderWidth
            || y >= sampleHeight - borderWidth;
          if (!isBorderPixel) {
            continue;
          }
          collectPixel((y * sampleWidth + x) * 4);
        }
      }

      let bestBucket = null;
      for (const bucket of buckets.values()) {
        if (!bestBucket || bucket.weight > bestBucket.weight) {
          bestBucket = bucket;
        }
      }

      if (!bestBucket || bestBucket.weight <= 0) {
        return null;
      }

      const red = Math.round(bestBucket.r / bestBucket.weight);
      const green = Math.round(bestBucket.g / bestBucket.weight);
      const blue = Math.round(bestBucket.b / bestBucket.weight);
      return 'rgb(' + red + ', ' + green + ', ' + blue + ')';
    } catch {
      return null;
    }
  }

  function syncLoadedImagePresentation(panel) {
    const img = images[panel];
    applyViewportBackground(panel, detectImageBackgroundColor(img));
    requestAnimationFrame(() => fitToViewport(panel));
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
    const sx = rect.width / vs.naturalW;
    const sy = rect.height / vs.naturalH;
    const scale = Math.min(1, Math.min(sx, sy));
    if (!Number.isFinite(scale) || scale <= 0) { return; }
    vs.fitScale = scale;
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
