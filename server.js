'use strict';

/**
 * GitHub 可视化上传面板 — 本地服务
 * 仅监听 127.0.0.1，零外部依赖（仅 Node 内置模块 + 系统 git / gh）
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

/* ------------------------------------------------------------------ */
/* 启动引导：兼容 FastGithub / 企业代理 等替换 GitHub 证书的环境        */
/* ------------------------------------------------------------------ */
// 这类工具会把 github.com / api.github.com 劫持到本地反代并签发自有证书。
// Node 默认只信任内置 CA，会报 UNABLE_TO_VERIFY_LEAF_SIGNATURE；
// Node >= 22.15 支持 --use-system-ca，改用 Windows 证书库即可正常访问。
(function bootstrapTls() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  const supportsSystemCa = maj > 22 || (maj === 22 && min >= 15);
  const alreadyOn = process.execArgv.includes('--use-system-ca');

  if (supportsSystemCa && !alreadyOn && !process.env.GH_UPLOADER_CHILD) {
    const child = spawnSync(
      process.execPath,
      ['--use-system-ca', __filename, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, GH_UPLOADER_CHILD: '1' } }
    );
    process.exit(child.status == null ? 0 : child.status);
  }
})();


const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const BASE_PORT = Number(process.env.PORT || 7717);

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 在 PATH 里查找可执行文件（跨机器、跨安装方式兜底） */
function whichBin(name) {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(probe, [name], { encoding: 'utf8', windowsHide: true });
    if (r && r.status === 0) {
      const first = (r.stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
    }
  } catch (_) {}
  return '';
}

function findBin(candidates, name) {
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return whichBin(name) || name;
}

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

const GH = findBin(
  [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'GitHub CLI', 'gh.exe'),
    path.join(LOCAL, 'GitHubCLI', 'gh.exe'),
    path.join(LOCAL, 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
    path.join(os.homedir(), 'scoop', 'shims', 'gh.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\gh.exe'
  ],
  'gh'
);

const GIT = findBin(
  [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
    path.join(LOCAL, 'Programs', 'Git', 'cmd', 'git.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\git.exe'
  ],
  'git'
);

function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd || ROOT,
        env: { ...process.env, ...(opts.env || {}) },
        windowsHide: true
      });
    } catch (e) {
      return resolve({ code: -1, out: '', err: String(e.message || e) });
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => resolve({ code: -1, out, err: err + String(e.message || e) }));
    child.on('close', (code) => resolve({ code: code === null ? -1 : code, out, err }));
    if (opts.input != null) {
      try {
        child.stdin.write(opts.input);
        child.stdin.end();
      } catch (_) {}
    }
    if (opts.timeout) {
      setTimeout(() => {
        try {
          child.kill();
        } catch (_) {}
      }, opts.timeout);
    }
  });
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (_) {}
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 文件扫描                                                            */
/* ------------------------------------------------------------------ */

// 体积大且几乎不需要上传的目录：直接不进入（但仍会在 UI 中提示已跳过）
const HARD_SKIP = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.idea',
  '.gradle',
  '.mvn',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.svelte-kit',
  'bower_components',
  'coverage',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.terraform',
  '.venv2'
]);

const SENSITIVE_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)\.env\.example$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /secret/i,
  /(^|\/)\.htpasswd$/i
];

const BUILD_PATTERNS = [
  /(^|\/)(dist|build|out|target|bin|obj|release|Debug)\//i,
  /\.(log|tmp|bak|swp|cache)$/i,
  /\.min\.(js|css)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock)$/i
];

const BINARY_EXT = /\.(exe|dll|so|dylib|zip|rar|7z|tar|gz|mp4|mov|avi|mkv|psd|ai|iso|dmg|bin|jar|war|class|pyc|o|obj|lib|pdb|ttf|otf|woff2?|db|sqlite)$/i;

const LARGE_BYTES = 5 * 1024 * 1024;

function classify(rel, size) {
  const flags = [];
  if (SENSITIVE_PATTERNS.some((r) => r.test(rel))) flags.push('sensitive');
  if (BUILD_PATTERNS.some((r) => r.test(rel))) flags.push('build');
  if (size >= LARGE_BYTES) flags.push('large');
  if (BINARY_EXT.test(rel)) flags.push('binary');

  let checked = true;
  let hint = '';
  if (flags.includes('sensitive')) {
    checked = false;
    hint = '疑似密钥/配置，默认不上传';
  } else if (flags.includes('build')) {
    checked = false;
    hint = '构建产物或锁文件，默认不上传';
  } else if (flags.includes('large')) {
    hint = '文件较大（' + (size / 1048576).toFixed(1) + ' MB）';
  }
  return { checked, flags, hint };
}

async function scanDir(dir, maxEntries = 40000) {
  const files = [];
  const skippedDirs = [];
  let truncated = false;

  async function walk(abs, rel, depth) {
    if (depth > 14 || truncated) return;
    let ents;
    try {
      ents = await fsp.readdir(abs, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of ents) {
      if (truncated) return;
      const absChild = path.join(abs, e.name);
      const relChild = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (HARD_SKIP.has(e.name)) {
          skippedDirs.push(relChild);
          continue;
        }
        await walk(absChild, relChild, depth + 1);
      } else if (e.isFile()) {
        if (files.length >= maxEntries) {
          truncated = true;
          return;
        }
        let st;
        try {
          st = await fsp.stat(absChild);
        } catch (_) {
          continue;
        }
        const c = classify(relChild, st.size);
        files.push({
          rel: relChild,
          name: e.name,
          size: st.size,
          mtime: st.mtimeMs,
          checked: c.checked,
          flags: c.flags,
          hint: c.hint
        });
      }
    }
  }

  await walk(dir, '', 0);
  files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-CN'));
  return { files, skippedDirs, truncated };
}

/* ------------------------------------------------------------------ */
/* 环境 / 认证                                                         */
/* ------------------------------------------------------------------ */

async function getEnvInfo() {
  const gv = await run(GIT, ['--version']);
  const hv = await run(GH, ['--version']);
  const auth = await run(GH, ['auth', 'status'], { env: { GH_PROMPT_DISABLED: '1' } });
  let login = '';
  let host = '';
  if (auth.code === 0) {
    const m = auth.out.match(/Logged in to (\S+) account (\S+)/i) || auth.err.match(/Logged in to (\S+) account (\S+)/i);
    if (m) {
      host = m[1];
      login = m[2];
    }
  }
  const userName = (await run(GIT, ['config', '--global', 'user.name'])).out.trim();
  const userEmail = (await run(GIT, ['config', '--global', 'user.email'])).out.trim();

  return {
    git: { ok: gv.code === 0, version: gv.out.trim(), path: GIT },
    gh: { ok: hv.code === 0, version: hv.out.split('\n')[0].trim(), path: GH },
    auth: { ok: auth.code === 0, login, host, raw: (auth.out + auth.err).trim() },
    gitUser: { name: userName, email: userEmail }
  };
}

// GitHub OAuth Device Flow（使用 gh CLI 官方公开 client_id，public client 无需 secret）
const GH_CLIENT_ID = '178c6fc778ccc68e1d6a';
const GH_SCOPE = 'repo read:org workflow';

async function ghFetch(url, bodyObj) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(bodyObj).toString(),
      signal: controller.signal
    });
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      return { error: 'bad_response', error_description: text.slice(0, 200) };
    }
  } catch (e) {
    const cause = (e.cause && (e.cause.code || e.cause.message)) || '';
    const flat = cause + ' ' + e.message;
    let hint = '';
    if (/CERT|SIGNATURE|SSL|TLS/i.test(flat)) {
      hint =
        '证书校验失败：你的网络中存在代理/加速工具（如 FastGithub）替换了 GitHub 证书。请更新本工具，或改用「粘贴 Token」方式登录。';
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(flat)) {
      hint = 'DNS 解析失败，请检查网络连接或代理设置。';
    } else if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(flat)) {
      hint = '连接 GitHub 失败，网络可能被阻断。可尝试关闭/开启代理后重试。';
    }
    throw new Error((hint || '网络请求失败') + (cause ? ' [' + cause + ']' : ''));
  } finally {
    clearTimeout(timer);
  }
}

async function startDeviceFlow() {
  let lastReason = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await ghFetch('https://github.com/login/device/code', {
        client_id: GH_CLIENT_ID,
        scope: GH_SCOPE
      });
      if (data.device_code && data.user_code) {
        pendingDevice = {
          deviceCode: data.device_code,
          interval: (data.interval || 5) * 1000,
          expiresAt: Date.now() + (data.expires_in || 900) * 1000
        };
        deviceState = { status: 'pending' };
        startDeviceWatcher();
        return {
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          expiresIn: data.expires_in
        };
      }
      lastReason = data.error_description || data.error || 'GitHub 未返回验证码';
    } catch (e) {
      lastReason = e.message;
    }
    // 偶发的服务端抖动：退避重试
    if (attempt < 2) await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  throw new Error(
    '无法连接 GitHub：' + lastReason + '。可稍后重试，或改用「粘贴 Token」方式登录。'
  );
}

let pendingDevice = null;
let deviceWatcher = null;
let deviceState = { status: 'idle' };

// 后端自主轮询：不依赖浏览器定时器，标签页被节流也能完成兑换
function startDeviceWatcher() {
  clearTimeout(deviceWatcher);
  const tick = async () => {
    if (!pendingDevice) {
      deviceState = { status: 'error', message: '授权会话已失效，请重新生成验证码' };
      return;
    }
    if (Date.now() > pendingDevice.expiresAt) {
      pendingDevice = null;
      deviceState = { status: 'error', message: '验证码已过期，请重新生成' };
      return;
    }
    try {
      const r = await pollDeviceFlow();
      if (r && r.status === 'ok') {
        deviceState = { status: 'ok', login: (await getEnvInfo()).auth.login };
        return;
      }
      deviceWatcher = setTimeout(tick, r && r.slow ? 10000 : 5000);
    } catch (e) {
      deviceState = { status: 'error', message: e.message };
      pendingDevice = null;
    }
  };
  deviceWatcher = setTimeout(tick, 3000);
}

async function pollDeviceFlow() {
  if (!pendingDevice) throw new Error('没有进行中的授权，请先点击生成验证码');
  if (Date.now() > pendingDevice.expiresAt) {
    pendingDevice = null;
    throw new Error('验证码已过期，请重新生成');
  }
  const data = await ghFetch('https://github.com/login/oauth/access_token', {
    client_id: GH_CLIENT_ID,
    device_code: pendingDevice.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  });
  if (data.access_token) {
    pendingDevice = null;
    await loginWithToken(data.access_token, 'oauth');
    return { status: 'ok' };
  }
  if (data.error === 'authorization_pending') return { status: 'pending' };
  if (data.error === 'slow_down') return { status: 'pending', slow: true };
  if (data.error === 'expired_token') {
    pendingDevice = null;
    throw new Error('验证码已过期，请重新生成');
  }
  if (data.error === 'access_denied') {
    pendingDevice = null;
    throw new Error('你拒绝了授权');
  }
  throw new Error(data.error_description || data.error || '授权失败');
}

async function loginWithToken(token, kind) {
  const r = await run(GH, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--with-token'], {
    input: token + '\n',
    env: { GH_PROMPT_DISABLED: '1' }
  });
  if (r.code !== 0) {
    throw new Error('Token 写入失败：' + (r.err || r.out).trim());
  }
  // 让 git 走 gh 的凭证，后续 push 不再询问
  await run(GH, ['auth', 'setup-git', '--hostname', 'github.com']);
  const cfg = readConfig();
  cfg.lastAuth = { kind, at: Date.now() };
  writeConfig(cfg);
  return true;
}

/* ------------------------------------------------------------------ */
/* 上传主流程                                                          */
/* ------------------------------------------------------------------ */

async function uploadFlow(params, emit) {
  const {
    dir,
    files = [],
    repoName,
    description = '',
    isPrivate = true,
    createRepo = true,
    message = '',
    keepLocal = true,
    skipGitignore = false,
    strategy = ''
  } = params;

  const log = (msg, level = 'info') => emit({ t: 'log', msg, level });
  const step = (msg) => emit({ t: 'step', msg });
  const done = (payload) => emit({ t: 'done', ...payload });

  if (!dir || !fs.existsSync(dir)) throw new Error('目录不存在：' + dir);
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) throw new Error('不是目录：' + dir);

  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoName || '')) {
    throw new Error('仓库名只能包含字母、数字、点、下划线、连字符');
  }
  if (!files.length) throw new Error('没有选中任何文件');

  // ---- 1. 认证检查 ----
  step('检查 GitHub 认证');
  const env = await getEnvInfo();
  if (!env.gh.ok) throw new Error('未找到 gh CLI，请先安装 GitHub CLI');
  if (!env.auth.ok) throw new Error('GitHub 尚未登录，请先在面板里完成授权');
  log('已登录：' + env.auth.login + ' @ ' + env.auth.host, 'ok');
  const owner = env.auth.login;

  // ---- 2. 准备工作目录 ----
  let workDir = dir;
  let tempRoot = null;

  if (!keepLocal) {
    step('创建临时工作副本（不改动本地目录）');
    tempRoot = path.join(os.tmpdir(), 'gh-upload-' + Date.now());
    await fsp.mkdir(tempRoot, { recursive: true });
    let copied = 0;
    for (const rel of files) {
      const src = path.join(dir, rel);
      const dst = path.join(tempRoot, rel);
      try {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(src, dst);
        copied++;
      } catch (e) {
        log('跳过无法复制：' + rel + ' (' + e.message + ')', 'warn');
      }
    }
    log(`已复制 ${copied} 个文件到临时目录`, 'ok');
    workDir = tempRoot;
  }

  // ---- 3. init ----
  const gitDir = path.join(workDir, '.git');
  const hasGit = fs.existsSync(gitDir);
  if (!hasGit) {
    step('初始化 git 仓库');
    const r = await run(GIT, ['init', '-b', 'main'], { cwd: workDir });
    if (r.code !== 0) throw new Error('git init 失败：' + (r.err || r.out));
    log('git init 完成（分支 main）', 'ok');
  } else {
    log('已存在 .git，跳过初始化', 'dim');
  }

  // ---- 4. .gitignore ----
  if (!skipGitignore) {
    const giPath = path.join(workDir, '.gitignore');
    if (!fs.existsSync(giPath)) {
      const tpl = [
        '# 依赖',
        'node_modules/',
        '.pnp',
        'vendor/',
        '',
        '# 构建产物',
        'dist/',
        'build/',
        'out/',
        'target/',
        '.next/',
        '',
        '# 缓存与日志',
        '*.log',
        '__pycache__/',
        '.pytest_cache/',
        '.cache/',
        '',
        '# 环境与密钥',
        '.env',
        '.env.local',
        '*.pem',
        '*.key',
        '',
        '# 系统',
        '.DS_Store',
        'Thumbs.db',
        '.idea/',
        '.vscode/',
        ''
      ].join('\n');
      await fsp.writeFile(giPath, tpl, 'utf8');
      log('已生成通用 .gitignore', 'ok');
    } else {
      log('检测到已有 .gitignore，保持不变', 'dim');
    }
  }

  // ---- 5. 精确暂存选中文件 ----
  step(`暂存 ${files.length} 个文件`);
  const list = files.join('\0') + '\0';
  const addRes = await run(
    GIT,
    ['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
    { cwd: workDir, input: list }
  );
  if (addRes.code !== 0) {
    throw new Error('git add 失败：' + (addRes.err || addRes.out).trim());
  }
  const staged = await run(GIT, ['diff', '--cached', '--name-only', '-z'], { cwd: workDir });
  const stagedFiles = staged.out.split('\0').filter(Boolean);
  log(`已暂存 ${stagedFiles.length} 个文件`, 'ok');

  if (stagedFiles.length === 0) {
    step('没有新的改动');
    // 仍然尝试推送（可能之前已提交但未推）
    const pushed = await doPush(workDir, { repoName, description, isPrivate, createRepo, owner, log, strategy });
    done({ url: pushed.url, files: 0, repo: repoName, note: '无新改动，已完成同步检查' });
    cleanupTemp(tempRoot);
    return;
  }

  // ---- 6. commit ----
  step('创建提交');
  const msg = (message || '').trim() || `Update ${new Date().toLocaleString('zh-CN')}`;
  const commitRes = await run(
    GIT,
    ['-c', 'user.name=' + (env.gitUser.name || 'uploader'), '-c', 'user.email=' + (env.gitUser.email || 'uploader@local'), 'commit', '-m', msg],
    { cwd: workDir }
  );
  if (commitRes.code !== 0) {
    const txt = (commitRes.out + commitRes.err).trim();
    if (/nothing to commit/i.test(txt)) {
      log('无内容变更', 'dim');
    } else {
      throw new Error('git commit 失败：' + txt);
    }
  } else {
    log('提交信息：' + msg, 'ok');
  }

  // ---- 7. 推送 ----
  const pushed = await doPush(workDir, { repoName, description, isPrivate, createRepo, owner, log, strategy });

  done({ url: pushed.url, files: stagedFiles.length, repo: repoName });
  cleanupTemp(tempRoot);
}

function cleanupTemp(tempRoot) {
  if (!tempRoot) return;
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (_) {}
}

async function getConflictFiles(cwd) {
  const r = await run(GIT, ['diff', '--name-only', '--diff-filter=U'], { cwd });
  return r.out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getRemoteCommits(cwd, branch, limit = 10) {
  const r = await run(
    GIT,
    ['log', 'origin/' + branch, '^HEAD', '-n', String(limit), '--pretty=format:%h\u0001%s\u0001%an\u0001%cr'],
    { cwd }
  );
  if (r.code !== 0) return [];
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, author, when] = line.split('\u0001');
      return { sha, subject, author, when };
    });
}

function conflictError(files, hint) {
  const e = new Error(
    (hint || '合并时发生文件冲突') +
      '，已自动回滚到操作前的状态。请手动解决以下文件的冲突后重新上传：\n' +
      files.map((f) => '  · ' + f).join('\n')
  );
  e.code = 'FILES_CONFLICT';
  e.files = files;
  return e;
}

async function doPush(workDir, ctx) {
  const { repoName, description, isPrivate, createRepo, owner, log, strategy } = ctx;

  const remotes = await run(GIT, ['remote', '-v'], { cwd: workDir });
  const hasOrigin = /\borigin\b/.test(remotes.out);

  if (createRepo && !hasOrigin) {
    log('在 GitHub 上创建仓库 ' + owner + '/' + repoName, 'info');
    const args = [
      'repo',
      'create',
      repoName,
      isPrivate ? '--private' : '--public',
      '--source',
      '.',
      '--remote',
      'origin',
      '--push'
    ];
    if (description) args.push('--description', description);
    const r = await run(GH, args, { cwd: workDir, env: { GH_PROMPT_DISABLED: '1' }, timeout: 300000 });
    const outTxt = ((r.err || '') + (r.out || '')).trim();
    if (r.code !== 0) {
      if (/already exists/i.test(outTxt)) {
        throw new Error(
          'GitHub 上已存在同名仓库 ' + owner + '/' + repoName + '，请换一个名字，或关闭"自动创建仓库"改用已有远程地址'
        );
      }
      throw new Error('创建仓库并推送失败：' + outTxt);
    }
    log(outTxt || '推送完成', 'ok');
    return { url: `https://github.com/${owner}/${repoName}` };
  }

  const br = await run(GIT, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workDir });
  const branch = br.out.trim() || 'main';

  let url = '';
  const rm = remotes.out.match(/origin\s+(\S+)\s+\(push\)/);
  if (rm) {
    url = rm[1].replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
  }

  /* ---- 1. 推送前检查远程是否有本地没有的提交 ---- */
  let behind = 0;
  let ahead = 0;
  if (hasOrigin) {
    log('检查远程是否有新提交…', 'dim');
    const f = await run(GIT, ['fetch', 'origin', branch], { cwd: workDir, timeout: 90000 });
    if (f.code !== 0) {
      log('无法获取远程状态，跳过冲突检查（将直接尝试推送）', 'warn');
    }
    const verify = await run(GIT, ['rev-parse', '--verify', 'origin/' + branch], { cwd: workDir });
    if (verify.code === 0) {
      const cnt = await run(GIT, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], {
        cwd: workDir
      });
      const parts = cnt.out.trim().split(/\s+/).map(Number);
      behind = parts[0] || 0;
      ahead = parts[1] || 0;
    }
  }

  /* ---- 2. 远程领先：先让用户决策，绝不擅自合并 ---- */
  if (behind > 0) {
    const remoteCommits = await getRemoteCommits(workDir, branch, 10);

    if (!strategy) {
      const err = new Error(`远程分支 ${branch} 有 ${behind} 个本地没有的提交，需要选择处理方式`);
      err.code = 'DIVERGED';
      err.conflict = { branch, behind, ahead, remoteCommits };
      throw err;
    }

    if (strategy === 'force') {
      log('强制覆盖远程分支 ' + branch + '（远程独有提交将被丢弃）', 'warn');
      const r = await run(GIT, ['push', '--force-with-lease', 'origin', branch], {
        cwd: workDir,
        timeout: 300000
      });
      if (r.code !== 0) throw new Error('强制推送失败：' + ((r.err || '') + (r.out || '')).trim());
      log('已用本地内容覆盖远程', 'ok');
      return { url };
    }

    if (strategy === 'merge') {
      log('合并远程提交（保留双方历史）…', 'info');
      const r = await run(
        GIT,
        ['pull', '--no-rebase', '--no-edit', '--allow-unrelated-histories', 'origin', branch],
        { cwd: workDir, timeout: 180000 }
      );
      if (r.code !== 0) {
        const files = await getConflictFiles(workDir);
        await run(GIT, ['merge', '--abort'], { cwd: workDir });
        if (files.length) throw conflictError(files, '合并时发生文件冲突');
        throw new Error('合并远程提交失败：' + ((r.err || '') + (r.out || '')).trim());
      }
      log('合并完成', 'ok');
    } else if (strategy === 'rebase') {
      log('将本地提交变基到远程之上（历史线性化）…', 'info');
      const r = await run(GIT, ['pull', '--rebase', 'origin', branch], {
        cwd: workDir,
        timeout: 180000
      });
      if (r.code !== 0) {
        const files = await getConflictFiles(workDir);
        await run(GIT, ['rebase', '--abort'], { cwd: workDir });
        if (files.length) throw conflictError(files, '变基时发生文件冲突');
        throw new Error('变基失败：' + ((r.err || '') + (r.out || '')).trim());
      }
      log('变基完成', 'ok');
    }
  }

  /* ---- 3. 推送 ---- */
  log('推送到 origin（分支 ' + branch + '）', 'info');
  const r = await run(GIT, ['push', '-u', 'origin', branch], { cwd: workDir, timeout: 300000 });
  if (r.code !== 0) {
    throw new Error('推送失败：' + ((r.err || '') + (r.out || '')).trim());
  }
  log((r.err || '').trim() || '推送完成', 'ok');
  return { url };
}

/* ------------------------------------------------------------------ */
/* HTTP 路由                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const abs = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!abs.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const data = await fsp.readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

async function handleBrowse(res, url) {
  const p = url.searchParams.get('path');
  const target = p && p.trim() ? path.resolve(p.trim()) : os.homedir();
  let out = { path: target, parent: path.dirname(target), dirs: [], count: 0 };
  try {
    const ents = await fsp.readdir(target, { withFileTypes: true });
    for (const e of ents) {
      if (e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information') {
        out.dirs.push(e.name);
      }
    }
    out.dirs.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const gitExists = fs.existsSync(path.join(target, '.git'));
    out.hasGit = gitExists;
    // 已有 remote 信息
    if (gitExists) {
      const r = await run(GIT, ['remote', 'get-url', 'origin'], { cwd: target });
      if (r.code === 0) out.origin = r.out.trim();
    }
    out.count = out.dirs.length;
  } catch (e) {
    return json(res, 400, { error: '无法读取目录：' + e.message });
  }
  json(res, 200, out);
}

async function handleScan(req, res) {
  const body = await readBody(req);
  const dir = body.dir;
  if (!dir || !fs.existsSync(dir)) return json(res, 400, { error: '目录不存在' });
  const started = Date.now();
  const result = await scanDir(path.resolve(dir));
  const token = rootTokenFor(path.resolve(dir));
  result.dir = path.resolve(dir);
  result.rootToken = token;
  result.elapsed = Date.now() - started;
  result.totalSize = result.files.reduce((s, f) => s + f.size, 0);

  // 已有 git 仓库：识别远程与分支
  result.hasGit = false;
  result.origin = '';
  result.branch = '';
  try {
    if (fs.existsSync(path.join(result.dir, '.git'))) {
      result.hasGit = true;
      const r = await run(GIT, ['remote', 'get-url', 'origin'], { cwd: result.dir });
      if (r.code === 0) result.origin = r.out.trim();
      const b = await run(GIT, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: result.dir });
      if (b.code === 0) result.branch = b.out.trim();
    }
  } catch (_) {}

  json(res, 200, result);
}

function rootTokenFor(dir) {
  return Buffer.from(dir, 'utf8').toString('base64url');
}

async function handleUpload(req, res) {
  const body = await readBody(req);
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const emit = (obj) => {
    try {
      res.write(JSON.stringify(obj) + '\n');
    } catch (_) {}
  };
  try {
    await uploadFlow(body, emit);
  } catch (e) {
    const payload = { t: 'error', msg: e.message || String(e) };
    if (e.code) payload.code = e.code;
    if (e.conflict) payload.conflict = e.conflict;
    if (e.files) payload.files = e.files;
    emit(payload);
  } finally {
    try {
      res.end();
    } catch (_) {}
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const p = url.pathname;

  try {
    if (p === '/api/env') return json(res, 200, await getEnvInfo());

    if (p === '/api/browse') {
      // 允许直接传 Windows 路径
      return await handleBrowse(res, url);
    }

    if (p === '/api/scan' && req.method === 'POST') return await handleScan(req, res);

    if (p === '/api/upload' && req.method === 'POST') return await handleUpload(req, res);

    if (p === '/api/home') {
      return json(res, 200, {
        home: os.homedir(),
        shortcuts: [
          { label: '桌面', path: path.join(os.homedir(), 'Desktop') },
          { label: '文档', path: path.join(os.homedir(), 'Documents') },
          { label: 'Downloads', path: path.join(os.homedir(), 'Downloads') },
          { label: 'Desktop/Code', path: path.join(os.homedir(), 'Desktop', 'Code') },
          { label: 'Documents/GitHub', path: path.join(os.homedir(), 'Documents', 'GitHub') }
        ].filter((s) => fs.existsSync(s.path))
      });
    }

    if (p === '/api/auth/device/start' && req.method === 'POST') {
      try {
        const d = await startDeviceFlow();
        return json(res, 200, d);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/auth/device/poll' && req.method === 'POST') {
      // 只读查询：真正的兑换由后端 watcher 完成
      return json(res, 200, deviceState);
    }

    if (p === '/api/auth/token' && req.method === 'POST') {
      const body = await readBody(req);
      const token = (body.token || '').trim();
      if (!token) return json(res, 400, { error: '请填写 Token' });
      try {
        await loginWithToken(token, 'pat');
        return json(res, 200, { ok: true, env: await getEnvInfo() });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      await run(GH, ['auth', 'logout', '--hostname', 'github.com'], { env: { GH_PROMPT_DISABLED: '1' } });
      return json(res, 200, { ok: true });
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    return await serveStatic(req, res, p);
  } catch (e) {
    try {
      json(res, 500, { error: e.message || String(e) });
    } catch (_) {}
  }
});

function listen(port, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 12) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', e.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log('GitHub 上传面板已启动：' + url);
    try {
      fs.writeFileSync(path.join(ROOT, '.port'), String(port), 'utf8');
    } catch (_) {}
    if (process.argv.includes('--open')) {
      try {
        spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true }).unref();
      } catch (_) {}
    }
  });
}

listen(BASE_PORT);
