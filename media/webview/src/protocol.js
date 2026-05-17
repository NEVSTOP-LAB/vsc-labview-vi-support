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

