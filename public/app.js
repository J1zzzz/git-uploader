'use strict';

/* ---------------- 状态 ---------------- */
const state = {
  dir: '',
  files: [],            // { rel, name, size, checked, flags, hint }
  byRel: new Map(),
  expanded: new Set(),
  filter: 'all',
  search: '',
  env: null,
  scanning: false,
  uploading: false
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const el = {
  authStatus: $('#authStatus'),
  btnAuth: $('#btnAuth'),
  dirInput: $('#dirInput'),
  btnBrowse: $('#btnBrowse'),
  btnScan: $('#btnScan'),
  shortcuts: $('#shortcuts'),
  dirMeta: $('#dirMeta'),
  tree: $('#tree'),
  treeWrap: $('#treeWrap'),
  emptyState: $('#emptyState'),
  scanStat: $('#scanStat'),
  search: $('#search'),
  filter: $('#filter'),
  btnCheckAll: $('#btnCheckAll'),
  btnUncheckAll: $('#btnUncheckAll'),
  repoName: $('#repoName'),
  repoHint: $('#repoHint'),
  repoDesc: $('#repoDesc'),
  commitMsg: $('#commitMsg'),
  createRepo: $('#createRepo'),
  keepLocal: $('#keepLocal'),
  log: $('#log'),
  summaryText: $('#summaryText'),
  summarySize: $('#summarySize'),
  btnUpload: $('#btnUpload'),
  browseModal: $('#browseModal'),
  browsePath: $('#browsePath'),
  browseList: $('#browseList'),
  browseUp: $('#browseUp'),
  browsePick: $('#browsePick'),
  authModal: $('#authModal'),
  deviceCode: $('#deviceCode'),
  deviceLink: $('#deviceLink'),
  deviceStatus: $('#deviceStatus'),
  deviceBox: $('#deviceBox'),
  btnDeviceStart: $('#btnDeviceStart'),
  tokenInput: $('#tokenInput'),
  btnTokenSave: $('#btnTokenSave'),
  conflictModal: $('#conflictModal'),
  conflictSummary: $('#conflictSummary'),
  conflictList: $('#conflictList')
};

let browseCurrent = '';

/* ---------------- 工具 ---------------- */
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function logLine(msg, level = '') {
  const span = document.createElement('span');
  span.className = level ? 'l-' + level : '';
  span.textContent = msg + '\n';
  el.log.appendChild(span);
  el.log.scrollTop = el.log.scrollHeight;
}

function clearLog() {
  el.log.textContent = '';
}

function safeJson(r) {
  return r.json().catch(() => ({}));
}

/* ---------------- 环境 / 认证 ---------------- */
async function refreshEnv() {
  try {
    const r = await fetch('/api/env');
    const env = await safeJson(r);
    state.env = env;

    if (env.auth && env.auth.ok) {
      el.authStatus.className = 'chip chip-ok';
      el.authStatus.textContent = '已连接 ' + env.auth.login;
      el.btnAuth.classList.add('hidden');
    } else {
      el.authStatus.className = 'chip chip-warn';
      el.authStatus.textContent = '未登录 GitHub';
      el.btnAuth.classList.remove('hidden');
    }
    updateRepoHint();
  } catch (e) {
    el.authStatus.className = 'chip chip-warn';
    el.authStatus.textContent = '服务连接失败';
  }
}

function updateRepoHint() {
  const login = state.env && state.env.auth && state.env.auth.login;
  const name = el.repoName.value.trim();
  if (login && name) {
    el.repoHint.innerHTML = '将创建为 <code>' + login + '/' + name + '</code>';
  } else {
    el.repoHint.innerHTML = '将创建为 <code>—</code>';
  }
}

/* 设备码授权 */
let pollTimer = null;

async function startDevice() {
  el.btnDeviceStart.disabled = true;
  el.deviceStatus.textContent = '正在向 GitHub 申请验证码…';
  el.deviceStatus.className = 'device-status';
  try {
    const r = await fetch('/api/auth/device/start', { method: 'POST' });
    const d = await safeJson(r);
    if (!r.ok) throw new Error(d.error || '申请失败');
    el.deviceBox.classList.remove('hidden');
    el.deviceCode.textContent = d.userCode;
    el.deviceLink.href = d.verificationUri;
    el.deviceStatus.textContent = '等待你在浏览器中确认…（' + Math.round(d.expiresIn / 60) + ' 分钟内有效）';
    el.deviceStatus.className = 'device-status';

    clearInterval(pollTimer);
    pollTimer = setInterval(pollDevice, 5000);
    pollDevice();
  } catch (e) {
    el.deviceStatus.textContent = e.message;
    el.deviceStatus.className = 'device-status err';
  } finally {
    el.btnDeviceStart.disabled = false;
  }
}

async function pollDevice() {
  try {
    const r = await fetch('/api/auth/device/poll', { method: 'POST' });
    const d = await safeJson(r);
    if (d.status === 'ok') {
      clearInterval(pollTimer);
      el.deviceStatus.textContent = '授权成功' + (d.login ? '：' + d.login : '') + '，正在连接…';
      el.deviceStatus.className = 'device-status ok';
      setTimeout(async () => {
        await refreshEnv();
        closeModal(el.authModal);
        logLine('GitHub 认证成功' + (d.login ? '：' + d.login : ''), 'ok');
      }, 400);
      return;
    }
    if (d.status === 'error') {
      clearInterval(pollTimer);
      el.deviceStatus.textContent = d.message || '授权失败';
      el.deviceStatus.className = 'device-status err';
    }
  } catch (_) {}
}

/* ---------------- 目录选择 ---------------- */
async function loadHome() {
  try {
    const r = await fetch('/api/home');
    const d = await safeJson(r);
    el.shortcuts.innerHTML = '';
    (d.shortcuts || []).forEach((s) => {
      const b = document.createElement('button');
      b.className = 'shortcut';
      b.textContent = s.label;
      b.title = s.path;
      b.addEventListener('click', () => {
        el.dirInput.value = s.path;
        scan();
      });
      el.shortcuts.appendChild(b);
    });
  } catch (_) {}
}

async function openBrowse(p) {
  const q = p ? '?path=' + encodeURIComponent(p) : '';
  try {
    const r = await fetch('/api/browse' + q);
    const d = await safeJson(r);
    if (!r.ok) throw new Error(d.error);
    browseCurrent = d.path;
    el.browsePath.textContent = d.path;
    el.browseList.innerHTML = '';
    if (d.parent && d.parent !== d.path) {
      const up = document.createElement('div');
      up.className = 'browse-item';
      up.innerHTML = '<span class="folder-icon">↰</span><span>..</span>';
      up.addEventListener('click', () => openBrowse(d.parent));
      el.browseList.appendChild(up);
    }
    d.dirs.forEach((name) => {
      const item = document.createElement('div');
      item.className = 'browse-item';
      const icon = document.createElement('span');
      icon.className = 'folder-icon';
      icon.textContent = '▸';
      const label = document.createElement('span');
      label.textContent = name;
      item.appendChild(icon);
      item.appendChild(label);
      item.addEventListener('click', () => openBrowse(d.path + '\\' + name));
      el.browseList.appendChild(item);
    });
    el.browseModal.classList.remove('hidden');
  } catch (e) {
    logLine('无法浏览目录：' + e.message, 'err');
  }
}

/* ---------------- 扫描 ---------------- */
async function scan() {
  const dir = el.dirInput.value.trim();
  if (!dir) {
    logLine('请先填写项目目录', 'warn');
    return;
  }
  if (state.scanning) return;
  state.scanning = true;
  el.btnScan.disabled = true;
  el.btnScan.textContent = '扫描中…';
  clearLog();
  logLine('扫描目录：' + dir);

  try {
    const r = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir })
    });
    const d = await safeJson(r);
    if (!r.ok) throw new Error(d.error || '扫描失败');

    state.dir = d.dir;
    state.files = d.files || [];
    state.byRel = new Map(state.files.map((f) => [f.rel, f]));
    state.expanded = new Set();

    localStorage.setItem('uploader.lastDir', d.dir);

    el.emptyState.classList.add('hidden');
    el.scanStat.textContent =
      d.files.length + ' 个文件 · ' + fmtSize(d.totalSize) + ' · ' + d.elapsed + ' ms';

    // 目录元信息
    el.dirMeta.classList.remove('hidden');
    const parts = [];
    parts.push('<span>路径 <code>' + escapeHtml(d.dir) + '</code></span>');
    if (d.skippedDirs && d.skippedDirs.length) {
      parts.push('<span class="dot">·</span><span>已跳过 ' + d.skippedDirs.length + ' 个依赖/缓存目录</span>');
    }
    if (d.truncated) {
      parts.push('<span class="dot">·</span><span style="color:var(--amber)">文件过多，已截断</span>');
    }

    // 已有 git 仓库：自动切到「推送到已有远程」
    if (d.hasGit && d.origin) {
      el.createRepo.checked = false;
      const m = d.origin.match(/([^\/:]+?)(?:\.git)?$/);
      if (m && m[1]) {
        el.repoName.value = m[1];
        updateRepoHint();
      }
      parts.push('<span class="dot">·</span><span style="color:var(--green)">已有远程 ' + escapeHtml(d.origin) + '</span>');
      logLine('检测到已有远程仓库，将直接推送变更', 'dim');
    }

    el.dirMeta.innerHTML = parts.join(' ');

    // 仓库名默认值
    if (!el.repoName.value.trim()) {
      const base = d.dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
      el.repoName.value = base.replace(/[^A-Za-z0-9._-]/g, '-');
      updateRepoHint();
    }

    renderTree();
    updateSummary();

    logLine('扫描完成：' + d.files.length + ' 个文件，' + fmtSize(d.totalSize), 'ok');
    const flagged = d.files.filter((f) => f.flags.length).length;
    if (flagged) logLine('其中 ' + flagged + ' 个文件带有提醒标记，请检查是否需要上传', 'warn');
    if (!d.files.length) logLine('该目录没有可上传的文件', 'warn');
  } catch (e) {
    logLine(e.message, 'err');
  } finally {
    state.scanning = false;
    el.btnScan.disabled = false;
    el.btnScan.textContent = '扫描文件';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 构建 & 渲染树 ---------------- */
function buildTree(files) {
  const root = { type: 'dir', name: '', rel: '', children: [] };
  const map = new Map();
  map.set('', root);

  for (const f of files) {
    const parts = f.rel.split('/');
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const parentRel = acc;
      acc = acc ? acc + '/' + parts[i] : parts[i];
      if (!map.has(acc)) {
        const dirNode = { type: 'dir', name: parts[i], rel: acc, children: [] };
        map.set(acc, dirNode);
        map.get(parentRel).children.push(dirNode);
      }
    }
    map.get(acc).children.push({
      type: 'file',
      name: parts[parts.length - 1],
      rel: f.rel,
      size: f.size,
      flags: f.flags,
      hint: f.hint,
      ref: f
    });
  }
  return root;
}

function dirStats(rel) {
  // 统计某目录下的文件总数与已选数
  let total = 0;
  let checked = 0;
  let size = 0;
  const prefix = rel ? rel + '/' : '';
  for (const f of state.files) {
    if (!rel || f.rel === rel || f.rel.startsWith(prefix)) {
      total++;
      size += f.size;
      if (f.checked) checked++;
    }
  }
  return { total, checked, size };
}

function visibleFiles() {
  const q = state.search.trim().toLowerCase();
  return state.files.filter((f) => {
    if (q && !f.rel.toLowerCase().includes(q)) return false;
    if (state.filter === 'checked') return f.checked;
    if (state.filter === 'unchecked') return !f.checked;
    if (state.filter === 'flagged') return f.flags.length > 0;
    return true;
  });
}

function makeFileRow(f, depth, displayName) {
  const row = document.createElement('div');
  const ind = 8 + depth * 16;
  row.className = 'tree-row' + (f.checked ? '' : ' unchecked');
  row.style.paddingLeft = ind + 'px';
  row.dataset.rel = f.rel;

  const chev = document.createElement('span');
  chev.className = 'chev leaf';
  chev.textContent = '›';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = f.checked;
  cb.dataset.rel = f.rel;
  cb.addEventListener('change', () => {
    setChecked(f.rel, cb.checked);
    row.classList.toggle('unchecked', !cb.checked);
    updateAncestors(f.rel);
    updateSummary();
  });

  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = displayName || f.name;
  name.title = f.rel;

  row.appendChild(chev);
  row.appendChild(cb);
  row.appendChild(name);

  for (const flag of f.flags) {
    if (flag === 'large' || flag === 'sensitive' || flag === 'build') {
      const tag = document.createElement('span');
      tag.className = 'tag tag-' + flag;
      tag.textContent = { sensitive: '敏感', build: '产物', large: '大文件' }[flag];
      tag.title = f.hint || '';
      row.appendChild(tag);
    }
  }

  const size = document.createElement('span');
  size.className = 'row-size';
  size.textContent = fmtSize(f.size);
  row.appendChild(size);

  row.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT') return;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
  });

  return row;
}

function makeDirRow(node, depth) {
  const stats = dirStats(node.rel);
  const row = document.createElement('div');
  row.className = 'tree-row is-dir';
  row.style.paddingLeft = 8 + depth * 16 + 'px';
  row.dataset.dir = node.rel;

  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '›';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.dir = node.rel;
  const all = stats.total > 0 && stats.checked === stats.total;
  cb.checked = all;
  cb.indeterminate = !all && stats.checked > 0;

  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = node.name + '/';
  name.title = node.rel;

  const count = document.createElement('span');
  count.className = 'row-count';
  count.textContent = stats.checked + '/' + stats.total;

  row.appendChild(chev);
  row.appendChild(cb);
  row.appendChild(name);
  row.appendChild(count);

  const container = document.createElement('div');
  container.className = 'dir-children';
  container.dataset.parent = node.rel;

  const open = state.expanded.has(node.rel);
  if (open) {
    chev.classList.add('open');
    renderChildren(node, depth + 1, container);
    container.classList.remove('hidden');
  } else {
    container.classList.add('hidden');
  }

  row.addEventListener('click', (e) => {
    if (e.target === cb) return;
    if (e.target.tagName === 'INPUT') return;
    const isOpen = state.expanded.has(node.rel);
    if (isOpen) {
      state.expanded.delete(node.rel);
      chev.classList.remove('open');
      container.classList.add('hidden');
    } else {
      state.expanded.add(node.rel);
      chev.classList.add('open');
      if (!container.dataset.rendered) {
        renderChildren(node, depth + 1, container);
        container.dataset.rendered = '1';
      }
      container.classList.remove('hidden');
    }
  });

  cb.addEventListener('change', () => {
    const target = cb.checked;
    const prefix = node.rel + '/';
    state.files.forEach((f) => {
      if (f.rel.startsWith(prefix)) f.checked = target;
    });
    refreshDirSubtree(node.rel);
    container.querySelectorAll('input[type=checkbox]').forEach((x) => {
      const rel = x.dataset.rel;
      if (rel) {
        x.checked = target;
        const r = x.closest('.tree-row');
        if (r) r.classList.toggle('unchecked', !target);
      }
    });
    cb.indeterminate = false;
    updateAncestors(node.rel);
    updateSummary();
  });

  const wrap = document.createElement('div');
  wrap.appendChild(row);
  wrap.appendChild(container);
  return wrap;
}

function refreshDirSubtree(rel) {
  // 更新所有目录行的计数与三态
  $$('.tree-row.is-dir').forEach((row) => {
    const d = row.dataset.dir;
    if (!d) return;
    if (!startswithRel(d, rel)) return;
    const st = dirStats(d);
    const cb = row.querySelector('input[type=checkbox]');
    const cnt = row.querySelector('.row-count');
    const all = st.total > 0 && st.checked === st.total;
    cb.checked = all;
    cb.indeterminate = !all && st.checked > 0;
    if (cnt) cnt.textContent = st.checked + '/' + st.total;
  });
}

function startswithRel(a, b) {
  return a === b || a.startsWith(b + '/');
}

function renderChildren(node, depth, container) {
  const frag = document.createDocumentFragment();
  // 目录在前，文件在后
  const dirs = node.children.filter((c) => c.type === 'dir');
  const files = node.children.filter((c) => c.type === 'file');
  dirs.forEach((d) => frag.appendChild(makeDirRow(d, depth)));
  files.forEach((f) => frag.appendChild(makeFileRow(f.ref, depth)));
  container.appendChild(frag);
  container.dataset.rendered = '1';
}

function renderFlat() {
  const list = visibleFiles();
  const frag = document.createDocumentFragment();
  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'empty-state';
    p.innerHTML = '<p>没有符合条件的文件</p>';
    frag.appendChild(p);
  }
  list.forEach((f) => frag.appendChild(makeFileRow(f, 0, f.rel)));
  el.tree.appendChild(frag);
}

function renderTree() {
  el.tree.innerHTML = '';
  if (!state.files.length) return;
  const isFlat = state.search.trim() || state.filter !== 'all';
  if (isFlat) {
    renderFlat();
    return;
  }
  const root = buildTree(state.files);
  const frag = document.createDocumentFragment();
  root.children.forEach((c) => {
    if (c.type === 'dir') frag.appendChild(makeDirRow(c, 0));
    else frag.appendChild(makeFileRow(c.ref, 0));
  });
  el.tree.appendChild(frag);
}

/* ---------------- 勾选逻辑 ---------------- */
function setChecked(rel, val) {
  const f = state.byRel.get(rel);
  if (f) f.checked = val;
}

function updateAncestors(rel) {
  // 逐级更新祖父目录行的三态
  const parts = rel.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const dirRel = parts.slice(0, i).join('/');
    const row = el.tree.querySelector('.tree-row.is-dir[data-dir="' + cssEscape(dirRel) + '"]');
    if (!row) continue;
    const st = dirStats(dirRel);
    const cb = row.querySelector('input[type=checkbox]');
    const cnt = row.querySelector('.row-count');
    const all = st.total > 0 && st.checked === st.total;
    cb.checked = all;
    cb.indeterminate = !all && st.checked > 0;
    if (cnt) cnt.textContent = st.checked + '/' + st.total;
  }
}

function cssEscape(s) {
  return s.replace(/["\\]/g, '\\$&');
}

function updateSummary() {
  const sel = state.files.filter((f) => f.checked);
  const size = sel.reduce((s, f) => s + f.size, 0);
  if (!state.files.length) {
    el.summaryText.textContent = '尚未选择文件';
    el.summarySize.textContent = '';
    el.btnUpload.disabled = true;
    return;
  }
  el.summaryText.textContent = '已选 ' + sel.length + ' / ' + state.files.length + ' 个文件';
  el.summarySize.textContent = fmtSize(size);
  el.btnUpload.disabled = sel.length === 0 || state.uploading;
}

/* ---------------- 上传 ---------------- */
async function doUpload(strategy = '') {
  if (state.uploading) return;
  const files = state.files.filter((f) => f.checked).map((f) => f.rel);
  if (!files.length) return;

  const repoName = el.repoName.value.trim();
  if (!repoName) {
    logLine('请填写仓库名', 'err');
    el.repoName.focus();
    return;
  }
  if (!state.env || !state.env.auth || !state.env.auth.ok) {
    logLine('请先登录 GitHub', 'err');
    openModal(el.authModal);
    return;
  }

  const vis = document.querySelector('input[name="vis"]:checked').value;

  state.uploading = true;
  el.btnUpload.disabled = true;
  el.btnUpload.textContent = strategy ? '处理中…' : '上传中…';
  if (!strategy) {
    clearLog();
    logLine('开始上传 ' + files.length + ' 个文件 → ' + repoName);
  } else {
    logLine('');
    logLine('→ 按「' + ({ merge: '合并', rebase: '变基', force: '强制覆盖' }[strategy] || strategy) + '」重新处理', 'step');
  }

  try {
    const resp = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dir: state.dir,
        files,
        repoName,
        description: el.repoDesc.value.trim(),
        isPrivate: vis === 'private',
        createRepo: el.createRepo.checked,
        keepLocal: el.keepLocal.checked,
        message: el.commitMsg.value.trim(),
        strategy
      })
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch (_) {
          continue;
        }
        handleEvent(ev);
      }
    }
  } catch (e) {
    logLine('请求失败：' + e.message, 'err');
  } finally {
    state.uploading = false;
    el.btnUpload.textContent = '上传到 GitHub';
    updateSummary();
  }
}

function handleEvent(ev) {
  if (ev.t === 'log') {
    logLine('  ' + ev.msg, ev.level || '');
  } else if (ev.t === 'step') {
    logLine('→ ' + ev.msg, 'step');
  } else if (ev.t === 'error') {
    logLine('✗ ' + ev.msg, 'err');
    if (ev.code === 'DIVERGED' && ev.conflict) {
      showConflict(ev.conflict);
    }
  } else if (ev.t === 'done') {
    logLine('');
    if (ev.url) {
      logLine('✓ 完成：' + ev.url, 'ok');
      const a = document.createElement('a');
      a.href = ev.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '  打开仓库 ↗';
      a.style.cssText = 'color:var(--accent);display:inline-block;margin:2px 0 6px 2px;font-size:12px';
      el.log.appendChild(a);
      el.log.appendChild(document.createTextNode('\n'));
    } else {
      logLine('✓ 完成', 'ok');
    }
    if (ev.note) logLine('  ' + ev.note, 'dim');
    if (typeof ev.files === 'number') logLine('  本次提交 ' + ev.files + ' 个文件', 'dim');
  }
}

function showConflict(c) {
  el.conflictSummary.innerHTML =
    '远程分支 <code>' +
    escapeHtml(c.branch || 'main') +
    '</code> 有 <strong>' +
    (c.behind || 0) +
    '</strong> 个本地没有的提交' +
    (c.ahead ? '，同时你本地有 <strong>' + c.ahead + '</strong> 个待推送的提交' : '') +
    '。请选择处理方式：';

  el.conflictList.innerHTML = '';
  const list = c.remoteCommits || [];
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'commit-item';
    d.innerHTML = '<span class="commit-meta">（未能获取提交详情，可能是远程分支为空或网络受限）</span>';
    el.conflictList.appendChild(d);
  } else {
    list.forEach((m) => {
      const d = document.createElement('div');
      d.className = 'commit-item';
      const sha = document.createElement('span');
      sha.className = 'commit-sha';
      sha.textContent = m.sha || '';
      const sub = document.createElement('span');
      sub.className = 'commit-subject';
      sub.textContent = m.subject || '';
      sub.title = m.subject || '';
      const meta = document.createElement('span');
      meta.className = 'commit-meta';
      meta.textContent = [m.author, m.when].filter(Boolean).join(' · ');
      d.appendChild(sha);
      d.appendChild(sub);
      d.appendChild(meta);
      el.conflictList.appendChild(d);
    });
  }
  openModal(el.conflictModal);
}

function applyStrategy(strategy) {
  closeModal(el.conflictModal);
  setTimeout(() => doUpload(strategy), 80);
}

/* ---------------- 模态 ---------------- */
function openModal(m) {
  m.classList.remove('hidden');
}
function closeModal(m) {
  m.classList.add('hidden');
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  el.btnScan.addEventListener('click', scan);
  el.dirInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') scan();
  });
  el.btnBrowse.addEventListener('click', () => openBrowse(el.dirInput.value.trim() || null));

  el.browseUp.addEventListener('click', () => {
    const parent = browseCurrent.replace(/[\\/][^\\/]+$/, '');
    if (parent && parent !== browseCurrent) openBrowse(parent);
  });
  el.browsePick.addEventListener('click', () => {
    el.dirInput.value = browseCurrent;
    closeModal(el.browseModal);
    scan();
  });

  el.search.addEventListener('input', () => {
    state.search = el.search.value;
    renderTree();
  });

  el.filter.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (!b) return;
    $$('#filter .seg').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.filter = b.dataset.filter;
    renderTree();
  });

  el.btnCheckAll.addEventListener('click', () => {
    visibleFiles().forEach((f) => (f.checked = true));
    renderTree();
    updateSummary();
  });

  el.btnUncheckAll.addEventListener('click', () => {
    visibleFiles().forEach((f) => (f.checked = false));
    renderTree();
    updateSummary();
  });

  el.btnUpload.addEventListener('click', () => doUpload());
  el.repoName.addEventListener('input', updateRepoHint);

  el.btnAuth.addEventListener('click', () => openModal(el.authModal));

  $('#btnStrategyMerge').addEventListener('click', () => applyStrategy('merge'));
  $('#btnStrategyRebase').addEventListener('click', () => applyStrategy('rebase'));
  $('#btnStrategyForce').addEventListener('click', () => {
    const ok = confirm(
      '强制覆盖会用本地内容替换远程分支，远程独有的提交将被丢弃，且无法通过 git 找回。\n\n确定继续？'
    );
    if (ok) applyStrategy('force');
  });

  $$('[data-close]').forEach((b) =>
    b.addEventListener('click', () => {
      closeModal(el.browseModal);
      closeModal(el.authModal);
      closeModal(el.conflictModal);
      clearInterval(pollTimer);
    })
  );

  $$('.modal').forEach((m) =>
    m.addEventListener('click', (e) => {
      if (e.target === m) {
        closeModal(m);
        clearInterval(pollTimer);
      }
    })
  );

  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $$('.tab-panel').forEach((p) => p.classList.add('hidden'));
      document.querySelector('.tab-panel[data-panel="' + t.dataset.tab + '"]').classList.remove('hidden');
    })
  );

  el.btnDeviceStart.addEventListener('click', startDevice);

  el.btnTokenSave.addEventListener('click', async () => {
    const token = el.tokenInput.value.trim();
    if (!token) return;
    el.btnTokenSave.disabled = true;
    el.btnTokenSave.textContent = '验证中…';
    try {
      const r = await fetch('/api/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const d = await safeJson(r);
      if (!r.ok) throw new Error(d.error || 'Token 无效');
      await refreshEnv();
      closeModal(el.authModal);
      logLine('GitHub 认证成功', 'ok');
      el.tokenInput.value = '';
    } catch (e) {
      logLine(e.message, 'err');
      alert(e.message);
    } finally {
      el.btnTokenSave.disabled = false;
      el.btnTokenSave.textContent = '保存并验证';
    }
  });

  $('#btnClearLog').addEventListener('click', clearLog);
}

/* ---------------- 启动 ---------------- */
async function boot() {
  bind();
  await refreshEnv();
  await loadHome();

  const preset = new URLSearchParams(location.search).get('dir');
  const last = preset || localStorage.getItem('uploader.lastDir');
  if (last) {
    el.dirInput.value = last;
    scan();
  }

  // 定期检测登录状态：无论用哪种方式登录（面板设备码 / 终端 gh / Token），
  // 面板都能自动感知并变绿，不再依赖一次性轮询链。
  setInterval(() => {
    if (!state.uploading && !document.querySelector('#authModal:not(.hidden)')) {
      refreshEnv();
    }
  }, 8000);
}

boot();
