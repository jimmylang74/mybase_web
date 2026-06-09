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
  let unlockedTabs = new Set(); // tab names unlocked in this session
  let currentSearchQuery = ''; // current search query for highlighting
  let encryptedTabsCache = null; // null = not loaded, array = list of encrypted tab names

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
      set_password: '加密',
      change_password: '修改密码',
      remove_password: '解密',
      password_label: '密码:',
      confirm_password_label: '确认密码:',
      old_password_label: '原密码:',
      password_mismatch: '两次密码输入不一致',
      password_too_short: '密码至少需要4个字符',
      wrong_password: '密码错误',
      unlock_kb: '解锁知识库',
      unlock_prompt: '请输入密码解锁该知识库',
      remove_password_confirm: '确定要解密该知识库吗？',
      encrypted: '已加密',
      insert_column: '插入列',
      insert_row: '插入行',
      delete_column: '删除列',
      delete_row: '删除行',
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
      set_password: 'Set Password',
      change_password: 'Change Password',
      remove_password: 'Remove Password',
      password_label: 'Password:',
      confirm_password_label: 'Confirm Password:',
      old_password_label: 'Current Password:',
      password_mismatch: 'Passwords do not match',
      password_too_short: 'Password must be at least 4 characters',
      wrong_password: 'Incorrect password',
      unlock_kb: 'Unlock Knowledge Base',
      unlock_prompt: 'Enter password to unlock this knowledge base',
      remove_password_confirm: 'Are you sure you want to remove password protection?',
      encrypted: 'Encrypted',
      insert_column: 'Insert Column',
      insert_row: 'Insert Row',
      delete_column: 'Delete Column',
      delete_row: 'Delete Row',
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
        clearSearchHighlights();
        const cleanHtml = convertFontSizesToInline(editor.innerHTML);
        applySearchHighlights();
        socket.emit('content_change', {
          tab: currentTab,
          item_id: currentItemId,
          content: cleanHtml
        });
      }
    }, 1000);
  }

  // ── Socket Event Listeners ───────────────────────────────────────────────

  // Real-time content sync (both users viewing the same document)
  socket.on('content_update', (data) => {
    if (data.tab === currentTab && data.item_id === currentItemId) {
      isRemoteUpdate = true;
      clearSearchHighlights();
      editor.innerHTML = data.content;
      constrainEditorImages();
      applySearchHighlights();
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
      clearSearchHighlights();
      editor.innerHTML = data.content;
      constrainEditorImages();
      applySearchHighlights();
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

  socket.on('sync_denied', (data) => {
    // Encrypted tab sync blocked — silently handled, no user-facing dialog needed
    console.warn('Sync denied for tab:', data.tab, data.reason);
  });

  // ── Encrypted Tab Lifecycle Events (from other windows) ────────────────

  // Another window deleted this encrypted tab → close it locally
  socket.on('encrypted_tab_deleted', (data) => {
    if (data.sender_sid === mySocketId) return;  // skip self
    const tab = data.tab;
    unlockedTabs.delete(tab);
    if (encryptedTabsCache) {
      const idx = encryptedTabsCache.indexOf(tab);
      if (idx !== -1) encryptedTabsCache.splice(idx, 1);
    }
    if (currentTab === tab) {
      currentTab = null;
      currentItemId = null;
      editor.innerHTML = '<p>Select a menu item to edit its content...</p>';
      editorStatus.textContent = 'No item selected';
    }
    loadTabs();  // removes the deleted tab from the tab bar
  });

  // Another window changed/added this encrypted tab's password → re-prompt needed
  socket.on('encrypted_tab_password_changed', async (data) => {
    if (data.sender_sid === mySocketId) return;  // skip self
    const tab = data.tab;
    // Server has already purged this session's key — clear local unlock state
    unlockedTabs.delete(tab);
    // Refresh encrypted-tabs cache so isTabEncrypted() returns correct result
    await loadEncryptedTabs();
    if (currentTab === tab) {
      // Close the view so user gets re-prompted when they click the tab
      leaveTabRoom(tab);
      currentTab = null;
      currentItemId = null;
      editor.innerHTML = '<p>Select a menu item to edit its content...</p>';
      editorStatus.textContent = 'No item selected';
    }
    updateTabEncryptionIndicators();
  });

  // Another window removed this tab's password → no longer encrypted
  socket.on('encrypted_tab_decrypted', (data) => {
    if (data.sender_sid === mySocketId) return;  // skip self
    const tab = data.tab;
    // Server has purged this session's key — clear local unlock state
    unlockedTabs.delete(tab);
    if (encryptedTabsCache) {
      const idx = encryptedTabsCache.indexOf(tab);
      if (idx !== -1) encryptedTabsCache.splice(idx, 1);
    }
    updateTabEncryptionIndicators();  // removes 🔒 icon
    if (currentTab === tab) {
      // Tab is now plaintext — join the sync room and reload
      joinTabRoom(tab);
      loadMenu();
    }
  });

  // Another window created a new tab → refresh the tab bar
  socket.on('tab_added', (data) => {
    if (data.sender_sid === mySocketId) return;  // skip self
    loadTabs();
  });

  // Another window deleted a tab → refresh the tab bar
  socket.on('tab_deleted', (data) => {
    if (data.sender_sid === mySocketId) return;  // skip self
    const tab = data.tab;
    // The encrypted_tab_deleted handler already handles encrypted-tab-specific cleanup.
    // This generic handler ensures ALL windows remove the tab regardless of encryption state.
    if (currentTab === tab) {
      currentTab = null;
      currentItemId = null;
      editor.innerHTML = '<p>Select a menu item to edit its content...</p>';
      editorStatus.textContent = 'No item selected';
    }
    loadTabs();
  });

  // Another window renamed a tab → rebuild the tab bar with fresh click handlers
  socket.on('tab_renamed', async (data) => {
    if (data.sender_sid === mySocketId) return;  // skip self

    // Migrate per-tab caches from old name to new name
    if (lastEditedItem[data.old_name] !== undefined) {
      lastEditedItem[data.new_name] = lastEditedItem[data.old_name];
      delete lastEditedItem[data.old_name];
    }
    if (dirtyTabs[data.old_name] !== undefined) {
      dirtyTabs[data.new_name] = dirtyTabs[data.old_name];
      delete dirtyTabs[data.old_name];
    }
    if (treeExpandedState[data.old_name] !== undefined) {
      treeExpandedState[data.new_name] = treeExpandedState[data.old_name];
      delete treeExpandedState[data.old_name];
    }

    const wasCurrent = currentTab === data.old_name;
    if (wasCurrent) {
      currentTab = data.new_name;
    }
    const prevTab = currentTab;

    // Rebuild the tab bar with skipRestore so the server-selected tab
    // doesn't steal focus from the tab this window is on.
    await loadTabs(true);

    // Re-activate visual state for the tab we were on (loadTabs rebuilds
    // all tab elements from scratch, clearing active state).
    if (prevTab) {
      const el = tabsEl.querySelector(`.tab[data-tab="${CSS.escape(prevTab)}"]`);
      if (el) {
        el.classList.add('active');
        activeTabEl = el;
      }
    }

    // If the renamed tab was our current tab, reload its menu so content
    // reflects the new tab name.
    if (wasCurrent) {
      await loadMenu();
    }

    updateTabEncryptionIndicators();
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

  async function loadTabs(skipRestore = false) {
    await loadEncryptedTabs();
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
      const labelSpan = document.createElement('span');
      labelSpan.className = 'tab-label';
      labelSpan.textContent = name;
      el.appendChild(labelSpan);
      el.addEventListener('click', () => switchTab(name, el));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabContextMenu(e, name);
      });
      makeTabDraggable(el);
      tabsEl.appendChild(el);
    });
    // Restore the previously selected tab (saved in tab_kb_visibility.is_active).
    // skipRestore=true is used when a rename event is received from another window
    // so we don't steal focus from the tab the user is currently on.
    const restoreTab = selectedTabFromServer && visibleTabs.includes(selectedTabFromServer)
      ? selectedTabFromServer
      : null;
    if (!skipRestore && restoreTab) {
      const el = tabsEl.querySelector(`.tab[data-tab="${CSS.escape(restoreTab)}"]`);
      if (el) switchTab(restoreTab, el);
    } else if (!currentTab || !visibleTabs.includes(currentTab)) {
      const first = tabsEl.querySelector('.tab');
      if (first) switchTab(visibleTabs[0], first);
    }
    updateTabScrollButtons();
    updateKbCheckbox();
    rebuildKbDropdown();
    updateTabEncryptionIndicators();
  }

  async function switchTab(name, el) {
    const prevTab = currentTab;
    const prevTabEl = activeTabEl;

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

    // Check if tab is encrypted and needs unlock
    const encrypted = await isTabEncrypted(name);
    if (encrypted && !unlockedTabs.has(name)) {
      const unlocked = await requireUnlock(name);
      if (!unlocked) {
        el.classList.remove('active');
        currentTab = prevTab;
        if (prevTabEl) {
          prevTabEl.classList.add('active');
          activeTabEl = prevTabEl;
        } else {
          activeTabEl = null;
        }
        return;
      }
    }

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
    label.textContent = style.iconAfter
      ? item.label + (style.icon || '')
      : (style.icon || '') + item.label;

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
      clearSearchHighlights();
      const html = data.content.trim();
      if (html) {
      editor.innerHTML = html;
      constrainEditorImages();
    } else {
      editor.innerHTML = '<p></p>';
      editor.focus();
      document.execCommand('fontSize', false, $('#font-size').value);
    }
    if (tableFormulaManager) {
      tableFormulaManager.refresh();
    }
    applySearchHighlights();
    isRemoteUpdate = false;
    const item = findNodeById(menuTree, itemId);
      editorStatus.textContent = `Editing: ${item ? item.label : 'Unknown'}`;
    } catch (e) {
      editor.innerHTML = '<p>Error loading content</p>';
      editorStatus.textContent = 'Error loading content';
    }
  }

  function convertFontSizesToInline(html) {
    // Bake font sizes into HTML so they survive toolbar setting changes
    html = html.replace(/<font\b([^>]*)>/gi, (match, attrs) => {
      const sizeMatch = attrs.match(/\s+size\s*=\s*["'](\d+)["']/i);
      if (!sizeMatch) return match;
      const px = FONT_SIZE_MAP[sizeMatch[1]];
      if (!px) return match;
      const styles = [`font-size: ${px}`];
      const colorMatch = attrs.match(/\s+color\s*=\s*["']([^"']*)["']/i);
      if (colorMatch) styles.push(`color: ${colorMatch[1]}`);
      const faceMatch = attrs.match(/\s+face\s*=\s*["']([^"']*)["']/i);
      if (faceMatch) styles.push(`font-family: ${faceMatch[1]}`);
      return `<span style="${styles.join('; ')}">`;
    });
    html = html.replace(/<\/font\s*>/gi, '</span>');
    return html;
  }

  async function saveContent(itemId) {
    if (!currentTab || !itemId) return;
    clearSearchHighlights();
    const html = convertFontSizesToInline(editor.innerHTML);
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
    const labelSpan = el.querySelector('.tab-label');
    if (labelSpan) {
      labelSpan.textContent = dirtyTabs[name] ? '*' + base : base;
    } else {
      el.textContent = dirtyTabs[name] ? '*' + base : base;
    }
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

  // ─── Password / Encryption ────────────────────────────────────────────

  async function loadEncryptedTabs() {
    try {
      const res = await api('GET', '/api/encrypted-tabs');
      encryptedTabsCache = res.encrypted_tabs || [];
    } catch (e) {
      encryptedTabsCache = [];
    }
    return encryptedTabsCache;
  }

  async function isTabEncrypted(tabName) {
    if (encryptedTabsCache === null) {
      await loadEncryptedTabs();
    }
    return encryptedTabsCache.includes(tabName);
  }

  async function setTabPassword(tabName, password, oldPassword) {
    const body = { password };
    if (oldPassword) body.old_password = oldPassword;
    await api('POST', `/api/tabs/${encodeURIComponent(tabName)}/password`, body);
  }

  async function verifyTabPassword(tabName, password) {
    await api('POST', `/api/tabs/${encodeURIComponent(tabName)}/verify-password`, { password });
  }

  async function removeTabPassword(tabName, password) {
    await api('DELETE', `/api/tabs/${encodeURIComponent(tabName)}/password`, { password });
  }

  function showPasswordDialog(mode, tabName) {
    // mode: 'set' | 'change' | 'unlock' | 'remove'
    const dialog = $('#password-dialog');
    const header = $('#password-dialog-header');
    const confirmRow = $('#password-confirm-row');
    const oldRow = $('#password-old-row');
    const errorEl = $('#password-error');
    const pwInput = $('#password-input');
    const confirmInput = $('#password-confirm-input');
    const oldInput = $('#password-old-input');

    // Reset
    pwInput.value = '';
    confirmInput.value = '';
    oldInput.value = '';
    errorEl.style.display = 'none';
    confirmRow.style.display = 'none';
    oldRow.style.display = 'none';

    if (mode === 'set') {
      header.textContent = t('set_password');
      confirmRow.style.display = '';
    } else if (mode === 'change') {
      header.textContent = t('change_password');
      confirmRow.style.display = '';
      oldRow.style.display = '';
    } else if (mode === 'unlock') {
      header.textContent = t('unlock_kb') + ' - ' + tabName;
    } else if (mode === 'remove') {
      header.textContent = t('remove_password');
    }

    dialog.style.display = 'flex';

    return new Promise((resolve) => {
      function doAction() {
        const password = pwInput.value;
        if (mode === 'set' || mode === 'change') {
          if (password.length < 4) {
            errorEl.textContent = t('password_too_short');
            errorEl.style.display = '';
            pwInput.focus();
            return;
          }
          if (password !== confirmInput.value) {
            errorEl.textContent = t('password_mismatch');
            errorEl.style.display = '';
            confirmInput.focus();
            return;
          }
        } else if (mode === 'unlock') {
          if (!password) {
            errorEl.textContent = t('password_too_short');
            errorEl.style.display = '';
            pwInput.focus();
            return;
          }
        } else if (mode === 'remove') {
          if (!password) {
            errorEl.textContent = t('password_too_short');
            errorEl.style.display = '';
            pwInput.focus();
            return;
          }
        }

        const oldPassword = (mode === 'change') ? oldInput.value : '';
        dialog.style.display = 'none';
        resolve({ password, oldPassword });
      }

      function doCancel() {
        dialog.style.display = 'none';
        resolve(null);
      }

      $('#password-btn-ok').onclick = doAction;
      $('#password-btn-cancel').onclick = doCancel;

      pwInput.onkeydown = (e) => {
        if (e.key === 'Enter') doAction();
        if (e.key === 'Escape') doCancel();
      };
      confirmInput.onkeydown = (e) => {
        if (e.key === 'Enter') doAction();
      };
      oldInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          if (mode === 'change' && !oldInput.value) return;
          pwInput.focus();
        }
      };

      setTimeout(() => pwInput.focus(), 100);
    });
  }

  async function requireUnlock(tabName) {
    // Check cached first
    if (unlockedTabs.has(tabName)) return true;

    const encrypted = await isTabEncrypted(tabName);
    if (!encrypted) {
      unlockedTabs.add(tabName); // not encrypted, mark as "unlocked"
      return true;
    }

    while (true) {
      const result = await showPasswordDialog('unlock', tabName);
      if (!result) return false; // user cancelled

      try {
        await verifyTabPassword(tabName, result.password);
        unlockedTabs.add(tabName);
        return true;
      } catch (e) {
        // Show error and retry
        const errorEl = $('#password-error');
        errorEl.textContent = t('wrong_password');
        errorEl.style.display = '';
        // Re-show the dialog
        const dialog = $('#password-dialog');
        dialog.style.display = 'flex';
      }
    }
  }

  function clearTabUnlock(tabName) {
    unlockedTabs.delete(tabName);
  }

  async function onTabUnlock(tabName) {
    // Called when re-opening an encrypted tab
    return await requireUnlock(tabName);
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

  // ─── Insert Table ─────────────────────────────────────────────────────

  function promptInsertTable() {
    const savedRange = (() => {
      const sel = window.getSelection();
      if (sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
        return sel.getRangeAt(0).cloneRange();
      }
      return null;
    })();

    showDialog(
      'Insert Table',
      '<label>Columns:</label><input type="number" id="dialog-table-cols" value="3" min="1" max="20" style="width:80px;margin-right:16px"><label>Rows:</label><input type="number" id="dialog-table-rows" value="3" min="1" max="50" style="width:80px">',
      () => {
        const cols = parseInt($('#dialog-table-cols').value) || 3;
        const rows = parseInt($('#dialog-table-rows').value) || 3;
        editor.focus();

        if (savedRange) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(savedRange);
        }

        insertTable(cols, rows);
        markModified();
        return true;
      }
    );
  }

  function insertTable(cols, rows) {
    const sel = window.getSelection();
    if (sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);

    let html = '<table><colgroup>';
    for (let i = 0; i < cols; i++) {
      html += '<col style="width:80px">';
    }
    html += '</colgroup><tbody>';
    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      const cellTag = r === 0 ? 'th' : 'td';
      const cellStyle = r === 0 ? ' style="background:#3498db;font-weight:bold;color:#fff"' : '';
      for (let c = 0; c < cols; c++) {
        html += '<' + cellTag + cellStyle + '><br></' + cellTag + '>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';

    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const tableEl = wrapper.firstElementChild;

    range.deleteContents();
    range.insertNode(tableEl);

    // Move cursor to second row first cell (skip header row)
    const firstCell = tableEl.querySelector('tbody tr:nth-child(2) td');
    if (firstCell) {
      const newRange = document.createRange();
      newRange.setStart(firstCell, 0);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }
  }

  // ─── Table Keyboard Handlers ─────────────────────────────────────────

  function findCell(node) {
    while (node && node.nodeName !== 'TD' && node.nodeName !== 'TH') {
      node = node.parentNode;
    }
    return node;
  }

  function handleTableEnter(e) {
    const sel = window.getSelection();
    if (sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);

    const td = findCell(range.startContainer);
    if (!td) return;

    const tr = td.closest('tr');
    if (!tr) return;

    const cells = tr.querySelectorAll('td');
    const isLastCell = td === cells[cells.length - 1];
    if (!isLastCell) return;

    if (range.startOffset < td.textContent.length) return;

    e.preventDefault();
    const table = td.closest('table');
    const colCount = table.querySelectorAll('col').length || cells.length;
    const newRow = document.createElement('tr');
    for (let i = 0; i < colCount; i++) {
      const newCell = document.createElement('td');
      newCell.innerHTML = '<br>';
      newRow.appendChild(newCell);
    }
    tr.parentNode.insertBefore(newRow, tr.nextSibling);

    const firstCell = newRow.querySelector('td');
    if (firstCell) {
      const newRange = document.createRange();
      newRange.setStart(firstCell, 0);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }
    markModified();
  }

  function handleTableBackspace(e) {
    const sel = window.getSelection();
    if (sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);

    if (range.startOffset !== 0) return;

    const td = findCell(range.startContainer);
    if (!td) return;

    const tr = td.closest('tr');
    if (!tr) return;
    const firstCell = tr.querySelector('td');
    if (td !== firstCell) return;

    const tbody = tr.parentNode;
    if (!tbody) return;

    const rows = tbody.querySelectorAll('tr');
    if (rows.length <= 1) return;

    e.preventDefault();
    tr.remove();
    markModified();

    const prevRow = tr.previousElementSibling || tbody.querySelector('tr');
    if (prevRow) {
      const prevCells = prevRow.querySelectorAll('td');
      const targetCell = prevCells[prevCells.length - 1];
      if (targetCell) {
        const newRange = document.createRange();
        newRange.setStart(targetCell, targetCell.childNodes.length || 0);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
    }
  }

  // ─── Table Column Resize ─────────────────────────────────────────────

  let tableColResize = null;

  function initTableColumnResize() {
    editor.addEventListener('mousemove', function(e) {
      if (tableColResize) return;
      if (editor._resizeInfo) {
        editor._resizeInfo = null;
        editor.style.cursor = '';
      }

      const table = e.target.closest('table');
      if (!table || !editor.contains(table)) return;

      const cells = table.querySelectorAll('tr:first-child > td, tr:first-child > th');
      if (cells.length < 2) return;

      // Don't trigger column resize when near the bottom-right corner
      // (element resize handle takes priority there)
      const tableRect = table.getBoundingClientRect();
      if (e.clientY > tableRect.bottom - 24) return;

      for (let i = 0; i < cells.length; i++) {
        const rect = cells[i].getBoundingClientRect();
        if (Math.abs(e.clientX - rect.right) < 5) {
          editor.style.cursor = 'col-resize';
          editor._resizeInfo = { table, colIndex: i };
          return;
        }
      }
    });

    editor.addEventListener('mouseleave', function() {
      if (!tableColResize) {
        editor.style.cursor = '';
        editor._resizeInfo = null;
      }
    });

    editor.addEventListener('mousedown', function(e) {
      if (editor._resizeInfo) {
        e.preventDefault();
        const { table, colIndex } = editor._resizeInfo;
        const cols = table.querySelectorAll('col');
        if (cols[colIndex]) {
          const currentW = parseFloat(cols[colIndex].style.width) || 80;
          tableColResize = {
            table, col: cols[colIndex], colIndex,
            startX: e.clientX, startW: currentW,
          };
        }
      }
    });

    // These document-level handlers track the drag globally
    // (using ones already defined for splitter would conflict, so add new ones)
  }

  // ─── Element resize handle (table & image) ───────────────────────────

  let elementResizeHandle = null;
  let elementResizeTarget = null;
  let elementResizeStart = null;

  function initElementResizeHandle() {
    elementResizeHandle = document.createElement('div');
    elementResizeHandle.className = 'editor-resize-handle';
    document.body.appendChild(elementResizeHandle);

    editor.addEventListener('mousemove', function(e) {
      if (elementResizeTarget) return;

      const editorRect = editor.getBoundingClientRect();
      if (e.clientX < editorRect.left || e.clientX > editorRect.right ||
          e.clientY < editorRect.top || e.clientY > editorRect.bottom) {
        elementResizeHandle.style.display = 'none';
        return;
      }

      let target = null;
      if (e.target.tagName === 'IMG' && editor.contains(e.target)) {
        target = e.target;
      } else if (e.target.tagName === 'TABLE' && editor.contains(e.target)) {
        target = e.target;
      } else {
        const img = e.target.closest('img');
        const tbl = e.target.closest('table');
        if (img && editor.contains(img)) target = img;
        else if (tbl && editor.contains(tbl)) target = tbl;
      }

      if (target) {
        const rect = target.getBoundingClientRect();
        const nearCorner = (e.clientX > rect.right - 24 && e.clientY > rect.bottom - 24);
        if (nearCorner) {
          elementResizeHandle.style.display = 'block';
          elementResizeHandle.style.left = (rect.right - 16) + 'px';
          elementResizeHandle.style.top = (rect.bottom - 16) + 'px';
          elementResizeHandle._target = target;
          return;
        }
      }
      elementResizeHandle.style.display = 'none';
    });

    elementResizeHandle.addEventListener('mousedown', function(e) {
      e.preventDefault();
      e.stopPropagation();

      const target = elementResizeHandle._target;
      if (!target || !editor.contains(target)) return;

      elementResizeTarget = target;

      if (target.tagName === 'IMG') {
        let w = target.naturalWidth || 0;
        let h = target.naturalHeight || 0;
        if (!w || !h) {
          w = target.width;
          h = target.height;
        }
        const rect = target.getBoundingClientRect();
        elementResizeStart = {
          startX: e.clientX,
          startY: e.clientY,
          startW: rect.width,
          startH: rect.height,
          aspectRatio: w / (h || 1),
          scaleCols: false,
        };
      } else if (target.tagName === 'TABLE') {
        const cols = target.querySelectorAll('col');
        const colWidths = [];
        cols.forEach(col => {
          colWidths.push(parseFloat(col.style.width) || 80);
        });
        const rect = target.getBoundingClientRect();
        const cs = window.getComputedStyle(target);
        const baseFontSize = parseFloat(cs.fontSize) || 16;
        elementResizeStart = {
          startX: e.clientX,
          startY: e.clientY,
          startW: rect.width,
          startH: rect.height,
          aspectRatio: rect.width / (rect.height || 1),
          colWidths: colWidths.length ? colWidths : null,
          scaleCols: true,
          startFontSize: baseFontSize,
        };
      }
    });
  }

  // Wire up document mouse events for element resize handle
  document.addEventListener('mousemove', function(e) {
    if (tableColResize) {
      const dx = e.clientX - tableColResize.startX;
      const newW = Math.max(30, tableColResize.startW + dx);
      tableColResize.col.style.width = newW + 'px';
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    }

    if (elementResizeTarget && elementResizeStart) {
      const dx = e.clientX - elementResizeStart.startX;
      const dy = e.clientY - elementResizeStart.startY;
      const scaleFromW = (elementResizeStart.startW + dx) / elementResizeStart.startW;
      const scaleFromH = (elementResizeStart.startH + dy) / elementResizeStart.startH;
      const scale = Math.max(scaleFromW, scaleFromH);
      const newW = Math.max(60, Math.round(elementResizeStart.startW * scale));
      const newH = Math.round(newW / elementResizeStart.aspectRatio);

      if (elementResizeTarget.tagName === 'IMG') {
        elementResizeTarget.style.width = newW + 'px';
        elementResizeTarget.style.height = newH + 'px';
      } else if (elementResizeTarget.tagName === 'TABLE') {
        elementResizeTarget.style.width = newW + 'px';
        if (elementResizeStart.scaleCols && elementResizeStart.colWidths) {
          const s = newW / elementResizeStart.startW;
          const cols = elementResizeTarget.querySelectorAll('col');
          cols.forEach((col, i) => {
            if (i < elementResizeStart.colWidths.length) {
              col.style.width = Math.round(elementResizeStart.colWidths[i] * s) + 'px';
            }
          });
        }
        if (elementResizeStart.startFontSize) {
          elementResizeTarget.style.fontSize =
            Math.round(elementResizeStart.startFontSize * scale) + 'px';
        }
      }

      const targetRect = elementResizeTarget.getBoundingClientRect();
      elementResizeHandle.style.left = (targetRect.right - 16) + 'px';
      elementResizeHandle.style.top = (targetRect.bottom - 16) + 'px';
      document.body.style.cursor = 'nwse-resize';
      e.preventDefault();
    }
  });

  document.addEventListener('mouseup', function() {
    if (tableColResize) {
      if (!tableColResize._noModified) {
        markModified();
      }
      tableColResize = null;
      document.body.style.cursor = '';
      if (editor) editor.style.cursor = '';
    }

    if (elementResizeTarget) {
      markModified();
      elementResizeTarget = null;
      elementResizeStart = null;
      elementResizeHandle.style.display = 'none';
      document.body.style.cursor = '';
    }
  });

  // ─── Integrate table key handlers into editor ────────────────────────

  // Extend the existing keydown listener (already has Ctrl+S and Escape)
  // We add table-specific handling by hooking into a secondary listener
  function handleTableTab(e) {
    const sel = window.getSelection();
    if (sel.rangeCount === 0) return;

    const td = findCell(sel.anchorNode);
    if (td) {
      // Inside a table — navigate between cells
      e.preventDefault();
      const table = td.closest('table');
      const allCells = table.querySelectorAll('td, th');
      let currentIdx = -1;
      for (let i = 0; i < allCells.length; i++) {
        if (allCells[i] === td) { currentIdx = i; break; }
      }
      if (currentIdx === -1) return;

      let targetIdx;
      if (e.shiftKey) {
        targetIdx = currentIdx - 1;
      } else {
        targetIdx = currentIdx + 1;
      }
      if (targetIdx < 0 || targetIdx >= allCells.length) return;

      const targetCell = allCells[targetIdx];
      const newRange = document.createRange();
      newRange.setStart(targetCell, 0);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
      editor.focus();
    } else {
      // Outside table — insert 4 spaces
      e.preventDefault();
      document.execCommand('insertText', false, '    ');
    }
  }

  editor.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      handleTableEnter(e);
    } else if (e.key === 'Backspace') {
      handleTableBackspace(e);
    } else if (e.key === 'Tab') {
      handleTableTab(e);
    }
  });

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
  const styleIconAfter = $('#style-icon-after');
  let styleItemId = null;

  function showCustomStyleDialog(itemId) {
    styleItemId = itemId;
    const item = findNodeById(menuTree, itemId);
    if (!item) return;

    const s = item.style || {};
    styleIcon.value = s.icon || '';
    styleIconBtn.textContent = s.icon || '📁';
    styleFontFamily.value = s.fontFamily || '';
    styleFontSize.value = s.fontSize || '';
    styleColor.value = s.color || '#000000';
    styleBgColor.value = s.bgColor || '#ffffff';
    styleBold.checked = !!s.bold;
    styleUnderline.checked = !!s.underline;
    styleStrikethrough.checked = !!s.strikethrough;
    styleIconAfter.checked = !!s.iconAfter;

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
      iconAfter: styleIconAfter.checked,
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
    if (s.iconAfter) out.iconAfter = true;
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
    styleIconBtn.textContent = '📁';
    styleFontFamily.value = '';
    styleFontSize.value = '';
    styleColor.value = '#000000';
    styleBgColor.value = '#ffffff';
    styleBold.checked = false;
    styleUnderline.checked = false;
    styleStrikethrough.checked = false;
    styleIconAfter.checked = false;
  }

  // ─── Emoji Picker Dialog ──────────────────────────────────────

  const EMOJI_CATEGORIES = [
    { name: '文件夹与文件', items: ['📁','📂','🗂️','📄','📑','📝','📃','📜','📋','📌','📎','🖇️','📏','📐','✂️','🗃️','🗄️','🧾','🏷️'] },
    { name: '书签与标记', items: ['🔖','⭐','🌟','✨','💫','🏅','🥇','🥈','🥉','🎖️','🏆','🎯','📍','🚩','🎗️','🏵️','🎪'] },
    { name: '沟通与消息', items: ['💬','💭','🗨️','🗯️','💌','📧','📨','📩','📤','📥','📫','📪','📬','📭','📢','📣','🔊','🔇'] },
    { name: '编辑与写作', items: ['✏️','✒️','🖊️','🖋️','🖌️','🖍️','✍️','📝','📄','📃','📜','✂️','📎','🖇️','🔗','🧷','📏','📐'] },
    { name: '图表与数据', items: ['📊','📈','📉','📋','📅','📆','🗓️','📇','🧮','📑','🗒️','🗃️','🗄️','📁','📂'] },
    { name: '搜索与灵感', items: ['🔍','🔎','💡','🕯️','🔦','🧠','🧩','🔬','🔭','💭','🎯','🎲','♟️','🧿','⚗️'] },
    { name: '技术与存储', items: ['💻','🖥️','🖨️','⌨️','🖱️','💿','📀','💾','💽','📼','📷','📹','🎥','📡','☁️','🖵','🖬'] },
    { name: '工具与设置', items: ['⚙️','🔧','🛠️','🔩','⛏️','🪛','🪚','🔨','🧰','🧲','⚖️','🔗','⚡','🔄','🧪','🔬','🔭','🗜️'] },
    { name: '安全与状态', items: ['🔒','🔓','🔐','🔑','🗝️','🛡️','✅','❌','⚠️','🚫','🔞','🚨','🚩','🏴','🔏','🔐','🛡️','✔️'] },
    { name: '学习与书籍', items: ['📚','📖','📕','📗','📘','📙','📔','📓','📒','🔖','🏷️','🎓','📝','✏️','📑','📃','🎒','📏'] },
    { name: '地点与导航', items: ['🏠','🏢','🏣','🏤','🏥','🏦','🏨','🏪','🏫','🏬','🏭','🏯','🏰','🗺️','🧭','🌍','🌎','🌏'] },
    { name: '设计与创意', items: ['🎨','🖌️','🖍️','🖼️','🎭','🎬','🎵','🎶','🎧','🎤','🎹','🥁','🎷','🎸','🎺','🎻','🎯','🎪'] },
    { name: '通知与提醒', items: ['🔔','🔕','📢','📣','🔊','🔇','📯','🛎️','🚨','⚠️','🚫','📛','🚸','🔞','📳','📴','🔅','🔆'] },
    { name: '目标与成就', items: ['🎯','🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎪','🎭','🎨','🎬','🎤','🎼','🎹','🥁','🎧','🎵'] },
    { name: '自然与物品', items: ['🌟','⭐','🌈','☀️','🌙','🌍','🌎','🌏','🌐','🔥','💧','❄️','🌊','🌿','🌺','🌻','🌸','🌴','🌵','🍀'] },
    { name: '符号与箭头', items: ['🔄','↩️','↪️','➡️','⬅️','⬆️','⬇️','↗️','↘️','↙️','↖️','➕','➖','➗','✖️','✔️','🔽','🔼','▶️','◀️'] },
  ];

  const emojiDialog = $('#emoji-dialog');
  const emojiDialogBody = $('#emoji-dialog-body');
  const emojiSearch = $('#emoji-search');
  const styleIconBtn = $('#style-icon-btn');
  let allEmojiItems = [];

  function renderEmojiGrid(filter) {
    emojiDialogBody.innerHTML = '';
    allEmojiItems = [];
    const lowerFilter = (filter || '').toLowerCase();

    for (const cat of EMOJI_CATEGORIES) {
      const matchingItems = lowerFilter
        ? cat.items.filter((e) => e.includes(lowerFilter) || cat.name.includes(lowerFilter))
        : cat.items;
      if (matchingItems.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'emoji-category';

      const header = document.createElement('div');
      header.className = 'emoji-category-header';
      header.textContent = cat.name;
      section.appendChild(header);

      const grid = document.createElement('div');
      grid.className = 'emoji-grid';

      for (const emoji of matchingItems) {
        const span = document.createElement('span');
        span.className = 'emoji-item';
        span.dataset.emoji = emoji;
        span.textContent = emoji;
        if (emoji === styleIcon.value) span.classList.add('selected');
        grid.appendChild(span);
        allEmojiItems.push(span);
      }

      section.appendChild(grid);
      emojiDialogBody.appendChild(section);
    }
  }

  function openEmojiPicker() {
    renderEmojiGrid(emojiSearch.value);
    emojiDialog.style.display = 'flex';
  }

  function closeEmojiPicker() {
    emojiDialog.style.display = 'none';
  }

  styleIconBtn.addEventListener('click', openEmojiPicker);

  emojiDialog.addEventListener('click', (e) => {
    const item = e.target.closest('.emoji-item');
    if (!item) return;
    styleIcon.value = item.dataset.emoji;
    styleIconBtn.textContent = item.dataset.emoji;
    closeEmojiPicker();
  });

  emojiSearch.addEventListener('input', () => {
    renderEmojiGrid(emojiSearch.value);
  });

  $('#emoji-btn-close').addEventListener('click', closeEmojiPicker);

  emojiDialog.addEventListener('click', (e) => {
    if (e.target === emojiDialog) closeEmojiPicker();
  });

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
      }
      // Base font-size fixed to 24px (Large) — toolbar setting only affects new input
      editor.style.fontSize = '24px';
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
    // Must NOT set editor.style.fontSize — that changes the CSS base,
    // affecting ALL existing content without inline font-size.
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

  // ─── Background Color (Highlight) ────────────────────────────────────────

  $('#text-bgcolor').addEventListener('input', function() {
    const swatch = $('#bgcolor-swatch');
    if (swatch) swatch.style.background = this.value;
    this.classList.remove('color-input-hidden--active');
    this.style.left = '';
    this.style.top = '';
  });

  $('#btn-apply-bgcolor').addEventListener('click', () => {
    editor.focus();
    const color = $('#text-bgcolor').value;
    document.execCommand('backColor', false, color);
    markModified();
  });

  $('#btn-bgcolor-arrow').addEventListener('click', (e) => {
    e.stopPropagation();
    const input = $('#text-bgcolor');
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

  $('#btn-insert-table').addEventListener('click', () => {
    promptInsertTable();
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
    // Save cursor position at right-click location for context menu actions
    if (selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
      ctxMenu._savedRange = selection.getRangeAt(0).cloneRange();
    } else {
      ctxMenu._savedRange = null;
    }

    // Detect if right-click is inside a table cell
    const tableCell = e.target.closest('td, th');
    const inTable = tableCell && editor.contains(tableCell);
    ctxMenu._tableCell = inTable ? tableCell : null;

    // Toggle context menu items based on context
    ctxMenu.querySelectorAll('.ctx-item:not(.ctx-table-item), .ctx-separator:not(.ctx-table-sep)').forEach(el => {
      el.style.display = inTable ? 'none' : '';
    });
    ctxMenu.querySelectorAll('.ctx-table-item, .ctx-table-sep').forEach(el => {
      el.style.display = inTable ? '' : 'none';
    });

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

  function restoreContextMenuRange() {
    if (ctxMenu._savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(ctxMenu._savedRange);
      ctxMenu._savedRange = null;
    }
  }

  $('#ctx-insert-table').addEventListener('click', () => {
    ctxMenu.style.display = 'none';
    restoreContextMenuRange();
    promptInsertTable();
  });

  $('#ctx-insert-link').addEventListener('click', () => {
    ctxMenu.style.display = 'none';
    restoreContextMenuRange();
    const sel = window.getSelection().toString();
    if (sel) {
      $('#dialog-link-text').value = sel;
    }
    promptInsertLink();
  });

  function getTableContext() {
    const cell = ctxMenu._tableCell;
    if (!cell) return null;
    const table = cell.closest('table');
    const tr = cell.closest('tr');
    const tbody = tr.parentNode;
    const rows = tbody.querySelectorAll('tr');
    const cellsInRow = tr.querySelectorAll('td, th');
    let colIndex = -1;
    for (let i = 0; i < cellsInRow.length; i++) {
      if (cellsInRow[i] === cell) { colIndex = i; break; }
    }
    const colgroup = table.querySelector('colgroup');
    const cols = colgroup ? colgroup.querySelectorAll('col') : [];
    return { table, cell, tr, tbody, rows, colIndex, colgroup, cols };
  }

  function insertTableColumn() {
    const ctx = getTableContext();
    if (!ctx || ctx.colIndex < 0) return;
    const { table, colIndex, cols, colgroup } = ctx;

    const newCol = document.createElement('col');
    newCol.style.width = '80px';
    if (cols[colIndex] && cols[colIndex].nextSibling) {
      colgroup.insertBefore(newCol, cols[colIndex].nextSibling);
    } else {
      colgroup.appendChild(newCol);
    }

    const allRows = table.querySelectorAll('tr');
    allRows.forEach(row => {
      const refCell = row.querySelectorAll('td, th')[colIndex];
      const newCell = document.createElement(refCell ? refCell.tagName : 'td');
      if (refCell && refCell.style.cssText) {
        newCell.style.cssText = refCell.style.cssText;
      }
      newCell.innerHTML = '<br>';
      if (refCell && refCell.nextSibling) {
        refCell.parentNode.insertBefore(newCell, refCell.nextSibling);
      } else {
        row.appendChild(newCell);
      }
    });

    markModified();
    tableFormulaManager?.onTableModified();
  }

  function insertTableRow() {
    const ctx = getTableContext();
    if (!ctx || !ctx.tr) return;
    const { table, tr } = ctx;
    const colCount = table.querySelectorAll('col').length;

    const newRow = document.createElement('tr');
    for (let i = 0; i < colCount; i++) {
      const newCell = document.createElement('td');
      newCell.innerHTML = '<br>';
      newRow.appendChild(newCell);
    }

    tr.parentNode.insertBefore(newRow, tr.nextSibling);

    const firstCell = newRow.querySelector('td');
    if (firstCell) {
      const sel = window.getSelection();
      const newRange = document.createRange();
      newRange.setStart(firstCell, 0);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }

    markModified();
    tableFormulaManager?.onTableModified();
  }

  function deleteTableColumn() {
    const ctx = getTableContext();
    if (!ctx || ctx.colIndex < 0) return;
    const { table, colIndex, cols } = ctx;

    if (cols.length <= 1) {
      table.remove();
      markModified();
      tableFormulaManager?.onTableModified();
      return;
    }

    if (cols[colIndex]) cols[colIndex].remove();

    const allRows = table.querySelectorAll('tr');
    allRows.forEach(row => {
      const cells = row.querySelectorAll('td, th');
      if (cells[colIndex]) cells[colIndex].remove();
    });

    markModified();
    tableFormulaManager?.onTableModified();
  }

  function deleteTableRow() {
    const ctx = getTableContext();
    if (!ctx || !ctx.tr) return;
    const { table, tr, rows } = ctx;

    if (rows.length <= 1) {
      table.remove();
      markModified();
      tableFormulaManager?.onTableModified();
      return;
    }

    const nextRow = tr.nextElementSibling || tr.previousElementSibling;
    tr.remove();

    if (nextRow) {
      const targetCell = nextRow.querySelector('td, th');
      if (targetCell) {
        const sel = window.getSelection();
        const newRange = document.createRange();
        newRange.setStart(targetCell, 0);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
    }

    markModified();
    tableFormulaManager?.onTableModified();
  }

  ctxMenu.querySelectorAll('.ctx-table-item').forEach(item => {
    item.addEventListener('click', () => {
      ctxMenu.style.display = 'none';
      restoreContextMenuRange();

      switch (item.dataset.tableAction) {
        case 'insert-col':
          insertTableColumn();
          break;
        case 'insert-row':
          insertTableRow();
          break;
        case 'delete-col':
          deleteTableColumn();
          break;
        case 'delete-row':
          deleteTableRow();
          break;
      }
    });
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
      // Skip images that have been manually resized (both width and height set to numbers)
      if (img.style.height && img.style.height !== 'auto') return;
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
    const setPwItem = tabCtxMenu.querySelector('[data-action="set-password"]');
    const changePwItem = tabCtxMenu.querySelector('[data-action="change-password"]');
    const removePwItem = tabCtxMenu.querySelector('[data-action="remove-password"]');
    const pwSep = $('#tab-ctx-pw-sep');
    const exportItems = tabCtxMenu.querySelectorAll('.ctx-submenu-item');
    const isEncrypted = encryptedTabsCache && encryptedTabsCache.includes(name);
    const isUnlocked = unlockedTabs.has(name);
    if (isEncrypted) {
      setPwItem.style.display = 'none';
      changePwItem.style.display = '';
      removePwItem.style.display = '';
      pwSep.style.display = '';
      // Disable export for encrypted-not-unlocked tabs
      exportItems.forEach((item) => {
        if (!isUnlocked) {
          item.classList.add('ctx-menu-disabled');
        } else {
          item.classList.remove('ctx-menu-disabled');
        }
      });
    } else {
      setPwItem.style.display = '';
      changePwItem.style.display = 'none';
      removePwItem.style.display = 'none';
      pwSep.style.display = '';
      exportItems.forEach((item) => item.classList.remove('ctx-menu-disabled'));
    }
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

  async function handleSetPassword(name) {
    const result = await showPasswordDialog('set', name);
    if (!result) return;
    try {
      await setTabPassword(name, result.password);
      encryptedTabsCache = encryptedTabsCache || [];
      if (!encryptedTabsCache.includes(name)) {
        encryptedTabsCache.push(name);
      }
      unlockedTabs.add(name);
      if (currentTab === name) {
        await loadMenu();
      }
      updateTabEncryptionIndicators();
    } catch (e) {
      showDialog(t('error_dialog_title'), `<p>${escapeHtml(e.message)}</p>`);
    }
  }

  async function handleChangePassword(name) {
    const result = await showPasswordDialog('change', name);
    if (!result) return;
    try {
      await setTabPassword(name, result.password, result.oldPassword);
      unlockedTabs.add(name);
      if (currentTab === name) {
        await loadMenu();
      }
    } catch (e) {
      showDialog(t('error_dialog_title'), `<p>${escapeHtml(e.message)}</p>`);
    }
  }

  async function handleRemovePassword(name) {
    // First confirm
    const confirmed = await showDialog(
      t('remove_password'),
      `<p>${t('remove_password_confirm')} "${escapeHtml(name)}"?</p>`,
      () => true
    );
    if (!confirmed) return;

    const result = await showPasswordDialog('remove', name);
    if (!result) return;
    try {
      await removeTabPassword(name, result.password);
      unlockedTabs.delete(name);
      if (encryptedTabsCache) {
        const idx = encryptedTabsCache.indexOf(name);
        if (idx !== -1) encryptedTabsCache.splice(idx, 1);
      }
      clearTabUnlock(name);
      if (currentTab === name) {
        await loadMenu();
      }
      updateTabEncryptionIndicators();
    } catch (e) {
      showDialog(t('error_dialog_title'), `<p>${escapeHtml(e.message)}</p>`);
    }
  }

  function updateTabEncryptionIndicators() {
    tabsEl.querySelectorAll('.tab').forEach((tabEl) => {
      const tabName = tabEl.dataset.tab;
      if (!tabName) return;
      const isEncrypted = encryptedTabsCache && encryptedTabsCache.includes(tabName);
      const lockIcon = tabEl.querySelector('.tab-lock-icon');
      if (isEncrypted) {
        if (!lockIcon) {
          const icon = document.createElement('span');
          icon.className = 'tab-lock-icon';
          icon.textContent = ' 🔒';
          icon.title = t('encrypted');
          // Append after .tab-label so updateTabLabel textContent doesn't wipe it
          const label = tabEl.querySelector('.tab-label');
          if (label && label.nextSibling) {
            tabEl.insertBefore(icon, label.nextSibling);
          } else {
            tabEl.appendChild(icon);
          }
        }
      } else if (lockIcon) {
        lockIcon.remove();
      }
    });
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
      if (item.classList.contains('ctx-menu-disabled')) return;
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
          clearTabUnlock(name);
          kbVisibility[name] = false;
          api('PUT', '/api/tab-visibility', kbVisibility).then(() => {
            loadTabs();
          }).catch((e) => {
            console.error('Failed to save visibility:', e);
          });
          break;
        case 'set-password':
          handleSetPassword(name);
          break;
        case 'change-password':
          handleChangePassword(name);
          break;
        case 'remove-password':
          handleRemovePassword(name);
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

  // ─── Search Highlight ──────────────────────────────────────────────────

  function clearSearchHighlights() {
    if (!editor) return;
    const highlights = editor.querySelectorAll('.search-highlight');
    highlights.forEach((span) => {
      const parent = span.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(span.textContent), span);
        parent.normalize();
      }
    });
  }

  function highlightInEditor(query) {
    if (!query || !editor) return;
    clearSearchHighlights();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    while (walker.nextNode()) {
      if (walker.currentNode.parentNode &&
          walker.currentNode.parentNode.closest &&
          walker.currentNode.parentNode.closest('.search-highlight')) {
        continue;
      }
      textNodes.push(walker.currentNode);
    }

    const lowerQuery = query.toLowerCase();
    textNodes.forEach((node) => {
      const text = node.textContent;
      const lowerText = text.toLowerCase();
      let idx = lowerText.indexOf(lowerQuery);
      if (idx === -1) return;

      const fragment = document.createDocumentFragment();
      let lastIdx = 0;
      while (idx !== -1) {
        if (idx > lastIdx) {
          fragment.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
        }
        const mark = document.createElement('span');
        mark.className = 'search-highlight';
        mark.textContent = text.slice(idx, idx + query.length);
        fragment.appendChild(mark);
        lastIdx = idx + query.length;
        idx = lowerText.indexOf(lowerQuery, lastIdx);
      }
      if (lastIdx < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      node.parentNode.replaceChild(fragment, node);
    });
  }

  function applySearchHighlights() {
    if (currentSearchQuery) {
      highlightInEditor(currentSearchQuery);
    }
  }

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
    currentSearchQuery = query;
    // Highlight the current content immediately if it contains the search term
    applySearchHighlights();

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
    clearSearchHighlights();
    currentSearchQuery = '';
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

  // ─── Session Security ──────────────────────────────────────────────────
  // Encryption key cache management:
  //   - The server caches derived AES keys in memory per tab_name.
  //   - The client tracks which tabs are unlocked via `unlockedTabs` Set.
  //   - Both caches are shared across windows/tabs connecting to the same server.
  //
  // Security model for a local-only desktop app:
  //   - Server is localhost-only; only the local user can reach it.
  //   - Clearing `unlockedTabs` on pagehide ensures the user re-authenticates
  //     on their next visit, without affecting other open windows.
  //   - The server key cache is intentionally NOT cleared on pagehide/visibilitychange
  //     because other windows may still need their cached keys. The server cache
  //     is in-memory and dies with the server process.

  // visibilitychange fires when switching browser tabs or minimizing.
  // We intentionally do NOT clear unlockedTabs here — doing so would cause
  // the encrypted tab to re-prompt for a password when switching back from
  // another browser window/tab. The server-side key cache is also shared
  // across sessions, so clearing only the client set provides no real
  // security benefit while creating a bad UX.
  // Server-side cache is never cleared on visibilitychange or pagehide
  // because other windows sharing the same server may need their cached keys.

  // pagehide fires on actual page unload (close tab, navigate away).
  // Clear client-side unlockedTabs so the next visit re-prompts for password.
  // Do NOT clear the server-side encryption cache — other windows/tabs sharing
  // the same server may still need their cached AES keys. The server cache is
  // in-memory and dies with the server process anyway.
  window.addEventListener('pagehide', () => {
    unlockedTabs.clear();
  });

  // ─── Table Formula Manager (Excel-like calculations) ──────────────

  const AGGREGATE_FUNCS = ['SUM','AVERAGE','AVERAGEA','COUNT','COUNTA','MAX','MIN','PRODUCT','STDEV','STDEVP','VAR','VARP','MEDIAN','MODE'];
  const formulaBar = $('#formula-bar');
  const formulaInput = $('#formula-bar-formula');
  const cellRefDisplay = $('#formula-bar-cell-ref');

  let tableFormulaManager = null;

  class TableFormulaManager {
    constructor() {
      this.hfInstances = new Map();
      this.activeCell = null;
      this.activeTable = null;
      this.isUpdating = false;
      this._formulaChangeHandler = null;
      this._cellClickHandler = null;
      this._editorInputHandler = null;
    }

    init() {
      this.scanTables();
      this.bindEvents();
    }

    refresh() {
      this.destroy();
      this.scanTables();
      formulaBar.style.display = this.hfInstances.size > 0 ? '' : 'none';
    }

    destroy() {
      console.log('[Formula] destroy() called, clearing', this.hfInstances.size, 'entries');
      for (const [, data] of this.hfInstances) {
        try { data.hf.destroy(); } catch(e) {}
      }
      this.hfInstances.clear();
      this.activeCell = null;
      this.activeTable = null;
      this.hideFormulaBar();
    }

    scanTables() {
      console.log('[Formula] scanTables() called');
      const tables = editor.querySelectorAll('table');
      console.log('[Formula] found', tables.length, 'tables');
      tables.forEach(table => {
        if (editor.contains(table)) {
          this.initTableFormulas(table);
        }
      });
      formulaBar.style.display = this.hfInstances.size > 0 ? '' : 'none';
    }

    colLetter(index) {
      let l = '';
      let i = index;
      while (i >= 0) {
        l = String.fromCharCode(65 + (i % 26)) + l;
        i = Math.floor(i / 26) - 1;
      }
      return l;
    }

    escapeRegex(str) {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    getDataRows(table) {
      const trs = table.querySelectorAll('tr');
      const result = [];
      trs.forEach((tr, ri) => {
        const cells = tr.querySelectorAll('td, th');
        const row = [];
        cells.forEach((cell, ci) => {
          if (cell.getAttribute('data-formula')) {
            row.push(cell.getAttribute('data-formula'));
          } else {
            const txt = cell.textContent.trim();
            if (txt === '') {
              row.push(null);
            } else {
              const num = parseFloat(txt);
              if (!isNaN(num) && /^-?\d+(\.\d+)?$/.test(txt)) {
                row.push(num);
              } else {
                row.push(txt);
              }
            }
          }
        });
        result.push(row);
      });
      return result;
    }

    getHeaders(table) {
      const firstRow = table.querySelector('tr:first-child');
      const headers = [];
      if (firstRow) {
        firstRow.querySelectorAll('th, td').forEach((cell, idx) => {
          const name = cell.textContent.replace(/\s+/g, ' ').trim();
          headers[idx] = name || ('Col' + (idx + 1));
        });
      }
      return headers;
    }

    resolveFormula(formula, headers, currentRow, totalRows) {
      if (!formula || !formula.startsWith('=')) return formula;

      let result = formula;
      const sortedHeaders = [];
      for (let i = 0; i < headers.length; i++) {
        if (headers[i] && headers[i] !== ('Col' + (i + 1))) {
          sortedHeaders.push({ idx: i, name: headers[i] });
        }
      }
      sortedHeaders.sort((a, b) => b.name.length - a.name.length);

      for (const { idx, name } of sortedHeaders) {
        const colLetter = this.colLetter(idx);
        const escaped = this.escapeRegex(name);

        for (const func of AGGREGATE_FUNCS) {
          // SUM(Header) -> SUM($B$2:$B$N) — full column range, exclude formula's own row
          const fullRegex = new RegExp(
            '(?<=' + func + '\\()' + escaped + '(?=\\))', 'gi'
          );
          const dataRowStart = 1;
          const dataRowEnd = totalRows - 1;
          let fullRange = '';
          if (currentRow >= dataRowEnd) {
            const end = Math.min(currentRow - 1, dataRowEnd);
            if (end >= dataRowStart) {
              fullRange = colLetter + '$' + (dataRowStart + 1) + ':' + colLetter + '$' + (end + 1);
            }
          } else if (currentRow <= dataRowStart) {
            if (currentRow + 1 <= dataRowEnd) {
              fullRange = colLetter + '$' + (currentRow + 2) + ':' + colLetter + '$' + (dataRowEnd + 1);
            }
          } else {
            const above = colLetter + '$' + (dataRowStart + 1) + ':' + colLetter + '$' + currentRow;
            const below = colLetter + '$' + (currentRow + 2) + ':' + colLetter + '$' + (dataRowEnd + 1);
            fullRange = above + ',' + below;
          }
          if (fullRange) {
            result = result.replace(fullRegex, fullRange);
          }

          // SUM(Header1:Header5) -> SUM($B$2:$B$6) — range with 1-indexed row numbers
          const rangeRegex = new RegExp(
            '(' + escaped + ')(\\d+)\\s*:\\s*\\1(\\d+)', 'gi'
          );
          result = result.replace(rangeRegex, (_m, _name, r1, r2) => {
            return colLetter + '$' + (parseInt(r1) + 1) + ':' + colLetter + '$' + (parseInt(r2) + 1);
          });
        }

        const standaloneRegex = new RegExp(
          '(?<![\\w$"\'])(' + escaped + ')(?![\\w"\'(])', 'g'
        );
        result = result.replace(standaloneRegex, '$' + colLetter + (currentRow + 1));
      }

      return result;
    }

    initTableFormulas(table) {
      const headers = this.getHeaders(table);
      const data = this.getDataRows(table);
      const maxCols = Math.max(...data.map(r => r.length), 1);
      const totalRows = data.length;

      const resolvedData = data.map((row, ri) => {
        return row.map((cell) => {
          if (typeof cell === 'string' && cell.startsWith('=')) {
            const resolved = this.resolveFormula(cell, headers, ri, totalRows);
            console.log('[Formula]', cell, '→', resolved);
            return resolved;
          }
          return cell;
        });
      });
      console.log('[Formula] resolvedData:', JSON.stringify(resolvedData));

      for (const row of resolvedData) {
        while (row.length < maxCols) row.push(null);
      }

      let hf;
      try {
        hf = HyperFormula.buildFromArray(resolvedData, { licenseKey: 'gpl-v3' });
      } catch (e) {
        console.warn('HyperFormula init failed:', e);
        const statusEl = document.getElementById('formula-bar-status');
        if (statusEl) statusEl.textContent = '✗';
        return;
      }

      this.hfInstances.set(table, {
        hf, headers, maxCols, totalRows,
      });

      const statusEl = document.getElementById('formula-bar-status');
      if (statusEl) statusEl.textContent = '✓';

      this.updateTableDisplay(table);
    }

    updateTableDisplay(table) {
      const prevUpdating = this.isUpdating;
      this.isUpdating = true;
      const entry = this.hfInstances.get(table);
      if (!entry) {
        this.isUpdating = prevUpdating;
        return;
      }

      const { hf, headers } = entry;
      const rows = table.querySelectorAll('tr');
      const sheetId = 0;

      rows.forEach((row, ri) => {
        const cells = row.querySelectorAll('td, th');
        cells.forEach((cell, ci) => {
          const formula = cell.getAttribute('data-formula');
          if (formula) {
            let value;
            try {
              value = hf.getCellValue({ sheet: sheetId, row: ri, col: ci });
            } catch(e) {
              value = '#REF!';
            }

            const isError = value !== null && typeof value === 'object';
            const displayText = isError
              ? formula
              : (value != null ? String(value) : '');

            if (cell.textContent !== displayText) {
              console.log('[Formula] Setting cell', ri, ci, 'to', displayText);
              cell.textContent = displayText;
            }
            cell.classList.remove('formula-cell', 'formula-error');
            if (isError) {
              cell.classList.add('formula-error');
            } else if (formula) {
              cell.classList.add('formula-cell');
            }
          } else {
            cell.classList.remove('formula-cell', 'formula-error');
          }
        });
      });
      this.isUpdating = prevUpdating;
    }

    rebuildTable(table) {
      let entry = this.hfInstances.get(table);
      if (!entry) {
        console.log('[Formula] rebuildTable: entry missing, re-initializing');
        this.initTableFormulas(table);
        entry = this.hfInstances.get(table);
        if (!entry) {
          console.log('[Formula] rebuildTable: re-init failed, aborting');
          return;
        }
        return;
      }

      const headers = this.getHeaders(table);
      const data = this.getDataRows(table);
      console.log('[Formula] rebuildTable data:', JSON.stringify(data));
      const totalRows = data.length;
      const maxCols = Math.max(...data.map(r => r.length), 1);

      const resolvedData = data.map((row, ri) => {
        return row.map((cell) => {
          if (typeof cell === 'string' && cell.startsWith('=')) {
            return this.resolveFormula(cell, headers, ri, totalRows);
          }
          return cell;
        });
      });
      for (const row of resolvedData) {
        while (row.length < maxCols) row.push(null);
      }

      try {
        const oldHf = entry.hf;
        const newHf = HyperFormula.buildFromArray(resolvedData, { licenseKey: 'gpl-v3' });
        entry.hf = newHf;
        entry.headers = headers;
        entry.totalRows = totalRows;
        entry.maxCols = maxCols;
        oldHf.destroy();
        this.updateTableDisplay(table);
      } catch(e) {
        console.warn('HyperFormula rebuild failed:', e);
      }
    }

    findCellTable(cell) {
      if (!cell) return null;
      return cell.closest('table');
    }

    showFormulaBar(cell) {
      if (!cell || !this.findCellTable(cell)) return;
      this.activeCell = cell;
      this.activeTable = this.findCellTable(cell);

      const table = this.activeTable;
      const tr = cell.closest('tr');
      const allRows = table.querySelectorAll('tr');
      const allCells = tr ? tr.querySelectorAll('td, th') : [];
      let rowIdx = -1;
      let colIdx = -1;
      if (tr) {
        for (let i = 0; i < allRows.length; i++) {
          if (allRows[i] === tr) { rowIdx = i; break; }
        }
      }
      for (let i = 0; i < allCells.length; i++) {
        if (allCells[i] === cell) { colIdx = i; break; }
      }
      if (rowIdx >= 0 && colIdx >= 0) {
        const colLetter = this.colLetter(colIdx);
        cellRefDisplay.textContent = colLetter + (rowIdx + 1);
      } else {
        cellRefDisplay.textContent = '';
      }

      const formula = cell.getAttribute('data-formula');
      formulaInput.textContent = formula || cell.textContent;

      table.querySelectorAll('td.formula-active-cell, th.formula-active-cell').forEach(el => {
        el.classList.remove('formula-active-cell');
      });
      cell.classList.add('formula-active-cell');

      formulaBar.style.display = '';
    }

    hideFormulaBar() {
      this.activeCell = null;
      this.activeTable = null;
      formulaBar.style.display = 'none';
      formulaInput.textContent = '';
      cellRefDisplay.textContent = '';
    }

    onCellClick(e) {
      const cell = e.target.closest('td, th');
      if (cell && editor.contains(cell) && this.findCellTable(cell)) {
        this.showFormulaBar(cell);
      }
    }

    onFormulaInputChange(skipRebuild = false) {
      if (this.isUpdating || !this.activeCell || !this.activeTable) return;
      const newValue = formulaInput.textContent.trim();
      const cell = this.activeCell;
      const table = this.activeTable;

      this.isUpdating = true;

      if (newValue === '') {
        cell.removeAttribute('data-formula');
        cell.textContent = '';
      } else if (newValue.startsWith('=')) {
        cell.setAttribute('data-formula', newValue);
        cell.textContent = newValue;
      } else {
        cell.removeAttribute('data-formula');
        cell.textContent = newValue;
      }

      if (!skipRebuild) {
        this.rebuildTable(table);
      }
      this.isUpdating = false;
    }

    onEditorInput() {
      if (this.isUpdating) return;
      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        let node = sel.anchorNode;
        if (node) {
          const cell = node.nodeType === 3 ? node.parentNode?.closest('td, th') : node.closest('td, th');
          if (cell && this.findCellTable(cell)) {
            const table = this.findCellTable(cell);
            const text = cell.textContent.trim();
            if (text.startsWith('=')) {
              console.log('[Formula] Detected formula in cell:', text);
              cell.setAttribute('data-formula', text);
            } else {
              const existingFormula = cell.getAttribute('data-formula');
              if (existingFormula) {
                cell.removeAttribute('data-formula');
              }
            }
            if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
            this._rebuildTimer = setTimeout(() => {
              this.rebuildTable(table);
              this._rebuildTimer = null;
            }, 300);
          }
        }
      }
    }

    bindEvents() {
      editor.addEventListener('click', (e) => this.onCellClick(e));

      formulaInput.addEventListener('blur', () => {
        this.onFormulaInputChange(true);
      });

      formulaInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.onFormulaInputChange(false);
        }
      });

      editor.addEventListener('input', () => {
        this.onEditorInput();
      });
    }

    onTableModified() {
      if (this.activeTable && document.contains(this.activeTable)) {
        this.rebuildTable(this.activeTable);
      } else {
        for (const [table] of this.hfInstances) {
          if (document.contains(table)) {
            this.rebuildTable(table);
          } else {
            this.hfInstances.delete(table);
          }
        }
      }
    }
  }

  // ─── Init ──────────────────────────────────────────────────────────────

  (async function init() {
    await loadLanguage();
    applyTranslations();
    loadTabs();
    loadFontConfig();
    initTableColumnResize();
    initElementResizeHandle();

    // Initialize formula engine
    tableFormulaManager = new TableFormulaManager();
    tableFormulaManager.init();
  })();

})();
