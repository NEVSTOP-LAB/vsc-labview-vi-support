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
