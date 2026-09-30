/* 从当前标签页 URL 提取 CC98 根地址，支持官网和 WebVPN 映射路径。 */
export function forumBase(input) {
  const u = new URL(input);
  if (u.protocol !== 'https:' || u.port || u.username || u.password) throw new Error('请打开 HTTPS 的 CC98 页面');
  if (/^(www\.)?cc98\.org$/.test(u.hostname)) return `${u.origin}/`;
  const prefix = u.pathname.match(/^\/https?\/[a-zA-Z0-9,._~-]+\//)?.[0];
  if (u.hostname === 'webvpn.zju.edu.cn' && prefix) return u.origin + prefix;
  throw new Error('请选择 CC98 页面，不能在 WebVPN 登录页连接');
}

/* 生成当前 CC98 站点的登录页地址，WebVPN 下仍保留代理前缀。 */
export function loginUrl(input) {
  return new URL('logon', forumBase(input)).href;
}

/* 在页面主世界写入登录后返回地址；标签页已离开原站点时拒绝写入。 */
export function prepareLoginInPage(base) {
  if (!location.href.startsWith(base)) return false;
  localStorage.setItem('logOnRedirectUrl', base);
  return true;
}

/* 从已观察到的论坛 API 请求中去掉资源路径，提取并校验 API 根地址。 */
export function apiBaseFromRequest(input, base) {
  try {
    const u = new URL(input);
    const path = u.pathname.replace(/\/(?:me|board\/(?:all|\d+(?:\/topic)?)|topic\/(?:toptopics|\d+(?:\/post)?))\/?$/i, '');
    if (path === u.pathname) return null;
    const result = u.origin + path;
    return validApiBase(result, base) ? result : null;
  } catch { return null; }
}

/* 校验 API 根地址必须对应官网 API，或与当前 WebVPN 页面使用同一代理前缀。 */
export function validApiBase(input, base) {
  try {
    const u = new URL(input), page = new URL(base);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return false;
    if (page.hostname === 'webvpn.zju.edu.cn') return u.origin === page.origin && /^\/https?\/[a-zA-Z0-9,._~-]+\/?$/.test(u.pathname);
    return u.hostname === 'api.cc98.org' && (u.pathname === '/' || u.pathname === '');
  } catch { return false; }
}

/* 将白名单资源描述转换为固定 API 路径，同时限制 ID、偏移量和页大小。 */
export function resourcePath(r) {
  if (!r || typeof r !== 'object') throw new Error('无效读取请求');
  if (r.kind === 'boards') return '/board/all';
  if (!Number.isSafeInteger(r.id) || r.id < 1) throw new Error('无效资源 ID');
  if (r.kind === 'board') return `/board/${r.id}`;
  if (r.kind === 'topic') return `/topic/${r.id}`;
  if (r.kind === 'pinned') return `/topic/toptopics?boardid=${r.id}`;
  if (!['topics', 'posts'].includes(r.kind) || !Number.isSafeInteger(r.from) || r.from < 0 ||
      !Number.isSafeInteger(r.size) || r.size < 1 || r.size > (r.kind === 'posts' ? 10 : 20)) throw new Error('无效分页参数');
  return r.kind === 'topics' ? `/Board/${r.id}/topic?from=${r.from}&size=${r.size}` : `/Topic/${r.id}/post?from=${r.from}&size=${r.size}`;
}

/*
 * 以下页面函数会被 chrome.scripting 序列化后注入主世界。
 * 它们只能使用参数、浏览器全局对象和函数内部定义，不能引用模块外变量。
 */

/*
 * 检查页面登录态，计算令牌指纹并收集可能的 API 地址。
 * 返回值不包含原始令牌；authorization 仅来自同一标签页捕获的认证请求。
 */
export async function inspectPage(base, authorization) {
  try {
    if (!location.href.startsWith(base)) return { error: '标签页已离开 CC98' };
    const rawToken = authorization || localStorage.getItem('accessToken') || '';
    if (!rawToken) {
      /* 页面外观、刷新令牌分别用于区分未登录和登录完成但访问令牌尚未生成。 */
      const appearsLoggedIn = !!globalThis.document?.querySelector(
        '.topBarUserName, .topBarUserImg, a[href^="/usercenter"], a[href^="/message"]',
      );
      return {
        error: appearsLoggedIn
          ? '页面显示已登录，但扩展尚未捕获到认证请求。请刷新页面后重试'
          : localStorage.getItem('refresh_token')
            ? 'CC98 访问令牌尚未生成，请刷新页面或打开一个版面后重试'
            : '当前页面没有可用的 CC98 登录态',
        code: appearsLoggedIn || localStorage.getItem('refresh_token') ? 'REQUEST_NEEDED' : 'LOGIN_REQUIRED',
      };
    }
    const expiry = Number(localStorage.getItem('accessToken_expirationTime'));
    if (!authorization && expiry && expiry * 1000 <= Date.now())
      return { error: 'CC98 登录已过期，请重新登录', code: 'LOGIN_REQUIRED' };
    let token = rawToken.startsWith('str-') ? rawToken.slice(4) : rawToken;
    if (!/^Bearer /i.test(token)) token = `Bearer ${token}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenFingerprint = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    /* performance 记录是 WebVPN 下识别真实代理 API 地址的首选来源。 */
    const resources = performance.getEntriesByType('resource').map(r => r.name);
    let configuredApi;
    try {
      const response = await fetch(new URL('static/config.json', base), { signal: AbortSignal.timeout(5000) });
      if (response.ok) configuredApi = (await response.json()).apiUrl;
    } catch { /* 配置读取失败时仍可使用已捕获的请求地址。 */ }
    if (configuredApi && location.hostname === 'webvpn.zju.edu.cn') {
      /*
       * CC98 公开配置返回直连域名时，按 WebVPN 的 AES-CBC 域名编码规则
       * 推导同源代理路径；这里只转换已校验的 HTTPS API 主机名。
       */
      const api = new URL(configuredApi);
      const host = new TextEncoder().encode(api.hostname);
      if (api.protocol !== 'https:' || host.length > 16 || api.port) {
        configuredApi = undefined;
      } else {
        const keyBytes = new TextEncoder().encode('wrdvpnisthebest!');
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
        const encrypted = new Uint8Array(await crypto.subtle.encrypt(
          { name: 'AES-CBC', iv: keyBytes }, key, new Uint8Array(16),
        )).slice(0, 16);
        const cipher = host.map((value, index) => value ^ encrypted[index]);
        /* WebVPN 路径由固定密钥的十六进制和加密后的域名组成。 */
        const hex = bytes => [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
        configuredApi = `${location.origin}/https/${hex(keyBytes)}${hex(cipher)}${api.pathname.replace(/\/$/, '')}`;
      }
    }
    return { forumBase: base, tokenFingerprint, resources, configuredApi };
  } catch { return { error: '无法读取登录状态，请刷新已登录的 CC98 页面' }; }
}

/* 调用 /me 确认账号 ID，并用令牌指纹保证连接过程中凭据没有变化。 */
export async function identifyInPage({ base, apiBase, tokenFingerprint, authorization }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    if (!location.href.startsWith(base)) return { status: 0, errorCode: 'SESSION_CHANGED' };
    const rawToken = authorization || localStorage.getItem('accessToken') || '';
    let token = rawToken.startsWith('str-') ? rawToken.slice(4) : rawToken;
    if (!token) return { status: 401 };
    if (!/^Bearer /i.test(token)) token = `Bearer ${token}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const currentFingerprint = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (currentFingerprint !== tokenFingerprint) return { status: 0, errorCode: 'SESSION_CHANGED' };
    /* 请求在页面主世界发出，原始认证头不会传给本地服务。 */
    const response = await fetch(`${apiBase.replace(/\/$/, '')}/me`, {
      method: 'GET', headers: { Authorization: token, Accept: 'application/json' },
      credentials: 'include', redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) return { status: response.status };
    if (!response.headers.get('content-type')?.includes('json')) return { status: 401 };
    const user = await response.json();
    if (!Number.isSafeInteger(user?.id) || user.id <= 0) return { status: 0, error: '账号接口返回格式异常' };
    return { status: 200, accountId: String(user.id) };
  } catch { return { status: 0, error: '账号读取失败，请检查 WebVPN 和 CC98 登录状态' }; }
  finally { clearTimeout(timeout); }
}

/*
 * 在页面主世界读取一个白名单 API 路径。
 * 请求前后都核对令牌指纹和页面地址，防止扫描跨账号或跨站点继续。
 */
export async function readInPage({ base, apiBase, tokenFingerprint, authorization, path, id }) {
  const controllers = globalThis.__cc98LocalSearchControllers ??= new Map();
  const controller = new AbortController();
  controllers.set(id, controller);
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    if (!location.href.startsWith(base)) return { status: 0, errorCode: 'SESSION_CHANGED' };
    const rawToken = authorization || localStorage.getItem('accessToken') || '';
    let token = rawToken.startsWith('str-') ? rawToken.slice(4) : rawToken;
    const expiry = Number(localStorage.getItem('accessToken_expirationTime'));
    if (!token || (!authorization && expiry && expiry * 1000 <= Date.now())) return { status: 401 };
    if (!/^Bearer /i.test(token)) token = `Bearer ${token}`;
    const beforeDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const beforeFingerprint = [...new Uint8Array(beforeDigest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (beforeFingerprint !== tokenFingerprint) return { status: 0, errorCode: 'TOKEN_CHANGED' };
    const response = await fetch(apiBase.replace(/\/$/, '') + path, {
      method: 'GET', headers: { Authorization: token, Accept: 'application/json' },
      credentials: 'include', redirect: 'error', signal: controller.signal,
    });
    const retry = response.headers.get('Retry-After');
    /* Retry-After 可能是秒数或 HTTP 日期，统一换算为毫秒交给本地请求池。 */
    const retryAfterMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : undefined;
    if (!response.ok) return { status: response.status, retryAfterMs };
    if (!response.headers.get('content-type')?.includes('json')) return { status: 401 };
    const data = await response.json();
    const currentRawToken = authorization || localStorage.getItem('accessToken') || '';
    let currentToken = currentRawToken.startsWith('str-') ? currentRawToken.slice(4) : currentRawToken;
    if (!/^Bearer /i.test(currentToken)) currentToken = `Bearer ${currentToken}`;
    const afterDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(currentToken));
    const afterFingerprint = [...new Uint8Array(afterDigest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (!location.href.startsWith(base)) return { status: 0, errorCode: 'SESSION_CHANGED' };
    if (afterFingerprint !== tokenFingerprint) return { status: 0, errorCode: 'TOKEN_CHANGED' };
    return { status: 200, data };
  } catch { return { status: 0, error: '页面请求失败，请检查 WebVPN、网络和登录状态' }; }
  finally { clearTimeout(timeout); controllers.delete(id); }
}

/* 按请求 ID 中止页面中的 fetch；由本地任务取消或连接断开触发。 */
export function cancelInPage(id) { globalThis.__cc98LocalSearchControllers?.get(id)?.abort(); }
