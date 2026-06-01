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
  let kbVisibility = {}; // { tabName: true/false }
  let kbTabNames = []; // full list of all tab names

  // Socket.IO for real-time collaboration
  const socket = io();
  let mySocketId = null;
  socket.on('connect', () => { mySocketId = socket.id; });
  let syncTimer = null;
  let isRemoteUpdate = false;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const tabsEl = $('#tabs');
  const treeContainer = $('#tree-container');
  const editor = $('#editor');
  const editorStatus = $('#editor-status');
  const ctxMenu = $('#context-menu');
  const treeCtxMenu = $('#tree-context-menu');
  const tabCtxMenu = $('#tab-context-menu');

  // ─── i18n ──────────────────────────────────────────────────────────────

  const i18n = {
    'zh-CN': {
      collapse_all: '全部收起',
      expand_all: '全部展开',
      add_root_menu: '新增根菜单项',
      add_child_menu: '新增子菜单项',
      add_menu_item: '新增菜单项',
      move_up: '上移',
      move_down: '下移',
      move_to: '移动到...',
      edit: '编辑',
      custom_style: '定制样式',
      export: '导出',
      delete: '删除',
      close: '关闭',
      global_search: '全局搜索',
      regex: '正则',
      search_placeholder: '输入搜索关键词...',
      search: '搜索',
      new_kb: '新增知识库',
      backup_kb: '备份知识库',
      all_kb: '全部知识库',
      search_results: '搜索结果',
      kb: '知识库',
      path: '路径',
      content_summary: '内容简述',
      icon_emoji: '图标 (Emoji):',
      icon_placeholder: '如: 📁 🔖',
      font: '字体:',
      font_size: '字号:',
      default: '默认',
      text_color: '文字颜色:',
      bg_color: '背景颜色:',
      reset: '重置',
      font_style: '字体样式:',
      bold: '加粗',
      underline: '下划线',
      strikethrough: '删除线',
      ok: '确定',
      cancel: '取消',
      reset_style: '重置样式',
      settings: '设置',
      help: '帮助',
      page_title: '知识库KBase {version}',
      version: '版本:',
      language: '语言:',
      loading: 'Loading...',
      failed_load_menu: 'Failed to load menu',
      select_item_hint: 'Select a menu item to edit its content...',
      no_item_selected: 'No item selected',
      search_in_progress: '搜索中...',
      search_no_results: '未找到匹配结果',
      search_found: '找到',
      search_results_count: '条结果',
      search_error: '搜索出错:',
      backup_title: '备份知识库',
      backup_waiting: '正在备份知识库，请稍候...',
      backup_scanning: '正在扫描文件...',
      backup_background: '后台运行',
      backup_packing: '正在打包...',
      backup_failed: '备份失败',
      add_menu_item_title: 'Add Menu Item',
      add_menu_item_placeholder: 'Enter item name',
      rename_tab: '重命名 Tab',
      new_name: '新名称',
      delete_tab: '删除 Tab',
      confirm_delete_tab: '确定要删除 tab',
      indexing: '索引中...',
      regex_placeholder: '输入正则表达式...',
      move_item_title: 'Move Item',
      move_to_label: 'Move',
      error_dialog_title: 'Error',
    },
    en: {
      collapse_all: 'Collapse All',
      expand_all: 'Expand All',
      add_root_menu: 'Add Root Menu',
      add_child_menu: 'Add Child Menu',
      add_menu_item: 'Add Menu Item',
      move_up: 'Move Up',
      move_down: 'Move Down',
      move_to: 'Move To...',
      edit: 'Edit',
      custom_style: 'Custom Style',
      export: 'Export',
      delete: 'Delete',
      close: 'Close',
      global_search: 'Global Search',
      regex: 'Regex',
      search_placeholder: 'Enter search keywords...',
      search: 'Search',
      new_kb: 'New KB',
      backup_kb: 'Backup KB',
      all_kb: 'All KBs',
      search_results: 'Search Results',
      kb: 'KB',
      path: 'Path',
      content_summary: 'Summary',
      icon_emoji: 'Icon (Emoji):',
      icon_placeholder: 'e.g. 📁 🔖',
      font: 'Font:',
      font_size: 'Font Size:',
      default: 'Default',
      text_color: 'Text Color:',
      bg_color: 'Background Color:',
      reset: 'Reset',
      font_style: 'Font Style:',
      bold: 'Bold',
      underline: 'Underline',
      strikethrough: 'Strikethrough',
      ok: 'OK',
      cancel: 'Cancel',
      reset_style: 'Reset Style',
      settings: 'Settings',
      help: 'Help',
      page_title: 'KBase v{version}',
      version: 'Version:',
      language: 'Language:',
      loading: 'Loading...',
      failed_load_menu: 'Failed to load menu',
      select_item_hint: 'Select a menu item to edit its content...',
      no_item_selected: 'No item selected',
      search_in_progress: 'Searching...',
      search_no_results: 'No matching results found',
      search_found: 'Found ',
      search_results_count: ' results',
      search_error: 'Search error:',
      backup_title: 'Backup Knowledge Base',
      backup_waiting: 'Backing up knowledge base, please wait...',
      backup_scanning: 'Scanning files...',
      backup_background: 'Background',
      backup_packing: 'Packaging...',
      backup_failed: 'Backup Failed',
      add_menu_item_title: 'Add Menu Item',
      add_menu_item_placeholder: 'Enter item name',
      rename_tab: 'Rename Tab',
      new_name: 'New name',
      delete_tab: 'Delete Tab',
      confirm_delete_tab: 'Are you sure you want to delete tab',
      indexing: 'Indexing...',
      regex_placeholder: 'Enter regex pattern...',
      move_item_title: 'Move Item',
      move_to_label: 'Move',
      error_dialog_title: 'Error',
    }
  };

  let currentLang = 'zh-CN';

  function t(key) {
    return (i18n[currentLang] && i18n[currentLang][key]) || (i18n['zh-CN'][key] || key);
  }

  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
    });
    $('#tab-help').title = t('help') || 'Help';
    $('#tab-settings').title = t('settings') || 'Settings';

    const titleEl = document.querySelector('title');
    if (titleEl) {
      const ver = titleEl.dataset.version || '';
      const titleKey = titleEl.dataset.i18nTitleTemplate || 'page_title';
      titleEl.textContent = t(titleKey).replace('{version}', ver);
    }
  }


  async function api(method, url, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (mySocketId) {
      opts.headers['X-Socket-ID'] = mySocketId;
    }
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || 'API Error');
      err.status = res.status;
      throw err;
    }
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

  // ─── Socket.IO Real-time Sync ──────────────────────────────────────────

  // ── Rooms ────────────────────────────────────────────────────────────────
  //   doc:{tab}:{item_id}  — real-time content sync (same item)
  //   tab:{tab}            — menu_changed / content_saved notifications

  function joinDocumentRoom(tab, itemId) {
    if (tab && itemId) {
      socket.emit('join_document', { tab, item_id: itemId });
    }
  }

  function leaveDocumentRoom(tab, itemId) {
    if (tab && itemId) {
      socket.emit('leave_document', { tab, item_id: itemId });
    }
  }

  function joinTabRoom(tab) {
    if (tab) {
      socket.emit('join_tab', { tab });
    }
  }

  function leaveTabRoom(tab) {
    if (tab) {
      socket.emit('leave_tab', { tab });
    }
  }

  // ── Edit Lock ────────────────────────────────────────────────────────────

  function tryLockDocument(tab, itemId) {
    if (tab && itemId) {
      socket.emit('lock_document', { tab, item_id: itemId });
    }
  }

  function unlockDocument(tab, itemId) {
    if (tab && itemId) {
      socket.emit('unlock_document', { tab, item_id: itemId });
    }
  }

  // ── Content Sync (debounced 1s) ──────────────────────────────────────────

  function debouncedSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      if (currentTab && currentItemId) {
        socket.emit('content_change', {
          tab: currentTab,
          item_id: currentItemId,
          content: editor.innerHTML
        });
      }
    }, 1000);
  }

  // ── Socket Event Listeners ───────────────────────────────────────────────

  // Real-time content sync (both users viewing the same document)
  socket.on('content_update', (data) => {
    if (data.tab === currentTab && data.item_id === currentItemId) {
      isRemoteUpdate = true;
      editor.innerHTML = data.content;
      constrainEditorImages();
      contentModified = false;
      const txt = editorStatus.textContent;
      if (txt.includes('(unsaved)')) {
        editorStatus.textContent = txt.replace(' (unsaved)', '');
      }
      isRemoteUpdate = false;
    }
  });

  // Menu changed (add/delete/rename/move) — reload menu tree
  socket.on('menu_changed', (data) => {
    if (data.tab === currentTab) {
      reloadMenu();
    }
  });

  // Content saved — if viewing the saved item, refresh it silently
  socket.on('content_saved', (data) => {
    if (data.tab === currentTab && data.item_id === currentItemId) {
      isRemoteUpdate = true;
      editor.innerHTML = data.content;
      constrainEditorImages();
      contentModified = false;
      const txt = editorStatus.textContent;
      if (txt.includes('(unsaved)')) {
        editorStatus.textContent = txt.replace(' (unsaved)', '');
      }
      isRemoteUpdate = false;
    }
  });

  // Lock management
  socket.on('lock_acquired', (data) => {
    // Lock confirmed — no UI feedback needed
  });

  socket.on('lock_denied', (data) => {
    showDialog('无法锁定', `<p>${escapeHtml(data.reason || '该条目正在被其他用户编辑')}</p>`);
  });

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
    kbTabNames = tabs.slice();
    // Load visibility state
    let selectedTabFromServer = null;
    try {
      const visData = await api('GET', '/api/tab-visibility');
      kbVisibility = {};
      for (const [key, val] of Object.entries(visData)) {
        if (key === '_selected_tab') {
          selectedTabFromServer = val;
        } else {
          kbVisibility[key] = val;
        }
      }
    } catch (e) {
      kbVisibility = {};
    }
    // Load saved current items (reading position) from server.
    // Only populate tabs not yet tracked in this session, so in-memory
    // selections (from selectItem) take priority over stale server data.
    try {
      const savedItems = await api('GET', '/api/tab-current-items');
      for (const [tab, itemId] of Object.entries(savedItems)) {
        if (lastEditedItem[tab] === undefined) {
          lastEditedItem[tab] = itemId;
        }
      }
    } catch (e) {
      // non-critical
    }
    // Ensure all tabs have a visibility entry
    kbTabNames.forEach((name) => {
      if (kbVisibility[name] === undefined) kbVisibility[name] = true;
    });
    // Filter to only show visible tabs
    const visibleTabs = tabs.filter((name) => kbVisibility[name] !== false);
    tabsEl.innerHTML = '';
    if (visibleTabs.length === 0) {
      tabsEl.innerHTML = '<div class="tab" style="color:#888">No document centers found</div>';
      treeContainer.innerHTML = '';
      editor.innerHTML = '<p>Select a menu item to edit its content...</p>';
      editorStatus.textContent = 'No item selected';
      currentTab = null;
      currentItemId = null;
      updateKbCheckbox();
      rebuildKbDropdown();
      return;
    }
    visibleTabs.forEach((name) => {
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
    // Restore the previously selected tab (saved in tab_kb_visibility.is_active)
    const restoreTab = selectedTabFromServer && visibleTabs.includes(selectedTabFromServer)
      ? selectedTabFromServer
      : null;
    if (restoreTab) {
      const el = tabsEl.querySelector(`.tab[data-tab="${CSS.escape(restoreTab)}"]`);
      if (el) switchTab(restoreTab, el);
    } else if (!currentTab || !visibleTabs.includes(currentTab)) {
      const first = tabsEl.querySelector('.tab');
      if (first) switchTab(visibleTabs[0], first);
    }
    updateTabScrollButtons();
    updateKbCheckbox();
    rebuildKbDropdown();
  }

  async function switchTab(name, el) {
    if (currentTab && currentTab !== name) {
      // Leave old tab room and document room
      leaveTabRoom(currentTab);
      if (currentItemId) {
        unlockDocument(currentTab, currentItemId);
        leaveDocumentRoom(currentTab, currentItemId);
      }
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

    // Join the tab-level room for menu/save notifications
    joinTabRoom(name);

    treeContainer.innerHTML = `<div style="padding:12px;color:#999;font-size:13px">${t('loading')}</div>`;

    try {
      await loadMenu();
    } catch (e) {
      console.error('Failed to load menu for tab:', name, e);
      treeContainer.innerHTML = `<div style="padding:12px;color:#999;font-size:13px">${t('failed_load_menu')}</div>`;
    }

    // Restore last selected item for this tab
    const lastId = lastEditedItem[currentTab];
    if (lastId && findNodeById(menuTree, lastId)) {
      scrollToTreeNode(lastId);
      selectItem(lastId);
    } else {
      editor.innerHTML = `<p>${t('select_item_hint')}</p>`;
      editorStatus.textContent = t('no_item_selected');
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
    const style = item.style || {};
    label.textContent = (style.icon || '') + item.label;

    header.appendChild(toggle);
    header.appendChild(label);
    if (style.fontFamily) label.style.fontFamily = style.fontFamily;
    if (style.fontSize) label.style.fontSize = style.fontSize;
    if (style.color) label.style.color = style.color;
    if (style.bgColor) header.style.backgroundColor = style.bgColor;
    if (style.bold) label.style.fontWeight = 'bold';
    if (style.underline && style.strikethrough) {
      label.style.textDecoration = 'underline line-through';
    } else if (style.underline) {
      label.style.textDecoration = 'underline';
    } else if (style.strikethrough) {
      label.style.textDecoration = 'line-through';
    }
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

    // Leave previous document room and unlock
    if (currentTab && currentItemId && currentItemId !== id) {
      unlockDocument(currentTab, currentItemId);
      leaveDocumentRoom(currentTab, currentItemId);
    }
    currentItemId = id;
    if (currentTab && id) {
      tryLockDocument(currentTab, id);
      joinDocumentRoom(currentTab, id);
    }

    lastEditedItem[currentTab] = id;
    contentModified = false;

    // Persist reading position to server (fire-and-forget)
    if (currentTab) {
      api('PUT', '/api/tab-current-item', { tab_name: currentTab, current_item_id: id }).catch(() => {});
    }

    $$('.tree-node-header').forEach((h) => h.classList.remove('active'));
    const header = treeContainer.querySelector(`.tree-node[data-id="${id}"] .tree-node-header`);
    if (header) header.classList.add('active');

    loadContent(id);
  }

  async function loadContent(itemId) {
    if (!currentTab) return;
    try {
      const data = await api('GET', `/api/${encodeURIComponent(currentTab)}/content/${itemId}`);
      isRemoteUpdate = true;
      const html = data.content.trim();
      if (html) {
        editor.innerHTML = html;
        constrainEditorImages();
      } else {
        editor.innerHTML = '<p></p>';
      }
      isRemoteUpdate = false;
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
      // Also broadcast via WebSocket so other clients see the save immediately
      socket.emit('content_change', {
        tab: currentTab,
        item_id: itemId,
        content: html
      });
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
      if (e.status === 409) {
        showDialog('删除被锁定', `<p>${escapeHtml(e.message)}</p>`);
      } else {
        showDialog('Error', `<p>${escapeHtml(e.message)}</p>`);
      }
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

  // ─── KB Selector (全部知识库) ────────────────────────────────────────────

  function updateKbCheckbox() {
    const cb = $('#kb-all-checkbox');
    if (!cb) return;
    const visibleCount = kbTabNames.filter((name) => kbVisibility[name] !== false).length;
    const totalCount = kbTabNames.length;
    if (totalCount === 0) {
      cb.checked = false;
      cb.indeterminate = false;
      return;
    }
    if (visibleCount === 0) {
      cb.checked = false;
      cb.indeterminate = false;
    } else if (visibleCount === totalCount) {
      cb.checked = true;
      cb.indeterminate = false;
    } else {
      cb.checked = false;
      cb.indeterminate = true;
    }
  }

  function rebuildKbDropdown() {
    const dd = $('#kb-dropdown');
    if (!dd) return;
    dd.innerHTML = '';
    kbTabNames.forEach((name) => {
      const item = document.createElement('div');
      item.className = 'kb-dropdown-item';
      const subCb = document.createElement('input');
      subCb.type = 'checkbox';
      subCb.checked = kbVisibility[name] !== false;
      const label = document.createElement('span');
      label.className = 'kb-item-label';
      label.textContent = name;
      item.appendChild(subCb);
      item.appendChild(label);
      item.addEventListener('click', (e) => {
        if (e.target === subCb) return; // let the native checkbox click handle it
        subCb.checked = !subCb.checked;
        onKbItemToggle(name, subCb.checked);
      });
      subCb.addEventListener('change', () => {
        onKbItemToggle(name, subCb.checked);
      });
      dd.appendChild(item);
    });
  }

  async function onKbItemToggle(tabName, visible) {
    kbVisibility[tabName] = visible;
    // Sync to server
    try {
      await api('PUT', '/api/tab-visibility', kbVisibility);
    } catch (e) {
      console.error('Failed to save visibility:', e);
    }
    // Reload tabs to reflect changes
    await loadTabs();
    // If current tab was hidden, switch to first visible tab
    if (currentTab && kbVisibility[currentTab] === false) {
      const firstVisible = tabsEl.querySelector('.tab');
      if (firstVisible && firstVisible.dataset.tab) {
        switchTab(firstVisible.dataset.tab, firstVisible);
      }
    }
  }

  async function onKbAllToggle() {
    // Use actual visibility state, not checkbox state (browser already toggled it)
    const allVisible = kbTabNames.length > 0 && kbTabNames.every((name) => kbVisibility[name] !== false);
    const newState = !allVisible;
    kbTabNames.forEach((name) => {
      kbVisibility[name] = newState;
    });
    try {
      await api('PUT', '/api/tab-visibility', kbVisibility);
    } catch (e) {
      console.error('Failed to save visibility:', e);
    }
    await loadTabs();
  }

  function toggleKbDropdown(e) {
    e.stopPropagation();
    const dd = $('#kb-dropdown');
    if (!dd) return;
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  }

  // ─── End KB Selector ───────────────────────────────────────────────────

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
      t('rename_tab'),
      `<label>${t('new_name')}:</label><input type="text" id="dialog-input" value="${escapeHtml(oldName)}">`,
      () => {
        const val = $('#dialog-input').value.trim();
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
    // Save selection before dialog steals focus
    const savedRange = (() => {
      const sel = window.getSelection();
      if (sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
        return sel.getRangeAt(0).cloneRange();
      }
      return null;
    })();

    showDialog(
      'Insert Link',
      '<label>URL:</label><input type="text" id="dialog-link-url" placeholder="https://..."><label>Text:</label><input type="text" id="dialog-link-text" placeholder="Link text">',
      () => {
        const url = $('#dialog-link-url').value.trim();
        const text = $('#dialog-link-text').value.trim();
        if (!url) return true;
        editor.focus();

        // Restore saved selection
        if (savedRange) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(savedRange);
        }

        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          if (sel.toString().length > 0 && !text) {
            document.execCommand('createLink', false, url);
            const newSel = window.getSelection();
            if (newSel.rangeCount > 0) {
              let node = newSel.getRangeAt(0).startContainer;
              while (node && node.nodeName !== 'A') node = node.parentNode;
              if (node && node.nodeName === 'A') node.setAttribute('target', '_blank');
            }
          } else {
            range.deleteContents();
            const a = document.createElement('a');
            a.href = url;
            a.target = '_blank';
            a.textContent = text || url;
            range.insertNode(a);
            range.setStartAfter(a);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        }
        markModified();
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
    window.open('/help', '_blank');
  });

  // ─── Settings ──────────────────────────────────────────────────────────

  async function loadLanguage() {
    try {
      const res = await api('GET', '/api/system-config/language');
      if (res.value) {
        currentLang = res.value;
      }
    } catch (e) {
      // fallback to localStorage
      const saved = localStorage.getItem('kbase_lang');
      if (saved) currentLang = saved;
    }
  }

  async function saveLanguage(lang) {
    try {
      await api('PUT', `/api/system-config/language`, { value: lang });
      localStorage.setItem('kbase_lang', lang);
    } catch (e) {
      // non-critical
    }
  }

  function openSettings() {
    $('#settings-language').value = currentLang;
    $('#settings-dialog').style.display = 'flex';
  }

  function closeSettings() {
    $('#settings-dialog').style.display = 'none';
  }

  $('#tab-settings').addEventListener('click', openSettings);

  $('#settings-btn-cancel').addEventListener('click', closeSettings);

  $('#settings-btn-ok').addEventListener('click', async () => {
    const newLang = $('#settings-language').value;
    if (newLang !== currentLang) {
      currentLang = newLang;
      await saveLanguage(newLang);
      applyTranslations();
    }
    closeSettings();
  });

  // Close settings dialog on overlay click
  $('#settings-dialog').addEventListener('click', (e) => {
    if (e.target === $('#settings-dialog')) {
      closeSettings();
    }
  });

  // ─── Backup Knowledge Base ────────────────────────────────────────────

  $('#btn-backup').addEventListener('click', async () => {
    const overlay = $('#dialog-overlay');
    $('#dialog-title').textContent = t('backup_title');
    $('#dialog-content').innerHTML = `
      <div id="backup-progress" style="text-align:center;padding:20px">
        <div style="margin-bottom:12px;font-size:14px;color:#555">${t('backup_waiting')}</div>
        <div style="background:#eee;border-radius:4px;height:20px;overflow:hidden">
          <div id="backup-progress-bar" style="background:#3498db;height:100%;width:0%;transition:width 0.3s"></div>
        </div>
        <div id="backup-progress-text" style="margin-top:8px;font-size:12px;color:#888">${t('backup_scanning')}</div>
      </div>
    `;
    $('#dialog-ok').style.display = 'none';
    $('#dialog-cancel').textContent = t('backup_background');
    overlay.style.display = 'flex';

    try {
      const { task_id, total } = await api('POST', '/api/backup');

      const pollInterval = setInterval(async () => {
        try {
          const status = await api('GET', `/api/backup/status/${task_id}`);
          const pct = total > 0 ? Math.min(100, Math.round(status.current / total * 100)) : 0;
          const bar = $('#backup-progress-bar');
          const txt = $('#backup-progress-text');
          if (bar) bar.style.width = pct + '%';
          if (txt) txt.textContent = `${t('backup_packing')} (${status.current}/${total})`;

          if (status.done) {
            clearInterval(pollInterval);
            overlay.style.display = 'none';
            $('#dialog-ok').style.display = '';
            $('#dialog-cancel').textContent = 'Cancel';

            if (status.error) {
              showDialog(t('backup_failed'), `<p>${escapeHtml(status.error)}</p>`);
              return;
            }

            const a = document.createElement('a');
            a.href = `/api/backup/download/${task_id}`;
            a.download = status.filename || 'mybase-backup.zip';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }
        } catch (e) {
          clearInterval(pollInterval);
          overlay.style.display = 'none';
          $('#dialog-ok').style.display = '';
          $('#dialog-cancel').textContent = 'Cancel';
          showDialog(t('backup_failed'), `<p>${escapeHtml(e.message)}</p>`);
        }
      }, 300);
    } catch (e) {
      overlay.style.display = 'none';
      $('#dialog-ok').style.display = '';
      $('#dialog-cancel').textContent = 'Cancel';
      showDialog(t('backup_failed'), `<p>${escapeHtml(e.message)}</p>`);
    }
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

  function positionMenuAtEvent(menuEl, e) {
    menuEl.style.display = 'block';
    const menuW = menuEl.offsetWidth;
    const menuH = menuEl.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = e.clientX;
    let top = e.clientY;
    if (left + menuW > vw) left = vw - menuW - 8;
    if (top + menuH > vh) top = vh - menuH - 8;
    if (left < 0) left = 8;
    if (top < 0) top = 8;
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';

    // Flip submenus to the left if menu is near the right edge
    const nearRight = (left + menuW + 100) > vw;
    menuEl.querySelectorAll('.tree-ctx-export, .tab-ctx-export').forEach((el) => {
      const submenu = el.querySelector('.ctx-submenu');
      if (submenu) {
        submenu.style.left = nearRight ? 'auto' : '';
        submenu.style.right = nearRight ? '100%' : '';
      }
    });
  }

  // ─── Tree Right-Click Context Menu ─────────────────────────────────────

  function showTreeContextMenu(e, itemId) {
    treeCtxItemId = itemId;
    positionMenuAtEvent(treeCtxMenu, e);
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
        case 'custom-style': {
          showCustomStyleDialog(id);
          break;
        }
      }
    });
  });

  // ─── Custom Style Dialog ────────────────────────────────────────────

  const styleDialog = $('#style-dialog');
  const styleIcon = $('#style-icon');
  const styleFontFamily = $('#style-font-family');
  const styleFontSize = $('#style-font-size');
  const styleColor = $('#style-color');
  const styleBgColor = $('#style-bg-color');
  const styleBold = $('#style-bold');
  const styleUnderline = $('#style-underline');
  const styleStrikethrough = $('#style-strikethrough');
  let styleItemId = null;

  function showCustomStyleDialog(itemId) {
    styleItemId = itemId;
    const item = findNodeById(menuTree, itemId);
    if (!item) return;

    const s = item.style || {};
    styleIcon.value = s.icon || '';
    styleFontFamily.value = s.fontFamily || '';
    styleFontSize.value = s.fontSize || '';
    styleColor.value = s.color || '#000000';
    styleBgColor.value = s.bgColor || '#ffffff';
    styleBold.checked = !!s.bold;
    styleUnderline.checked = !!s.underline;
    styleStrikethrough.checked = !!s.strikethrough;

    styleDialog.style.display = 'flex';
  }

  function collectStyleData() {
    return {
      icon: styleIcon.value.trim(),
      fontFamily: styleFontFamily.value,
      fontSize: styleFontSize.value,
      color: styleColor.value === '#000000' ? '' : styleColor.value,
      bgColor: styleBgColor.value === '#ffffff' ? '' : styleBgColor.value,
      bold: styleBold.checked,
      underline: styleUnderline.checked,
      strikethrough: styleStrikethrough.checked,
    };
  }

  function getEffectiveStyle(s) {
    const out = {};
    if (s.icon) out.icon = s.icon;
    if (s.fontFamily) out.fontFamily = s.fontFamily;
    if (s.fontSize) out.fontSize = s.fontSize;
    if (s.color) out.color = s.color;
    if (s.bgColor) out.bgColor = s.bgColor;
    if (s.bold) out.bold = true;
    if (s.underline) out.underline = true;
    if (s.strikethrough) out.strikethrough = true;
    return out;
  }

  async function saveCustomStyle(itemId, styleData) {
    if (!currentTab) return;
    try {
      await api('PUT', `/api/${encodeURIComponent(currentTab)}/menu/${itemId}`, { style: styleData });
      const item = findNodeById(menuTree, itemId);
      if (item) {
        if (Object.keys(styleData).length === 0) {
          delete item.style;
        } else {
          item.style = styleData;
        }
      }
      await reloadMenu();
    } catch (e) {
      showDialog('Error', `<p>${escapeHtml(e.message)}</p>`);
    }
  }

  function resetStyleFields() {
    styleIcon.value = '';
    styleFontFamily.value = '';
    styleFontSize.value = '';
    styleColor.value = '#000000';
    styleBgColor.value = '#ffffff';
    styleBold.checked = false;
    styleUnderline.checked = false;
    styleStrikethrough.checked = false;
  }

  $('#style-btn-ok').addEventListener('click', () => {
    if (!styleItemId) return;
    const data = collectStyleData();
    const effective = getEffectiveStyle(data);
    styleDialog.style.display = 'none';
    saveCustomStyle(styleItemId, effective);
  });

  $('#style-btn-cancel').addEventListener('click', () => {
    styleDialog.style.display = 'none';
  });

  $('#style-btn-reset').addEventListener('click', () => {
    if (!styleItemId) return;
    styleDialog.style.display = 'none';
    saveCustomStyle(styleItemId, {});
  });

  styleDialog.querySelectorAll('.style-reset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      if (target === 'color') {
        styleColor.value = '#000000';
      } else if (target === 'bg-color') {
        styleBgColor.value = '#ffffff';
      }
    });
  });

  styleDialog.addEventListener('click', (e) => {
    if (e.target === styleDialog) {
      styleDialog.style.display = 'none';
    }
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

  async function saveFontConfig() {
    try {
      await api('PUT', '/api/font-config', {
        font_family: $('#font-family').value,
        font_size: $('#font-size').value,
      });
    } catch (e) {
      // non-critical
    }
  }

  const FONT_SIZE_MAP = { '1': '12px', '2': '14px', '3': '16px', '4': '20px', '5': '24px', '6': '32px', '7': '48px' };

  async function loadFontConfig() {
    try {
      const cfg = await api('GET', '/api/font-config');
      if (cfg.font_family) {
        $('#font-family').value = cfg.font_family;
        document.execCommand('fontName', false, cfg.font_family);
      }
      if (cfg.font_size) {
        $('#font-size').value = cfg.font_size;
        editor.style.fontSize = FONT_SIZE_MAP[cfg.font_size] || '16px';
      }
    } catch (e) {
      // non-critical, use defaults
    }
  }

  $('#font-family').addEventListener('change', function() {
    editor.focus();
    document.execCommand('fontName', false, this.value);
    markModified();
    saveFontConfig();
  });

  $('#font-size').addEventListener('change', function() {
    editor.focus();
    document.execCommand('fontSize', false, this.value);
    markModified();
    saveFontConfig();
  });

  $('#text-color').addEventListener('input', function() {
    const swatch = $('#color-swatch');
    if (swatch) swatch.style.background = this.value;
    this.classList.remove('color-input-hidden--active');
    this.style.left = '';
    this.style.top = '';
  });

  $('#btn-apply-color').addEventListener('click', () => {
    editor.focus();
    const color = $('#text-color').value;
    document.execCommand('foreColor', false, color);
    markModified();
  });

  $('#btn-color-arrow').addEventListener('click', (e) => {
    e.stopPropagation();
    const input = $('#text-color');
    const rect = e.currentTarget.getBoundingClientRect();
    input.classList.add('color-input-hidden--active');
    input.style.left = rect.left + 'px';
    input.style.top = (rect.top + rect.height) + 'px';
    input.click();
  });

  $('#btn-insert-link').addEventListener('click', () => {
    const sel = window.getSelection().toString();
    if (sel) {
      $('#dialog-link-text').value = sel;
    }
    promptInsertLink();
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

  editor.addEventListener('input', () => {
    markModified();
    if (!isRemoteUpdate) {
      debouncedSync();
    }
  });
  editor.addEventListener('paste', handlePaste);
  editor.addEventListener('click', (e) => {
    let node = e.target;
    while (node && node !== editor) {
      if (node.nodeName === 'A' && node.href) {
        e.preventDefault();
        e.stopPropagation();
        window.open(node.href, '_blank');
        return;
      }
      node = node.parentNode;
    }
  });

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
      constrainEditorImages();
      markModified();
    } catch (e) {
      console.error('Image paste upload failed:', e);
    }
  }

  // ─── Editor Context Menu ───────────────────────────────────────────────

  editor.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const selection = window.getSelection();
    positionMenuAtEvent(ctxMenu, e);
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

  // ─── Image Sizing (80% of original) ────────────────────────────────────

  function constrainEditorImages() {
    editor.querySelectorAll('img').forEach((img) => {
      if (img.complete && img.naturalWidth) {
        setImage50(img);
      } else {
        img.addEventListener('load', function onLoad() {
          setImage50(img);
          img.removeEventListener('load', onLoad);
        });
      }
    });
  }

  function setImage50(img) {
    if (img.naturalWidth) {
      const w = Math.round(img.naturalWidth * 0.5);
      img.style.width = w + 'px';
      img.style.height = 'auto';
    }
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
    positionMenuAtEvent(tabCtxMenu, e);
  }

  function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function handleTabExport(action) {
    const name = tabCtxName;
    tabCtxMenu.style.display = 'none';
    if (!name) return;

    const encodedName = encodeURIComponent(name);
    if (action === 'export-tab-pdf') {
      triggerDownload(`/api/${encodedName}/export/pdf`);
    } else if (action === 'export-tab-zip') {
      triggerDownload(`/api/${encodedName}/export/zip`);
    }
  }

  function handleTreeExport(action) {
    const id = treeCtxItemId;
    treeCtxMenu.style.display = 'none';
    if (!id || !currentTab) return;

    const encodedTab = encodeURIComponent(currentTab);
    if (action === 'export-tree-pdf') {
      triggerDownload(`/api/${encodedTab}/export/pdf/${id}`);
    } else if (action === 'export-tree-zip') {
      triggerDownload(`/api/${encodedTab}/export/zip/${id}`);
    }
  }

  $$('#tab-context-menu .ctx-submenu-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      handleTabExport(item.dataset.action);
    });
  });

  $$('#tree-context-menu .ctx-submenu-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      handleTreeExport(item.dataset.action);
    });
  });

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
        case 'close-tab':
          // Hide this tab and sync to server
          kbVisibility[name] = false;
          api('PUT', '/api/tab-visibility', kbVisibility).then(() => {
            loadTabs();
          }).catch((e) => {
            console.error('Failed to save visibility:', e);
          });
          break;
        case 'delete-tab':
          showDialog(
            t('delete_tab'),
            `<p>${t('confirm_delete_tab')} "<strong>${escapeHtml(name)}</strong>"?</p>`,
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
    // Close KB dropdown when clicking outside
    const kbDropdown = $('#kb-dropdown');
    const kbLabel = $('#kb-all-label');
    if (kbDropdown && kbDropdown.style.display !== 'none') {
      if (!kbDropdown.contains(e.target) && !kbLabel.contains(e.target)) {
        kbDropdown.style.display = 'none';
      }
    }
  });

  // ─── Background Indexing ───────────────────────────────────────────────

  async function checkIndexingStatus() {
    try {
      const state = await api('GET', '/api/indexing-status');
      const statusEl = $('#indexing-status');
      if (state.busy) {
        statusEl.style.display = 'inline';
        statusEl.textContent = state.status || '📇 ' + t('indexing');
      } else {
        statusEl.style.display = 'none';
      }
    } catch (e) {
      // ignore polling errors
    }
  }

  // Periodic status polling (every 2 s, inexpensive)
  setInterval(checkIndexingStatus, 2000);

  // ─── Search ────────────────────────────────────────────────────────────

  const searchInput = $('#search-input');
  const searchBtn = $('#btn-search');
  const searchGlobal = $('#search-global');
  const searchRegex = $('#search-regex');
  const searchPanel = $('#search-results-panel');
  const searchSplitter = $('#search-splitter');
  const searchResultsBody = $('#search-results-body');
  const searchResultsClose = $('#search-results-close');
  let searchDragging = false;

  async function performSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    const globalMode = searchGlobal.checked;
    const tabParam = globalMode ? '' : (currentTab || '');

    searchResultsBody.innerHTML = `<div class="search-loading">${t('search_in_progress')}</div>`;
    searchPanel.style.display = 'flex';
    searchSplitter.style.display = 'block';
    $('#search-results-column-headers').style.display = 'none';
    $('#search-results-title').textContent = t('search_results');

    const regexMode = searchRegex.checked;

    try {
      let url = `/api/search?q=${encodeURIComponent(query)}`;
      if (tabParam) {
        url += `&tab=${encodeURIComponent(tabParam)}`;
      }
      if (regexMode) {
        url += '&regex=true';
      }
      const results = await api('GET', url);

      $('#search-results-title').textContent = `${t('search_results')} (${results.length})`;
      if (results.length === 0) {
        searchResultsBody.innerHTML = `<div class="search-empty">${t('search_no_results')}</div>`;
        return;
      }

      let html = `<div class="search-stats">${t('search_found')} ${results.length} ${t('search_results_count')}</div>`;
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
      searchResultsBody.innerHTML = `<div class="search-empty">${t('search_error')} ${escapeHtml(e.message)}</div>`;
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
  searchRegex.addEventListener('change', () => {
    searchInput.placeholder = searchRegex.checked
      ? t('regex_placeholder')
      : t('search_placeholder');
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
    const hasOverflow = tabsEl.scrollWidth > tabsEl.clientWidth + 2;
    const atStart = tabsEl.scrollLeft <= 4;
    const atEnd = tabsEl.scrollLeft >= tabsEl.scrollWidth - tabsEl.clientWidth - 4;

    scrollLeftBtn.classList.toggle('visible', hasOverflow && !atStart);
    scrollRightBtn.classList.toggle('visible', hasOverflow && !atEnd);
  }

  tabsEl.addEventListener('scroll', updateTabScrollButtons);
  window.addEventListener('resize', updateTabScrollButtons);

  function scrollTabs(direction, smooth) {
    tabsEl.scrollBy({
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
  tabsEl.addEventListener('wheel', (e) => {
    const absX = Math.abs(e.deltaX);
    const absY = Math.abs(e.deltaY);
    if (absY > absX && absY > 0) {
      tabsEl.scrollBy({ left: e.deltaY, behavior: 'auto' });
      e.preventDefault();
    }
  }, { passive: false });

  // ─── KB Selector Event Handlers ──────────────────────────────────────

  $('#kb-all-checkbox').addEventListener('change', onKbAllToggle);
  $('#kb-dropdown-arrow').addEventListener('click', toggleKbDropdown);

  // ─── Init ──────────────────────────────────────────────────────────────

  (async function init() {
    await loadLanguage();
    applyTranslations();
    loadTabs();
    loadFontConfig();
  })();

})();
