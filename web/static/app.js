(function() {
  'use strict';

  let currentTab = null;
  let currentItemId = null;
  let menuTree = [];
  let contentModified = false;
  let activeTabEl = null;
  let treeCtxItemId = null;
  let treeExpandedState = {}; // { tabName: Set<nodeId> }
  let dirtyTabs = {}; // { tabName: true/false }
  let lastEditedItem = {}; // { tabName: itemId }

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const tabsEl = $('#tabs');
  const treeContainer = $('#tree-container');
  const editor = $('#editor');
  const editorStatus = $('#editor-status');
  const ctxMenu = $('#context-menu');
  const treeCtxMenu = $('#tree-context-menu');
  const tabCtxMenu = $('#tab-context-menu');


  async function api(method, url, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API Error');
    return data;
  }

  async function apiUpload(url, file) {
    const formData = new FormData();
    formData.append('image', file);
    const res = await fetch(url, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload Error');
    return data;
  }

  // ─── Tab Drag-and-Drop ─────────────────────────────────────────────────

  let dragSrcTab = null;

  function clearTabDragOver() {
    tabsEl.querySelectorAll('.tab').forEach((t) => t.classList.remove('drag-over', 'drag-over-right'));
    tabsEl.classList.remove('drag-over-end');
  }

  function clearTabDragState() {
    clearTabDragOver();
    dragSrcTab = null;
  }

  async function doTabReorder(targetEl, onRightHalf) {
    if (!dragSrcTab) return;
    const tabs = [...tabsEl.querySelectorAll('.tab')].filter((t) => t.dataset.tab);
    const srcIdx = tabs.indexOf(dragSrcTab);
    if (srcIdx === -1) return;

    // Determine insertBefore index (position where the item should be inserted)
    let insertBefore;
    if (!targetEl) {
      // Dropped on empty space -> append at end
      insertBefore = tabs.length;
    } else {
      const dstIdx = tabs.indexOf(targetEl);
      if (dstIdx === -1) return;
      insertBefore = onRightHalf ? dstIdx + 1 : dstIdx;
    }

    const names = tabs.map((t) => t.dataset.tab);
    const draggedName = names[srcIdx];
    names.splice(srcIdx, 1);
    if (srcIdx < insertBefore) insertBefore--;
    names.splice(insertBefore, 0, draggedName);

    try {
      await api('PUT', '/api/tab-order', names);
      await loadTabs();
      // After tabs are rebuilt, switch to the dragged tab
      const newTabEl = tabsEl.querySelector(`.tab[data-tab="${CSS.escape(draggedName)}"]`);
      if (newTabEl) {
        switchTab(draggedName, newTabEl);
      }
    } catch (err) {
      console.error('Failed to save tab order:', err);
    }
  }

  function makeTabDraggable(el) {
    el.draggable = true;

    el.addEventListener('dragstart', (e) => {
      dragSrcTab = el;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', el.dataset.tab);
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (el === dragSrcTab) return;
      e.dataTransfer.dropEffect = 'move';
      clearTabDragOver();
      const rect = el.getBoundingClientRect();
      if (e.clientX < rect.left + rect.width / 2) {
        el.classList.add('drag-over');
      } else {
        el.classList.add('drag-over-right');
      }
    });

    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over', 'drag-over-right');
    });

    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (el === dragSrcTab || !dragSrcTab) return;
      clearTabDragOver();
      const rect = el.getBoundingClientRect();
      const onRightHalf = e.clientX >= rect.left + rect.width / 2;
      await doTabReorder(el, onRightHalf);
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      clearTabDragState();
    });
  }

  // ─── Tab Container Drop (for dropping at end of list) ──────────────────

  tabsEl.addEventListener('dragover', (e) => {
    const tabUnder = e.target.closest('.tab');
    if (!tabUnder && dragSrcTab) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearTabDragOver();
      tabsEl.classList.add('drag-over-end');
    }
  });

  tabsEl.addEventListener('dragleave', (e) => {
    if (!tabsEl.contains(e.relatedTarget)) {
      tabsEl.classList.remove('drag-over-end');
    }
  });

  tabsEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    tabsEl.classList.remove('drag-over-end');
    // Only handle if not dropping on a specific tab element
    const tabUnder = e.target.closest('.tab');
    if (!tabUnder && dragSrcTab) {
      await doTabReorder(null, false);
    }
  });

  // ─── Load Tabs ─────────────────────────────────────────────────────────

  async function loadTabs() {
    const tabs = await api('GET', '/api/tabs');
    tabsEl.innerHTML = '';
    if (tabs.length === 0) {
      tabsEl.innerHTML = '<div class="tab" style="color:#888">No document centers found</div>';
      return;
    }
    tabs.forEach((name) => {
      const el = document.createElement('div');
      el.className = 'tab';
      el.dataset.tab = name;
      el.dataset.origName = name;
      el.textContent = name;
      el.addEventListener('click', () => switchTab(name, el));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabContextMenu(e, name);
      });
      makeTabDraggable(el);
      tabsEl.appendChild(el);
    });
    if (!currentTab || !tabs.includes(currentTab)) {
      const first = tabsEl.querySelector('.tab');
      if (first) switchTab(tabs[0], first);
    }
    updateTabScrollButtons();
  }

  async function switchTab(name, el) {
    if (currentTab && currentTab !== name) {
      // Save unsaved content before leaving
      if (contentModified && currentItemId) {
        await saveContent(currentItemId);
      }
      // Clear dirty flag when leaving a tab — menu ops (add/rename/delete/move)
      // already persist to server but set dirtyTabs=true without contentModified=true,
      // so saveContent won't run and the * would stick.
      dirtyTabs[currentTab] = false;
      updateTabLabel(currentTab);
      treeExpandedState[currentTab] = saveExpandedState();
    }
    if (activeTabEl) activeTabEl.classList.remove('active');
    el.classList.add('active');
    activeTabEl = el;
    currentTab = name;
    currentItemId = null;
    contentModified = false;
    menuTree = [];

    treeContainer.innerHTML = '<div style="padding:12px;color:#999;font-size:13px">Loading...</div>';

    try {
      await loadMenu();
    } catch (e) {
      console.error('Failed to load menu for tab:', name, e);
      treeContainer.innerHTML = '<div style="padding:12px;color:#999;font-size:13px">Failed to load menu</div>';
    }

    // Restore last selected item for this tab
    const lastId = lastEditedItem[currentTab];
    if (lastId && findNodeById(menuTree, lastId)) {
      scrollToTreeNode(lastId);
      selectItem(lastId);
    } else {
      editor.innerHTML = '<p>Select a menu item to edit its content...</p>';
      editorStatus.textContent = 'No item selected';
    }
  }

  async function loadMenu() {
    if (!currentTab) return;
    menuTree = await api('GET', `/api/${encodeURIComponent(currentTab)}/menu`);
    renderTree();
  }

  function saveExpandedState() {
    const expanded = new Set();
    treeContainer.querySelectorAll('.tree-node').forEach((node) => {
      const childrenDiv = node.querySelector('.tree-children');
      if (childrenDiv && childrenDiv.style.display !== 'none') {
        expanded.add(node.dataset.id);
      }
    });
    return expanded;
  }

  function restoreExpandedState(expanded) {
    if (!expanded) return;
    expanded.forEach((id) => {
      const node = treeContainer.querySelector(`.tree-node[data-id="${id}"]`);
      if (node) {
        const childrenDiv = node.querySelector('.tree-children');
        const toggle = node.querySelector('.toggle');
        if (childrenDiv && toggle && !toggle.classList.contains('empty')) {
          childrenDiv.style.display = '';
          toggle.textContent = '\u25BE';
        }
      }
    });
  }

  function renderTree() {
    treeContainer.innerHTML = '';
    menuTree.forEach((item) => renderTreeNode(item, treeContainer, 0));
    const saved = currentTab ? treeExpandedState[currentTab] : null;
    if (saved) restoreExpandedState(saved);
  }

  async function reloadMenu() {
    if (currentTab) {
      treeExpandedState[currentTab] = saveExpandedState();
    }
    await loadMenu();
  }

  function renderTreeNode(item, container, depth) {
    const nodeDiv = document.createElement('div');
    nodeDiv.className = 'tree-node';
    nodeDiv.dataset.id = item.id;

    const header = document.createElement('div');
    header.className = 'tree-node-header';
    if (currentItemId === item.id) header.classList.add('active');

    const toggle = document.createElement('span');
    toggle.className = 'toggle';
    const hasChildren = item.children && item.children.length > 0;
    toggle.textContent = '\u25B8';
    if (!hasChildren) {
      toggle.className = 'toggle empty';
    }
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const childrenDiv = nodeDiv.querySelector('.tree-children');
      if (childrenDiv) {
        const isHidden = childrenDiv.style.display === 'none';
        childrenDiv.style.display = isHidden ? '' : 'none';
        toggle.textContent = isHidden ? '\u25BE' : '\u25B8';
      }
    });

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label;

    header.appendChild(toggle);
    header.appendChild(label);
    header.addEventListener('click', () => {
      if (currentItemId === item.id && !item._editing) {
        startInlineEdit(item, label);
      } else {
        selectItem(item.id);
      }
    });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showTreeContextMenu(e, item.id);
    });

    nodeDiv.appendChild(header);

    if (hasChildren) {
      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'tree-children';
      childrenDiv.style.display = 'none';
      item.children.forEach((child) => renderTreeNode(child, childrenDiv, depth + 1));
      nodeDiv.appendChild(childrenDiv);
    }

    container.appendChild(nodeDiv);
  }

  function findNodeById(items, id) {
    for (const item of items) {
      if (item.id === id) return item;
      if (item.children) {
        const found = findNodeById(item.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  function findParentId(items, id, parentId) {
    for (const item of items) {
      if (item.id === id) return parentId;
      if (item.children) {
        const found = findParentId(item.children, id, item.id);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  function scrollToTreeNode(nodeId) {
    // Expand all ancestors so the node is visible
    const ancestors = [];
    let pid = findParentId(menuTree, nodeId, null);
    while (pid !== undefined && pid !== null) {
      ancestors.unshift(pid);
      pid = findParentId(menuTree, pid, null);
    }
    for (const aid of ancestors) {
      const parentEl = treeContainer.querySelector(`.tree-node[data-id="${aid}"]`);
      if (!parentEl) continue;
      const childrenDiv = parentEl.querySelector('.tree-children');
      const toggle = parentEl.querySelector('.toggle');
      if (childrenDiv && toggle && !toggle.classList.contains('empty') && childrenDiv.style.display === 'none') {
        childrenDiv.style.display = '';
        toggle.textContent = '\u25BE';
      }
    }
    // Scroll the new node into view
    const nodeEl = treeContainer.querySelector(`.tree-node[data-id="${nodeId}"]`);
    if (nodeEl) {
      nodeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function selectItem(id) {
    if (contentModified && currentItemId) {
      saveContent(currentItemId);
    }

    currentItemId = id;
    lastEditedItem[currentTab] = id;
    contentModified = false;

    $$('.tree-node-header').forEach((h) => h.classList.remove('active'));
    const header = treeContainer.querySelector(`.tree-node[data-id="${id}"] .tree-node-header`);
    if (header) header.classList.add('active');

    loadContent(id);
  }

  async function loadContent(itemId) {
    if (!currentTab) return;
    try {
      const data = await api('GET', `/api/${encodeURIComponent(currentTab)}/content/${itemId}`);
      const html = data.content.trim();
      if (html) {
        editor.innerHTML = html;
      } else {
        editor.innerHTML = '<p></p>';
      }
      const item = findNodeById(menuTree, itemId);
      editorStatus.textContent = `Editing: ${item ? item.label : 'Unknown'}`;
    } catch (e) {
      editor.innerHTML = '<p>Error loading content</p>';
      editorStatus.textContent = 'Error loading content';
    }
  }

  async function saveContent(itemId) {
    if (!currentTab || !itemId) return;
    const html = editor.innerHTML;
    try {
      await api('PUT', `/api/${encodeURIComponent(currentTab)}/content/${itemId}`, { content: html });
      contentModified = false;
      editorStatus.textContent = editorStatus.textContent.replace(' (unsaved)', '') + ' (saved)';
      dirtyTabs[currentTab] = false;
      updateTabLabel(currentTab);
    } catch (e) {
      console.error('Save failed:', e);
      editorStatus.textContent = 'Save failed!';
    }
  }

  async function addMenuItem(label, parentId, afterId) {
    if (!currentTab) return;
    try {
      const body = { label };
      if (afterId) {
        body.after_id = afterId;
      } else {
        body.parent_id = parentId || null;
      }
      const result = await api('POST', `/api/${encodeURIComponent(currentTab)}/menu`, body);
      dirtyTabs[currentTab] = true;
      updateTabLabel(currentTab);
      await reloadMenu();
      if (result && result.id) {
        scrollToTreeNode(result.id);
        selectItem(result.id);
      }
    } catch (e) {
      showDialog('Error', `<p>${escapeHtml(e.message)}</p>`);
    }
  }

  async function updateMenuItem(itemId, label) {
    if (!currentTab) return;
    try {
      await api('PUT', `/api/${encodeURIComponent(currentTab)}/menu/${itemId}`, { label });
      dirtyTabs[currentTab] = true;
      updateTabLabel(currentTab);
      await reloadMenu();
      if (currentItemId === itemId) {
        editorStatus.textContent = `Editing: ${label}`;
      }
    } catch (e) {
      showDialog('Error', `<p>${escapeHtml(e.message)}</p>`);
    }
  }

  async function deleteMenuItem(itemId) {
    if (!currentTab) return;
    try {
      await api('DELETE', `/api/${encodeURIComponent(currentTab)}/menu/${itemId}`);
      if (currentItemId === itemId) {
        currentItemId = null;
        editor.innerHTML = '<p>Select a menu item to edit its content...</p>';
        editorStatus.textContent = 'No item selected';
      }
      dirtyTabs[currentTab] = true;
      updateTabLabel(currentTab);
      await reloadMenu();
    } catch (e) {
      showDialog('Error', `<p>${escapeHtml(e.message)}</p>`);
    }
  }

  async function renameTab(oldName, newName) {
    try {
      await api('PUT', `/api/tabs/${encodeURIComponent(oldName)}`, { new_name: newName });
      if (currentTab === oldName) {
        currentTab = newName;
      }
      if (treeExpandedState[oldName] !== undefined) {
        treeExpandedState[newName] = treeExpandedState[oldName];
        delete treeExpandedState[oldName];
      }
      if (dirtyTabs[oldName] !== undefined) {
        dirtyTabs[newName] = dirtyTabs[oldName];
        delete dirtyTabs[oldName];
      }
      if (lastEditedItem[oldName] !== undefined) {
        lastEditedItem[newName] = lastEditedItem[oldName];
        delete lastEditedItem[oldName];
      }
      await loadTabs();
      if (currentTab === newName) {
        const newTabEl = tabsEl.querySelector(`.tab[data-tab="${CSS.escape(newName)}"]`);
        if (newTabEl) {
          switchTab(newName, newTabEl);
        }
      }
    } catch (e) {
      showDialog('Error', `<p>${escapeHtml(e.message)}</p>`);
    }
  }

  async function deleteTab(name) {
    try {
      await api('DELETE', `/api/tabs/${encodeURIComponent(name)}`);
      if (currentTab === name) {
        currentTab = null;
        currentItemId = null;
        editor.innerHTML = '<p>Select a menu item to edit its content...</p>';
        editorStatus.textContent = 'No item selected';
      }
      await loadTabs();
    } catch (e) {
      showDialog('Error', `<p>${escapeHtml(e.message)}</p>`);
    }
  }

  function updateTabLabel(name) {
    const el = tabsEl.querySelector(`.tab[data-tab="${name}"]`);
    if (!el) return;
    const base = el.dataset.origName || name;
    el.textContent = dirtyTabs[name] ? '*' + base : base;
  }



  async function moveMenuItem(itemId, direction) {
    if (!currentTab) return;
    try {
      await api('PUT', `/api/${encodeURIComponent(currentTab)}/menu/${itemId}/move`, { direction });
      dirtyTabs[currentTab] = true;
      updateTabLabel(currentTab);
      await reloadMenu();
    } catch (e) {
      showDialog('Error', `<p>${escapeHtml(e.message)}</p>`);
    }
  }

  async function moveMenuItemToTarget(itemId, targetParentId) {
    if (!currentTab) return;
    try {
      await api('PUT', `/api/${encodeURIComponent(currentTab)}/menu/${itemId}/move`, { target_parent_id: targetParentId });
      dirtyTabs[currentTab] = true;
      updateTabLabel(currentTab);
      await reloadMenu();
    } catch (e) {
      showDialog('Error', `<p>${escapeHtml(e.message)}</p>`);
    }
  }

  // ─── Dialog ────────────────────────────────────────────────────────────

  function showDialog(title, contentHtml, onOk) {
    const overlay = $('#dialog-overlay');
    $('#dialog-title').textContent = title;
    $('#dialog-content').innerHTML = contentHtml;
    overlay.style.display = 'flex';

    return new Promise((resolve) => {
      $('#dialog-ok').onclick = () => {
        const result = onOk ? onOk() : true;
        overlay.style.display = 'none';
        resolve(result);
      };
      $('#dialog-cancel').onclick = () => {
        overlay.style.display = 'none';
        resolve(null);
      };
    });
  }

  function promptAddChild(parentId, afterId) {
    showDialog(
      'Add Menu Item',
      '<label>Item name:</label><input type="text" id="dialog-input" placeholder="Enter item name">',
      () => {
        const input = $('#dialog-input');
        const val = input.value.trim();
        if (val) {
          addMenuItem(val, parentId, afterId);
          return true;
        }
        return false;
      }
    );
    const input = $('#dialog-input');
    if (input) {
      input.focus();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#dialog-ok').click();
      });
    }
  }

  function promptRename(itemId, currentLabel) {
    showDialog(
      'Rename Item',
      `<label>New name:</label><input type="text" id="dialog-input" value="${escapeHtml(currentLabel)}">`,
      () => {
        const input = $('#dialog-input');
        const val = input.value.trim();
        if (val && val !== currentLabel) {
          updateMenuItem(itemId, val);
        }
        return true;
      }
    );
    const input = $('#dialog-input');
    if (input) {
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#dialog-ok').click();
      });
    }
  }

  function promptDelete(itemId, label) {
    showDialog(
      'Delete Item',
      `<p>Are you sure you want to delete "<strong>${escapeHtml(label)}</strong>" and all its children?</p>`,
      () => {
        deleteMenuItem(itemId);
        return true;
      }
    );
  }

  function promptRenameTab(oldName) {
    showDialog(
      '重命名 Tab',
      `<label>新名称:</label><input type="text" id="dialog-input" value="${escapeHtml(oldName)}">`,
      () => {
        const input = $('#dialog-input');
        const val = input.value.trim();
        if (val && val !== oldName) {
          renameTab(oldName, val);
        }
        return true;
      }
    );
    const input = $('#dialog-input');
    if (input) {
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#dialog-ok').click();
      });
    }
  }

  function promptInsertLink() {
    showDialog(
      'Insert Link',
      '<label>URL:</label><input type="text" id="dialog-link-url" placeholder="https://..."><label>Text:</label><input type="text" id="dialog-link-text" placeholder="Link text">',
      () => {
        const url = $('#dialog-link-url').value.trim();
        const text = $('#dialog-link-text').value.trim() || url;
        if (url) {
          document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}" target="_blank">${escapeHtml(text)}</a>`);
          editor.focus();
        }
        return true;
      }
    );
  }

  // ─── New Tab ───────────────────────────────────────────────────────────

  $('#btn-new-tab').addEventListener('click', () => {
    showDialog(
      'New Tab',
      '<label>Tab name:</label><input type="text" id="dialog-input" placeholder="Enter tab name">',
      async () => {
        const input = $('#dialog-input');
        const val = input.value.trim();
        if (!val) return false;
        try {
          await api('POST', '/api/tabs', { name: val });
          await loadTabs();
        } catch (e) {
          showDialog('Error', `<p>${escapeHtml(e.message)}</p>`);
        }
        return true;
      }
    );
    const input = $('#dialog-input');
    if (input) {
      input.focus();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#dialog-ok').click();
      });
    }
  });

  // ─── Help ──────────────────────────────────────────────────────────────

  $('#tab-help').addEventListener('click', () => {
    showDialog('Help', `
      <div style="font-size:13px;line-height:1.8">
        <p><b>Editor</b></p>
        <p>Ctrl+S — Save current content</p>
        <p><b>Tree</b></p>
        <p>Right-click on any item for context menu</p>
        <p>Click item name twice to rename inline</p>
        <p><b>Tabs</b></p>
        <p>Right-click on a tab to delete it</p>
        <p>+ Tab button in toolbar creates a new tab</p>
      </div>
    `);
  });

  // ─── Toolbar Dropdown ──────────────────────────────────────────────────

  $('#btn-toolbar-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = $('#toolbar-dropdown');
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  });

  document.addEventListener('click', (e) => {
    const dd = $('#toolbar-dropdown');
    if (dd && !e.target.closest('#toolbar-dropdown-wrap')) {
      dd.style.display = 'none';
    }
  });

  $('#dd-collapse-all').addEventListener('click', () => {
    $('#toolbar-dropdown').style.display = 'none';
    collapseAll();
  });

  $('#dd-expand-all').addEventListener('click', () => {
    $('#toolbar-dropdown').style.display = 'none';
    expandAll();
  });

  $('#dd-add-root').addEventListener('click', () => {
    $('#toolbar-dropdown').style.display = 'none';
    promptAddChild(null);
  });

  function collapseAll() {
    treeContainer.querySelectorAll('.tree-children').forEach((el) => {
      el.style.display = 'none';
    });
    treeContainer.querySelectorAll('.tree-node-header .toggle').forEach((t) => {
      if (!t.classList.contains('empty')) {
        t.textContent = '\u25B8';
      }
    });
    if (currentTab) treeExpandedState[currentTab] = new Set();
  }

  function expandAll() {
    treeContainer.querySelectorAll('.tree-children').forEach((el) => {
      el.style.display = '';
    });
    treeContainer.querySelectorAll('.tree-node-header .toggle').forEach((t) => {
      if (!t.classList.contains('empty')) {
        t.textContent = '\u25BE';
      }
    });
    if (currentTab) {
      const all = new Set();
      treeContainer.querySelectorAll('.tree-node').forEach((n) => all.add(n.dataset.id));
      treeExpandedState[currentTab] = all;
    }
  }

  // ─── Tree Right-Click Context Menu ─────────────────────────────────────

  function showTreeContextMenu(e, itemId) {
    treeCtxItemId = itemId;
    treeCtxMenu.style.left = e.clientX + 'px';
    treeCtxMenu.style.top = e.clientY + 'px';
    treeCtxMenu.style.display = 'block';
  }

  $$('#tree-context-menu .tree-ctx-item').forEach((item) => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      const id = treeCtxItemId;
      treeCtxMenu.style.display = 'none';
      if (!id) return;

      switch (action) {
        case 'add-child':
          promptAddChild(id);
          break;
        case 'add-sibling': {
          const parentId = findParentId(menuTree, id, null);
          promptAddChild(parentId, id);
          break;
        }
        case 'move-up':
          moveMenuItem(id, 'up');
          break;
        case 'move-down':
          moveMenuItem(id, 'down');
          break;
        case 'move-to':
          showMoveToDialog(id);
          break;
        case 'edit': {
          const node = findNodeById(menuTree, id);
          if (node) promptRename(id, node.label);
          break;
        }
        case 'delete': {
          const node = findNodeById(menuTree, id);
          if (node) promptDelete(id, node.label);
          break;
        }
      }
    });
  });

  async function showMoveToDialog(itemId) {
    if (!currentTab) return;
    let treeData;
    try {
      treeData = await api('GET', `/api/${encodeURIComponent(currentTab)}/tree`);
    } catch (e) {
      showDialog('Error', `<p>${escapeHtml(e.message)}</p>`);
      return;
    }

    const currentItem = findNodeById(menuTree, itemId);
    const currentLabel = currentItem ? currentItem.label : 'Unknown';

    let html = `<p style="margin-bottom:8px;font-size:13px;color:#555">Move "<strong>${escapeHtml(currentLabel)}</strong>" to:</p>`;
    html += '<div id="move-tree">';
    html += '<div class="move-tree-item" data-id="">&lt;Root (top level)&gt;</div>';
    treeData.forEach((n) => {
      if (n.id === itemId) return;
      const indent = n.depth * 20;
      html += `<div class="move-tree-item" data-id="${n.id}" style="padding-left:${10 + indent}px">${escapeHtml(n.label)}</div>`;
    });
    html += '</div>';

    let selectedTargetId = null;

    showDialog('Move Item', html, () => {
      if (selectedTargetId === undefined) return false;
      moveMenuItemToTarget(itemId, selectedTargetId);
      return true;
    });

    const moveTreeEl = $('#move-tree');
    if (moveTreeEl) {
      moveTreeEl.querySelectorAll('.move-tree-item').forEach((el) => {
        el.addEventListener('click', () => {
          moveTreeEl.querySelectorAll('.move-tree-item').forEach((x) => x.classList.remove('selected'));
          el.classList.add('selected');
          selectedTargetId = el.dataset.id === '' ? null : el.dataset.id;
        });
      });
    }
  }

  // ─── Editor Toolbar ────────────────────────────────────────────────────

  $$('.tool-btn[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      editor.focus();
      document.execCommand(cmd, false, null);
      markModified();
    });
  });

  $('#font-family').addEventListener('change', function() {
    editor.focus();
    document.execCommand('fontName', false, this.value);
    markModified();
  });

  $('#font-size').addEventListener('change', function() {
    editor.focus();
    document.execCommand('fontSize', false, this.value);
    markModified();
  });

  $('#text-color').addEventListener('input', function() {
    editor.focus();
    document.execCommand('foreColor', false, this.value);
    markModified();
  });

  $('#btn-insert-link').addEventListener('click', () => {
    const sel = window.getSelection().toString();
    if (sel) {
      $('#dialog-link-text').value = sel;
    }
    promptInsertLink();
  });

  $('#btn-insert-image').addEventListener('click', () => {
    showDialog(
      'Insert Image',
      '<label>Image URL:</label><input type="text" id="dialog-img-url" placeholder="https://...">',
      () => {
        const url = $('#dialog-img-url').value.trim();
        if (url) {
          editor.focus();
          document.execCommand('insertImage', false, url);
          markModified();
        }
        return true;
      }
    );
  });

  $('#btn-upload-image').addEventListener('click', () => {
    $('#image-upload-input').click();
  });

  $('#image-upload-input').addEventListener('change', async function() {
    if (!this.files || !this.files[0]) return;
    const file = this.files[0];
    try {
      const result = await apiUpload(`/api/${encodeURIComponent(currentTab)}/upload`, file);
      editor.focus();
      document.execCommand('insertImage', false, result.url);
      markModified();
    } catch (e) {
      showDialog('Error', `<p>${escapeHtml(e.message)}</p>`);
    }
    this.value = '';
  });

  $('#btn-paste-plain').addEventListener('click', () => {
    navigator.clipboard.readText().then((text) => {
      editor.focus();
      document.execCommand('insertText', false, text);
      markModified();
    }).catch(() => {
      showDialog('Error', '<p>Cannot read clipboard. Please use Ctrl+Shift+V for plain paste.</p>');
    });
  });

  $('#btn-save').addEventListener('click', () => {
    if (currentItemId) {
      saveContent(currentItemId);
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (currentItemId) saveContent(currentItemId);
    }
    if (e.key === 'Escape') {
      ctxMenu.style.display = 'none';
      treeCtxMenu.style.display = 'none';
      tabCtxMenu.style.display = 'none';
    }
  });

  function markModified() {
    if (!contentModified && currentItemId) {
      contentModified = true;
      const txt = editorStatus.textContent;
      if (!txt.includes('(unsaved)')) {
        editorStatus.textContent = txt + ' (unsaved)';
      }
      if (currentTab) {
        dirtyTabs[currentTab] = true;
        updateTabLabel(currentTab);
      }
    }
  }

  editor.addEventListener('input', markModified);
  editor.addEventListener('paste', handlePaste);

  function handlePaste(e) {
    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;

    const items = clipboardData.items;
    let hasImage = false;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.startsWith('image/')) {
        hasImage = true;
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) {
          uploadAndInsertImage(file);
        }
        break;
      }
    }

    if (!hasImage && items.length > 0) {
      const htmlContent = clipboardData.getData('text/html');
      const textContent = clipboardData.getData('text/plain');

      if (textContent && !htmlContent) {
        e.preventDefault();
        editor.focus();
        document.execCommand('insertText', false, textContent);
        markModified();
      }
    }
  }

  async function uploadAndInsertImage(file) {
    if (!currentTab) return;
    try {
      const result = await apiUpload(`/api/${encodeURIComponent(currentTab)}/upload`, file);
      editor.focus();
      document.execCommand('insertImage', false, result.url);
      markModified();
    } catch (e) {
      console.error('Image paste upload failed:', e);
    }
  }

  // ─── Editor Context Menu ───────────────────────────────────────────────

  editor.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const selection = window.getSelection();
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top = e.clientY + 'px';
    ctxMenu.style.display = 'block';
    ctxMenu.dataset.hasSelection = selection.toString().length > 0 ? 'true' : 'false';
  });

  $$('.ctx-item[data-cmd]').forEach((item) => {
    item.addEventListener('click', () => {
      const cmd = item.dataset.cmd;
      if (cmd === 'copy') {
        document.execCommand('copy');
      } else if (cmd === 'paste') {
        editor.focus();
        document.execCommand('paste');
      } else {
        editor.focus();
        document.execCommand(cmd, false, null);
        markModified();
      }
      ctxMenu.style.display = 'none';
    });
  });

  $('#ctx-font-family').addEventListener('click', () => {
    ctxMenu.style.display = 'none';
    showDialog(
      'Set Font Family',
      `<label>Font:</label>
       <select id="dialog-font-family">
         <option value="Arial">Arial</option>
         <option value="Times New Roman">Times New Roman</option>
         <option value="Courier New">Courier New</option>
         <option value="Georgia">Georgia</option>
         <option value="Verdana">Verdana</option>
         <option value="SimSun">SimSun</option>
         <option value="Microsoft YaHei">Microsoft YaHei</option>
       </select>`,
      () => {
        const val = $('#dialog-font-family').value;
        editor.focus();
        document.execCommand('fontName', false, val);
        markModified();
        return true;
      }
    );
  });

  $('#ctx-font-color').addEventListener('click', () => {
    ctxMenu.style.display = 'none';
    showDialog(
      'Set Font Color',
      '<label>Color:</label><input type="color" id="dialog-font-color" value="#ff0000">',
      () => {
        const val = $('#dialog-font-color').value;
        editor.focus();
        document.execCommand('foreColor', false, val);
        markModified();
        return true;
      }
    );
  });

  $('#ctx-remove-format').addEventListener('click', () => {
    editor.focus();
    document.execCommand('removeFormat', false, null);
    markModified();
    ctxMenu.style.display = 'none';
  });

  // ─── Splitter ──────────────────────────────────────────────────────────

  let isDragging = false;

  $('#splitter').addEventListener('mousedown', (e) => {
    isDragging = true;
    $('#splitter').classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  $('#search-splitter').addEventListener('mousedown', (e) => {
    searchDragging = true;
    searchSplitter.classList.add('active');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      const sidebar = $('#sidebar');
      const mainContent = $('#main-content');
      const rect = mainContent.getBoundingClientRect();
      let x = e.clientX - rect.left;
      const minWidth = 150;
      const maxWidth = rect.width - 200;
      if (x < minWidth) x = minWidth;
      if (x > maxWidth) x = maxWidth;
      sidebar.style.width = x + 'px';
      return;
    }
    if (searchDragging) {
      const appEl = $('#app');
      const appRect = appEl.getBoundingClientRect();
      let h = appRect.bottom - e.clientY;
      const minH = 60;
      const maxH = appRect.height * 0.6;
      if (h < minH) h = minH;
      if (h > maxH) h = maxH;
      searchPanel.style.height = h + 'px';
      return;
    }
    if (colResizing) {
      const dx = e.clientX - colResizing.startX;
      if (colResizing.isSnippet) {
        // Resize both 路径 and 内容简述 so the boundary follows the cursor
        let newSnippetW = colResizing.startSnippetW - dx;
        let newPathW = colResizing.startPathW + dx;
        const total = colResizing.startSnippetW + colResizing.startPathW;
        const snippetMinW = colResizing.snippetMinW;
        const pathMinW = colResizing.pathMinW;
        if (newSnippetW < snippetMinW) {
          newSnippetW = snippetMinW;
          newPathW = total - snippetMinW;
        }
        if (newPathW < pathMinW) {
          newPathW = pathMinW;
          newSnippetW = total - pathMinW;
        }
        // Apply to header columns
        colResizing.snippetCol.style.width = newSnippetW + 'px';
        colResizing.snippetCol.style.flex = 'none';
        colResizing.pathCol.style.width = newPathW + 'px';
        colResizing.pathCol.style.flex = 'none';
        // Sync to search result items
        searchResultsBody.querySelectorAll('.col-snippet').forEach((el) => {
          el.style.width = newSnippetW + 'px';
          el.style.flex = 'none';
        });
        searchResultsBody.querySelectorAll('.col-path').forEach((el) => {
          el.style.width = newPathW + 'px';
          el.style.flex = 'none';
        });
      } else {
        // col-tab: simple single-column resize
        let newW = colResizing.startW + dx;
        if (newW < colResizing.minW) newW = colResizing.minW;
        colResizing.col.style.width = newW + 'px';
        colResizing.col.style.flex = 'none';
        searchResultsBody.querySelectorAll('.col-tab').forEach((el) => {
          el.style.width = newW + 'px';
          el.style.flex = 'none';
        });
      }
      return;
    }
  });

  // ─── Search Column Resize ──────────────────────────────────────────────

  let colResizing = null; // { col: element, startX: number, startW: number, minW: number }

  document.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.col-resize-handle');
    if (!handle) return;
    const col = handle.parentElement;
    if (col.classList.contains('col-snippet')) {
      // Resize both 路径 and 内容简述 — boundary follows cursor
      const snippetRect = col.getBoundingClientRect();
      const pathCol = document.querySelector('#search-results-column-headers .col-path');
      const pathRect = pathCol.getBoundingClientRect();
      colResizing = {
        isSnippet: true,
        snippetCol: col,
        pathCol: pathCol,
        startX: e.clientX,
        startSnippetW: snippetRect.width,
        startPathW: pathRect.width,
        snippetMinW: parseFloat(getComputedStyle(col).minWidth) || 60,
        pathMinW: parseFloat(getComputedStyle(pathCol).minWidth) || 60
      };
    } else {
      // col-tab: simple resize
      const rect = col.getBoundingClientRect();
      colResizing = {
        isSnippet: false,
        col: col,
        startX: e.clientX,
        startW: rect.width,
        minW: parseFloat(getComputedStyle(col).minWidth) || 60
      };
    }
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  // ─── Global Mouse Up ────────────────────────────────────────────────────

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      $('#splitter').classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    if (searchDragging) {
      searchDragging = false;
      searchSplitter.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    if (colResizing) {
      document.querySelectorAll('.col-resize-handle.active').forEach((h) => h.classList.remove('active'));
      colResizing = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });

  // ─── Utilities ─────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Inline Rename ────────────────────────────────────────────────────

  let inlineEditInput = null;

  function startInlineEdit(item, labelEl) {
    if (inlineEditInput) return;
    item._editing = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename-input';
    input.value = item.label;
    labelEl.replaceWith(input);
    inlineEditInput = input;
    input.focus();
    input.select();

    function finish(save) {
      if (!inlineEditInput) return;
      const val = input.value.trim();
      input.replaceWith(labelEl);
      inlineEditInput = null;
      item._editing = false;
      if (save && val && val !== item.label) {
        updateMenuItem(item.id, val);
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ─── Tab Context Menu ─────────────────────────────────────────────────

  let tabCtxName = null;

  function showTabContextMenu(e, name) {
    tabCtxName = name;
    tabCtxMenu.style.left = e.clientX + 'px';
    tabCtxMenu.style.top = e.clientY + 'px';
    tabCtxMenu.style.display = 'block';
  }

  $$('#tab-context-menu .tab-ctx-item').forEach((item) => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      const name = tabCtxName;
      tabCtxMenu.style.display = 'none';
      if (!name) return;

      switch (action) {
        case 'edit-tab':
          promptRenameTab(name);
          break;
        case 'delete-tab':
          showDialog(
            '删除 Tab',
            `<p>确定要删除 tab "<strong>${escapeHtml(name)}</strong>" 及其所有数据吗？</p>`,
            () => {
              deleteTab(name);
              return true;
            }
          );
          break;
      }
    });
  });

  document.addEventListener('click', (e) => {
    if (!tabCtxMenu.contains(e.target)) {
      tabCtxMenu.style.display = 'none';
    }
    if (!treeCtxMenu.contains(e.target)) {
      treeCtxMenu.style.display = 'none';
    }
    if (!ctxMenu.contains(e.target)) {
      ctxMenu.style.display = 'none';
    }
  });

  // ─── Background Indexing ───────────────────────────────────────────────

  async function checkIndexingStatus() {
    try {
      const state = await api('GET', '/api/indexing-status');
      const statusEl = $('#indexing-status');
      if (state.busy) {
        statusEl.style.display = 'inline';
        statusEl.textContent = state.status || '📇 索引中...';
      } else {
        statusEl.style.display = 'none';
      }
    } catch (e) {
      // ignore polling errors
    }
  }

  // Periodic status polling (every 2 s, inexpensive)
  setInterval(checkIndexingStatus, 2000);

  /**
   * Show a modal dialog that auto-polls indexing status.
   * Resolves `true` when indexing finishes (dialog auto-closes).
   * Resolves `false` if the user clicks Cancel.
   */
  function waitForIndexing(initialStatus) {
    return new Promise((resolve) => {
      const overlay = $('#dialog-overlay');
      $('#dialog-title').textContent = '索引建立中';
      $('#dialog-content').innerHTML =
        '<p>系统正在后台建立索引，请等待索引完成后重试搜索。</p>' +
        '<p class="indexing-wait-status" id="indexing-wait-status">' + escapeHtml(initialStatus) + '</p>' +
        '<div class="indexing-progress-track"><div class="indexing-progress-bar"></div></div>';
      $('#dialog-buttons').innerHTML = '<button id="dialog-cancel">取消</button>';
      overlay.style.display = 'flex';

      const cancelBtn = $('#dialog-cancel');
      let cancelled = false;

      cancelBtn.onclick = () => {
        cancelled = true;
        overlay.style.display = 'none';
        resolve(false);
      };

      // Poll every second until indexing finishes or user cancels
      const timer = setInterval(async () => {
        if (cancelled) {
          clearInterval(timer);
          return;
        }
        try {
          const state = await api('GET', '/api/indexing-status');
          const statusEl = $('#indexing-wait-status');
          if (statusEl) {
            statusEl.textContent = state.status || '索引中...';
          }
          if (!state.busy) {
            clearInterval(timer);
            overlay.style.display = 'none';
            resolve(true);
          }
        } catch (e) {
          // ignore polling errors
        }
      }, 1000);
    });
  }

  // ─── Search ────────────────────────────────────────────────────────────

  const searchInput = $('#search-input');
  const searchBtn = $('#btn-search');
  const searchGlobal = $('#search-global');
  const searchPanel = $('#search-results-panel');
  const searchSplitter = $('#search-splitter');
  const searchResultsBody = $('#search-results-body');
  const searchResultsClose = $('#search-results-close');
  let searchDragging = false;

  async function performSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    // Check if background indexing is in progress — if so, wait
    try {
      const state = await api('GET', '/api/indexing-status');
      if (state.busy) {
        const proceed = await waitForIndexing(state.status);
        if (!proceed) return; // user cancelled
        // Indexing done — proceed with search below
      }
    } catch (e) {
      // If status check fails, proceed anyway
    }

    const globalMode = searchGlobal.checked;
    const tabParam = globalMode ? '' : (currentTab || '');

    searchResultsBody.innerHTML = '<div class="search-loading">搜索中...</div>';
    searchPanel.style.display = 'flex';
    searchSplitter.style.display = 'block';
    $('#search-results-column-headers').style.display = 'none';

    try {
      let url = `/api/search?q=${encodeURIComponent(query)}`;
      if (tabParam) {
        url += `&tab=${encodeURIComponent(tabParam)}`;
      }
      const results = await api('GET', url);

      if (results.length === 0) {
        searchResultsBody.innerHTML = '<div class="search-empty">未找到匹配结果</div>';
        return;
      }

      let html = `<div class="search-stats">找到 ${results.length} 条结果</div>`;
      results.forEach((r) => {
        const tab = escapeHtml(r.tab);
        const path = escapeHtml(r.menu_path);
        const snippet = escapeHtml(r.snippet || '');
        html += `<div class="search-result-item" data-tab="${escapeHtml(r.tab)}" data-item-id="${escapeHtml(r.menu_item_id)}">`;
        html += `<span class="col-tab">${tab}</span>`;
        html += `<span class="col-path">${path}</span>`;
        html += `<span class="col-snippet">${snippet || ''}</span>`;
        html += '</div>';
      });
      searchResultsBody.innerHTML = html;
      $('#search-results-column-headers').style.display = 'flex';

      searchResultsBody.querySelectorAll('.search-result-item').forEach((el) => {
        el.addEventListener('click', () => {
          const targetTab = el.dataset.tab;
          const targetItemId = el.dataset.itemId;
          // Highlight selected item
          searchResultsBody.querySelectorAll('.search-result-item').forEach((x) => x.classList.remove('active'));
          el.classList.add('active');
          navigateToSearchResult(targetTab, targetItemId);
        });
      });
    } catch (e) {
      searchResultsBody.innerHTML = `<div class="search-empty">搜索出错: ${escapeHtml(e.message)}</div>`;
    }
  }

  async function navigateToSearchResult(tabName, itemId) {
    // Keep search panel open (no longer hides it on select)

    if (tabName && tabName !== currentTab) {
      const tabEl = tabsEl.querySelector(`.tab[data-tab="${CSS.escape(tabName)}"]`);
      if (tabEl) {
        await switchTab(tabName, tabEl);
      } else {
        await loadTabs();
        const newTabEl = tabsEl.querySelector(`.tab[data-tab="${CSS.escape(tabName)}"]`);
        if (newTabEl) {
          await switchTab(tabName, newTabEl);
        } else {
          return;
        }
      }
    }

    if (findNodeById(menuTree, itemId)) {
      scrollToTreeNode(itemId);
      selectItem(itemId);
    }
  }

  searchBtn.addEventListener('click', performSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      performSearch();
    }
  });

  searchResultsClose.addEventListener('click', () => {
    searchPanel.style.display = 'none';
    searchSplitter.style.display = 'none';
  });

  // ─── Tab Scrolling (overflow arrows) ────────────────────────────────────

  const scrollLeftBtn = $('#tab-scroll-left');
  const scrollRightBtn = $('#tab-scroll-right');
  const SCROLL_STEP = 200;
  let scrollInterval = null;

  function updateTabScrollButtons() {
    const hasOverflow = tabsContainer.scrollWidth > tabsContainer.clientWidth + 2;
    const atStart = tabsContainer.scrollLeft <= 4;
    const atEnd = tabsContainer.scrollLeft >= tabsContainer.scrollWidth - tabsContainer.clientWidth - 4;

    scrollLeftBtn.classList.toggle('visible', hasOverflow && !atStart);
    scrollRightBtn.classList.toggle('visible', hasOverflow && !atEnd);
  }

  tabsContainer.addEventListener('scroll', updateTabScrollButtons);
  window.addEventListener('resize', updateTabScrollButtons);

  function scrollTabs(direction, smooth) {
    tabsContainer.scrollBy({
      left: direction * SCROLL_STEP,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  scrollLeftBtn.addEventListener('click', () => scrollTabs(-1, true));
  scrollRightBtn.addEventListener('click', () => scrollTabs(1, true));

  function startScroll(direction) {
    scrollTabs(direction, false);
    if (scrollInterval) clearInterval(scrollInterval);
    scrollInterval = setInterval(() => scrollTabs(direction, false), 120);
  }

  function stopScroll() {
    if (scrollInterval) {
      clearInterval(scrollInterval);
      scrollInterval = null;
    }
  }

  scrollLeftBtn.addEventListener('mousedown', (e) => { e.preventDefault(); startScroll(-1); });
  scrollRightBtn.addEventListener('mousedown', (e) => { e.preventDefault(); startScroll(1); });
  document.addEventListener('mouseup', stopScroll);
  scrollLeftBtn.addEventListener('mouseleave', stopScroll);
  scrollRightBtn.addEventListener('mouseleave', stopScroll);

  // Wheel → horizontal scroll on tabs
  tabsContainer.addEventListener('wheel', (e) => {
    const absX = Math.abs(e.deltaX);
    const absY = Math.abs(e.deltaY);
    if (absY > absX && absY > 0) {
      tabsContainer.scrollBy({ left: e.deltaY, behavior: 'auto' });
      e.preventDefault();
    }
  }, { passive: false });

  // ─── Init ──────────────────────────────────────────────────────────────

  loadTabs();

})();
