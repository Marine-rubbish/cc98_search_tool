import {
  forumBase, loginUrl, apiBaseFromRequest, validApiBase, resourcePath,
  prepareLoginInPage, inspectPage, identifyInPage, readInPage, cancelInPage,
} from './protocol.js';
import { localPagePort, bootstrapInPage, validLocalServer } from './local.js';

let connection;
let pendingConnection;
let localServer;
let autoConnect = true;
let connecting;
let revision = 0;
let socket;
let state = '正在自动连接';
let inFlight = 0;
let credentialRefresh;
let unauthorizedRecovery;
let credentialFailureState;
const observed = new Map();
const observedAuthorization = new Map();
const authorizationWaiters = new Map();
const activeReads = new Map();

/* 兼容旧版已保存的连接，所有事件都在存储恢复后执行。 */
const restored = chrome.storage.local.get(['connection', 'pendingConnection', 'localServer', 'autoConnect']).then(data => {
  connection = data.connection;
  pendingConnection = data.pendingConnection;
  autoConnect = data.autoConnect !== false;
  const saved = data.localServer || connection || pendingConnection;
  if (validLocalServer(saved)) localServer = { port: saved.port, token: saved.token };
  if (!autoConnect) state = '已断开，点击「重新连接」恢复';
});

/* 记录每个标签页最近的论坛 XHR 地址，供 WebVPN API 根地址识别使用。 */
chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return;
  const list = observed.get(details.tabId) || [];
  if (!list.includes(details.url)) list.push(details.url);
  observed.set(details.tabId, list.slice(-40));
}, { urls: ['https://*.cc98.org/*', 'https://webvpn.zju.edu.cn/*'], types: ['xmlhttprequest'] });

/* 捕获论坛自己的 Bearer 认证头，仅存于扩展会话中，不发送给本地服务。 */
chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  if (details.tabId < 0) return;
  const authorization = details.requestHeaders?.find(header => header.name.toLowerCase() === 'authorization')?.value;
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return;
  chrome.tabs.get(details.tabId).then(tab => {
    try {
      /* WebVPN 与其他站点共用域名，只有能识别为 CC98 的标签页才保存凭据。 */
      forumBase(tab.url);
      const previous = observedAuthorization.get(details.tabId);
      observedAuthorization.set(details.tabId, authorization);
      chrome.storage.session.set({ [`authorization:${details.tabId}`]: authorization })
        .then(() => {
          for (const notify of authorizationWaiters.get(details.tabId) || []) notify(authorization);
          if (socket && connection?.tabId === details.tabId && authorization !== previous)
            void refreshCredentials(connection).catch(handleCredentialFailure);
          else void ensureConnected();
        });
    } catch { /* Ignore requests from other sites sharing the WebVPN origin. */ }
  }).catch(() => {});
}, { urls: ['https://*.cc98.org/*', 'https://webvpn.zju.edu.cn/*'], types: ['xmlhttprequest'] },
['requestHeaders', 'extraHeaders']);

/* 优先读取内存中的认证头，Service Worker 重启后再从 session 存储恢复。 */
async function getAuthorization(tabId) {
  const current = observedAuthorization.get(tabId);
  if (current) return current;
  const key = `authorization:${tabId}`;
  const stored = await chrome.storage.session.get(key);
  /* Chrome 的脚本位置参数不接受 undefined；null 表示尚未捕获认证头。 */
  return stored[key] ?? null;
}

/* 在指定标签页的主世界执行协议函数，并取回其结构化返回值。 */
async function execute(tabId, func, args) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  if (!result?.result) throw new Error('无法读取页面，请刷新后重试');
  return result.result;
}

/* 等待刷新后的标签页发出不同认证头；超时后交给用户恢复登录。 */
function waitForDifferentAuthorization(tabId, previous, timeoutMs = 60000) {
  let cleanup = () => {};
  const promise = new Promise((resolve, reject) => {
    const waiters = authorizationWaiters.get(tabId) || new Set();
    cleanup = () => {
      clearTimeout(timer);
      waiters.delete(notify);
      if (!waiters.size) authorizationWaiters.delete(tabId);
    };
    const notify = authorization => {
      if (authorization === previous) return;
      cleanup();
      resolve(authorization);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('CC98 登录已过期，请在绑定标签页中重新登录'), { code: 'AUTH_REQUIRED' }));
    }, timeoutMs);
    waiters.add(notify);
    authorizationWaiters.set(tabId, waiters);
  });
  return { promise, cancel: cleanup };
}

/*
 * 核对最新令牌仍属于原账号和站点，然后原地更新当前连接的指纹。
 * 多个请求共享一次核验，论坛令牌始终只在扩展和页面之间传递。
 */
function refreshCredentials(current) {
  if (credentialRefresh) return credentialRefresh;
  credentialRefresh = (async () => {
    const tab = await chrome.tabs.get(current.tabId);
    if (forumBase(tab.url) !== current.session.forumBase)
      throw Object.assign(new Error('CC98 标签页已改变'), { code: 'SESSION_CHANGED' });
    const authorization = await getAuthorization(current.tabId);
    const inspected = await execute(current.tabId, inspectPage, [current.session.forumBase, authorization]);
    if (inspected.error)
      throw Object.assign(new Error(inspected.error), {
        code: inspected.code === 'LOGIN_REQUIRED' ? 'AUTH_REQUIRED' : inspected.code,
      });
    if (inspected.tokenFingerprint === current.tokenFingerprint) return;
    const identity = await execute(current.tabId, identifyInPage, [{
      base: current.session.forumBase, apiBase: current.apiBase,
      tokenFingerprint: inspected.tokenFingerprint, authorization,
    }]);
    if (identity.status === 401)
      throw Object.assign(new Error('CC98 登录已过期，请重新登录'), { code: 'AUTH_REQUIRED' });
    if (identity.status !== 200)
      throw Object.assign(new Error(identity.error || '账号读取失败'), { code: identity.errorCode || 'DISCONNECTED' });
    if (identity.accountId !== current.session.accountId)
      throw Object.assign(new Error('CC98 账号已改变，请重新连接'), { code: 'SESSION_CHANGED' });
    /* 连接已被替换时丢弃迟到结果；否则原地更新，保证读取闭包同步看到新指纹。 */
    if (connection !== current) return;
    current.tokenFingerprint = inspected.tokenFingerprint;
    await chrome.storage.local.set({ connection: { ...current } });
  })().finally(() => { credentialRefresh = null; });
  return credentialRefresh;
}

/* 账号变化必须断开；登录过期保留标签页，等待后续人工登录请求。 */
function handleCredentialFailure(error) {
  if (error.code === 'SESSION_CHANGED') {
    credentialFailureState = error.message;
    state = credentialFailureState;
    socket?.close();
  }
}

/* 401 恢复全局合并，只刷新绑定标签页一次并等待新的 Bearer 请求。 */
function recoverUnauthorized(current) {
  if (unauthorizedRecovery) return unauthorizedRecovery;
  unauthorizedRecovery = (async () => {
    const previous = await getAuthorization(current.tabId);
    state = 'CC98 登录已过期，正在刷新绑定标签页';
    const waiting = waitForDifferentAuthorization(current.tabId, previous);
    try {
      await chrome.tabs.reload(current.tabId);
      await waiting.promise;
    } finally {
      waiting.cancel();
    }
    await refreshCredentials(current);
    state = '已连接';
  })().catch(error => {
    const failure = error.code ? error :
      Object.assign(new Error('CC98 登录恢复失败，请在绑定标签页中重新登录'), { code: 'AUTH_REQUIRED' });
    state = failure.code === 'SESSION_CHANGED' ? failure.message : '等待 CC98 登录恢复';
    throw failure;
  }).finally(() => { unauthorizedRecovery = null; });
  return unauthorizedRecovery;
}

/*
 * 校验标签页、登录态、账号、版面读取和自动绑定的本地凭据。
 * 全部通过后持久化连接信息，并建立到本地服务的 WebSocket。
 */
async function connect(settings, attempt) {
  const tab = await chrome.tabs.get(settings.tabId);
  const base = forumBase(tab.url);
  const authorization = await getAuthorization(tab.id);
  const inspected = await execute(tab.id, inspectPage, [base, authorization]);
  if (!autoConnect || attempt !== revision) return;
  if (inspected.error) {
    /* 携带错误码和论坛地址，消息处理器据此进入登录或刷新等待状态。 */
    const error = new Error(inspected.error);
    error.code = inspected.code;
    error.forumBase = base;
    throw error;
  }
  const candidates = [...(observed.get(tab.id) || []), ...(inspected.resources || [])]
    .map(url => apiBaseFromRequest(url, base)).filter(Boolean);
  /* 新捕获的请求优先，旧连接地址只在仍属于当前论坛时复用。 */
  const apiBase = candidates.at(-1) || inspected.configuredApi ||
    (validApiBase(settings.apiBase, base) ? settings.apiBase : undefined);
  if (!validApiBase(apiBase, base))
    throw Object.assign(new Error('请在 CC98 中打开一个版面，扩展会自动重试'), { code: 'REQUEST_NEEDED', forumBase: base });
  const identity = await execute(tab.id, identifyInPage, [{
    base, apiBase, tokenFingerprint: inspected.tokenFingerprint, authorization,
  }]);
  if (!autoConnect || attempt !== revision) return;
  if (identity.status !== 200) {
    if (identity.status === 401)
      throw Object.assign(new Error('CC98 登录已过期，请重新登录'), { code: 'LOGIN_REQUIRED', forumBase: base });
    throw new Error(identity.error || `账号读取失败（HTTP ${identity.status}）`);
  }
  const session = { accountId: identity.accountId, forumBase: base };
  /* 正式连接前实际读取版面目录，确认 API 地址、权限和响应结构都可用。 */
  const check = await execute(tab.id, readInPage, [{
    base, apiBase, tokenFingerprint: inspected.tokenFingerprint, authorization,
    path: '/board/all', id: crypto.randomUUID(),
  }]);
  if (check.status !== 200 || !Array.isArray(check.data) || !check.data.every(b => Number.isInteger(b.id) && typeof b.name === 'string')) {
    if (check.status === 401)
      throw Object.assign(new Error('请在 Chrome 中重新登录 CC98'), { code: 'LOGIN_REQUIRED', forumBase: base });
    throw new Error('版面读取失败，请刷新论坛后重试');
  }
  if (!validLocalServer(settings)) throw new Error('请运行平台启动脚本或 npm run open');
  if (!autoConnect || attempt !== revision) return;
  socket?.close();
  connection = { ...settings, apiBase, tokenFingerprint: inspected.tokenFingerprint, session };
  pendingConnection = undefined;
  await chrome.storage.local.set({ connection });
  await chrome.storage.local.remove('pendingConnection');
  if (!autoConnect || attempt !== revision) return;
  await openSocket();
}

/* 自动发现本地页面与论坛页面，并合并事件、弹窗和定时器的并发重试。 */
async function ensureConnected(force = false) {
  await restored;
  if (!autoConnect) return;
  if (connecting) return connecting;
  if (socket && !force) return;
  const attempt = revision;
  const current = () => autoConnect && attempt === revision;
  connecting = (async () => {
    state = '正在寻找本地搜索页和 CC98';
    const tabs = await chrome.tabs.query({});
    const localTabs = tabs.filter(tab => localPagePort(tab.url))
      .sort((a, b) => Number(localPagePort(b.url) === localServer?.port) - Number(localPagePort(a.url) === localServer?.port));
    for (const tab of localTabs) {
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'ISOLATED', func: bootstrapInPage, args: [localPagePort(tab.url)],
        });
        if (!current()) return;
        if (!validLocalServer(result?.result) || result.result.port !== localPagePort(tab.url)) continue;
        localServer = result.result;
        await chrome.storage.local.set({ localServer });
        break;
      } catch { /* 页面关闭或尚未加载时，继续使用已保存的连接。 */ }
    }
    if (!current()) return;
    if (!localServer) throw new Error('请运行平台启动脚本或 npm run open');
    const forumTabs = tabs.filter(tab => { try { forumBase(tab.url); return true; } catch { return false; } });
    const rank = tab => tab.id === connection?.tabId ? 3 : tab.id === pendingConnection?.tabId ? 2 : tab.active ? 1 : 0;
    forumTabs.sort((a, b) => rank(b) - rank(a));
    if (!forumTabs.length) throw new Error('请在 Chrome 打开并登录 CC98，扩展会自动连接');
    let failure;
    for (const tab of forumTabs) {
      if (!current()) return;
      const settings = { ...localServer, tabId: tab.id,
        apiBase: tab.id === connection?.tabId ? connection.apiBase : undefined };
      try {
        await connect(settings, attempt);
        return;
      } catch (error) {
        failure ??= { error, settings };
        /* 本地服务不可达时，换论坛标签页没有帮助。 */
        if (error.code === 'LOCAL_UNAVAILABLE') { failure = { error, settings }; break; }
      }
    }
    if (!current()) return;
    const { error, settings } = failure;
    pendingConnection = ['LOGIN_REQUIRED', 'REQUEST_NEEDED'].includes(error.code)
      ? { ...settings, forumBase: error.forumBase, action: error.code === 'LOGIN_REQUIRED' ? 'login' : 'reload' }
      : undefined;
    if (pendingConnection) await chrome.storage.local.set({ pendingConnection });
    else await chrome.storage.local.remove('pendingConnection');
    throw error;
  })().catch(error => { if (current()) state = error.message; }).finally(() => { connecting = null; });
  return connecting;
}

/* 执行一次页面读取；调用方负责凭据恢复和最多一次业务重试。 */
async function readWithCurrentCredentials(current, path, id) {
  const authorization = await getAuthorization(current.tabId);
  return execute(current.tabId, readInPage, [{
    base: current.session.forumBase, apiBase: current.apiBase,
    tokenFingerprint: current.tokenFingerprint, authorization, path, id,
  }]);
}

/* 同账号令牌轮换直接核验；401 刷新一次标签页，恢复后只重试原请求一次。 */
async function readWithRecovery(current, path, id) {
  let reply = await readWithCurrentCredentials(current, path, id);
  try {
    if (reply.errorCode === 'TOKEN_CHANGED') {
      await refreshCredentials(current);
      reply = await readWithCurrentCredentials(current, path, id);
    } else if (reply.status === 401) {
      await recoverUnauthorized(current);
      reply = await readWithCurrentCredentials(current, path, id);
      if (reply.status === 401 || reply.errorCode === 'TOKEN_CHANGED')
        return { status: 0, errorCode: 'AUTH_REQUIRED' };
    }
    return reply;
  } catch (error) {
    if (error.code === 'SESSION_CHANGED') return { status: 0, errorCode: 'SESSION_CHANGED' };
    if (error.code === 'AUTH_REQUIRED') return { status: 0, errorCode: 'AUTH_REQUIRED' };
    return { status: 0, errorCode: 'DISCONNECTED' };
  }
}

/* 连接本地桥，处理心跳、读取、取消和断线清理。 */
function openSocket() {
  const current = connection;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${current.port}/bridge`);
    socket = ws;
    state = '连接本地服务中';
    const unavailable = () => Object.assign(new Error('本地服务未连接，请运行平台启动脚本或 npm run open'), { code: 'LOCAL_UNAVAILABLE' });
    const timer = setTimeout(() => { ws.close(); reject(unavailable()); }, 6000);
    ws.onopen = () => ws.send(JSON.stringify({
      type: 'hello',
      token: current.token,
      session: current.session,
      extensionVersion: chrome.runtime.getManifest().version,
    }));
    ws.onerror = () => { clearTimeout(timer); ws.close(); reject(unavailable()); };
    ws.onclose = () => {
      clearTimeout(timer);
      if (socket === ws) {
        socket = null;
        if (autoConnect) state = credentialFailureState || '连接已断开，等待自动重连';
      }
      /* 旧连接只能取消自己的请求，不能误伤新连接中的读取。 */
      for (const [id, read] of activeReads) if (read.ws === ws)
        chrome.scripting.executeScript({ target: { tabId: read.tabId }, world: 'MAIN', func: cancelInPage, args: [id] }).catch(() => {});
      reject(unavailable());
    };
    ws.onmessage = async event => {
      try {
        if (socket !== ws) return;
        const m = JSON.parse(event.data);
        if (m.type === 'ready') {
          clearTimeout(timer);
          credentialFailureState = undefined;
          state = '已连接';
          resolve();
          return;
        }
        if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
        if (m.type === 'cancel') {
          const tabId = activeReads.get(m.id)?.tabId;
          if (tabId !== undefined) await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: cancelInPage, args: [m.id] });
          return;
        }
        if (m.type !== 'read' || typeof m.id !== 'string') return;
        const path = resourcePath(m.resource);
        /* 扩展自身再设一层 20 并发上限，超过时让本地请求池退避重试。 */
        if (inFlight >= 20) {
          ws.send(JSON.stringify({ type: 'reply', id: m.id, status: 429, retryAfterMs: 1000 }));
          return;
        }
        inFlight++;
        activeReads.set(m.id, { tabId: current.tabId, ws });
        try {
          /* 每次读取前确认标签页仍属于原论坛，并使用最新捕获的认证头。 */
          const tab = await chrome.tabs.get(current.tabId);
          if (forumBase(tab.url) !== current.session.forumBase) throw new Error('标签页已改变');
          const reply = await readWithRecovery(current, path, m.id);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reply', id: m.id, ...reply }));
        } catch {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reply', id: m.id, status: 0, errorCode: 'DISCONNECTED' }));
        } finally {
          inFlight--;
          if (activeReads.get(m.id)?.ws === ws) activeReads.delete(m.id);
        }
      } catch { ws.close(); }
    };
  });
}

/* 弹窗只返回可展示的状态，不返回本地凭据或论坛账号。 */
function status() {
  return { state, connected: state === '已连接', autoConnect,
    needsLogin: pendingConnection?.action === 'login',
    needsRefresh: pendingConnection?.action === 'reload' };
}

/* 搜索页只能由用户点击时打开，后台定时重连不会反复创建标签页。 */
async function openSearch() {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(tab => localPagePort(tab.url) === (localServer?.port || 9876));
  if (existing) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url: `http://127.0.0.1:${localServer?.port || 9876}/` });
}

/* 处理弹窗发来的状态、连接、登录辅助、刷新和断开操作。 */
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  (async () => {
    await restored;
    if (message.type === 'status') return status();
    if (message.type === 'connect' || message.type === 'open-search') {
      autoConnect = true;
      await chrome.storage.local.set({ autoConnect });
      if (message.type === 'open-search') await openSearch();
      await ensureConnected(message.type === 'connect');
      return status();
    }
    if (message.type === 'open-forum') {
      await chrome.tabs.create({ url: pendingConnection?.forumBase || connection?.session?.forumBase || 'https://www.cc98.org/' });
      return status();
    }
    if (message.type === 'open-login') {
      const pending = pendingConnection;
      if (!pending) throw new Error('请先点击连接，再打开 CC98 登录页');
      const tab = await chrome.tabs.get(pending.tabId);
      if (forumBase(tab.url) !== pending.forumBase) throw new Error('当前标签页已离开原 CC98 页面');
      const prepared = await execute(tab.id, prepareLoginInPage, [pending.forumBase]);
      if (prepared !== true) throw new Error('无法设置登录后的返回地址，请刷新 CC98 页面后重试');
      await chrome.tabs.update(tab.id, { url: loginUrl(tab.url) });
      state = '请在 CC98 页面登录，成功后会自动重试连接';
      return status();
    }
    if (message.type === 'reload-page') {
      const pending = pendingConnection;
      if (!pending) throw new Error('请先点击连接，再刷新 CC98 页面');
      await chrome.tabs.reload(pending.tabId);
      state = '正在刷新 CC98 页面，加载完成后会自动重试连接';
      return status();
    }
    if (message.type === 'disconnect') {
      autoConnect = false;
      revision++;
      socket?.close();
      socket = null;
      state = '已断开，点击「重新连接」恢复';
      /* 等待已发起的检查退出，确保断开后没有迟到的存储写入重新启用连接。 */
      await connecting;
      pendingConnection = null;
      await chrome.storage.local.set({ autoConnect: false });
      await chrome.storage.local.remove('pendingConnection');
      return status();
    }
    throw new Error('未知操作');
  })().then(reply).catch(error => reply({
    ...status(), error: error.message,
    errorCode: error.code,
    needsLogin: error.code === 'LOGIN_REQUIRED',
    needsRefresh: error.code === 'REQUEST_NEEDED',
  }));
  return true;
});

/* 标签页关闭时清理该页的请求记录、临时凭据和连接状态。 */
chrome.tabs.onRemoved.addListener(tabId => {
  observed.delete(tabId);
  observedAuthorization.delete(tabId);
  chrome.storage.session.remove(`authorization:${tabId}`);
  if (connection?.tabId === tabId) { socket?.close(); state = 'CC98 标签页已关闭'; }
  if (pendingConnection?.tabId === tabId) {
    pendingConnection = null;
    chrome.storage.local.remove('pendingConnection');
  }
});

/* 搜索页、论坛登录或刷新完成后立即重试，无需先打开扩展弹窗。 */
chrome.tabs.onUpdated.addListener(async (_tabId, change, tab) => {
  if (change.status !== 'complete') return;
  if (!localPagePort(tab.url)) { try { forumBase(tab.url); } catch { return; } }
  await ensureConnected();
});

/* Service Worker 被唤醒后，每 30 秒尝试恢复已保存的本地连接。 */
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'reconnect') await ensureConnected();
});

/* 扩展启动时恢复已连接或等待登录的状态。 */
void ensureConnected();
