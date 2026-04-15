const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 80);
const SITE_ROOT = process.env.SITE_ROOT || '/app/site';
const DATA_DIR = process.env.DATA_DIR || '/data';
const QUOTA_CACHE_FILE = path.join(DATA_DIR, 'quota-cache.json');
const USAGE_CACHE_FILE = path.join(DATA_DIR, 'usage-cache.json');
const DASHBOARD_CACHE_FILE = path.join(DATA_DIR, 'dashboard-cache.json');
const PANEL_CONFIG_FILE = path.join(DATA_DIR, 'panel-config.json');
const ADMIN_AUTH_FILE = path.join(DATA_DIR, 'admin-auth.json');
const CLIPROXY_CONFIG_FILE = process.env.CLIPROXY_CONFIG_FILE || '/config/cli-proxy-api.yaml';
const HOST_BRIDGE = process.env.HOST_BRIDGE || 'host.docker.internal';
const AUTH_DIR = process.env.AUTH_DIR || '/auths';
const USAGE_POLL_INTERVAL_MS = Number(process.env.USAGE_POLL_INTERVAL_MS || 15000);
const ADMIN_SESSION_COOKIE = 'panel_admin_session';
const ADMIN_KEY_HEADER = 'x-panel-admin-key';
const adminSessions = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeBaseUrl(baseUrl) {
  const v = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!v) return '';
  const u = new URL(v);
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') u.hostname = HOST_BRIDGE;
  return u.toString().replace(/\/$/, '');
}

async function readPanelConfig() {
  await ensureDataDir();
  try {
    const raw = await fsp.readFile(PANEL_CONFIG_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writePanelConfig(next) {
  await ensureDataDir();
  const tmp = `${PANEL_CONFIG_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fsp.rename(tmp, PANEL_CONFIG_FILE);
}

async function readAdminAuth() {
  await ensureDataDir();
  try {
    const raw = await fsp.readFile(ADMIN_AUTH_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const defaults = { password: 'Sfnko8uJI3428Ppb0ev7' };
      await writeJsonFile(ADMIN_AUTH_FILE, defaults);
      return defaults;
    }
    throw err;
  }
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const out = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return;
    out[key] = decodeURIComponent(value);
  });
  return out;
}

function hasAdminSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_SESSION_COOKIE];
  if (!token) return false;
  const exp = adminSessions.get(token);
  if (!exp || exp < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function isLoopbackRequest(req) {
  const ip = String(req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireLocalAdmin(req, res) {
  if (isLoopbackRequest(req)) return true;
  sendJson(res, 403, { error: 'admin endpoint is local only' });
  return false;
}

function isAdminAuthorized(req) {
  return isLoopbackRequest(req) || hasAdminSession(req);
}

function requireAdmin(req, res) {
  if (isAdminAuthorized(req)) return true;
  sendJson(res, 403, { error: 'admin authorization required' });
  return false;
}

function getAdminKey(req) {
  const direct = req.headers[ADMIN_KEY_HEADER];
  if (typeof direct === 'string') return direct.trim();
  if (Array.isArray(direct)) return String(direct[0] || '').trim();
  return '';
}

async function hasValidAdminKey(req) {
  const provided = getAdminKey(req);
  if (!provided) return false;
  const auth = await readAdminAuth();
  return provided === String(auth.password || '').trim();
}

async function requireSensitiveAccess(req, res) {
  if (!requireAdmin(req, res)) return false;
  if (await hasValidAdminKey(req)) return true;
  sendJson(res, 403, { error: 'valid admin key required' });
  return false;
}

async function getManagementConfig() {
  const cfg = await readPanelConfig();
  const baseUrl = normalizeBaseUrl(cfg.baseUrl || '');
  const managementKey = String(cfg.managementKey || '').trim();
  if (!baseUrl || !managementKey) throw new Error('panel management config incomplete');
  return { baseUrl, managementKey };
}

async function fetchManagement(pathname, options = {}) {
  const { baseUrl, managementKey } = await getManagementConfig();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${managementKey}`);
  return fetch(`${baseUrl}${pathname}`, { ...options, headers });
}

async function fetchManagementJson(pathname, options = {}) {
  const res = await fetchManagement(pathname, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!res.ok) throw new Error((json && (json.error || json.message)) || text || `${res.status} ${res.statusText}`);
  return json;
}

async function readJsonFileOrDefault(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonFile(filePath, payload) {
  await ensureDataDir();
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
}

async function handlePanelConfig(req, res) {
  if (req.method === 'GET') {
    try {
      const cfg = await readPanelConfig();
      return sendJson(res, 200, {
        baseUrl: String(cfg.baseUrl || '').trim(),
        hasManagementKey: !!String(cfg.managementKey || '').trim(),
      });
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? err.message : 'failed to read panel config' });
    }
  }

  if (req.method === 'PUT') {
    if (!await requireSensitiveAccess(req, res)) return;
    try {
      const current = await readPanelConfig();
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const next = {
        baseUrl: body.baseUrl != null ? String(body.baseUrl || '').trim() : String(current.baseUrl || '').trim(),
        managementKey: body.managementKey != null && String(body.managementKey || '').trim() ? String(body.managementKey || '').trim() : String(current.managementKey || '').trim(),
      };
      await writePanelConfig(next);
      return sendJson(res, 200, { ok: true, baseUrl: next.baseUrl, hasManagementKey: !!next.managementKey });
    } catch (err) {
      return sendJson(res, 400, { error: err && err.message ? err.message : 'failed to save panel config' });
    }
  }

  res.setHeader('Allow', 'GET, PUT');
  return sendJson(res, 405, { error: 'method not allowed' });
}

async function handleManagementProxy(req, res, url) {
  if (!await requireSensitiveAccess(req, res)) return;
  try {
    const upstreamPath = url.pathname.slice('/api/management'.length) + (url.search || '');
    const contentType = req.headers['content-type'];
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const upstream = await fetchManagement(upstreamPath, {
      method: req.method,
      headers: contentType ? { 'Content-Type': contentType } : {},
      body,
    });
    const text = await upstream.text();
    const respType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    res.writeHead(upstream.status, {
      'Content-Type': respType,
      'Cache-Control': 'no-store',
    });
    res.end(text);
  } catch (err) {
    const msg = err && err.message ? err.message : 'management proxy failed';
    sendJson(res, msg.includes('incomplete') ? 400 : 500, { error: msg });
  }
}

async function getFirstApiKeyFromConfig() {
  const raw = await fsp.readFile(CLIPROXY_CONFIG_FILE, 'utf8');
  const lines = raw.split(/\r?\n/);
  let inApiKeys = false;
  for (const line of lines) {
    if (!inApiKeys) {
      if (/^api-keys:\s*$/.test(line.trim())) inApiKeys = true;
      continue;
    }
    if (/^[^\s-][^:]*:\s*/.test(line)) break;
    const m = line.match(/^\s*-\s*(.+?)\s*$/);
    if (m && m[1]) return m[1].replace(/^['"]|['"]$/g, '');
  }
  throw new Error('missing api key in config');
}

async function handleModelList(req, res, url) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (!await requireSensitiveAccess(req, res)) return;
  try {
    let baseUrl = String(url.searchParams.get('baseUrl') || '').trim().replace(/\/$/, '');
    if (!baseUrl) {
      const cfg = await readPanelConfig();
      baseUrl = String(cfg.baseUrl || '').trim().replace(/\/$/, '');
    }
    if (!baseUrl) return sendJson(res, 400, { error: 'missing baseUrl' });
    const upstream = new URL(normalizeBaseUrl(baseUrl));
    const apiKey = await getFirstApiKeyFromConfig();
    const r = await fetch(`${upstream.toString().replace(/\/$/, '')}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (!r.ok) {
      return sendJson(res, r.status, { error: (json && (json.error || json.message)) || text || 'failed to fetch models' });
    }
    const models = Array.isArray(json?.data) ? json.data.map((x) => String(x.id || x.name || '').trim()).filter(Boolean) : [];
    return sendJson(res, 200, { models });
  } catch (err) {
    return sendJson(res, 500, { error: err && err.message ? err.message : 'failed to load models' });
  }
}

async function readAuthMeta(name) {
  const filePath = safeAuthPath(name);
  let authIndex = '';
  let accountId = '';
  let planType = '';

  try {
    const text = await fsp.readFile(filePath, 'utf8');
    const json = JSON.parse(text);
    authIndex = json.auth_index ?? json.authIndex ?? authIndex;
    accountId = json.account_id ?? json.accountId ?? json.id_token?.chatgpt_account_id ?? accountId;
    planType = json.id_token?.plan_type || planType;
  } catch (_) {
    // fall through to auth-files fallback below
  }

  if (authIndex && accountId) {
    return { authIndex, accountId, planType };
  }

  const authFiles = await fetchManagementJson('/v0/management/auth-files');
  const files = Array.isArray(authFiles?.files) ? authFiles.files : [];
  const target = files.find((f) => String(f?.name || f?.id || '').trim() === String(name).trim());
  if (target) {
    authIndex = authIndex || target.auth_index || target.authIndex || '';
    accountId = accountId || target.account_id || target.accountId || target.id_token?.chatgpt_account_id || '';
    planType = planType || target.id_token?.plan_type || '';
  }

  return { authIndex, accountId, planType };
}

async function refreshUsageCache() {
  const usage = await fetchManagementJson('/v0/management/usage');
  const payload = { fetchedAt: Date.now(), data: usage };
  await writeJsonFile(USAGE_CACHE_FILE, payload);
  return payload;
}

async function handlePublicConfig(req, res) {
  try {
    const cfg = await readPanelConfig();
    return sendJson(res, 200, {
      baseUrl: String(cfg.baseUrl || '').trim(),
      hasManagementKey: !!String(cfg.managementKey || '').trim(),
      readonly: true,
      dangerousActionsAvailable: false,
    });
  } catch (err) {
    return sendJson(res, 500, { error: err && err.message ? err.message : 'failed to read public config' });
  }
}

async function handlePublicAuthFiles(req, res) {
  try {
    const json = await fetchManagementJson('/v0/management/auth-files');
    return sendJson(res, 200, json);
  } catch (err) {
    return sendJson(res, 500, { error: err && err.message ? err.message : 'failed to load auth files' });
  }
}

async function handlePublicUsageCache(req, res) {
  try {
    const cached = await readJsonFileOrDefault(USAGE_CACHE_FILE, {});
    return sendJson(res, 200, cached);
  } catch (err) {
    return sendJson(res, 500, { error: err && err.message ? err.message : 'failed to read usage cache' });
  }
}

async function handlePublicRefreshUsage(req, res) {
  if (!await requireSensitiveAccess(req, res)) return;
  try {
    const payload = await refreshUsageCache();
    return sendJson(res, 200, payload);
  } catch (err) {
    return sendJson(res, 500, { error: err && err.message ? err.message : 'failed to refresh usage cache' });
  }
}

async function handlePublicQuota(req, res, url) {
  if (!await requireSensitiveAccess(req, res)) return;
  try {
    const name = String(url.searchParams.get('name') || '').trim();
    if (!name) return sendJson(res, 400, { error: 'missing auth file name' });
    const meta = await readAuthMeta(name);
    if (!meta.authIndex || !meta.accountId) return sendJson(res, 400, { error: 'missing auth meta' });
    const json = await fetchManagementJson('/v0/management/api-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authIndex: meta.authIndex,
        method: 'GET',
        url: 'https://chatgpt.com/backend-api/wham/usage',
        header: {
          Authorization: 'Bearer $TOKEN$',
          'Content-Type': 'application/json',
          'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
          'Chatgpt-Account-Id': meta.accountId,
        }
      })
    });
    return sendJson(res, 200, json);
  } catch (err) {
    return sendJson(res, 500, { error: err && err.message ? err.message : 'failed to query quota' });
  }
}

function safeAuthPath(name) {
  const normalized = path.basename(String(name || '')).trim();
  if (!normalized || normalized.includes(' ')) throw new Error('invalid auth file name');
  const filePath = path.resolve(path.join(AUTH_DIR, normalized));
  const root = path.resolve(AUTH_DIR);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) throw new Error('invalid auth file path');
  return filePath;
}

async function handleAuthToggle(req, res) {
  if (!await requireSensitiveAccess(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const name = String(body?.name || '').trim();
    const disabled = !!body?.disabled;
    if (!name) return sendJson(res, 400, { error: 'missing auth file name' });
    const filePath = safeAuthPath(name);
    const text = await fsp.readFile(filePath, 'utf8');
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object' || Array.isArray(json)) return sendJson(res, 400, { error: 'auth file must be a JSON object' });
    json.disabled = disabled;
    const tmp = `${filePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(json, null, 2), 'utf8');
    await fsp.rename(tmp, filePath);
    return sendJson(res, 200, { ok: true, disabled });
  } catch (err) {
    return sendJson(res, 500, { error: err && err.message ? err.message : 'failed to toggle auth file' });
  }
}

async function handleAdminStatus(req, res) {
  return sendJson(res, 200, { authenticated: isAdminAuthorized(req), local: isLoopbackRequest(req) });
}

async function handleAdminLogin(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  try {
    const auth = await readAdminAuth();
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const password = String(body.password || '').trim();
    if (password !== String(auth.password || '')) {
      return sendJson(res, 401, { error: 'invalid admin credentials' });
    }
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    adminSessions.set(token, Date.now() + 7 * 24 * 3600 * 1000);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
    });
    res.end(JSON.stringify({ ok: true, authenticated: true }));
  } catch (err) {
    return sendJson(res, 500, { error: err && err.message ? err.message : 'admin login failed' });
  }
}

async function handleAdminLogout(req, res) {
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (token) adminSessions.delete(token);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  });
  res.end(JSON.stringify({ ok: true, authenticated: false }));
}

async function handleQuotaCache(req, res) {
  await ensureDataDir();

  if (req.method === 'GET') {
    try {
      const raw = await fsp.readFile(QUOTA_CACHE_FILE, 'utf8');
      const obj = JSON.parse(raw);
      return sendJson(res, 200, obj && typeof obj === 'object' ? obj : {});
    } catch (err) {
      if (err && err.code === 'ENOENT') return sendJson(res, 200, {});
      return sendJson(res, 500, { error: 'failed to read quota cache' });
    }
  }

  if (req.method === 'PUT') {
    if (!await requireSensitiveAccess(req, res)) return;
    try {
      const raw = await readBody(req);
      const obj = raw ? JSON.parse(raw) : {};
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return sendJson(res, 400, { error: 'quota cache must be an object' });
      }
      const tmp = `${QUOTA_CACHE_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
      await fsp.rename(tmp, QUOTA_CACHE_FILE);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: 'invalid quota cache payload' });
    }
  }

  res.setHeader('Allow', 'GET, PUT');
  return sendJson(res, 405, { error: 'method not allowed' });
}

async function handleDashboardCache(req, res) {
  await ensureDataDir();
  if (req.method === 'GET') {
    try {
      const raw = await fsp.readFile(DASHBOARD_CACHE_FILE, 'utf8');
      const obj = JSON.parse(raw);
      return sendJson(res, 200, obj && typeof obj === 'object' ? obj : {});
    } catch (err) {
      if (err && err.code === 'ENOENT') return sendJson(res, 200, {});
      return sendJson(res, 500, { error: 'failed to read dashboard cache' });
    }
  }
  if (req.method === 'PUT') {
    if (!await requireSensitiveAccess(req, res)) return;
    try {
      const raw = await readBody(req);
      const obj = raw ? JSON.parse(raw) : {};
      const tmp = `${DASHBOARD_CACHE_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
      await fsp.rename(tmp, DASHBOARD_CACHE_FILE);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: 'invalid dashboard cache payload' });
    }
  }
  res.setHeader('Allow', 'GET, PUT');
  return sendJson(res, 405, { error: 'method not allowed' });
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = path.normalize(rel).replace(/^( |\.+[\/])+/, '');
  const filePath = path.join(SITE_ROOT, rel);
  const resolved = path.resolve(filePath);
  const root = path.resolve(SITE_ROOT);
  if (!resolved.startsWith(root)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  try {
    const stat = await fsp.stat(resolved);
    const target = stat.isDirectory() ? path.join(resolved, 'index.html') : resolved;
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 500, { error: 'failed to serve file' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/public/config') return handlePublicConfig(req, res);
    if (url.pathname === '/api/public/auth-files') return handlePublicAuthFiles(req, res);
    if (url.pathname === '/api/public/usage-cache') return handlePublicUsageCache(req, res);
    if (url.pathname === '/api/public/refresh-usage-cache') return handlePublicRefreshUsage(req, res);
    if (url.pathname === '/api/public/quota') return handlePublicQuota(req, res, url);
    if (url.pathname === '/api/admin/status') return handleAdminStatus(req, res);
    if (url.pathname === '/api/admin/login') return handleAdminLogin(req, res);
    if (url.pathname === '/api/admin/logout') return handleAdminLogout(req, res);
    if (url.pathname === '/api/panel-config') return handlePanelConfig(req, res);
    if (url.pathname === '/api/quota-cache') return handleQuotaCache(req, res);
    if (url.pathname === '/api/dashboard-cache') return handleDashboardCache(req, res);
    if (url.pathname === '/api/model-list') return handleModelList(req, res, url);
    if (url.pathname === '/api/auth-toggle') return handleAuthToggle(req, res);
    if (url.pathname.startsWith('/api/management')) return handleManagementProxy(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    sendJson(res, 500, { error: 'internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`cliproxy-sub2-panel listening on ${PORT}`);
});

async function usagePollLoop() {
  try {
    const cfg = await readPanelConfig();
    if (!cfg || !cfg.baseUrl || !cfg.managementKey) return;
    await refreshUsageCache();
  } catch (_) {
    // keep poller quiet
  }
}

setInterval(usagePollLoop, USAGE_POLL_INTERVAL_MS);
usagePollLoop();
