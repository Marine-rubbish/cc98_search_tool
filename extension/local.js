/* 仅把环回地址根页面作为本地搜索页候选，端口由页面地址决定。 */
export function localPagePort(input) {
  try {
    const url = new URL(input);
    const port = Number(url.port);
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
        !url.username && !url.password && url.pathname === '/' && !url.search &&
        Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
  } catch { /* 忽略其他页面。 */ }
  return null;
}

/*
 * 在本地页面的 ISOLATED 世界执行。凭据只通过 executeScript 返回后台，
 * 不写 DOM 或广播事件；请求仍遵守服务端的同源 bootstrap 限制。
 */
export async function bootstrapInPage(expectedPort) {
  try {
    const url = new URL(location.href);
    if (url.origin !== `http://127.0.0.1:${expectedPort}` || url.pathname !== '/' || url.search ||
        url.username || url.password ||
        document.querySelector('meta[name="cc98-local-search"]')?.content !== '1') return null;
    const response = await fetch('/api/bootstrap', {
      headers: { 'X-CC98-UI': '1' }, credentials: 'omit', redirect: 'error',
      cache: 'no-store', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (location.href !== url.href || data.product !== 'cc98-local-search' ||
        !/^[a-f0-9]{64}$/.test(data.token)) return null;
    return { port: expectedPort, token: data.token };
  } catch { return null; }
}

/* 同时用于旧版连接迁移和隔离世界返回值检查。 */
export function validLocalServer(value) {
  return !!value && Number.isInteger(value.port) && value.port >= 1024 &&
    value.port <= 65535 && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token);
}
