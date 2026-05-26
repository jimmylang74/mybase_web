(function() {
  'use strict';

  let currentTab = null;
  let currentItemId = null;
  let menuTree = [];
  let contentModified = false;
  let activeTabEl = null;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const tabsEl = $('#tabs');
  const treeContainer = $('#tree-container');
  const editor = $('#editor');
  const editorStatus = $('#editor-status');
  const ctxMenu = $('#context-menu');


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
      el.textContent = name;
      el.dataset.tab = name;
      el.addEventListener('click', () => switchTab(name, el));
      tabsEl.appendChild(el);
    });
    if (!currentTab || !tabs.includes(currentTab)) {
      const first = tabsEl.querySelector('.tab');
      if (first) switchTab(tabs[0], first);
    }
  }

  async function switchTab(name, el) {
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

    editor.innerHTML = '<p>Select a menu item to edit its content...</p>';
    editorStatus.textContent = 'No item selected';
  }

  async function loadMenu() {
    if (!currentTab) return;
    menuTree = await api('GET', `/api/${encodeURIComponent(currentTab)}/menu`);
    renderTree();
  }

  function renderTree() {
    treeContainer.innerHTML = '';
    menuTree.forEach((item) => renderTreeNode(item, treeContainer, 0));
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
    if (item.children && item.children.length > 0) {
      toggle.textContent = '▾';
    } else {
      toggle.className = 'toggle empty';
      toggle.textContent = '▸';
    }
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const childrenDiv = nodeDiv.querySelector('.tree-children');
      if (childrenDiv) {
        childrenDiv.style.display = childrenDiv.style.display === 'none' ? '' : 'none';
        toggle.textContent = childrenDiv.style.display === 'none' ? '▸' : '▾';
      }
    });

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label;

    const actions = document.createElement('span');
    actions.className = 'node-actions';

    const btnAdd = document.createElement('button');
    btnAdd.className = 'node-action-btn';
    btnAdd.textContent = '+';
    btnAdd.title = 'Add child';
    btnAdd.addEventListener('click', (e) => {
      e.stopPropagation();
      promptAddChild(item.id);
    });

    const btnEdit = document.createElement('button');
    btnEdit.className = 'node-action-btn';
    btnEdit.textContent = '✎';
    btnEdit.title = 'Rename';
    btnEdit.addEventListener('click', (e) => {
      e.stopPropagation();
      promptRename(item.id, item.label);
    });

    const btnDel = document.createElement('button');
    btnDel.className = 'node-action-btn';
    btnDel.textContent = '✕';
    btnDel.title = 'Delete';
    btnDel.addEventListener('click', (e) => {
      e.stopPropagation();
      promptDelete(item.id, item.label);
    });

    actions.appendChild(btnAdd);
    actions.appendChild(btnEdit);
    actions.appendChild(btnDel);

    header.appendChild(toggle);
    header.appendChild(label);
    header.appendChild(actions);
    header.addEventListener('click', () => selectItem(item.id));

    nodeDiv.appendChild(header);

    if (hasChildren) {
      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'tree-children';
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

  function selectItem(id) {
    if (contentModified && currentItemId) {
      saveContent(currentItemId);
    }

    currentItemId = id;
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
    } catch (e) {
      console.error('Save failed:', e);
      editorStatus.textContent = 'Save failed!';
    }
  }

  async function addMenuItem(label, parentId) {
    if (!currentTab) return;
    try {
      await api('POST', `/api/${encodeURIComponent(currentTab)}/menu`, {
        label,
        parent_id: parentId || null,
      });
      await loadMenu();
    } catch (e) {
      alert('Add failed: ' + e.message);
    }
  }

  async function updateMenuItem(itemId, label) {
    if (!currentTab) return;
    try {
      await api('PUT', `/api/${encodeURIComponent(currentTab)}/menu/${itemId}`, { label });
      await loadMenu();
      if (currentItemId === itemId) {
        editorStatus.textContent = `Editing: ${label}`;
      }
    } catch (e) {
      alert('Rename failed: ' + e.message);
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
      await loadMenu();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

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

  function promptAddChild(parentId) {
    showDialog(
      'Add Menu Item',
      '<label>Item name:</label><input type="text" id="dialog-input" placeholder="Enter item name">',
      () => {
        const input = $('#dialog-input');
        const val = input.value.trim();
        if (val) {
          addMenuItem(val, parentId);
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
      alert('Upload failed: ' + e.message);
    }
    this.value = '';
  });

  $('#btn-paste-plain').addEventListener('click', () => {
    navigator.clipboard.readText().then((text) => {
      editor.focus();
      document.execCommand('insertText', false, text);
      markModified();
    }).catch(() => {
      alert('Cannot read clipboard. Please use Ctrl+Shift+V for plain paste.');
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
    if (e.key === 'Escape') ctxMenu.style.display = 'none';
  });

  function markModified() {
    if (!contentModified && currentItemId) {
      contentModified = true;
      const txt = editorStatus.textContent;
      if (!txt.includes('(unsaved)')) {
        editorStatus.textContent = txt + ' (unsaved)';
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

  editor.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const selection = window.getSelection();
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top = e.clientY + 'px';
    ctxMenu.style.display = 'block';
    ctxMenu.dataset.hasSelection = selection.toString().length > 0 ? 'true' : 'false';
  });

  document.addEventListener('click', (e) => {
    if (!ctxMenu.contains(e.target)) {
      ctxMenu.style.display = 'none';
    }
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

  $('#btn-add-root').addEventListener('click', () => {
    promptAddChild(null);
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  loadTabs();

})();
