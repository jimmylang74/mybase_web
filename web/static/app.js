(function() {
  'use strict';

  let currentTab = null;
  let currentItemId = null;
  let menuTree = [];
  let contentModified = false;
  let activeTabEl = null;
  let treeCtxItemId = null;
  let copiedMenuItem = null;
  let treeExpandedState = {}; // { tabName: Set<nodeId> }
  let dirtyTabs = {}; // { tabName: true/false }
  let lastEditedItem = {}; // { tabName: itemId }
  let kbVisibility = {}; // { tabName: true/false }
  let kbTabNames = []; // full list of all tab names
  let kbTabOwners = {}; // { tabName: owner }
  let kbPublicEdit = {}; // { tabName: true/false } - public edit (discussion mode)
  let unlockedTabs = new Set(); // tab names unlocked in this session
  let canWriteCurrentTab = false;
  let currentSearchQuery = ''; // current search query for highlighting
  let encryptedTabsCache = null; // null = not loaded, array = list of encrypted tab names

  // Auth state
  let currentUser = null; // { username, role } or null
  let authToken = sessionStorage.getItem('kbase_auth_token') || null;

  // Socket.IO for real-time collaboration
  function getSocketOpts() {
    return { query: authToken ? { token: authToken } : {} };
  }
  const socket = io(getSocketOpts());
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
  const sidebarToggle = $('#btn-sidebar-toggle');
  const sidebarBackdrop = $('#sidebar-backdrop');
  const mobileSidebarHint = $('#mobile-sidebar-hint');

  // ─── Mobile viewport height fix ─────────────────────────────────────────
  // Prevents content from being hidden behind mobile browser chrome (URL bar, nav bar)
  function refreshViewportHeight() {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', vh + 'px');
  }
  refreshViewportHeight();
  window.addEventListener('resize', refreshViewportHeight);
  window.addEventListener('orientationchange', function() {
    setTimeout(refreshViewportHeight, 100);
  });

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
      copy: '拷贝',
      paste: '粘贴',
      import_md: '导入Markdown',
      import_md_no_file: '所选文件夹中未找到 .md 文件',
      import_md_select: '选择要导入的Markdown文件',
      import_md_has_images: '该文件引用了以下本地图片，请选择图片所在文件夹：',
      import_md_select_folder: '请点击"确定"后选择包含图片的文件夹（也可跳过，图片将保持原路径）。',
      import_md_uploading: '正在上传图片',
      import_md_done: 'Markdown 导入完成',
      copy_progress: '正在拷贝内容',
      copy_done: '拷贝完成 ✓',
      edit: '编辑',
      custom_style: '定制样式',
      export: '导出',
      delete: '删除',
      close: '隐藏',
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
      italic: '斜体',
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
      password_too_short: '密码不能为空',
      wrong_password: '密码错误',
      unlock_kb: '解锁知识库',
      unlock_prompt: '请输入密码解锁该知识库',
      remove_password_confirm: '确定要解密该知识库吗？',
      encrypted: '已加密',
      login: '用户登录',
      logout: '退出登录',
      username: '用户名:',
      password: '密码:',
      new_password: '新密码:',
      confirm_password: '确认密码:',
      login_success: '登录成功',
      logout_success: '已退出登录',
      current_user: '当前用户:',
      admin_settings: '管理员设置',
      user_management: '用户管理',
      add_user: '增加用户',
      admin_password: '管理员密码:',
      reset_password_for: '重置密码 -',
      password_reset_ok: '密码重置成功',
      set_owner: '设置Owner',
      owner: 'Owner:',
      download_failed: '下载失败',
      insert_column: '插入列',
      insert_row: '插入行',
      delete_column: '删除列',
      delete_row: '删除行',
      clear_bgcolor: '清除背景颜色 (设为透明)',
      choose_color: '选择颜色',
      quick_colors: '常用颜色',
      custom_color: '自定义颜色...',
      cell_format: '设置单元格格式',
      cell_format_title: '设置单元格格式',
      enable_public_edit: '解锁可编辑',
      disable_public_edit: '加锁不可编辑',
      public_edit_tab: '讨论区 - 任何人可编辑',
      vertical_align: '垂直对齐:',
      horizontal_align: '水平对齐:',
      align_top: '顶部',
      align_middle: '居中',
      align_bottom: '底部',
      align_left: '左对齐',
      align_center: '居中',
      align_right: '右对齐',
      font_family: '字体',
      font_color: '字体颜色',
      remove_format: '清除格式',
      insert_table: '插入表格',
      insert_mermaid: '插入Mermaid图表',
      save_as_png: '保存为PNG...',
      edit_link: '编辑Link',
      insert_link: '插入链接',
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
      copy: 'Copy',
      paste: 'Paste',
      import_md: 'Import Markdown',
      import_md_no_file: 'No .md file found in selected folder',
      import_md_select: 'Select Markdown file to import',
      import_md_has_images: 'This file references the following local images. Please select the folder containing them:',
      import_md_select_folder: 'Click "OK" then choose the image folder (or cancel to skip image upload).',
      import_md_uploading: 'Uploading images',
      import_md_done: 'Markdown import complete',
      copy_progress: 'Copying content',
      copy_done: 'Copy complete ✓',
      edit: 'Edit',
      custom_style: 'Custom Style',
      export: 'Export',
      delete: 'Delete',
      close: 'Hide',
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
      italic: 'Italic',
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
      password_too_short: 'Password cannot be empty',
      wrong_password: 'Incorrect password',
      unlock_kb: 'Unlock Knowledge Base',
      unlock_prompt: 'Enter password to unlock this knowledge base',
      remove_password_confirm: 'Are you sure you want to remove password protection?',
      encrypted: 'Encrypted',
      login: 'Login',
      logout: 'Logout',
      username: 'Username:',
      password: 'Password:',
      new_password: 'New Password:',
      confirm_password: 'Confirm Password:',
      login_success: 'Login successful',
      logout_success: 'Logged out',
      current_user: 'Current User:',
      admin_settings: 'Admin Settings',
      user_management: 'User Management',
      add_user: 'Add User',
      admin_password: 'Admin Password:',
      reset_password_for: 'Reset password for',
      password_reset_ok: 'Password reset successful',
      set_owner: 'Set Owner',
      owner: 'Owner:',
      download_failed: 'Download failed',
      insert_column: 'Insert Column',
      insert_row: 'Insert Row',
      delete_column: 'Delete Column',
      delete_row: 'Delete Row',
      clear_bgcolor: 'Clear Background Color (Transparent)',
      choose_color: 'Choose Color',
      quick_colors: 'Quick Colors',
      custom_color: 'Custom Color...',
      cell_format: 'Cell Format',
      cell_format_title: 'Set Cell Format',
      enable_public_edit: 'Unlock Editable',
      disable_public_edit: 'Lock Not Editable',
      public_edit_tab: 'Discussion - Anyone can edit',
      vertical_align: 'Vertical Align:',
      horizontal_align: 'Horizontal Align:',
      align_top: 'Top',
      align_middle: 'Middle',
      align_bottom: 'Bottom',
      align_left: 'Left',
      align_center: 'Center',
      align_right: 'Right',
      font_family: 'Font Family',
      font_color: 'Font Color',
      remove_format: 'Remove Format',
      insert_table: 'Insert Table',
      insert_mermaid: 'Insert Mermaid Chart',
      save_as_png: 'Save As PNG...',
      edit_link: 'Edit Link',
      insert_link: 'Insert Link',
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
    if (authToken) {
      opts.headers['X-Auth-Token'] = authToken;
    }
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) {
        authToken = null;
        currentUser = null;
        sessionStorage.removeItem('kbase_auth_token');
        updateUserIndicator();
        // Don't auto-redirect - let the user re-login when they need to
      }
      const err = new Error(data.error || 'API Error');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function apiUpload(url, file) {
    const formData = new FormData();
    formData.append('image', file);
    const headers = {};
    if (authToken) {
      headers['X-Auth-Token'] = authToken;
    }
    const opts = { method: 'POST', body: formData, headers };
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload Error');
    return data;
  }

  async function apiUploadFile(url, file, filename) {
    const formData = new FormData();
    formData.append('file', file, filename);
    const headers = {};
    if (authToken) {
      headers['X-Auth-Token'] = authToken;
    }
    const opts = { method: 'POST', body: formData, headers };
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload Error');
    return data;
  }

  // ─── Auth ────────────────────────────────────────────────────────────────

  function updateUserIndicator() {
    const btn = $('#btn-login');
    const indicator = $('#user-indicator');
    if (currentUser) {
      indicator.textContent = currentUser.username;
      indicator.style.display = '';
      if (typeof singleUserMode !== 'undefined' && singleUserMode) {
        btn.style.display = 'none';
      } else {
        btn.style.display = '';
        btn.textContent = t('logout');
        btn.title = t('logout');
        btn.classList.add('logged-in');
      }
    } else {
      indicator.style.display = 'none';
      btn.style.display = '';
      btn.textContent = '🔑';
      btn.title = t('login');
      btn.classList.remove('logged-in');
    }
  }



  function updateToolbarButtons() {
    // Backup button: admin only
    const backupBtn = $('#btn-backup');
    if (backupBtn) {
      backupBtn.style.display = (currentUser && currentUser.role === 'admin') ? 'inline-flex' : 'none';
    }
    // Save / New Tab / 知识库选择器: hide for anonymous users
    const isLoggedIn = !!currentUser;
    const saveBtn = $('#btn-save');
    if (saveBtn) saveBtn.style.display = isLoggedIn ? '' : 'none';
    const newTabBtn = $('#btn-new-tab');
    if (newTabBtn) newTabBtn.style.display = isLoggedIn ? '' : 'none';
    const kbSelector = document.querySelector('.kb-selector-wrap');
    if (kbSelector) kbSelector.style.display = isLoggedIn ? '' : 'none';
  }

  async function checkAuth() {
    if (typeof singleUserMode !== 'undefined' && singleUserMode) {
      currentUser = { username: 'admin', role: 'admin' };
      authToken = 'single-user';
      updateUserIndicator();
      updateToolbarButtons();
      return;
    }
    if (!authToken) {
      updateToolbarButtons();
      return;
    }
    try {
      const data = await api('GET', '/api/auth/me');
      currentUser = data.user;
      sessionStorage.setItem('kbase_auth_token', authToken);
    } catch (e) {
      authToken = null;
      currentUser = null;
      sessionStorage.removeItem('kbase_auth_token');
    }
    updateUserIndicator();
    updateToolbarButtons();
  }

  async function doLogin(username, password) {
    const data = await api('POST', '/api/auth/login', { username, password });
    authToken = data.token;
    currentUser = data.user;
    sessionStorage.setItem('kbase_auth_token', authToken);
    updateUserIndicator();
    // Clear encryption state — user context changed, re-prompt needed
    unlockedTabs.clear();
    encryptedTabsCache = null;
    // Reconnect socket with auth token
    if (socket.connected) socket.disconnect();
    socket.io.opts.query = { token: authToken };
    socket.connect();
    return data;
  }

  function doLogout() {
    if (authToken) {
      api('POST', '/api/auth/logout').catch(() => {});
      authToken = null;
      currentUser = null;
      sessionStorage.removeItem('kbase_auth_token');
    }
    // Clear encryption state — user context changed, re-prompt needed
    unlockedTabs.clear();
    encryptedTabsCache = null;
    $('#user-indicator').style.display = 'none';
    $('#btn-login').textContent = '🔑';
    $('#btn-login').title = t('login');
    $('#btn-login').classList.remove('logged-in');
    updateToolbarButtons();
    // Reconnect socket without auth
    if (socket.connected) socket.disconnect();
    socket.io.opts.query = {};
    socket.connect();
  }

  function showLoginDialog() {
    $('#login-username').value = '';
    $('#login-password').value = '';
    $('#login-error').style.display = 'none';
    $('#login-dialog').style.display = 'flex';
    $('#login-username').focus();
  }

  function hideLoginDialog() {
    $('#login-dialog').style.display = 'none';
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
      if (currentTab && currentItemId && canWriteCurrentTab) {
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
      if (tableFormulaManager) {
        tableFormulaManager.refresh();
      }
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
      if (tableFormulaManager) {
        tableFormulaManager.refresh();
      }
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

  // Admin deleted our user → force logout
  socket.on('force_logout', (data) => {
    doLogout();
    showDialog(t('logout_success') || '已退出登录', `<p>${escapeHtml(data.reason || 'Your session has expired')}</p>`);
    loadTabs();
  });

  // Tab ownership changed (e.g. user deleted by admin) → refresh tabs
  socket.on('tabs_updated', () => {
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
      if (currentUser && currentUser.role !== 'admin') {
        const data = names.map((name, i) => ({
          tab_name: name,
          visible: 1,
          is_active: name === currentTab ? 1 : 0
        }));
        await api('PUT', '/api/user-tab-order', data);
      } else {
        await api('PUT', '/api/tab-order', names);
      }
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
    if (!currentUser) return;
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
    // Load owner map for badge rendering and public edit status
    try {
      const ownerData = await api('GET', '/api/tabs-with-owner');
      kbTabOwners = {};
      kbPublicEdit = {};
      ownerData.forEach((t) => {
        kbTabOwners[t.name] = t.owner || '';
        kbPublicEdit[t.name] = !!t.public_edit;
      });
    } catch (e) {
      kbTabOwners = {};
      kbPublicEdit = {};
    }
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
    // Use per-user API when logged in to avoid cross-user interference,
    // fall back to the legacy global table for anonymous sessions.
    try {
      const currentItemsUrl = authToken ? '/api/user-tab-current-items' : '/api/tab-current-items';
      const savedItems = await api('GET', currentItemsUrl);
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
      const owner = kbTabOwners[name];
      if (owner !== undefined) {
        const badge = document.createElement('span');
        badge.className = 'tab-owner-badge' + (owner && owner !== '' ? ' badge-u' : ' badge-a');
        badge.textContent = owner && owner !== '' ? 'U' : 'A';
        el.appendChild(badge);
      }
      // Public edit (discussion mode) badge
      if (kbPublicEdit[name]) {
        const pubBadge = document.createElement('span');
        pubBadge.className = 'tab-public-edit-badge';
        pubBadge.textContent = 'M';
        pubBadge.title = t('public_edit_tab');
        el.appendChild(pubBadge);
      }
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
      attachLongPress(el, function(touch) {
        showTabContextMenu(touch, name);
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

  function canEditTab(tabName) {
    if (!currentUser) return false;
    if (currentUser.role === 'admin') return true;
    const owner = kbTabOwners[tabName];
    if (owner === currentUser.username) return true;
    // Public edit (discussion mode): any authenticated user can edit
    if (kbPublicEdit[tabName]) return true;
    return false;
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

    canWriteCurrentTab = canEditTab(name);
    if (!canWriteCurrentTab) {
      editor.contentEditable = 'false';
      editor.style.opacity = '0.7';
      editorStatus.textContent = `[Read Only] - ${name}`;
    } else {
      editor.contentEditable = 'true';
      editor.style.opacity = '1';
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
      // Persist the selected tab even when there is no item to select
      if (authToken && currentTab) {
        api('PUT', '/api/user-tab-current-item', { tab_name: currentTab, current_item_id: '' }).catch(() => {});
      }
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
    if (item.mtime) {
      const mtimeSpan = document.createElement('span');
      mtimeSpan.className = 'mtime';
      mtimeSpan.textContent = item.mtime;
      header.appendChild(mtimeSpan);
    }
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
    attachLongPress(header, function(touch) {
      showTreeContextMenu(touch, item.id);
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
    // Scroll the node to the center of the container
    const nodeEl = treeContainer.querySelector(`.tree-node[data-id="${nodeId}"]`);
    if (nodeEl) {
      const containerRect = treeContainer.getBoundingClientRect();
      const nodeRect = nodeEl.getBoundingClientRect();
      const offset = nodeRect.top - containerRect.top - (containerRect.height - nodeRect.height) / 2;
      treeContainer.scrollTop += offset;
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
      if (canWriteCurrentTab) {
        tryLockDocument(currentTab, id);
      }
      joinDocumentRoom(currentTab, id);
    }

    lastEditedItem[currentTab] = id;
    contentModified = false;

    // Persist reading position to server (fire-and-forget)
    // Use per-user endpoint when logged in to isolate positions per user.
    if (currentTab) {
      const url = authToken ? '/api/user-tab-current-item' : '/api/tab-current-item';
      api('PUT', url, { tab_name: currentTab, current_item_id: id }).catch(() => {});
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
      if (!inlineEditInput && canWriteCurrentTab) {
        editor.focus();
        document.execCommand('fontSize', false, $('#font-size').value);
      }
    }
    if (tableFormulaManager) {
      tableFormulaManager.refresh();
    }
    applySearchHighlights();
    renderMermaidDiagrams();
    isRemoteUpdate = false;
    const item = findNodeById(menuTree, itemId);
      editorStatus.textContent = canWriteCurrentTab
        ? `Editing: ${item ? item.label : 'Unknown'}`
        : `[Read Only] - ${item ? item.label : 'Unknown'}`;
    } catch (e) {
      editor.innerHTML = '<p>Error loading content</p>';
      editorStatus.textContent = 'Error loading content';
    }
  }

  function convertFontSizesToInline(html) {
    // Convert ALL <font> tags to <span style="..."> so tags always pair correctly.
    // document.execCommand('foreColor') produces <font color="..."> without size,
    // and the old code only converted <font>→<span> when size was present, causing
    // unclosed <font> tags that leaked formatting to subsequent text after save.
    html = html.replace(/<font\b([^>]*)>/gi, (match, attrs) => {
      const styles = [];
      const sizeMatch = attrs.match(/\s+size\s*=\s*["'](\d+)["']/i);
      if (sizeMatch) {
        const px = FONT_SIZE_MAP[sizeMatch[1]];
        if (px) styles.push(`font-size: ${px}`);
      }
      const colorMatch = attrs.match(/\s+color\s*=\s*["']([^"']*)["']/i);
      if (colorMatch) styles.push(`color: ${colorMatch[1]}`);
      const faceMatch = attrs.match(/\s+face\s*=\s*["']([^"']*)["']/i);
      if (faceMatch) styles.push(`font-family: ${faceMatch[1]}`);
      if (styles.length === 0) return '<span>';
      return `<span style="${styles.join('; ')}">`;
    });
    html = html.replace(/<\/font\s*>/gi, '</span>');
    return html;
  }

  async function saveContent(itemId) {
    if (!currentTab || !itemId) return;
    if (!canWriteCurrentTab) return;
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

  async function togglePublicEdit(name) {
    const newStatus = !kbPublicEdit[name];
    try {
      await api('PUT', `/api/tabs/${encodeURIComponent(name)}/public-edit`, { public_edit: newStatus });
      kbPublicEdit[name] = newStatus;
      // Reload tabs to update UI (badges, context menu text)
      await loadTabs();
      // Re-activate current tab so canWriteCurrentTab is recalculated
      if (currentTab) {
        const el = tabsEl.querySelector(`.tab[data-tab="${CSS.escape(currentTab)}"]`);
        if (el) {
          await switchTab(currentTab, el);
        }
      }
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
      const owner = kbTabOwners[name];
      if (owner !== undefined) {
        const badge = document.createElement('span');
        badge.className = 'kb-owner-badge' + (owner && owner !== '' ? ' badge-u' : ' badge-a');
        badge.textContent = owner && owner !== '' ? owner : 'A';
        item.appendChild(badge);
      }
      const label = document.createElement('span');
      label.className = 'kb-item-label';
      label.textContent = name;
      item.appendChild(subCb);
      item.appendChild(label);
      // Permission: admin can toggle any tab; user can toggle own tabs; anonymous cannot toggle
      const canToggle = currentUser && (
        currentUser.role === 'admin' || owner === currentUser.username
      );
      if (!canToggle) {
        subCb.disabled = true;
        item.style.opacity = '0.6';
        item.style.cursor = 'default';
      }
      item.addEventListener('click', (e) => {
        if (!canToggle) return;
        if (e.target === subCb) return;
        subCb.checked = !subCb.checked;
        onKbItemToggle(name, subCb.checked);
      });
      subCb.addEventListener('change', () => {
        if (!canToggle) return;
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
      // Only toggle tabs the user has permission to hide
      const owner = kbTabOwners[name];
      const canToggle = currentUser && (
        currentUser.role === 'admin' || owner === currentUser.username
      );
      if (canToggle) {
        kbVisibility[name] = newState;
      }
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
          if (password.length < 1) {
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

  function promptInsertLink(existingLink) {
    if (existingLink) {
      showDialog(
        t('edit_link'),
        '<label>URL:</label><input type="text" id="dialog-link-url" placeholder="https://..."><label>Text:</label><input type="text" id="dialog-link-text" placeholder="Link text">',
        () => {
          const url = $('#dialog-link-url').value.trim();
          const text = $('#dialog-link-text').value.trim();
          if (!url) return true;
          existingLink.href = url;
          existingLink.target = '_blank';
          if (text) existingLink.textContent = text;
          markModified();
          return true;
        }
      );
      $('#dialog-link-url').value = existingLink.href || '';
      $('#dialog-link-text').value = existingLink.textContent || '';
      return;
    }

    // Save selection before dialog steals focus
    const savedRange = (() => {
      const sel = window.getSelection();
      if (sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
        return sel.getRangeAt(0).cloneRange();
      }
      return null;
    })();

    showDialog(
      t('insert_link'),
      '<label>URL:</label><input type="text" id="dialog-link-url" placeholder="https://..."><label>Text:</label><input type="text" id="dialog-link-text" placeholder="Link text">',
      () => {
        const url = $('#dialog-link-url').value.trim();
        const text = $('#dialog-link-text').value.trim();
        if (!url) return true;
        const scrollPos = editor.scrollTop;
        editor.focus();
        editor.scrollTop = scrollPos;

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
        const scrollPos = editor.scrollTop;
        editor.focus();
        editor.scrollTop = scrollPos;

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
  let tableColResizeCell = null;

  function clearColResizeCell() {
    if (tableColResizeCell) {
      tableColResizeCell.style.cursor = '';
      tableColResizeCell.classList.remove('col-resize-active');
      tableColResizeCell = null;
    }
  }

  function initTableColumnResize() {
    editor.addEventListener('mousemove', function(e) {
      if (tableColResize) return;
      if (editor._resizeInfo) {
        editor._resizeInfo = null;
        editor.style.cursor = '';
        clearColResizeCell();
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
          cells[i].style.cursor = 'col-resize';
          cells[i].classList.add('col-resize-active');
          tableColResizeCell = cells[i];
          editor._resizeInfo = { table, colIndex: i };
          return;
        }
      }
    });

    editor.addEventListener('mouseleave', function() {
      if (!tableColResize) {
        editor.style.cursor = '';
        editor._resizeInfo = null;
        clearColResizeCell();
      }
    });

    editor.addEventListener('mousedown', function(e) {
      if (editor._resizeInfo) {
        e.preventDefault();
        clearColResizeCell();
        const { table, colIndex } = editor._resizeInfo;
        let cols = table.querySelectorAll('col');
        // If <col> elements were stripped (e.g. by browser copy-paste),
        // dynamically create them based on current cell widths
        if (!cols.length) {
          const cells = table.querySelectorAll('tr:first-child > td, tr:first-child > th');
          if (cells.length) {
            const colgroup = document.createElement('colgroup');
            cells.forEach((cell) => {
              const col = document.createElement('col');
              col.style.width = Math.round(cell.getBoundingClientRect().width) + 'px';
              colgroup.appendChild(col);
            });
            table.insertBefore(colgroup, table.firstChild);
            cols = colgroup.querySelectorAll('col');
          }
        }
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
      clearColResizeCell();
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
    // Intercept dropdown navigation when dropdown is visible
    if (tableFormulaManager && tableFormulaManager._dropdownItems && tableFormulaManager._dropdownItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        tableFormulaManager._navigateDropdown(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        tableFormulaManager._navigateDropdown(-1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        tableFormulaManager._applyFormulaDropdown();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        tableFormulaManager._hideFormulaDropdown();
        return;
      }
    }
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
    // Populate user section
    if (currentUser) {
      $('#settings-current-user').textContent = currentUser.username;
      if (typeof singleUserMode !== 'undefined' && singleUserMode) {
        // Single-user mode: hide password/ logout / user management UI
        $('#settings-user-section').style.display = 'none';
        $('#settings-admin-section').style.display = 'none';
      } else {
        $('#settings-user-section').style.display = '';
        if (currentUser.role === 'admin') {
          $('#settings-admin-section').style.display = '';
          loadUserList();
        } else {
          $('#settings-admin-section').style.display = 'none';
        }
      }
    } else {
      $('#settings-user-section').style.display = 'none';
      $('#settings-admin-section').style.display = 'none';
    }
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

  // ─── Login Dialog ─────────────────────────────────────────────────────

  $('#btn-login').addEventListener('click', () => {
    if (currentUser) {
      doLogout();
      applyTranslations();
    } else {
      showLoginDialog();
    }
  });

  $('#login-btn-ok').addEventListener('click', async () => {
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    if (!username || !password) {
      $('#login-error').textContent = 'Please enter username and password';
      $('#login-error').style.display = '';
      return;
    }
    try {
      await doLogin(username, password);
      hideLoginDialog();
      applyTranslations();
      // Re-check auth and reload tabs for user-specific visibility
      await checkAuth();
      await loadTabs();
    } catch (e) {
      $('#login-error').textContent = e.message || 'Login failed';
      $('#login-error').style.display = '';
    }
  });

  $('#login-btn-cancel').addEventListener('click', hideLoginDialog);

  // Close login dialog on overlay click
  $('#login-dialog').addEventListener('click', (e) => {
    if (e.target === $('#login-dialog')) {
      hideLoginDialog();
    }
  });

  // Enter key in login password field
  $('#login-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#login-btn-ok').click();
  });
  $('#login-username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#login-password').focus();
  });

  // ─── Change Password Dialog ───────────────────────────────────────────

  function showChangePasswordDialog(username) {
    $('#change-pw-input').value = '';
    $('#change-pw-confirm').value = '';
    $('#change-pw-error').style.display = 'none';
    const header = $('#change-password-dialog-header');
    if (username) {
      header.textContent = t('reset_password_for') + ' ' + username;
      header.dataset.resetUser = username;
    } else {
      header.textContent = t('change_password');
      delete header.dataset.resetUser;
    }
    $('#change-password-dialog').style.display = 'flex';
    $('#change-pw-input').focus();
  }

  function hideChangePasswordDialog() {
    $('#change-password-dialog').style.display = 'none';
  }

  $('#settings-btn-change-pw').addEventListener('click', () => showChangePasswordDialog());

  $('#change-pw-btn-ok').addEventListener('click', async () => {
    const pw = $('#change-pw-input').value;
    const confirm = $('#change-pw-confirm').value;
    if (pw.length < 1) {
      $('#change-pw-error').textContent = t('password_too_short');
      $('#change-pw-error').style.display = '';
      return;
    }
    if (pw !== confirm) {
      $('#change-pw-error').textContent = t('password_mismatch');
      $('#change-pw-error').style.display = '';
      return;
    }
    try {
      const resetUser = $('#change-password-dialog-header').dataset.resetUser;
      if (resetUser) {
        await api('PUT', `/api/admin/users/${encodeURIComponent(resetUser)}/reset-password`, { new_password: pw });
        showSettingsMsg(t('password_reset_ok'), 'success');
      } else if (currentUser && currentUser.role === 'admin') {
        await api('PUT', '/api/admin/change-password', { new_password: pw });
      } else {
        await api('PUT', '/api/auth/change-password', { new_password: pw });
      }
      hideChangePasswordDialog();
    } catch (e) {
      $('#change-pw-error').textContent = e.message || 'Password change failed';
      $('#change-pw-error').style.display = '';
    }
  });

  $('#change-pw-btn-cancel').addEventListener('click', hideChangePasswordDialog);

  $('#change-password-dialog').addEventListener('click', (e) => {
    if (e.target === $('#change-password-dialog')) {
      hideChangePasswordDialog();
    }
  });

  $('#change-pw-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#change-pw-confirm').focus();
  });
  $('#change-pw-confirm').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#change-pw-btn-ok').click();
  });

  // ─── Logout Button in Settings ────────────────────────────────────────

  $('#settings-btn-logout').addEventListener('click', () => {
    doLogout();
    closeSettings();
    applyTranslations();
    loadTabs();
  });

  // ─── User Management (Admin) ──────────────────────────────────────────

  async function loadUserList() {
    const container = $('#settings-user-list');
    if (!container) return;
    try {
      const data = await api('GET', '/api/admin/users');
      if (!Array.isArray(data)) return;
      container.innerHTML = '';
      data.forEach((u) => {
        if (u.username === currentUser.username) return; // skip self
        const row = document.createElement('div');
        row.className = 'settings-user-row';
        row.innerHTML = `
          <span class="settings-user-name">${escapeHtml(u.username)}</span>
          <span class="settings-user-role">${escapeHtml(u.role || 'user')}</span>
          <button class="style-btn settings-user-reset-pw" data-username="${escapeHtml(u.username)}" data-i18n="change_password">修改密码</button>
          <button class="style-btn settings-user-delete" data-username="${escapeHtml(u.username)}">✕</button>
        `;
        container.appendChild(row);
      });
      // Bind reset password buttons
      container.querySelectorAll('.settings-user-reset-pw').forEach((btn) => {
        btn.addEventListener('click', () => {
          showChangePasswordDialog(btn.dataset.username);
        });
      });
      // Bind delete buttons
      container.querySelectorAll('.settings-user-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const username = btn.dataset.username;
          const confirmed = await showDialog(t('delete') || 'Delete', `Delete user "<b>${escapeHtml(username)}</b>"?<br><br>Their KBs will be moved to admin.`);
          if (!confirmed) return;
          try {
            await api('DELETE', `/api/admin/users/${encodeURIComponent(username)}`);
            await loadUserList();
            await loadTabs();
            showSettingsMsg(`User ${username} deleted`, 'success');
          } catch (e) {
            showSettingsMsg(e.message, 'error');
          }
        });
      });
    } catch (e) {
      // non-critical
    }
  }

  function showSettingsMsg(msg, type) {
    const el = $('#settings-user-msg');
    if (!el) return;
    el.textContent = msg;
    el.style.color = type === 'error' ? '#e74c3c' : '#27ae60';
    el.style.display = '';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  $('#settings-btn-add-user').addEventListener('click', async () => {
    const username = $('#settings-new-username').value.trim();
    const password = $('#settings-new-password').value;
    if (!username || !password) {
      showSettingsMsg('Please enter username and password', 'error');
      return;
    }
    if (password.length < 1) {
      showSettingsMsg('Password cannot be empty', 'error');
      return;
    }
    try {
      await api('POST', '/api/admin/users', { username, password });
      $('#settings-new-username').value = '';
      $('#settings-new-password').value = '';
      await loadUserList();
      showSettingsMsg(`User ${username} created`, 'success');
    } catch (e) {
      showSettingsMsg(e.message, 'error');
    }
  });

  // ─── Owner Dialog ─────────────────────────────────────────────────────

  async function showOwnerDialog(tabName) {
    try {
      const usersData = await api('GET', '/api/admin/users');
      const ownerData = await api('GET', `/api/tab-owner/${encodeURIComponent(tabName)}`);
      const select = $('#owner-select');
      select.innerHTML = '<option value="">(admin - all users can read)</option>';
      (usersData || []).forEach((u) => {
        const opt = document.createElement('option');
        opt.value = u.username;
        opt.textContent = u.username;
        if (u.username === ownerData.owner) opt.selected = true;
        select.appendChild(opt);
      });
      $('#owner-dialog').style.display = 'flex';
      // Store the tab name for the ok handler
      $('#owner-dialog').dataset.tab = tabName;
    } catch (e) {
      // non-critical
    }
  }

  function hideOwnerDialog() {
    $('#owner-dialog').style.display = 'none';
  }

  $('#owner-btn-ok').addEventListener('click', async () => {
    const tabName = $('#owner-dialog').dataset.tab;
    const owner = $('#owner-select').value;
    if (!tabName) return;
    try {
      await api('PUT', `/api/tab-owner/${encodeURIComponent(tabName)}`, { owner });
      hideOwnerDialog();
      await loadTabs();
    } catch (e) {
      // non-critical
    }
  });

  $('#owner-btn-cancel').addEventListener('click', hideOwnerDialog);

  $('#owner-dialog').addEventListener('click', (e) => {
    if (e.target === $('#owner-dialog')) hideOwnerDialog();
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
    $('#dialog-cancel').onclick = () => { overlay.style.display = 'none'; };
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
            a.href = `/api/backup/download/${task_id}?token=${encodeURIComponent(authToken || '')}`;
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

  // ─── Mobile long-press → context menu ──────────────────────────────────
  // On touch devices, a 500ms hold simulates right-click.
  // We suppress native text selection by temporarily disabling user-select
  // on the body when long-press fires, then restoring it on release.
  function attachLongPress(el, onLongPress) {
    var timer = null;
    var startX = 0, startY = 0;
    var fired = false;
    var threshold = 10;
    var delay = 500;

    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    }

    function restoreBodySelect() {
      document.body.style.webkitUserSelect = '';
      document.body.style.userSelect = '';
    }

    el.addEventListener('touchstart', function(e) {
      fired = false;
      var t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      timer = setTimeout(function() {
        timer = null;
        fired = true;
        // Forcibly stop any in-progress text selection by disabling
        // selection at the body level while the context menu is shown
        document.body.style.webkitUserSelect = 'none';
        document.body.style.userSelect = 'none';
        window.getSelection().removeAllRanges();
        if (navigator.vibrate) navigator.vibrate(15);
        onLongPress({ clientX: startX, clientY: startY });
      }, delay);
    }, { passive: true });

    el.addEventListener('touchmove', function(e) {
      if (timer) {
        var t = e.touches[0];
        if (Math.abs(t.clientX - startX) > threshold || Math.abs(t.clientY - startY) > threshold) {
          cancel();
        }
      }
    }, { passive: true });

    el.addEventListener('touchend', function(e) {
      if (fired) {
        e.preventDefault();
        e.stopPropagation();
        fired = false;
        // Restore selection on next tick so the context menu stays functional
        setTimeout(restoreBodySelect, 0);
      }
      cancel();
    });

    el.addEventListener('touchcancel', function() {
      if (fired) fired = false;
      cancel();
      restoreBodySelect();
    });
  }

  // ─── Tree Right-Click Context Menu ─────────────────────────────────────

  function showTreeContextMenu(e, itemId) {
    treeCtxItemId = itemId;
    positionMenuAtEvent(treeCtxMenu, e);
    // Clear stale disabled state from previous invocations
    treeCtxMenu.querySelectorAll('.tree-ctx-item, .ctx-submenu-item').forEach(function(el) {
      el.classList.remove('ctx-menu-disabled');
    });
    // Disable export for users without permission
    const treeExportItems = treeCtxMenu.querySelectorAll('.ctx-submenu-item');
    const canExport = currentUser && (currentUser.role === 'admin' || (currentTab && kbTabOwners[currentTab] === currentUser.username) || (currentTab && kbPublicEdit[currentTab]));
    treeExportItems.forEach((item) => {
      if (!canExport) {
        item.classList.add('ctx-menu-disabled');
      } else {
        item.classList.remove('ctx-menu-disabled');
      }
    });
    // Copy: any logged-in user can copy (read access is already checked)
    const copyItem = treeCtxMenu.querySelector('[data-action="copy"]');
    if (copyItem) {
      if (!currentUser) {
        copyItem.classList.add('ctx-menu-disabled');
      } else {
        copyItem.classList.remove('ctx-menu-disabled');
      }
    }
    // Paste: needs write permission + copied data
    const pasteItem = treeCtxMenu.querySelector('[data-action="paste"]');
    if (pasteItem) {
      var canPaste = currentUser && canEditTab(currentTab) && copiedMenuItem;
      if (!canPaste) {
        pasteItem.classList.add('ctx-menu-disabled');
      } else {
        pasteItem.classList.remove('ctx-menu-disabled');
      }
    }
    // Read-only (admin's tab for regular user): disable all write items, only copy stays
    if (!canEditTab(currentTab)) {
      treeCtxMenu.querySelectorAll('.tree-ctx-item').forEach(function(item) {
        if (item.dataset.action !== 'copy') item.classList.add('ctx-menu-disabled');
      });
    }
  }

  $$('#tree-context-menu .tree-ctx-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (item.classList.contains('ctx-menu-disabled')) return;
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
        case 'copy': {
          const node = findNodeById(menuTree, id);
          if (node && currentTab) {
            function cloneNode(src) {
              const c = { id: src.id, label: src.label, children: [] };
              if (src.style) c.style = Object.assign({}, src.style);
              (src.children || []).forEach(function(ch) { c.children.push(cloneNode(ch)); });
              return c;
            }
            const cloned = cloneNode(node);
            copiedMenuItem = { item: cloned, contents: {} };
            (async function() {
              const allIds = [];
              function collectIds(n) { allIds.push(n.id); (n.children || []).forEach(collectIds); }
              collectIds(cloned);
              var total = allIds.length;
              var done = 0;
              var progressEl = $('#copy-progress');
              if (progressEl) {
                progressEl.textContent = t('copy_progress') + ' 0/' + total;
                progressEl.style.display = '';
              }
              var results = [];
              for (var i = 0; i < allIds.length; i++) {
                try {
                  var data = await api('GET', '/api/' + encodeURIComponent(currentTab) + '/content/' + allIds[i]);
                  results.push({ id: allIds[i], content: data.content || '' });
                } catch (e) {
                  results.push({ id: allIds[i], content: '' });
                }
                done++;
                if (progressEl) {
                  progressEl.textContent = t('copy_progress') + ' ' + done + '/' + total;
                }
              }
              var contents = {};
              results.forEach(function(r) { if (r.content) contents[r.id] = r.content; });
              copiedMenuItem.contents = contents;
              if (progressEl) {
                progressEl.textContent = t('copy_done');
                setTimeout(function() { progressEl.style.display = 'none'; }, 1500);
              }
            })();
          }
          break;
        }
        case 'paste': {
          if (!copiedMenuItem || !currentTab) break;
          (async function() {
            try {
              var payload = {
                item: copiedMenuItem.item,
                after_id: id,
                contents: copiedMenuItem.contents || {}
              };
              var result = await api('POST', '/api/' + encodeURIComponent(currentTab) + '/menu/paste', payload);
              await reloadMenu();
              var newId = result.id;
              if (newId) {
                scrollToTreeNode(newId);
                selectItem(newId);
              }
            } catch (e) {
              showDialog('Error', '<p>' + escapeHtml(e.message) + '</p>');
            }
          })();
          break;
        }
        case 'import-md': {
          (async function() {
            var selectedMd = await new Promise(function(resolve) {
              var input = document.createElement('input');
              input.type = 'file';
              input.accept = '.md,.markdown';
              input.onchange = function() { resolve(input.files[0] || null); };
              input.oncancel = function() { resolve(null); };
              input.click();
            });
            if (!selectedMd) return;

            var mdText = await selectedMd.text();
            var label = selectedMd.name.replace(/\.(md|markdown)$/i, '');

            var imgRefs = [];
            var imgRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
            var m;
            while ((m = imgRegex.exec(mdText)) !== null) imgRefs.push(m[1]);
            var htmlImgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
            while ((m = htmlImgRegex.exec(mdText)) !== null) imgRefs.push(m[1]);

            var localRefs = imgRefs.filter(function(p) {
              return !p.startsWith('http://') && !p.startsWith('https://') &&
                     !p.startsWith('data:') && !p.startsWith('//');
            });
            localRefs = localRefs.filter(function(v, i, a) { return a.indexOf(v) === i; });

            var pathMap = {};
            if (localRefs.length > 0) {
              var proceed = await new Promise(function(resolve) {
                var listHtml = '<p>' + t('import_md_has_images') + '</p><ul style="max-height:120px;overflow-y:auto;margin:8px 0;padding-left:20px">';
                localRefs.forEach(function(ref) {
                  listHtml += '<li style="font-size:12px;color:#666;word-break:break-all">' + escapeHtml(ref) + '</li>';
                });
                listHtml += '</ul><p>' + t('import_md_select_folder') + '</p>';
                showDialog(t('import_md'), listHtml, function() { return true; }).then(function(r) { resolve(r); });
              });
              if (!proceed) return;

              var folderFiles = await new Promise(function(resolve) {
                var input = document.createElement('input');
                input.type = 'file';
                input.webkitdirectory = true;
                input.multiple = true;
                input.onchange = function() { resolve(Array.from(input.files)); };
                input.oncancel = function() { resolve([]); };
                input.click();
              });

              if (folderFiles.length > 0) {
                var fileMap = {};
                folderFiles.forEach(function(f) {
                  var rel = f.webkitRelativePath || f.name;
                  var parts = rel.split('/');
                  if (parts.length > 1) parts.shift();
                  var key = parts.join('/');
                  fileMap[key] = f;
                  fileMap[f.name] = f;
                });

                var toUpload = [];
                localRefs.forEach(function(ref) {
                  var cleanRef = ref.replace(/^\.\//, '');
                  var candidates = [cleanRef, cleanRef.split('/').pop()];
                  for (var ci = 0; ci < candidates.length; ci++) {
                    if (fileMap[candidates[ci]]) {
                      toUpload.push({ ref: ref, file: fileMap[candidates[ci]] });
                      break;
                    }
                  }
                });

                for (var ui = 0; ui < toUpload.length; ui++) {
                  try {
                    var uploadResult = await apiUpload('/api/' + encodeURIComponent(currentTab) + '/upload', toUpload[ui].file);
                    if (uploadResult && uploadResult.url) {
                      pathMap[toUpload[ui].ref] = uploadResult.url;
                    }
                  } catch (e) {
                    console.error('Failed to upload image:', toUpload[ui].ref, e);
                  }
                }
              }
            }

            var processedMd = mdText;
            Object.keys(pathMap).forEach(function(oldPath) {
              var escaped = oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              processedMd = processedMd.replace(
                new RegExp('(!\\[[^\\]]*\\]\\()' + escaped + '\\)', 'g'),
                '$1' + pathMap[oldPath] + ')'
              );
              processedMd = processedMd.replace(
                new RegExp('(src=["\'])' + escaped + '(["\'])', 'g'),
                '$1' + pathMap[oldPath] + '$2'
              );
            });

            try {
              var result = await api('POST', '/api/' + encodeURIComponent(currentTab) + '/menu/import-md', {
                md_text: processedMd,
                after_id: id,
                label: label
              });
              await reloadMenu();
              if (result && result.id) {
                scrollToTreeNode(result.id);
                selectItem(result.id);
              }
            } catch (e) {
              showDialog('Error', '<p>' + escapeHtml(e.message) + '</p>');
            }
          })();
          break;
        }
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

    // ── Build hierarchical tree from flat API data ──
    function buildHierarchy(flat, excludeId) {
      // Collect all descendants of the excluded node so they are removed from
      // the tree entirely (preventing them from becoming orphaned root nodes).
      const excludeSet = new Set();
      if (excludeId) {
        excludeSet.add(excludeId);
        let prevSize = 0;
        while (prevSize !== excludeSet.size) {
          prevSize = excludeSet.size;
          for (const n of flat) {
            if (excludeSet.has(n.parent_id)) {
              excludeSet.add(n.id);
            }
          }
        }
      }

      const roots = [];
      const map = {};
      for (const n of flat) {
        if (excludeSet.has(n.id)) continue;
        map[n.id] = { id: n.id, label: n.label, parent_id: n.parent_id, children: [] };
      }
      for (const n of flat) {
        if (excludeSet.has(n.id)) continue;
        const node = map[n.id];
        if (n.parent_id && map[n.parent_id]) {
          map[n.parent_id].children.push(node);
        } else {
          roots.push(node);
        }
      }
      return roots;
    }

    const tree = buildHierarchy(treeData, itemId);

    // ── Recursive node HTML renderer ──
    function renderNodeHtml(node, depth) {
      const hasCh = node.children.length > 0;
      const pad = depth * 20;
      let h = `<div class="move-tree-node" data-id="${node.id}">`;
      h += `<div class="move-tree-header" style="padding-left:${8 + pad}px">`;
      h += hasCh
        ? `<span class="move-toggle">\u25B8</span>`
        : `<span class="move-toggle move-toggle-empty"></span>`;
      h += `<span class="move-label">${escapeHtml(node.label)}</span>`;
      h += '</div>';
      if (hasCh) {
        h += '<div class="move-children" style="display:none">';
        for (const child of node.children) h += renderNodeHtml(child, depth + 1);
        h += '</div>';
      }
      h += '</div>';
      return h;
    }

    // ── Assemble dialog HTML ──
    let html = `<p style="margin-bottom:6px;font-size:13px;color:#555">${escapeHtml(currentLabel)} \u2192</p>`;

    // Search + toolbar
    html += '<div class="move-tree-toolbar">';
    html += `<input type="text" id="move-search-input" class="move-search-input" placeholder="${t('search_placeholder')}">`;
    html += `<button type="button" id="move-collapse-all" class="move-tool-btn" title="${t('collapse_all')}">\u25B8\u25B8</button>`;
    html += `<button type="button" id="move-expand-all" class="move-tool-btn" title="${t('expand_all')}">\u25BE\u25BE</button>`;
    html += '</div>';

    html += '<div id="move-tree">';
    // Root sentinel
    html += '<div class="move-tree-node" data-id="">';
    html += '<div class="move-tree-header" style="padding-left:8px">';
    html += '<span class="move-toggle move-toggle-empty"></span>';
    html += '<span class="move-label">&lt;Root (top level)&gt;</span>';
    html += '</div></div>';
    for (const node of tree) html += renderNodeHtml(node, 0);
    html += '</div>';

    let selectedTargetId = null;

    showDialog(t('move_item_title'), html, () => {
      if (selectedTargetId === undefined) return false;
      moveMenuItemToTarget(itemId, selectedTargetId);
      return true;
    });

    const moveTreeEl = $('#move-tree');
    if (!moveTreeEl) return;

    // ── Click header to select (delegated) ──
    moveTreeEl.addEventListener('click', (e) => {
      const header = e.target.closest('.move-tree-header');
      if (!header) return;
      // Ignore clicks on toggle button (handled separately)
      if (e.target.closest('.move-toggle') && !e.target.closest('.move-toggle-empty')) return;

      moveTreeEl.querySelectorAll('.move-tree-header').forEach((h) => h.classList.remove('selected'));
      header.classList.add('selected');
      const nodeId = header.closest('.move-tree-node').dataset.id;
      selectedTargetId = nodeId === '' ? null : nodeId;
    });

    // ── Toggle expand/collapse (delegated) ──
    moveTreeEl.addEventListener('click', (e) => {
      const toggle = e.target.closest('.move-toggle:not(.move-toggle-empty)');
      if (!toggle) return;
      e.stopPropagation();
      const nodeEl = toggle.closest('.move-tree-node');
      const childrenDiv = nodeEl.querySelector('.move-children');
      if (!childrenDiv) return;
      const isHidden = childrenDiv.style.display === 'none';
      childrenDiv.style.display = isHidden ? '' : 'none';
      toggle.textContent = isHidden ? '\u25BE' : '\u25B8';
    });

    // ── Collapse All ──
    const collapseBtn = $('#move-collapse-all');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => {
        moveTreeEl.querySelectorAll('.move-children').forEach((el) => { el.style.display = 'none'; });
        moveTreeEl.querySelectorAll('.move-toggle:not(.move-toggle-empty)').forEach((t) => { t.textContent = '\u25B8'; });
      });
    }

    // ── Expand All ──
    const expandBtn = $('#move-expand-all');
    if (expandBtn) {
      expandBtn.addEventListener('click', () => {
        moveTreeEl.querySelectorAll('.move-children').forEach((el) => { el.style.display = ''; });
        moveTreeEl.querySelectorAll('.move-toggle:not(.move-toggle-empty)').forEach((t) => { t.textContent = '\u25BE'; });
      });
    }

    // ── Search / Filter ──
    const searchInput = $('#move-search-input');
    if (searchInput) {
      let searchTimer;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          const q = searchInput.value.trim().toLowerCase();
          const allNodes = [...moveTreeEl.querySelectorAll('.move-tree-node')];

          if (q === '') {
            // Reset: show all, collapse children
            allNodes.forEach((el) => { el.style.display = ''; });
            moveTreeEl.querySelectorAll('.move-children').forEach((el) => { el.style.display = 'none'; });
            moveTreeEl.querySelectorAll('.move-toggle:not(.move-toggle-empty)').forEach((t) => { t.textContent = '\u25B8'; });
            return;
          }

          const nodeMap = {};
          allNodes.forEach((el) => {
            const id = el.dataset.id;
            const labelEl = el.querySelector('.move-label');
            nodeMap[id] = {
              el,
              label: labelEl ? labelEl.textContent.toLowerCase() : '',
              childrenEl: el.querySelector('.move-children'),
            };
          });

          const matchingIds = new Set();
          allNodes.forEach((el) => {
            if (nodeMap[el.dataset.id]?.label.includes(q)) matchingIds.add(el.dataset.id);
          });

          const visibleIds = new Set();
          matchingIds.forEach((id) => {
            visibleIds.add(id);
            let cur = nodeMap[id]?.el;
            while (cur) {
              const parent = cur.parentElement?.closest('.move-tree-node');
              if (parent) { visibleIds.add(parent.dataset.id); cur = parent; }
              else break;
            }
          });

          allNodes.forEach((el) => {
            el.style.display = visibleIds.has(el.dataset.id) ? '' : 'none';
            const info = nodeMap[el.dataset.id];
            if (info?.childrenEl) {
              const hasVisible = [...info.childrenEl.querySelectorAll(':scope > .move-tree-node')]
                .some((c) => c.style.display !== 'none');
              if (hasVisible) {
                info.childrenEl.style.display = '';
                const toggle = el.querySelector('.move-toggle:not(.move-toggle-empty)');
                if (toggle) toggle.textContent = '\u25BE';
              }
            }
          });
        }, 150);
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

  // ─── Color Picker Popup ─────────────────────────────────────────────────

  let colorPickerTarget = null;
  let colorPickerColor = '#ff0000';

  function openColorPicker(e, mode) {
    e.stopPropagation();

    const sel = window.getSelection();
    if (sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
      editor._savedRange = sel.getRangeAt(0).cloneRange();
    } else {
      editor._savedRange = null;
    }

    const popup = $('#color-picker-popup');
    const content = $('#color-picker-popup-content');
    const header = $('#color-picker-popup-header');
    const customInput = $('#cp-custom-input');
    const btn = e.currentTarget;

    colorPickerTarget = mode;
    colorPickerColor = mode === 'foreColor' ? $('#text-color').value : $('#text-bgcolor').value;
    header.textContent = mode === 'foreColor' ? '选择文字颜色' : '选择背景颜色';
    customInput.value = colorPickerColor;

    popup.querySelectorAll('.cp-color-swatch').forEach((s) => s.classList.remove('selected'));
    popup.querySelectorAll('.cp-color-swatch').forEach((s) => {
      if (s.dataset.color === colorPickerColor) s.classList.add('selected');
    });

    const rect = btn.getBoundingClientRect();
    content.style.left = Math.max(4, rect.left) + 'px';
    content.style.top = (rect.bottom + 4) + 'px';

    const contentRect = content.getBoundingClientRect();
    if (contentRect.right > window.innerWidth - 4) {
      content.style.left = Math.max(4, window.innerWidth - contentRect.width - 4) + 'px';
    }

    popup.style.display = 'block';
  }

  $('#color-picker-popup').addEventListener('click', (e) => {
    const swatch = e.target.closest('.cp-color-swatch');
    if (!swatch) return;
    const color = swatch.dataset.color;
    if (!color) return;

    const popup = $('#color-picker-popup');
    popup.querySelectorAll('.cp-color-swatch').forEach((s) => s.classList.remove('selected'));
    swatch.classList.add('selected');
    colorPickerColor = color;
    $('#cp-custom-input').value = color === 'transparent' ? '#ffffff' : color;
  });

  $('#cp-custom-btn').addEventListener('click', () => {
    $('#cp-custom-input').click();
  });

  $('#cp-custom-input').addEventListener('input', function() {
    colorPickerColor = this.value;
    const popup = $('#color-picker-popup');
    popup.querySelectorAll('.cp-color-swatch').forEach((s) => s.classList.remove('selected'));
    popup.querySelectorAll('.cp-color-swatch').forEach((s) => {
      if (s.dataset.color === this.value) s.classList.add('selected');
    });
  });

  $('#cp-btn-ok').addEventListener('click', () => {
    const popup = $('#color-picker-popup');
    popup.style.display = 'none';

    if (editor._savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(editor._savedRange);
      editor._savedRange = null;
    }

    if (colorPickerTarget === 'foreColor') {
      const swatch = $('#color-swatch');
      if (swatch) swatch.style.background = colorPickerColor === 'transparent' ? 'transparent' : colorPickerColor;
      $('#text-color').value = colorPickerColor === 'transparent' ? '#ffffff' : colorPickerColor;
      editor.focus();
      document.execCommand('foreColor', false, colorPickerColor === 'transparent' ? '#000000' : colorPickerColor);
    } else {
      const swatch = $('#bgcolor-swatch');
      if (swatch) swatch.style.background = colorPickerColor === 'transparent' ? 'transparent' : colorPickerColor;
      $('#text-bgcolor').value = colorPickerColor === 'transparent' ? '#ffffff' : colorPickerColor;
      editor.focus();
      document.execCommand('backColor', false, colorPickerColor);
    }
    markModified();
    colorPickerTarget = null;
  });

  $('#cp-btn-cancel').addEventListener('click', () => {
    $('#color-picker-popup').style.display = 'none';
    colorPickerTarget = null;
  });

  $('#color-picker-popup').addEventListener('click', (e) => {
    if (e.target === $('#color-picker-popup')) {
      $('#color-picker-popup').style.display = 'none';
      colorPickerTarget = null;
    }
  });

  // ─── Text Color ─────────────────────────────────────────────────────────

  $('#btn-apply-color').addEventListener('click', () => {
    editor.focus();
    const color = $('#text-color').value;
    document.execCommand('foreColor', false, color);
    markModified();
  });

  $('#btn-color-arrow').addEventListener('click', (e) => {
    openColorPicker(e, 'foreColor');
  });

  // ─── Background Color (Highlight) ────────────────────────────────────────

  $('#btn-apply-bgcolor').addEventListener('click', () => {
    editor.focus();
    const color = $('#text-bgcolor').value;
    document.execCommand('backColor', false, color);
    markModified();
  });

  $('#btn-bgcolor-arrow').addEventListener('click', (e) => {
    openColorPicker(e, 'backColor');
  });

  $('#btn-insert-link').addEventListener('click', () => {
    promptInsertLink();
  });

  $('#btn-insert-table').addEventListener('click', () => {
    promptInsertTable();
  });

  // ─── Mermaid Sequence Diagram ─────────────────────────────────────────

  let mermaidInitialized = false;

  function initMermaid() {
    if (mermaidInitialized) return;
    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'loose',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      });
      mermaidInitialized = true;
    } catch (e) {
      console.warn('Mermaid init failed:', e);
    }
  }

  /** Store renderEl and SVG widths as the scaling baseline for drag mode */
  function captureMermaidBase(blockEl) {
    const renderEl = blockEl.querySelector('.mermaid-render');
    const svgEl = renderEl ? renderEl.querySelector('svg') : null;
    if (!renderEl || !svgEl) return;
    blockEl.dataset.baseW = svgEl.getAttribute('width');
    blockEl.dataset.baseRenderW = renderEl.clientWidth;
  }

  /** Render the SVG element to a PNG data URL and store in data-png.
   *  This provides a fallback for PDF export when cairosvg cannot handle
   *  browser-specific SVG features like foreignObject. */
  function captureMermaidPng(blockEl) {
    const renderEl = blockEl.querySelector('.mermaid-render');
    const svgEl = renderEl ? renderEl.querySelector('svg') : null;
    if (!svgEl) return;
    const targetWidth = Math.min(parseInt(svgEl.getAttribute('width')) || 360, 1920);
    try {
      const clone = svgEl.cloneNode(true);
      clone.querySelectorAll('foreignObject').forEach(function (fo) {
        const xhtmlDiv = fo.querySelector('div');
        const text = xhtmlDiv && typeof xhtmlDiv.innerText === 'string'
          ? xhtmlDiv.innerText.trim()
          : (fo.textContent || '').trim();
        if (!text) { fo.remove(); return; }
        const w = parseFloat(fo.getAttribute('width')) || 0;
        const h = parseFloat(fo.getAttribute('height')) || 0;
        
        let tx = 0, ty = 0;
        try {
          const ctm = fo.getCTM ? fo.getCTM() : null;
          if (ctm) {
            tx = ctm.e;
            ty = ctm.f;
          } else {
            let p = fo.parentElement;
            while (p && p !== clone) {
              const tf = p.getAttribute('transform');
              if (tf) {
                const translateMatch = tf.match(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)/);
                if (translateMatch) {
                  tx += parseFloat(translateMatch[1]);
                  ty += parseFloat(translateMatch[2]);
                }
                const matrixMatch = tf.match(/matrix\(\s*([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)\s*\)/);
                if (matrixMatch) {
                  tx += parseFloat(matrixMatch[5]);
                  ty += parseFloat(matrixMatch[6]);
                }
              }
              p = p.parentElement;
            }
          }
        } catch (e) {
          console.warn('captureMermaidPng transform calc:', e);
        }
        
        let fontSize = '16';
        let fontFamily = 'sans-serif';
        let fill = '#333';
        if (xhtmlDiv) {
          const computedStyle = window.getComputedStyle(xhtmlDiv);
          fontSize = computedStyle.fontSize || '16';
          fontFamily = computedStyle.fontFamily || 'sans-serif';
          fill = computedStyle.color || '#333';
        }
        
        const lines = text.split('\n');
        const te = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        te.setAttribute('x', tx + w / 2);
        te.setAttribute('y', ty + h / 2);
        te.setAttribute('text-anchor', 'middle');
        te.setAttribute('dominant-baseline', 'central');
        te.setAttribute('font-size', fontSize);
        te.setAttribute('font-family', fontFamily);
        te.setAttribute('fill', fill);
        if (lines.length === 1) {
          te.textContent = text;
        } else {
          const lineH = Math.max(parseFloat(fontSize) || 16, h / lines.length);
          const startY = ty + h / 2 - (lines.length - 1) * lineH / 2;
          lines.forEach(function (line, i) {
            const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
            tspan.setAttribute('x', tx + w / 2);
            tspan.setAttribute('dy', i === 0 ? startY - (ty + h / 2) : lineH);
            tspan.textContent = line;
            te.appendChild(tspan);
          });
        }
        fo.parentNode.replaceChild(te, fo);
      });
      const svgData = new XMLSerializer().serializeToString(clone);
      const svgFull = svgData.includes('xmlns')
        ? svgData
        : svgData.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      const blob = new Blob([svgFull], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = function () {
        try {
          const scale = targetWidth / (img.width || 1);
          const canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = Math.round((img.height || 1) * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          svgEl.setAttribute('data-png', canvas.toDataURL('image/png'));
        } catch (e) {
          console.warn('captureMermaidPng draw:', e);
        }
        URL.revokeObjectURL(url);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
      };
      img.src = url;
    } catch (e) {
      console.warn('captureMermaidPng err:', e);
    }
  }

  /** Render an SVG element to a canvas and return the PNG data URL.
   *  Tries the original SVG first (preserves foreignObject content such as
   *  class diagrams). Falls back to cloning + replacing foreignObject with
   *  text elements when the canvas is tainted. */
  function svgToPngDataUrl(svgEl, width, height) {
    return new Promise(function (resolve) {
      // Try original SVG first — preserves foreignObject layout
      try {
        const svgData = new XMLSerializer().serializeToString(svgEl);
        const svgFull = svgData.includes('xmlns')
          ? svgData
          : svgData.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
        const blob = new Blob([svgFull], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          try {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/png'));
          } catch (e) {
            // Canvas tainted — use fallback with cloned SVG
            console.warn('svgToPng canvas tainted, using fallback:', e);
            resolve(fallbackSvgToPng(svgEl, width, height));
          }
        };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
      } catch (e) {
        console.warn('svgToPng failed:', e);
        resolve(null);
      }
    });
  }

  /** Fallback: clone SVG, replace foreignObject with text elements,
   *  then render to canvas at the requested size. */
  function fallbackSvgToPng(svgEl, width, height) {
    try {
      const clone = svgEl.cloneNode(true);
      clone.querySelectorAll('foreignObject').forEach(function (fo) {
        // Use innerText from the XHTML container so block-level element
        // boundaries (div, br, hr) produce line separators, unlike
        // textContent which concatenates without gaps.
        const xhtmlDiv = fo.querySelector('div');
        const text = xhtmlDiv && typeof xhtmlDiv.innerText === 'string'
          ? xhtmlDiv.innerText.trim()
          : (fo.textContent || '').trim();
        if (!text) { fo.remove(); return; }
        const w = parseFloat(fo.getAttribute('width')) || 0;
        const h = parseFloat(fo.getAttribute('height')) || 0;
        
        let tx = 0, ty = 0;
        try {
          const ctm = fo.getCTM ? fo.getCTM() : null;
          if (ctm) {
            tx = ctm.e;
            ty = ctm.f;
          } else {
            let p = fo.parentElement;
            while (p && p !== clone) {
              const tf = p.getAttribute('transform');
              if (tf) {
                const translateMatch = tf.match(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)/);
                if (translateMatch) {
                  tx += parseFloat(translateMatch[1]);
                  ty += parseFloat(translateMatch[2]);
                }
                const matrixMatch = tf.match(/matrix\(\s*([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)\s*\)/);
                if (matrixMatch) {
                  tx += parseFloat(matrixMatch[5]);
                  ty += parseFloat(matrixMatch[6]);
                }
              }
              p = p.parentElement;
            }
          }
        } catch (e) {
          console.warn('fallbackSvgToPng transform calc:', e);
        }
        
        let fontSize = '14';
        let fontFamily = 'sans-serif';
        let fill = '#333';
        if (xhtmlDiv) {
          const computedStyle = window.getComputedStyle(xhtmlDiv);
          fontSize = computedStyle.fontSize || '14';
          fontFamily = computedStyle.fontFamily || 'sans-serif';
          fill = computedStyle.color || '#333';
        }
        
        // Split multi-line text into separate <tspan> elements
        const lines = text.split('\n');
        const te = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        te.setAttribute('x', tx + w / 2);
        te.setAttribute('y', ty + h / 2);
        te.setAttribute('text-anchor', 'middle');
        te.setAttribute('dominant-baseline', 'central');
        te.setAttribute('font-size', fontSize);
        te.setAttribute('font-family', fontFamily);
        te.setAttribute('fill', fill);
        if (lines.length === 1) {
          te.textContent = text;
        } else {
          const lineH = Math.max(parseFloat(fontSize) || 14, h / lines.length);
          const startY = ty + h / 2 - (lines.length - 1) * lineH / 2;
          lines.forEach(function (line, i) {
            const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
            tspan.setAttribute('x', tx + w / 2);
            tspan.setAttribute('dy', i === 0 ? startY - (ty + h / 2) : lineH);
            tspan.textContent = line;
            te.appendChild(tspan);
          });
        }
        fo.parentNode.replaceChild(te, fo);
      });
      const svgData = new XMLSerializer().serializeToString(clone);
      const svgFull = svgData.includes('xmlns')
        ? svgData
        : svgData.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      const blob = new Blob([svgFull], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      return new Promise(function (resolve) {
        img.onload = function () {
          URL.revokeObjectURL(url);
          try {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/png'));
          } catch (e) {
            console.warn('fallbackSvgToPng draw:', e);
            resolve(null);
          }
        };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
      });
    } catch (e) {
      console.warn('fallbackSvgToPng err:', e);
      return null;
    }
  }

  /** Download a mermaid block's rendered diagram as a PNG file.
   *  Renders at the full SVG resolution for crisp output. */
  function saveMermaidAsPng(blockEl) {
    const renderEl = blockEl.querySelector('.mermaid-render');
    const svgEl = renderEl ? renderEl.querySelector('svg') : null;
    if (!svgEl) return;

    // Use actual rendered dimensions
    const width = parseInt(svgEl.getAttribute('width'));
    const height = parseInt(svgEl.getAttribute('height'));
    if (!width || !height) return;

    svgToPngDataUrl(svgEl, width, height).then(function (pngData) {
      if (!pngData) {
        console.warn('saveMermaidAsPng: failed to generate PNG');
        return;
      }

      // Derive filename from the first line of mermaid source
      const source = (blockEl.dataset.mermaidSource || 'diagram').trim();
      const firstLine = source.split('\n')[0].replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 40);
      const filename = (firstLine || 'mermaid_diagram') + '.png';

      const link = document.createElement('a');
      link.download = filename;
      link.href = pngData;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  }

  /** Size SVG in a mermaid block.
   *  - Auto mode (block has no inline width / fit-content):
   *    natural size × zoom, constrained to editor width.
   *  - Drag mode (user dragged the resize handle, giving the block an
   *    explicit inline width):
   *    SVG scales proportionally from the last captured baseline.
   */
  function resizeSvgToZoom(blockEl) {
    const renderEl = blockEl.querySelector('.mermaid-render');
    const svgEl = renderEl ? renderEl.querySelector('svg') : null;
    if (!svgEl) return;

    const viewBox = svgEl.getAttribute('viewBox');
    if (!viewBox) return;
    const parts = viewBox.trim().split(/\s+/).map(Number);
    const vbW = parts[2];
    const vbH = parts[3];
    if (!vbW || !vbH) return;

    const zoom = parseInt(blockEl.dataset.zoom, 10) || 100;
    let svgWidth, svgHeight;

    if (blockEl.style.width) {
      const baseW = parseFloat(blockEl.dataset.baseW);
      const baseRenderW = parseFloat(blockEl.dataset.baseRenderW);
      const containerWidth = renderEl.clientWidth;
      if (baseW && baseRenderW && containerWidth > 0) {
        const scale = containerWidth / baseRenderW;
        svgWidth = baseW * scale;
        svgHeight = Math.round(svgWidth * (vbH / vbW));
      } else {
        svgWidth = vbW * (zoom / 100);
        svgHeight = vbH * (zoom / 100);
      }
    } else {
      svgWidth = vbW * (zoom / 100);
      svgHeight = vbH * (zoom / 100);
      const editorWidth = editor ? editor.clientWidth : window.innerWidth;
      const maxWidth = editorWidth - 40;
      if (svgWidth > maxWidth) {
        const scale = maxWidth / svgWidth;
        svgWidth = maxWidth;
        svgHeight = Math.round(svgHeight * scale);
      }
    }

    // Avoid redundant attribute changes that could trigger ResizeObserver loops
    const curW = parseFloat(svgEl.getAttribute('width'));
    const curH = parseFloat(svgEl.getAttribute('height'));
    const newW = Math.round(svgWidth);
    const newH = Math.round(svgHeight);
    if (curW === newW && curH === newH) return;

    svgEl.setAttribute('width', newW);
    svgEl.setAttribute('height', newH);
  }

  /** Render a single mermaid block element */
  async function renderMermaidBlock(blockEl) {
    if (!mermaidInitialized) initMermaid();
    const source = (blockEl.dataset.mermaidSource || '').trim();
    if (!source) return;

    const renderEl = blockEl.querySelector('.mermaid-render');
    if (!renderEl) return;

    renderEl.textContent = 'Rendering...';

    try {
      const id = 'mermaid-' + Math.random().toString(36).slice(2, 10);
      const { svg } = await mermaid.render(id, source);
      renderEl.innerHTML = svg;

      resizeSvgToZoom(blockEl);
      // Capture baseline after layout so drag mode can scale from it
      requestAnimationFrame(() => {
        captureMermaidBase(blockEl);
        captureMermaidPng(blockEl);
      });

      if (!renderEl.__resizeObs) {
        renderEl.__resizeObs = new ResizeObserver(() => {
          if (blockEl.dataset.mode === 'source') return;
          resizeSvgToZoom(blockEl);
          // In auto mode (fit-content, no drag yet), refresh the baseline
          if (!blockEl.style.width) {
            captureMermaidBase(blockEl);
          }
        });
        renderEl.__resizeObs.observe(renderEl);
      }
    } catch (e) {
      renderEl.innerHTML = '<div style="color:#e74c3c;font-size:13px;text-align:center">Diagram render error: ' + escapeHtml(e.message) + '</div>';
    }
  }

  /** Find and render all mermaid blocks in the editor */
  function renderMermaidDiagrams() {
    if (!editor) return;
    if (!mermaidInitialized) initMermaid();
    const blocks = editor.querySelectorAll('.mermaid-block[data-mode="rendered"]');
    blocks.forEach((el) => {
      // Set a unique id if not present
      if (!el.id) {
        el.id = 'mmb-' + Math.random().toString(36).slice(2, 10);
      }
      renderMermaidBlock(el);
    });
  }

  /** Re-constrain all rendered mermaid blocks (e.g., on editor/window resize) */
  function refreshMermaidSizes() {
    if (!editor) return;
    const blocks = editor.querySelectorAll('.mermaid-block[data-mode="rendered"]');
    blocks.forEach((el) => resizeSvgToZoom(el));
  }

  let _resizeTick = null;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTick);
    _resizeTick = setTimeout(refreshMermaidSizes, 150);
  });

  /** Toggle a mermaid block between rendered and source mode */
  async function toggleMermaidBlock(blockEl) {
    const mode = blockEl.dataset.mode;
    const toggleBtn = blockEl.querySelector('.mermaid-toggle-btn');
    const sourceEl = blockEl.querySelector('.mermaid-source-edit');

    if (mode === 'rendered') {
      // Switch to source mode
      blockEl.dataset.mode = 'source';
      blockEl.classList.remove('selected');
      if (sourceEl) {
        sourceEl.contentEditable = 'true';
        sourceEl.focus();
      }
      if (toggleBtn) toggleBtn.textContent = 'Render';
    } else {
      // Switch to rendered mode
      const newSource = sourceEl ? sourceEl.textContent.trim() : '';
      if (newSource) {
        blockEl.dataset.mermaidSource = newSource;
      }
      blockEl.dataset.mode = 'rendered';
      if (sourceEl) {
        sourceEl.contentEditable = 'false';
      }
      if (toggleBtn) toggleBtn.textContent = 'Source';
      await renderMermaidBlock(blockEl);
      markModified();
    }
  }

  /** Build a mermaid block HTML string from source code */
  function buildMermaidBlockHtml(source) {
    const escapedSource = escapeHtml(source);
    const blockId = 'mmb-' + Math.random().toString(36).slice(2, 10);
    return '<div class="mermaid-block" id="' + blockId + '" data-mode="rendered" data-zoom="100" data-mermaid-source="' + escapeHtml(source).replace(/"/g, '&quot;') + '">'
      + '<div class="mermaid-header" contenteditable="false">'
      + '<span class="mermaid-label">📊 Sequence Diagram</span>'
      + '<div class="mermaid-header-actions">'
      + '<div class="mermaid-zoom-control" contenteditable="false">'
      + '<button class="mermaid-zoom-out" contenteditable="false" title="Zoom out">-</button>'
      + '<span class="mermaid-zoom-label" contenteditable="false">100%</span>'
      + '<button class="mermaid-zoom-in" contenteditable="false" title="Zoom in">+</button>'
      + '</div>'
      + '<button class="mermaid-toggle-btn" contenteditable="false">Source</button>'
      + '<button class="mermaid-del-btn" contenteditable="false" title="Delete diagram">✕</button>'
      + '</div>'
      + '</div>'
      + '<div class="mermaid-render" contenteditable="false">Rendering...</div>'
      + '<pre class="mermaid-source-edit" contenteditable="false">' + escapedSource + '</pre>'
      + '</div>';
  }

  /** Insert a mermaid sequence diagram block at a given range (or current cursor) */
  function insertMermaidBlock(source, savedRange) {
    if (!source || !source.trim()) return;

    const sel = window.getSelection();
    let range = savedRange;
    if (!range) {
      const scrollPos = editor.scrollTop;
      editor.focus();
      editor.scrollTop = scrollPos;
      if (sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
        range = sel.getRangeAt(0);
      } else {
        range = document.createRange();
        range.setStartAfter(editor.lastChild || editor);
        range.collapse(true);
      }
    }

    const html = buildMermaidBlockHtml(source.trim());
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const blockEl = tempDiv.firstElementChild;

    range.deleteContents();
    range.insertNode(blockEl);

    // Move cursor after the block
    const newRange = document.createRange();
    newRange.setStartAfter(blockEl);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);

    // Render the diagram
    renderMermaidBlock(blockEl);
    markModified();
  }

  /** Resize the mermaid dialog to fit the rendered SVG */
  function fitDialogToSvg(svgEl) {
    const content = $('#mermaid-dialog-content');
    const preview = $('#mermaid-dialog-preview');
    if (!content || !preview || !svgEl) return;

    // Determine SVG natural dimensions
    let svgW = 0, svgH = 0;

    // Try viewBox first (most reliable for mermaid output)
    const viewBox = svgEl.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox.trim().split(/\s+/).map(Number);
      if (parts.length >= 4) {
        svgW = parts[2];
        svgH = parts[3];
      }
    }

    // Fallback to explicit width/height
    if (!svgW || !svgH) {
      const wAttr = parseFloat(svgEl.getAttribute('width'));
      const hAttr = parseFloat(svgEl.getAttribute('height'));
      if (wAttr && hAttr) {
        svgW = wAttr;
        svgH = hAttr;
      }
      // Still try to compute from child bounding box
      if (!svgW || !svgH) {
        const bbox = svgEl.getBoundingClientRect();
        if (bbox.width > 0 && bbox.height > 0) {
          svgW = bbox.width;
          svgH = bbox.height;
        }
      }
    }

    if (!svgW || !svgH) return;

    // Viewport limits: keep 8% margin on each side
    const maxW = window.innerWidth * 0.84;
    const maxH = window.innerHeight * 0.84;

    // Dialog content horizontal padding: 24px * 2
    const hPad = 48;
    // Vertical overhead: content padding(24*2) + header(~22px) + hint(~16px)
    //   + textarea(200px) + margins + footer(~38px) + preview margin(12px)
    const vOverhead = 370;

    // Space available for the SVG inside the preview
    const previewMaxW = maxW - hPad;
    const previewMaxH = Math.max(200, maxH - vOverhead);

    // Scale SVG proportionally to fit preview area
    let displayW = svgW;
    let displayH = svgH;

    if (displayW > previewMaxW) {
      const scale = previewMaxW / displayW;
      displayW = previewMaxW;
      displayH = Math.round(svgH * scale);
    }
    if (displayH > previewMaxH) {
      const scale = previewMaxH / displayH;
      displayH = previewMaxH;
      displayW = Math.round(svgW * scale);
    }

    // Ensure minimum display size
    displayW = Math.max(displayW, 380);
    displayH = Math.max(displayH, 60);

    // Allow content to override fixed max-width
    content.style.maxWidth = 'none';
    content.style.width = Math.round(displayW + hPad) + 'px';

    // Size preview to fit the SVG
    preview.style.height = Math.round(displayH) + 'px';
    preview.style.maxHeight = Math.round(previewMaxH) + 'px';
    preview.style.overflow = 'hidden';

    // Set explicit SVG display dimensions so it renders at the right size
    svgEl.setAttribute('width', Math.round(displayW));
    svgEl.setAttribute('height', Math.round(displayH));
  }

  /** Reset mermaid dialog size to CSS defaults */
  function resetDialogSize() {
    const content = $('#mermaid-dialog-content');
    const preview = $('#mermaid-dialog-preview');
    if (content) {
      content.style.width = '';
      content.style.maxWidth = '';
    }
    if (preview) {
      preview.style.height = '';
      preview.style.maxHeight = '';
      preview.style.overflow = '';
    }
  }

  /** Show the mermaid insert dialog */
  function promptInsertMermaid() {
    const dialog = $('#mermaid-dialog');
    if (!dialog) return;
    const textarea = $('#mermaid-dialog-source');
    const preview = $('#mermaid-dialog-preview');
    if (!textarea || !preview) return;

    // Save cursor position before dialog steals focus
    const savedRange = (() => {
      const sel = window.getSelection();
      if (sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
        return sel.getRangeAt(0).cloneRange();
      }
      return null;
    })();

    resetDialogSize();

    textarea.value = '';
    preview.innerHTML = '<div style="color:#999;font-size:13px">Enter source code above to preview</div>';
    dialog.style.display = 'flex';
    textarea.focus();

    // Live preview on input
    textarea._previewTimer = null;
    textarea.addEventListener('input', function() {
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(async () => {
        const src = this.value.trim();
        if (!src) {
          preview.innerHTML = '<div style="color:#999;font-size:13px">Enter source code above to preview</div>';
          resetDialogSize();
          return;
        }
        try {
          if (!mermaidInitialized) initMermaid();
          const id = 'mermaid-preview-' + Math.random().toString(36).slice(2, 8);
          const { svg } = await mermaid.render(id, src);
          preview.className = '';
          preview.innerHTML = svg;
          const svgEl = preview.querySelector('svg');
          if (svgEl) fitDialogToSvg(svgEl);
        } catch (e) {
          preview.className = 'mermaid-error';
          preview.textContent = 'Error: ' + e.message;
          resetDialogSize();
        }
      }, 500);
    });

    // OK button
    const okBtn = $('#mermaid-btn-ok');
    const cancelBtn = $('#mermaid-btn-cancel');

    function doInsert() {
      const src = textarea.value.trim();
      if (!src) return;
      dialog.style.display = 'none';
      insertMermaidBlock(src, savedRange);
    }

    function doCancel() {
      dialog.style.display = 'none';
    }

    okBtn.onclick = doInsert;
    cancelBtn.onclick = doCancel;

    textarea.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doInsert();
      }
      if (e.key === 'Escape') doCancel();
    };

    // Close on overlay click
    dialog.onclick = (e) => {
      if (e.target === dialog) doCancel();
    };
  }

  $('#btn-insert-mermaid').addEventListener('click', () => {
    promptInsertMermaid();
  });

  /** Remove a mermaid block from the editor */
  function removeMermaidBlock(blockEl) {
    // Move cursor before/after before removing
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(blockEl);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    blockEl.remove();
    editor.focus();
    markModified();
  }

  /** Change zoom level for a mermaid block */
  function changeMermaidZoom(blockEl, delta) {
    let zoom = parseInt(blockEl.dataset.zoom, 10) || 100;
    zoom = Math.max(25, Math.min(200, zoom + delta));
    blockEl.dataset.zoom = zoom;
    const label = blockEl.querySelector('.mermaid-zoom-label');
    if (label) label.textContent = zoom + '%';
    // Clear baseline so resizeSvgToZoom recalculates from natural × new zoom
    delete blockEl.dataset.baseW;
    delete blockEl.dataset.baseRenderW;
    resizeSvgToZoom(blockEl);
    // Re-capture baseline after zoom recalculation
    requestAnimationFrame(() => captureMermaidBase(blockEl));
    markModified();
  }

  // Delegate clicks within mermaid blocks in the editor
  editor.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('.mermaid-toggle-btn');
    if (toggleBtn) {
      e.preventDefault();
      e.stopPropagation();
      const blockEl = toggleBtn.closest('.mermaid-block');
      if (blockEl) {
        toggleMermaidBlock(blockEl);
      }
      return;
    }

    const zoomOut = e.target.closest('.mermaid-zoom-out');
    if (zoomOut) {
      e.preventDefault();
      e.stopPropagation();
      const blockEl = zoomOut.closest('.mermaid-block');
      if (blockEl) changeMermaidZoom(blockEl, -25);
      return;
    }

    const zoomIn = e.target.closest('.mermaid-zoom-in');
    if (zoomIn) {
      e.preventDefault();
      e.stopPropagation();
      const blockEl = zoomIn.closest('.mermaid-block');
      if (blockEl) changeMermaidZoom(blockEl, 25);
      return;
    }

    const delBtn = e.target.closest('.mermaid-del-btn');
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      const blockEl = delBtn.closest('.mermaid-block');
      if (blockEl) {
        removeMermaidBlock(blockEl);
      }
      return;
    }

    // Click on the block body → select it (only if hitting actual content, not empty padding)
    const blockEl = e.target.closest('.mermaid-block');
    if (blockEl) {
      // Ignore clicks on empty padding in the render area
      // (happens when diagram is zoomed out — space right of SVG)
      const inRender = e.target.closest('.mermaid-render');
      const isSvg = e.target.closest('svg');
      if (inRender && !isSvg) return;

      if (e.target.closest('.mermaid-source-edit')) return;

      editor.querySelectorAll('.mermaid-block.selected').forEach((el) => el.classList.remove('selected'));
      blockEl.classList.add('selected');
      return;
    }
  });

  // Click outside a mermaid block → deselect
  editor.addEventListener('click', (e) => {
    if (!e.target.closest('.mermaid-block')) {
      editor.querySelectorAll('.mermaid-block.selected').forEach((el) => el.classList.remove('selected'));
    }
  });

  // Backspace/Delete on selected mermaid block → remove it
  editor.addEventListener('keydown', (e) => {
    const selected = editor.querySelector('.mermaid-block.selected');
    if (!selected) return;

    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      removeMermaidBlock(selected);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      // Insert a new empty paragraph after the mermaid block
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      selected.parentNode.insertBefore(p, selected.nextSibling);
      // Move cursor into the new paragraph
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(p, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      // Deselect the block
      selected.classList.remove('selected');
      markModified();
    }
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
        // If the link has a download attribute (file embed), trigger download
        if (node.getAttribute('download')) {
          triggerDownload(node.href, node.getAttribute('download'));
        } else {
          window.open(node.href, '_blank');
        }
        return;
      }
      node = node.parentNode;
    }

    // Multi-cell selection for tables
    const cell = e.target.closest('td, th');
    if (cell && editor.contains(cell)) {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Click: toggle cell in multi-selection
        e.preventDefault();
        const idx = tableSelectedCells.indexOf(cell);
        if (idx >= 0) {
          cell.classList.remove('table-cell-selected');
          tableSelectedCells.splice(idx, 1);
        } else {
          cell.classList.add('table-cell-selected');
          tableSelectedCells.push(cell);
        }
        if (tableSelectedCells.length > 0) {
          cellRangeAnchor = cell;
        }
      } else if (e.shiftKey && cellRangeAnchor) {
        // Shift+Click: range select from anchor to this cell
        e.preventDefault();
        selectCellRange(cellRangeAnchor, cell);
      } else {
        // Normal click: clear multi-selection (cursor moves for text editing)
        if (tableSelectedCells.length > 0) {
          clearCellSelection();
        }
        cellRangeAnchor = cell;
      }
    } else {
      // Click outside table: clear multi-selection
      if (tableSelectedCells.length > 0) {
        clearCellSelection();
      }
    }
  });

  function handlePaste(e) {
    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;

    const items = clipboardData.items;
    const htmlContent = clipboardData.getData('text/html');
    const textContent = clipboardData.getData('text/plain');

    // Check if cursor is inside an existing table cell
    const sel = window.getSelection();
    let inTableCell = false;
    if (sel && sel.rangeCount > 0) {
      let node = sel.getRangeAt(0).commonAncestorContainer;
      if (node.nodeType === 3) node = node.parentNode;
      inTableCell = node.closest && !!node.closest('td, th');
    }

    // Excel/HTML table paste — create a clean table.
    // Checked BEFORE image paste because Excel puts both table HTML and
    // a screenshot in the clipboard; we want the editable table, not the picture.
    if (!inTableCell && htmlContent && containsTable(htmlContent)) {
      e.preventDefault();
      if (hasTextOutsideTable(htmlContent)) {
        handleMixedPaste(htmlContent);
      } else {
        const result = parseTableFromHtml(htmlContent);
        if (result && result.data.length > 0 && result.data[0].length > 0) {
          insertTableFromData(result.data, result.widths);
        }
      }
      markModified();
      requestAnimationFrame(() => {
        if (tableFormulaManager) tableFormulaManager.refresh();
      });
      return;
    }

    // Tab-separated plain text (e.g. copied from Excel as text)
    if (!inTableCell && textContent && textContent.includes('\t') && !htmlContent) {
      e.preventDefault();
      const result = parseTsvData(textContent);
      if (result && result.data.length > 0 && result.data[0].length > 0) {
        insertTableFromData(result.data, result.widths);
        markModified();
        requestAnimationFrame(() => {
          if (tableFormulaManager) tableFormulaManager.refresh();
        });
      }
      return;
    }

    // File paste (including images) — handle ALL file types from clipboard
    for (let i = 0; i < items.length; i++) {
      const file = items[i].getAsFile && items[i].getAsFile();
      if (file) {
        e.preventDefault();
        if (file.type.startsWith('image/')) {
          uploadAndInsertImage(file);
        } else {
          uploadAndInsertFile(file);
        }
        return;
      }
    }

    // Text/HTML paste (no table, no file)
    if (items.length > 0) {
      if (textContent && !htmlContent) {
        e.preventDefault();
        editor.focus();
        document.execCommand('insertText', false, textContent);
        markModified();
      }
      // For other HTML paste (non-table), let browser handle it natively then
      // re-initialize formula engine on the newly inserted content
      if (htmlContent) {
        requestAnimationFrame(() => {
          if (tableFormulaManager) {
            tableFormulaManager.refresh();
          }
        });
      }
    }
  }

  // ─── Excel/Table Paste Helpers ─────────────────────────────────────

  function containsTable(html) {
    return /<table[\s>]/i.test(html) || /<tr[\s>]/i.test(html);
  }

  /** Check if HTML has meaningful text content outside of <table> elements.
   *  Used to avoid discarding text when pasting mixed content (text + table). */
  function hasTextOutsideTable(html) {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const tables = temp.querySelectorAll('table');
    tables.forEach(t => t.remove());
    const text = temp.textContent.replace(/\s+/g, ' ').trim();
    return text.length > 0;
  }

  /** Extract computed visual styles from a cell element.
   *  Uses getComputedStyle so class-based CSS works (Excel uses classes like .xl65). */
  function parseCellStyles(cell) {
    const sty = {};
    const cs = getComputedStyle(cell);

    const bg = cs.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') sty.bg = bg;

    const fc = cs.color;
    if (fc && fc !== 'rgb(0, 0, 0)') sty.fc = fc;

    const fw = cs.fontWeight;
    if (fw && fw !== '400' && fw !== 'normal') sty.fw = fw;

    const fs = cs.fontSize;
    if (fs) sty.fs = fs;

    const ta = cs.textAlign;
    if (ta && ta !== 'start' && ta !== 'initial') sty.ta = ta;

    return sty;
  }

  function parseTableFromHtml(html) {
    // Use a live container so getComputedStyle resolves class-based CSS.
    // Excel HTML uses <style> tags with classes (.xl65, .xl66, …), not inline styles.
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;';
    container.innerHTML = html;
    document.body.appendChild(container);

    try {
      const tables = container.querySelectorAll('table');
      let allData = [];
      let allWidths = [];
      let firstTable = true;

      for (const table of tables) {
        const result = parseHtmlTable(table);
        if (!result) continue;

        if (firstTable) {
          allWidths = result.widths;
          firstTable = false;
        }

        for (const row of result.data) {
          // Pad shorter rows from secondary tables to match column count
          if (allData.length > 0) {
            const targetLen = Math.max(allData[0].length, row.length);
            while (row.length < targetLen) row.push({ text: '', colspan: 1, rowspan: 1, tagName: 'TD', sty: {} });
          }
          allData.push(row);
        }
      }

      return allData.length > 0 ? { data: allData, widths: allWidths } : null;
    } finally {
      document.body.removeChild(container);
    }
  }

  /** Parse a single <table> element with colspan/rowspan support */
  function parseHtmlTable(table) {
    const trs = table.querySelectorAll('tr');
    if (trs.length === 0) return null;

    // Extract column widths from <colgroup>
    const widths = [];
    const colgroup = table.querySelector('colgroup');
    if (colgroup) {
      colgroup.querySelectorAll('col').forEach(col => { widths.push(extractElWidth(col)); });
    }
    // Fallback: extract widths from first row cells
    if (widths.length === 0 && trs[0]) {
      trs[0].querySelectorAll('td, th').forEach(cell => { widths.push(extractElWidth(cell)); });
    }

    const data = [];
    const rowspanMap = {};       // { colIndex: remainingRows }
    let maxCols = 0;

    trs.forEach((tr, ri) => {
      const cells = tr.querySelectorAll('td, th');
      const row = [];
      let col = 0;
      let ci = 0;

      while (ci < cells.length) {
        // Skip columns occupied by rowspan from previous rows
        while (rowspanMap[col]) {
          row.push(null);
          rowspanMap[col]--;
          if (rowspanMap[col] <= 0) delete rowspanMap[col];
          col++;
        }

        const cell = cells[ci];
        const colspan = Math.min(parseInt(cell.getAttribute('colspan'), 10) || 1, 50);
        const rowspan = Math.min(parseInt(cell.getAttribute('rowspan'), 10) || 1, 50);
        const text = cell.textContent.trim();

        // Cell origin (preserve original tag: TD or TH) and inline styles
        const sty = parseCellStyles(cell);
        row.push({ text, colspan, rowspan, tagName: cell.tagName, sty });

        // Mark spanned columns in current row
        for (let c = 1; c < colspan; c++) row.push(null);

        // Track rowspan for subsequent rows
        if (rowspan > 1) {
          for (let c = 0; c < colspan; c++) {
            const ongoing = rowspanMap[col + c] || 0;
            if (rowspan - 1 > ongoing) rowspanMap[col + c] = rowspan - 1;
          }
        }

        col += colspan;
        ci++;
      }

      // Fill remaining rowspan columns at end of row
      for (const rcStr of Object.keys(rowspanMap)) {
        const rc = parseInt(rcStr, 10);
        if (rc >= col && rowspanMap[rc] > 0) {
          while (col < rc) { row.push({ text: '', colspan: 1, rowspan: 1, tagName: 'TD', sty: {} }); col++; }
          row.push(null);
          rowspanMap[rc]--;
          if (rowspanMap[rc] <= 0) delete rowspanMap[rc];
          col++;
        }
      }

      if (row.length > 0) {
        data.push(row);
        maxCols = Math.max(maxCols, row.length);
      }
    });

    // Normalize all rows to maxCols
    for (const row of data) {
      while (row.length < maxCols) {
        const rc = row.length;
        if (rowspanMap[rc] && rowspanMap[rc] > 0) {
          row.push(null);
          rowspanMap[rc]--;
          if (rowspanMap[rc] <= 0) delete rowspanMap[rc];
        } else {
          row.push({ text: '', colspan: 1, rowspan: 1, tagName: 'TD', sty: {} });
        }
      }
    }

    return { data, widths };
  }

  /** Extract pixel width from a <col>, <td>, or <th> element */
  function extractElWidth(el) {
    // Try width attribute first
    const attr = el.getAttribute('width');
    if (attr) { const w = parseInt(attr, 10); if (!isNaN(w) && w > 0) return w; }
    // Try inline style width
    const style = el.getAttribute('style');
    if (style) {
      const m = style.match(/width:\s*(\d+(?:\.\d+)?)\s*(px|pt)?/i);
      if (m) {
        let v = parseFloat(m[1]);
        if (m[2] && m[2].toLowerCase() === 'pt') v = v * 3;
        if (!isNaN(v) && v > 0) return Math.round(v);
      }
    }
    return 80;
  }

  function parseTsvData(text) {
    const lines = text.split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) return null;
    const data = lines.map(line =>
      line.split('\t').map(cell => ({ text: cell.trim(), colspan: 1, rowspan: 1, tagName: 'TD', sty: {} }))
    );
    return data.length > 0 && data[0].length > 0 ? { data, widths: [] } : null;
  }

  /** Build a custom table HTML string from parsed data.
   *  Shared by insertTableFromData and handleMixedPaste. */
  function buildTableHtmlString(data, widths) {
    let cols = 0;
    for (const row of data) {
      let c = 0;
      for (const cell of row) {
        if (cell && typeof cell === 'object') c += cell.colspan || 1;
      }
      cols = Math.max(cols, c);
    }

    const colWidths = [];
    for (let i = 0; i < cols; i++) {
      colWidths.push((widths && widths[i]) || 80);
    }

    let html = '<table><colgroup>';
    for (let i = 0; i < cols; i++) {
      html += '<col style="width:' + colWidths[i] + 'px">';
    }
    html += '</colgroup><tbody>';

    const rows = data.length;
    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      for (const cell of data[r]) {
        if (cell === null) continue;
        const cellTag = cell.tagName.toLowerCase();
        const text = cell.text;
        const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        let styleStr = '';
        if (cell.sty) {
          const parts = [];
          if (cell.sty.bg) parts.push('background:' + cell.sty.bg);
          if (cell.sty.fc) parts.push('color:' + cell.sty.fc);
          if (cell.sty.fw) parts.push('font-weight:' + cell.sty.fw);
          if (cell.sty.fs) parts.push('font-size:' + cell.sty.fs);
          if (cell.sty.ta) parts.push('text-align:' + cell.sty.ta);
          if (parts.length > 0) styleStr = ' style="' + parts.join(';') + '"';
        }
        let attrs = '';
        if (cell.colspan > 1) attrs += ' colspan="' + cell.colspan + '"';
        if (cell.rowspan > 1) attrs += ' rowspan="' + cell.rowspan + '"';
        html += '<' + cellTag + styleStr + attrs + '>' + (escaped || '<br>') + '</' + cellTag + '>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  function insertTableFromData(data, widths) {
    const sel = window.getSelection();
    if (sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);

    const html = buildTableHtmlString(data, widths);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const tableEl = wrapper.firstElementChild;

    range.deleteContents();
    range.insertNode(tableEl);

    // Move cursor to second row first cell (skip header row)
    // For single-row tables, position cursor right after the table
    const rows = data.length;
    const newRange = document.createRange();
    if (rows > 1) {
      const firstCell = tableEl.querySelector('tbody tr:nth-child(2) td');
      if (firstCell) {
        newRange.setStart(firstCell, 0);
      } else {
        newRange.setStartAfter(tableEl);
      }
    } else {
      newRange.setStartAfter(tableEl);
    }
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }

  /** Paste mixed content (text + tables) preserving text formatting and
   *  using custom table elements for <table> portions. */
  function handleMixedPaste(htmlContent) {
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;';
    container.innerHTML = htmlContent;
    document.body.appendChild(container);

    try {
      const allTables = container.querySelectorAll('table');
      for (let i = allTables.length - 1; i >= 0; i--) {
        const table = allTables[i];
        if (!table.parentNode) continue;
        const result = parseHtmlTable(table);
        if (result && result.data.length > 0 && result.data[0].length > 0) {
          const customHtml = buildTableHtmlString(result.data, result.widths);
          const wrapper = document.createElement('div');
          wrapper.innerHTML = customHtml;
          table.parentNode.replaceChild(wrapper.firstElementChild, table);
        }
      }

      const nonContent = container.querySelectorAll('style, script, link, meta');
      nonContent.forEach(el => el.remove());

      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const fragment = document.createDocumentFragment();
        while (container.firstChild) {
          fragment.appendChild(container.firstChild);
        }
        range.deleteContents();
        range.insertNode(fragment);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } finally {
      if (container.parentNode) {
        document.body.removeChild(container);
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

  async function uploadAndInsertFile(file) {
    if (!currentTab) return;
    try {
      const result = await apiUploadFile(`/api/${encodeURIComponent(currentTab)}/upload/file`, file, file.name || 'file');
      editor.focus();
      // Build a human-readable size string
      const size = result.size || 0;
      let sizeStr = '';
      if (size < 1024) {
        sizeStr = size + ' B';
      } else if (size < 1024 * 1024) {
        sizeStr = (size / 1024).toFixed(1) + ' KB';
      } else {
        sizeStr = (size / (1024 * 1024)).toFixed(1) + ' MB';
      }
      const displayName = result.filename || file.name || 'file';
      const fileHtml = '<div class="file-embed" contenteditable="false" data-filename="' + escapeHtml(displayName) + '" data-filesize="' + size + '">' +
        '<a href="' + result.url + '" download="' + escapeHtml(displayName).replace(/"/g, '&quot;') + '">' +
        '📎 ' + escapeHtml(displayName) + ' (' + sizeStr + ')' +
        '</a>' +
        '</div>';
      document.execCommand('insertHTML', false, fileHtml);
      markModified();
    } catch (e) {
      console.error('File paste upload failed:', e);
    }
  }

  // ─── Copy/Clipboard Handling for Formula Cells ──────────────────────

  editor.addEventListener('copy', function(e) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;

    // Check if selection is inside a single table cell
    const startCell = range.startContainer.nodeType === 3
      ? range.startContainer.parentNode?.closest('td, th')
      : range.startContainer.closest('td, th');
    const endCell = range.endContainer.nodeType === 3
      ? range.endContainer.parentNode?.closest('td, th')
      : range.endContainer.closest('td, th');

    // Only intercept when copying from a single cell that has a formula
    if (startCell && startCell === endCell && startCell.getAttribute('data-formula')) {
      const formula = startCell.getAttribute('data-formula');
      e.preventDefault();
      e.clipboardData.setData('text/plain', startCell.textContent);
      e.clipboardData.setData('text/html',
        '<td data-formula="' + formula.replace(/"/g, '&quot;') + '">' + startCell.innerHTML + '</td>');
    }
  });

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

    // Detect if right-click is inside a mermaid block
    const mermaidBlock = e.target.closest('.mermaid-block');
    const inMermaid = mermaidBlock && editor.contains(mermaidBlock);

    // Preserve multi-selection when right-clicking on a cell that is part of the selection
    if (inTable && tableSelectedCells.indexOf(tableCell) >= 0) {
      // Keep current multi-selection, right-clicked cell is part of it
      ctxMenu._tableCell = tableCell;
    } else {
      // Right-click on cell not in selection: clear multi-selection
      if (tableSelectedCells.length > 0) clearCellSelection();
      ctxMenu._tableCell = inTable ? tableCell : null;
      if (inTable) cellRangeAnchor = tableCell;
    }

    const linkEl = e.target.closest('a');
    const onLink = linkEl && editor.contains(linkEl);
    ctxMenu._linkElement = onLink ? linkEl : null;

    // Store reference to the mermaid block for the save action
    ctxMenu._mermaidBlock = inMermaid ? mermaidBlock : null;

    // Toggle context menu items based on context
    const mainItems = [].slice.call(ctxMenu.querySelectorAll('#ctx-insert-table, #ctx-insert-mermaid, #ctx-insert-link'));
    const tableItems = [].slice.call(ctxMenu.querySelectorAll('.ctx-table-item, .ctx-table-sep'));
    const mermaidItems = [].slice.call(ctxMenu.querySelectorAll('.ctx-mermaid-item, .ctx-mermaid-sep'));

    function show(items) { items.forEach(el => { el.style.display = ''; }); }
    function hide(items) { items.forEach(el => { el.style.display = 'none'; }); }

    if (onLink) {
      hide(mainItems);
      hide(tableItems);
      hide(mermaidItems);
      $('#ctx-insert-link').style.display = '';
    } else if (inTable) {
      hide(mainItems);
      show(tableItems);
      hide(mermaidItems);
    } else if (inMermaid) {
      hide(mainItems);
      hide(tableItems);
      show(mermaidItems);
    } else {
      show(mainItems);
      hide(tableItems);
      hide(mermaidItems);
    }

    // Refresh context menu item text to match current language
    ctxMenu.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
    // Override link item text based on context (edit vs insert)
    $('#ctx-insert-link').textContent = onLink ? t('edit_link') : t('insert_link');

    positionMenuAtEvent(ctxMenu, e);
    ctxMenu.dataset.hasSelection = selection.toString().length > 0 ? 'true' : 'false';
  });

  $('#ctx-mermaid-save-png').addEventListener('click', () => {
    const blockEl = ctxMenu._mermaidBlock;
    if (!blockEl) return;
    ctxMenu.style.display = 'none';
    saveMermaidAsPng(blockEl);
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

  $('#ctx-insert-mermaid').addEventListener('click', () => {
    ctxMenu.style.display = 'none';
    restoreContextMenuRange();
    promptInsertMermaid();
  });

  $('#ctx-insert-link').addEventListener('click', () => {
    ctxMenu.style.display = 'none';
    const linkEl = ctxMenu._linkElement;
    if (linkEl) {
      promptInsertLink(linkEl);
    } else {
      restoreContextMenuRange();
      promptInsertLink(null);
    }
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

  $('#ctx-cell-format').addEventListener('click', () => {
    ctxMenu.style.display = 'none';
    restoreContextMenuRange();
    showCellFormatDialog();
  });

  $('#cell-format-btn-ok').addEventListener('click', () => {
    applyCellFormat();
    $('#cell-format-dialog').style.display = 'none';
  });
  $('#cell-format-btn-cancel').addEventListener('click', () => {
    $('#cell-format-dialog').style.display = 'none';
  });
  $('#cell-format-bgcolor-reset').addEventListener('click', () => {
    $('#cell-format-bgcolor').value = '#ffffff';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#cell-format-dialog').style.display !== 'none') {
      $('#cell-format-dialog').style.display = 'none';
    }
  });
  $('#cell-format-dialog').addEventListener('click', (e) => {
    if (e.target === $('#cell-format-dialog')) {
      $('#cell-format-dialog').style.display = 'none';
    }
  });

  function rgbToHex(rgb) {
    const m = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if (!m) return rgb;
    return '#' + [1,2,3].map(i => parseInt(m[i], 10).toString(16).padStart(2, '0')).join('');
  }

  function showCellFormatDialog() {
    const cell = ctxMenu._tableCell;
    if (!cell) return;

    // Determine which cells to format: multi-selection or single context cell
    const isMultiCell = tableSelectedCells.length > 1 && tableSelectedCells.indexOf(cell) >= 0;
    const targetCells = isMultiCell ? tableSelectedCells : [cell];
    ctxMenu._formatCells = targetCells;

    // Show count indicator when multiple cells selected
    const countEl = $('#cell-format-count');
    if (isMultiCell) {
      countEl.textContent = '已选中 ' + targetCells.length + ' 个单元格';
      countEl.style.display = '';
    } else {
      countEl.style.display = 'none';
    }

    // Read current values from the context cell (first cell)
    const currentBg = cell.style.backgroundColor || '';
    const currentVAlign = cell.style.verticalAlign || '';
    const currentHAlign = cell.style.textAlign || '';

    let hexColor = '#ffffff';
    if (currentBg && currentBg !== 'transparent') {
      hexColor = currentBg.startsWith('#') ? currentBg : rgbToHex(currentBg);
    }
    if (!/^#[0-9a-f]{6}$/i.test(hexColor)) hexColor = '#ffffff';
    $('#cell-format-bgcolor').value = hexColor;

    const valignSelect = $('#cell-format-valign');
    const halignSelect = $('#cell-format-halign');
    valignSelect.value = currentVAlign || 'middle';
    halignSelect.value = currentHAlign || '';

    $('#cell-format-dialog').style.display = 'flex';
  }

  function applyCellFormat() {
    const cells = ctxMenu._formatCells || (ctxMenu._tableCell ? [ctxMenu._tableCell] : []);
    if (!cells.length) return;

    const bgColor = $('#cell-format-bgcolor').value;
    const vAlign = $('#cell-format-valign').value;
    const hAlign = $('#cell-format-halign').value;

    for (const cell of cells) {
      if (bgColor && bgColor !== '#ffffff') {
        cell.style.backgroundColor = bgColor;
      } else {
        cell.style.backgroundColor = '';
      }

      if (vAlign) {
        cell.style.verticalAlign = vAlign;
      } else {
        cell.style.verticalAlign = '';
      }

      if (hAlign) {
        cell.style.textAlign = hAlign;
      } else {
        cell.style.textAlign = '';
      }
    }

    markModified();
    tableFormulaManager?.onTableModified();
  }

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

  // ─── Mobile Sidebar Toggle ────────────────────────────────────────────
  if (sidebarToggle && sidebarBackdrop) {
    function toggleSidebar(open) {
      const sidebar = $('#sidebar');
      if (!sidebar) return;
      const isOpen = open !== undefined ? open : !sidebar.classList.contains('sidebar-open');
      sidebar.classList.toggle('sidebar-open', isOpen);
      sidebarBackdrop.classList.toggle('active', isOpen);
      document.body.style.overflow = isOpen ? 'hidden' : '';
    }
    sidebarToggle.addEventListener('click', function() { toggleSidebar(); });
    if (mobileSidebarHint) {
      mobileSidebarHint.addEventListener('click', function() {
        toggleSidebar();
        mobileSidebarHint.style.display = 'none';
      });
    }
    sidebarBackdrop.addEventListener('click', function() { toggleSidebar(false); });
    window.addEventListener('resize', function() {
      if (window.innerWidth > 768) {
        const sidebar = $('#sidebar');
        if (sidebar && sidebar.classList.contains('sidebar-open')) {
          sidebar.classList.remove('sidebar-open');
          sidebarBackdrop.classList.remove('active');
          document.body.style.overflow = '';
        }
      }
    });
  }

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
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ─── Tab Context Menu ─────────────────────────────────────────────────

  let tabCtxName = null;

  function showTabContextMenu(e, name) {
    tabCtxName = name;
    const canWrite = canEditTab(name);

    // Anonymous or non-owner: disable everything
    if (!canWrite) {
      tabCtxMenu.querySelectorAll('.tab-ctx-item').forEach(function(item) {
        item.classList.add('ctx-menu-disabled');
      });
      // Also disable submenu export items
      tabCtxMenu.querySelectorAll('.ctx-submenu-item').forEach(function(item) {
        item.classList.add('ctx-menu-disabled');
      });
      positionMenuAtEvent(tabCtxMenu, e);
      return;
    }

    // Clear all disabled states first
    tabCtxMenu.querySelectorAll('.tab-ctx-item, .ctx-submenu-item').forEach(function(item) {
      item.classList.remove('ctx-menu-disabled');
    });

    const setPwItem = tabCtxMenu.querySelector('[data-action="set-password"]');
    const changePwItem = tabCtxMenu.querySelector('[data-action="change-password"]');
    const removePwItem = tabCtxMenu.querySelector('[data-action="remove-password"]');
    const pwSep = $('#tab-ctx-pw-sep');
    const exportItems = tabCtxMenu.querySelectorAll('.ctx-submenu-item');
    const isEncrypted = encryptedTabsCache && encryptedTabsCache.includes(name);
    const isUnlocked = unlockedTabs.has(name);
    // Set Owner visibility - admin only, disabled when public_edit is active
    const setOwnerItem = $('#tab-ctx-set-owner');
    const ownerSep = $('#tab-ctx-owner-sep');
    if (currentUser && currentUser.role === 'admin') {
      setOwnerItem.style.display = '';
      ownerSep.style.display = '';
      if (kbPublicEdit[name]) {
        setOwnerItem.classList.add('ctx-menu-disabled');
      } else {
        setOwnerItem.classList.remove('ctx-menu-disabled');
      }
    } else {
      setOwnerItem.style.display = 'none';
      ownerSep.style.display = 'none';
    }
    // Hide tab ("隐藏") visibility:
    //   admin can hide any tab; user can only hide own tabs; anonymous cannot hide
    const closeTabItem = tabCtxMenu.querySelector('[data-action="close-tab"]');
    if (closeTabItem) {
      const canHide = currentUser && (
        currentUser.role === 'admin' || kbTabOwners[name] === currentUser.username
      );
      closeTabItem.style.display = canHide ? '' : 'none';
    }
    if (isEncrypted) {
      setPwItem.style.display = 'none';
      changePwItem.style.display = '';
      removePwItem.style.display = '';
      pwSep.style.display = '';
      exportItems.forEach(function(item) {
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
      exportItems.forEach(function(item) { item.classList.remove('ctx-menu-disabled'); });
    }
    // Public edit toggle: only admin/owner can toggle; show appropriate text
    const togglePubItem = $('#tab-ctx-toggle-public-edit');
    if (togglePubItem) {
      const isAdminOrOwner = currentUser && (
        currentUser.role === 'admin' || kbTabOwners[name] === currentUser.username
      );
      if (isAdminOrOwner) {
        togglePubItem.classList.remove('ctx-menu-disabled');
        if (kbPublicEdit[name]) {
          togglePubItem.textContent = t('disable_public_edit');
        } else {
          togglePubItem.textContent = t('enable_public_edit');
        }
      } else {
        togglePubItem.classList.add('ctx-menu-disabled');
        togglePubItem.textContent = t('enable_public_edit');
      }
    }
    const canExport = currentUser && (currentUser.role === 'admin' || kbTabOwners[name] === currentUser.username || kbPublicEdit[name]);
    if (!canExport) {
      exportItems.forEach(function(item) { item.classList.add('ctx-menu-disabled'); });
    }
    positionMenuAtEvent(tabCtxMenu, e);
  }

  function triggerDownload(url, filename) {
    // For URLs that need auth, use fetch + blob
    if (authToken) {
      fetch(url, { headers: { 'X-Auth-Token': authToken } })
        .then(res => {
          if (!res.ok) throw new Error('Download failed');
          const disposition = res.headers.get('Content-Disposition');
          let name = filename || '';
          if (!name && disposition) {
            const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
            if (match) name = match[1].replace(/['"]/g, '');
          }
          return res.blob().then(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
          });
        })
        .catch(err => {
          console.error('Download failed:', err);
          showDialog(t('error_dialog_title'), `<p>${t('download_failed') || 'Download failed'}</p>`);
        });
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
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
    } else if (action === 'export-tab-md') {
      triggerDownload(`/api/${encodedName}/export/md`);
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
    } else if (action === 'export-tree-md') {
      triggerDownload(`/api/${encodedTab}/export/md/${id}`);
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
      if (item.classList.contains('ctx-menu-disabled')) return;
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
        case 'set-owner':
          if (kbPublicEdit[name]) {
            // Blocked when public edit is enabled (discussion tab unlocked)
            break;
          }
          showOwnerDialog(name);
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
        case 'toggle-public-edit':
          togglePublicEdit(name);
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

  // ─── Multi-Cell Selection State ─────────────────────────────────────
  let tableSelectedCells = [];
  let cellRangeAnchor = null;

  function clearCellSelection() {
    tableSelectedCells.forEach(cell => cell.classList.remove('table-cell-selected'));
    tableSelectedCells = [];
    cellRangeAnchor = null;
  }

  function getCellTableGrid(cell) {
    const table = cell.closest('table');
    if (!table) return null;
    const allRows = table.querySelectorAll('tr');
    let rowIdx = -1;
    let colIdx = -1;
    for (let r = 0; r < allRows.length; r++) {
      const cells = allRows[r].querySelectorAll('td, th');
      for (let c = 0; c < cells.length; c++) {
        if (cells[c] === cell) { rowIdx = r; colIdx = c; break; }
      }
      if (rowIdx >= 0) break;
    }
    if (rowIdx < 0 || colIdx < 0) return null;
    return { table, rows: allRows, row: rowIdx, col: colIdx };
  }

  function selectCellRange(anchorCell, targetCell) {
    const anchor = getCellTableGrid(anchorCell);
    const target = getCellTableGrid(targetCell);
    if (!anchor || !target || anchor.table !== target.table) return;

    clearCellSelection();

    const r1 = Math.min(anchor.row, target.row);
    const r2 = Math.max(anchor.row, target.row);
    const c1 = Math.min(anchor.col, target.col);
    const c2 = Math.max(anchor.col, target.col);

    for (let r = r1; r <= r2; r++) {
      const row = anchor.rows[r];
      if (!row) continue;
      const cells = row.querySelectorAll('td, th');
      for (let c = c1; c <= c2; c++) {
        const cell = cells[c];
        if (cell) {
          cell.classList.add('table-cell-selected');
          tableSelectedCells.push(cell);
        }
      }
    }
    cellRangeAnchor = anchorCell;
  }

  class TableFormulaManager {
    constructor() {
      this.hfInstances = new Map();
      this.activeCell = null;
      this.activeTable = null;
      this.isUpdating = false;
      this._formulaChangeHandler = null;
      this._cellClickHandler = null;
      this._editorInputHandler = null;
      this._dropdownIndex = -1;
      this._dropdownItems = null;
      this._cachedFnNames = null;
    }

    init() {
      this.scanTables();
      this.bindEvents();
    }

    refresh() {
      this.destroy();
      this.scanTables();
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
      formulaBar.style.display = 'none';
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

    normalizeFormula(formula) {
      let result = formula.replace(/（/g, '(').replace(/）/g, ')');
      // Normalize aggregate function names to uppercase for consistent matching
      for (const func of AGGREGATE_FUNCS) {
        const re = new RegExp('(?<![\\w"\'])(' + this.escapeRegex(func) + ')(?=\\()', 'gi');
        result = result.replace(re, func);
      }
      return result;
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

      let result = this.normalizeFormula(formula);
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

      // Resolve bare column-letter references (e.g. SUM(B) → SUM(B:B))
      for (const func of AGGREGATE_FUNCS) {
        const colRegex = new RegExp(
          '(?<=' + func + '\\()([A-Z])(?=\\))', 'gi'
        );
        result = result.replace(colRegex, (match) => {
          const colIdx = match.charCodeAt(0) - 65;
          if (colIdx >= 0 && colIdx < 26) {
            const colLetter = this.colLetter(colIdx);
            return colLetter + ':' + colLetter;
          }
          return match;
        });
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

    /** Find the deepest text node containing the display value, so we can
        update it in-place without destroying formatting wrappers. */
    _findDisplayTextNode(cell) {
      for (let i = 0; i < cell.childNodes.length; i++) {
        const child = cell.childNodes[i];
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent.trim()) return child;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const found = this._findDisplayTextNode(child);
          if (found) return found;
        }
      }
      return null;
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
              const textNode = this._findDisplayTextNode(cell);
              if (textNode) {
                textNode.textContent = displayText;
              } else {
                cell.textContent = displayText;
              }
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
      const cellText = formula || cell.textContent;
      formulaInput.textContent = cellText;

      // Show autocomplete if this cell already has a formula
      if (cellText.startsWith('=')) {
        this._showFormulaDropdown(cellText);
      } else {
        this._hideFormulaDropdown();
      }

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
        // Hide formula bar for cells without formulas
        if (!cell.hasAttribute('data-formula') && !(cell.textContent || '').trim().startsWith('=')) {
          formulaBar.style.display = 'none';
        }
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
        this._hideFormulaDropdown();
      } else if (newValue.startsWith('=')) {
        const normalized = this.normalizeFormula(newValue);
        cell.setAttribute('data-formula', normalized);
        cell.textContent = normalized;
      } else {
        cell.removeAttribute('data-formula');
        cell.textContent = newValue;
        this._hideFormulaDropdown();
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
            const text = this.normalizeFormula(cell.textContent.trim());
            if (text.startsWith('=')) {
              console.log('[Formula] Detected formula in cell:', text);
              cell.setAttribute('data-formula', text);
              formulaInput.textContent = text;
              if (this.activeCell !== cell || formulaBar.style.display === 'none') {
                this.activeCell = cell;
                this.activeTable = this.findCellTable(cell);
                formulaBar.style.display = '';
              }
              this._showFormulaDropdown(text);
            } else if (cell.getAttribute('data-formula')) {
              cell.removeAttribute('data-formula');
              formulaInput.textContent = '';
              this._hideFormulaDropdown();
            }
            // If cell has a formula and text still matches its computed value,
            // this is a formatting-only change (backColor etc.) so skip rebuild.
            const existingFormula = cell.getAttribute('data-formula');
            if (existingFormula) {
              const entry = this.hfInstances.get(table);
              if (entry) {
                const tr = cell.closest('tr');
                if (tr) {
                  const allRows = table.querySelectorAll('tr');
                  const rowCells = tr.querySelectorAll('td, th');
                  let ri = -1, ci = -1;
                  for (let i = 0; i < allRows.length; i++) {
                    if (allRows[i] === tr) { ri = i; break; }
                  }
                  for (let i = 0; i < rowCells.length; i++) {
                    if (rowCells[i] === cell) { ci = i; break; }
                  }
                  if (ri >= 0 && ci >= 0) {
                    try {
                      const value = entry.hf.getCellValue({ sheet: 0, row: ri, col: ci });
                      const expectedText = value != null ? String(value) : '';
                      if (text === expectedText) return;
                    } catch(e) {}
                  }
                }
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

    // ─── Formula Autocomplete ────────────────────────────────────────────

    _getFormulaFunctionNames() {
      if (this._cachedFnNames) return this._cachedFnNames;
      try {
        const names = HyperFormula.getRegisteredFunctionNames
          ? HyperFormula.getRegisteredFunctionNames()
          : null;
        if (names && names.length) {
          this._cachedFnNames = names.slice().sort();
        } else {
          this._cachedFnNames = AGGREGATE_FUNCS.slice();
        }
      } catch (e) {
        this._cachedFnNames = AGGREGATE_FUNCS.slice();
      }
      return this._cachedFnNames;
    }

    _renderDropdownItems(items) {
      const dropdown = $('#formula-dropdown');
      if (!items || !items.length) {
        dropdown.innerHTML = '<div class="fd-empty">—</div>';
        dropdown.style.display = '';
        this._dropdownIndex = -1;
        this._dropdownItems = null;
        return;
      }
      dropdown.innerHTML = items.map((name, i) =>
        '<div class="fd-item' + (i === 0 ? ' fd-active' : '') + '" data-index="' + i + '">' +
          '<span class="fd-name">' + name + '</span>' +
          '<span class="fd-desc">function</span>' +
        '</div>'
      ).join('');
      dropdown.style.display = '';
      this._dropdownIndex = 0;
      this._dropdownItems = items;
    }

    _showFormulaDropdown(formulaText) {
      const dropdown = $('#formula-dropdown');
      formulaText = this.normalizeFormula(formulaText || '');
      if (!formulaText || !formulaText.startsWith('=')) {
        dropdown.style.display = 'none';
        return;
      }

      // Extract the partial token after '=' (last word if cursor is mid-formula)
      const eq = formulaText.indexOf('=');
      const after = formulaText.slice(eq + 1);
      const tokenMatch = after.match(/([A-Za-z]\w*)$/);
      const partial = tokenMatch ? tokenMatch[1].toUpperCase() : '';

      const allFns = this._getFormulaFunctionNames();

      if (!partial) {
        // No word token at cursor — show all functions only when just "=" or "=("
        const trimmed = after.trim();
        if (!trimmed || trimmed === '(' || trimmed.endsWith('(')) {
          this._renderDropdownItems(allFns);
        } else {
          dropdown.style.display = 'none';
        }
        return;
      }

      const matched = allFns.filter(n => n.startsWith(partial));
      this._renderDropdownItems(matched);
    }

    _hideFormulaDropdown() {
      $('#formula-dropdown').style.display = 'none';
      this._dropdownIndex = -1;
      this._dropdownItems = null;
    }

    _applyFormulaDropdown() {
      if (this._dropdownIndex < 0 || !this._dropdownItems) return;
      const selected = this._dropdownItems[this._dropdownIndex];
      const text = formulaInput.textContent || '';
      const eqIdx = text.indexOf('=');
      if (eqIdx === -1) return;

      const after = text.slice(eqIdx + 1);
      const tokenMatch = after.match(/([A-Za-z]\w*)$/);

      let newText, cursorPos;
      if (tokenMatch) {
        const beforeToken = text.slice(0, eqIdx + 1 + after.length - tokenMatch[1].length);
        const afterToken = text.slice(eqIdx + 1 + after.length);
        newText = beforeToken + selected + '(' + afterToken;
        cursorPos = beforeToken.length + selected.length + 1;
      } else {
        // No partial token (e.g. just "="): insert selected function after "="
        newText = '=' + selected + '(';
        cursorPos = newText.length;
      }
      formulaInput.textContent = newText;
      const sel = window.getSelection();
      const range = document.createRange();
      if (formulaInput.firstChild) {
        range.setStart(formulaInput.firstChild, Math.min(cursorPos, newText.length));
        range.collapse(true);
      } else {
        range.selectNodeContents(formulaInput);
        range.collapse(false);
      }
      sel.removeAllRanges();
      sel.addRange(range);

      this._hideFormulaDropdown();
      formulaInput.focus();
    }

    _navigateDropdown(direction) {
      const items = $('#formula-dropdown').querySelectorAll('.fd-item');
      if (!items.length) return;
      const prev = this._dropdownIndex;
      const next = Math.max(0, Math.min(items.length - 1, prev + direction));
      if (prev === next) return;
      if (prev >= 0) items[prev].classList.remove('fd-active');
      items[next].classList.add('fd-active');
      items[next].scrollIntoView({ block: 'nearest' });
      this._dropdownIndex = next;
    }

    bindEvents() {
      editor.addEventListener('click', (e) => this.onCellClick(e));

      formulaInput.addEventListener('blur', () => {
        // Delay hiding so click on dropdown item registers first
        setTimeout(() => this._hideFormulaDropdown(), 200);
        this.onFormulaInputChange(false);
      });

      formulaInput.addEventListener('keydown', (e) => {
        if (this._dropdownItems && this._dropdownItems.length) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            this._navigateDropdown(1);
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            this._navigateDropdown(-1);
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            this._applyFormulaDropdown();
            return;
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            this._applyFormulaDropdown();
            return;
          }
          if (e.key === 'Escape') {
            this._hideFormulaDropdown();
            return;
          }
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          this.onFormulaInputChange(false);
        }
      });

      formulaInput.addEventListener('input', () => {
        this._showFormulaDropdown(formulaInput.textContent || '');
      });

      $('#formula-dropdown').addEventListener('click', (e) => {
        const item = e.target.closest('.fd-item');
        if (!item) return;
        const idx = parseInt(item.dataset.index, 10);
        if (!isNaN(idx)) {
          this._dropdownIndex = idx;
          this._applyFormulaDropdown();
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

  // ─── OCR Image Text Copy (Offline) ─────────────────────────────────

  var ocrBtn = null;
  var ocrActiveImg = null;
  var ocrHideTimer = null;

  function initOcrImageCopy() {
    ocrBtn = document.createElement('div');
    ocrBtn.className = 'ocr-copy-btn';
    ocrBtn.innerHTML = '<span class="ocr-copy-icon">📋</span> 复制文字';
    ocrBtn.style.display = 'none';
    document.body.appendChild(ocrBtn);

    editor.addEventListener('mouseover', function(e) {
      var img = e.target.closest ? e.target.closest('img') : null;
      if (img && editor.contains(img) && img.src) {
        ocrActiveImg = img;
        positionOcrBtn(img);
        ocrBtn.style.display = 'inline-flex';
        if (ocrHideTimer) {
          clearTimeout(ocrHideTimer);
          ocrHideTimer = null;
        }
      }
    });

    editor.addEventListener('mouseout', function(e) {
      var img = e.target.closest ? e.target.closest('img') : null;
      if (!img || !editor.contains(img)) return;
      var to = e.relatedTarget;
      if (to && (to === ocrBtn || ocrBtn.contains(to))) return;
      if (ocrHideTimer) clearTimeout(ocrHideTimer);
      ocrHideTimer = setTimeout(function() {
        ocrBtn.style.display = 'none';
        ocrActiveImg = null;
        ocrHideTimer = null;
      }, 300);
    });

    ocrBtn.addEventListener('mouseover', function() {
      if (ocrHideTimer) {
        clearTimeout(ocrHideTimer);
        ocrHideTimer = null;
      }
      ocrBtn.style.display = 'inline-flex';
    });
    ocrBtn.addEventListener('mouseout', function() {
      ocrBtn.style.display = 'none';
      ocrActiveImg = null;
    });

    ocrBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      e.preventDefault();
      var img = ocrActiveImg;
      if (!img || !img.src) return;
      ocrBtn.style.display = 'none';
      ocrActiveImg = null;

      (async function() {
        try {
          showOcrProgress('正在准备 OCR...');
          var path = '/static/tesseract/';
          var result = await Tesseract.recognize(img, 'chi_sim+eng+jpn+kor', {
            workerPath: path + 'worker.min.js',
            corePath: path,
            langPath: path + 'lang-data',
            logger: function(m) {
              if (m.status === 'loading tesseract core') {
                showOcrProgress('加载识别引擎...');
              } else if (m.status === 'initializing tesseract') {
                showOcrProgress('初始化引擎...');
              } else if (m.status === 'loading language traineddata') {
                showOcrProgress('加载语言数据 ' + (m.progress ? Math.round(m.progress * 100) + '%' : ''));
              } else if (m.status === 'initializing api') {
                showOcrProgress('初始化 API...');
              } else if (m.status === 'recognizing text') {
                showOcrProgress('识别中 ' + (m.progress ? Math.round(m.progress * 100) + '%' : ''));
              }
            }
          });
          var text = (result.data.text || '').trim();
          if (!text) {
            showOcrToast('未在图片中识别到文字', false);
            return;
          }
          showOcrResultPanel(result.data, img);
        } catch (err) {
          console.error('OCR failed:', err);
          showOcrToast('OCR 识别失败: ' + (err.message || '未知错误'), false);
        }
      })();
    });

    function onViewportChange() {
      if (ocrBtn.style.display !== 'none' && ocrActiveImg) {
        positionOcrBtn(ocrActiveImg);
      }
    }
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
  }

  function positionOcrBtn(img) {
    var rect = img.getBoundingClientRect();
    ocrBtn.style.top = Math.max(2, rect.top + 4) + 'px';
    ocrBtn.style.left = Math.max(4, rect.left + 4) + 'px';
  }

  function showOcrProgress(msg) {
    var el = $('#copy-progress');
    if (el) {
      el.textContent = '📷 ' + msg;
      el.style.background = '#2c3e50';
      el.style.display = '';
    }
  }

  function showOcrToast(msg, success) {
    var el = $('#copy-progress');
    if (el) {
      el.textContent = (success ? '✅ ' : '⚠️ ') + msg;
      el.style.background = success ? '#27ae60' : '#c0392b';
      el.style.display = '';
      setTimeout(function() {
        el.style.display = 'none';
        el.style.background = '#2c3e50';
      }, 3500);
    }
  }

  // ─── Clipboard ─────────────────────────────────────────────────────────

  function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for plain HTTP context
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      document.body.removeChild(ta);
      return Promise.reject(e);
    }
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  // ─── OCR Result Panel ──────────────────────────────────────────────────

  function showOcrResultPanel(data, img) {
    // Hide the progress bar first
    var progressEl = $('#copy-progress');
    if (progressEl) {
      progressEl.style.display = 'none';
      progressEl.style.background = '#2c3e50';
    }

    // Split recognized text into paragraphs.
    // data.paragraphs[i].text can contain the full text in some Tesseract builds,
    // so we split data.text by newlines instead.
    var raw = data.text || '';
    var paragraphs = raw.split(/\n\s*\n/).map(function(s) { return s.trim(); }).filter(Boolean);
    if (paragraphs.length <= 1) {
      // Single/double newline didn't split — try single newlines
      paragraphs = raw.split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
    }
    if (!paragraphs.length) paragraphs = [raw.trim()];

    // Create backdrop
    var backdrop = document.createElement('div');
    backdrop.className = 'ocr-result-backdrop';

    // Create panel
    var panel = document.createElement('div');
    panel.className = 'ocr-result-panel';

    // Header
    var header = document.createElement('div');
    header.className = 'ocr-result-header';
    var title = document.createElement('span');
    title.textContent = '📷 OCR 识别结果';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'ocr-result-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = '关闭 (Esc)';
    header.appendChild(title);
    header.appendChild(closeBtn);

    // Body
    var body = document.createElement('div');
    body.className = 'ocr-result-body';

    // Toolbar
    var toolbar = document.createElement('div');
    toolbar.className = 'ocr-result-toolbar';
    var copyAllBtn = document.createElement('button');
    copyAllBtn.className = 'ocr-result-btn ocr-result-btn-primary';
    copyAllBtn.textContent = '📋 复制全部';
    var charCount = document.createElement('span');
    charCount.className = 'ocr-result-count';
    charCount.textContent = '共 ' + data.text.length + ' 字符，' + paragraphs.length + ' 段';
    toolbar.appendChild(copyAllBtn);
    toolbar.appendChild(charCount);

    // Paragraphs
    var textContainer = document.createElement('div');
    textContainer.className = 'ocr-result-text';

    paragraphs.forEach(function(pText, idx) {
      var paraEl = document.createElement('div');
      paraEl.className = 'ocr-result-para';

      var paraText = document.createElement('div');
      paraText.className = 'ocr-result-para-text';
      paraText.textContent = pText;

      var paraCopy = document.createElement('button');
      paraCopy.className = 'ocr-result-btn ocr-result-btn-small';
      paraCopy.textContent = '复制本段';
      paraCopy.addEventListener('click', function(e) {
        e.stopPropagation();
        copyTextToClipboard(pText).then(function() {
          paraCopy.textContent = '✅ 已复制';
          setTimeout(function() { paraCopy.textContent = '复制本段'; }, 2000);
        }).catch(function(err) {
          console.error('Copy paragraph failed:', err);
          paraCopy.textContent = '❌ 失败';
        });
      });

      paraEl.appendChild(paraText);
      paraEl.appendChild(paraCopy);
      textContainer.appendChild(paraEl);
    });

    body.appendChild(toolbar);
    body.appendChild(textContainer);

    panel.appendChild(header);
    panel.appendChild(body);

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    // Show with animation
    requestAnimationFrame(function() {
      backdrop.classList.add('ocr-result-active');
    });

    // Close handlers
    function closePanel() {
      backdrop.classList.remove('ocr-result-active');
      setTimeout(function() { document.body.removeChild(backdrop); }, 200);
      document.removeEventListener('keydown', onKeydown);
    }

    function onKeydown(e) {
      if (e.key === 'Escape') closePanel();
    }
    document.addEventListener('keydown', onKeydown);

    closeBtn.addEventListener('click', closePanel);
    backdrop.addEventListener('click', function(e) {
      if (e.target === backdrop) closePanel();
    });

    // Copy All
    copyAllBtn.addEventListener('click', function() {
      copyTextToClipboard(data.text).then(function() {
        copyAllBtn.textContent = '✅ 已复制全部';
        setTimeout(function() { copyAllBtn.textContent = '📋 复制全部'; }, 2000);
      }).catch(function(err) {
        console.error('Copy all failed:', err);
        copyAllBtn.textContent = '❌ 复制失败';
      });
    });

    // Prevent text selection in body from triggering close
    panel.addEventListener('mousedown', function(e) { e.stopPropagation(); });
  }

  // ─── Init ──────────────────────────────────────────────────────────────

  (async function init() {
    await loadLanguage();
    applyTranslations();
    await checkAuth();
    loadTabs();
    loadFontConfig();
    initTableColumnResize();
    initElementResizeHandle();

    // Initialize formula engine
    tableFormulaManager = new TableFormulaManager();
    tableFormulaManager.init();

    // Initialize OCR image copy (must be after editor is in DOM)
    initOcrImageCopy();
  })();

})();
