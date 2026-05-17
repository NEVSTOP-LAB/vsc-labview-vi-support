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
