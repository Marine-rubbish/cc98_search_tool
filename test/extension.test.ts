import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import {
  resourcePath, forumBase, loginUrl, apiBaseFromRequest, validApiBase,
  prepareLoginInPage, inspectPage, identifyInPage, readInPage,
} from '../extension/protocol.js';

/* 验证论坛地址白名单、WebVPN 根路径识别和 Resource 到 API 路径的限制。 */
test('扩展只接受固定读取资源，正确识别 WebVPN 地址', () => {
  const vpn = 'https://webvpn.zju.edu.cn/https/abcdef0123/';
  assert.equal(forumBase(`${vpn}topic/1/2`), vpn);
  assert.equal(loginUrl(`${vpn}topic/1/2`), `${vpn}logon`);
  assert.equal(forumBase('https://www.cc98.org/board/235'), 'https://www.cc98.org/');
  assert.equal(loginUrl('https://www.cc98.org/board/235'), 'https://www.cc98.org/logon');
  assert.throws(() => forumBase('https://webvpn.zju.edu.cn/login'));
  assert.throws(() => forumBase('https://www.cc98.org.evil.example/'));
  assert.equal(apiBaseFromRequest('https://webvpn.zju.edu.cn/https/deadbeef/Topic/1/post?from=0&size=10', vpn), 'https://webvpn.zju.edu.cn/https/deadbeef');
  assert.equal(validApiBase('https://api.cc98.org', vpn), false);
  assert.equal(validApiBase('https://evil.example', 'https://www.cc98.org/'), false);
  assert.equal(resourcePath({ kind: 'posts', id: 123, from: 90, size: 10 }), '/Topic/123/post?from=90&size=10');
  assert.throws(() => resourcePath({ kind: 'fetch', id: 1, url: 'https://evil.example' }));
  assert.throws(() => resourcePath({ kind: 'posts', id: 1, from: -1, size: 10 }));
  assert.throws(() => resourcePath({ kind: 'posts', id: 1, from: 0, size: 100 }));
});

/* 验证跳转登录前只在同一论坛页面写入登录后返回地址。 */
test('打开登录页前保存同一论坛地址作为登录后返回位置', () => {
  const storage = new Map<string, string>();
  const context = vm.createContext({
    location: { href: 'https://webvpn.zju.edu.cn/https/abcdef0123/board/235' },
    localStorage: { setItem: (key: string, value: string) => storage.set(key, value) },
  });
  const prepare = vm.runInContext(`(${prepareLoginInPage.toString()})`, context);
  assert.equal(prepare('https://webvpn.zju.edu.cn/https/abcdef0123/'), true);
  assert.equal(storage.get('logOnRedirectUrl'), 'https://webvpn.zju.edu.cn/https/abcdef0123/');
  assert.equal(prepare('https://www.cc98.org/'), false);
});

/* 验证不依赖 userInfo：用令牌指纹锁定会话，通过 /me 获取账号且不泄露凭据。 */
test('userInfo 缺失时通过访问令牌和 /me 确认账号，凭据不离开页面', async () => {
  const storage = new Map([
    ['accessToken', 'str-Bearer fixture-token'],
    ['accessToken_expirationTime', String(Math.floor(Date.now() / 1000) + 3600)],
  ]);
  const requests: { url: string | URL; init: RequestInit }[] = [];
  const context = vm.createContext({
    Map, URL, AbortController, AbortSignal, TextEncoder, Uint8Array, crypto: webcrypto,
    setTimeout, clearTimeout, Date,
    location: { href: 'https://www.cc98.org/board/235' },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    performance: { getEntriesByType: () => [] },
    fetch: async (url: string | URL, init: RequestInit) => {
      requests.push({ url, init });
      const data = String(url).endsWith('/me') ? { id: 42 } : [{ id: 235, name: '求职广场' }];
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  const inspect = vm.runInContext(`(${inspectPage.toString()})`, context);
  const identify = vm.runInContext(`(${identifyInPage.toString()})`, context);
  const read = vm.runInContext(`(${readInPage.toString()})`, context);
  const inspected = await inspect('https://www.cc98.org/');
  assert.equal(inspected.error, undefined);
  assert.equal(inspected.tokenFingerprint, createHash('sha256').update('Bearer fixture-token').digest('hex'));
  assert.equal(JSON.stringify(inspected).includes('fixture-token'), false);
  const identity = await identify({
    base: 'https://www.cc98.org/', apiBase: 'https://api.cc98.org',
    tokenFingerprint: inspected.tokenFingerprint,
  });
  assert.equal(identity.status, 200);
  assert.equal(identity.accountId, '42');
  const request = {
    base: 'https://www.cc98.org/', apiBase: 'https://api.cc98.org',
    tokenFingerprint: inspected.tokenFingerprint, path: '/board/all', id: 'test',
  };
  const reply = await read(request);
  assert.equal(reply.status, 200);
  assert.equal(String(requests[0]?.url), 'https://www.cc98.org/static/config.json');
  assert.equal(requests[1]?.url, 'https://api.cc98.org/me');
  assert.equal(requests[2]?.url, 'https://api.cc98.org/board/all');
  assert.equal((requests[1]?.init.headers as Record<string, string>).Authorization, 'Bearer fixture-token');
  assert.equal((requests[2]?.init.headers as Record<string, string>).Authorization, 'Bearer fixture-token');
  assert.equal(JSON.stringify(reply).includes('fixture-token'), false);
  storage.set('accessToken_expirationTime', '1');
  assert.equal((await read(request)).status, 401);
  assert.equal(requests.length, 3);
  storage.set('accessToken_expirationTime', String(Math.floor(Date.now() / 1000) + 3600));
  storage.set('accessToken', 'str-Bearer another-token');
  assert.equal((await read(request)).errorCode, 'TOKEN_CHANGED');
  assert.equal(requests.length, 3);
});

/* 验证页面存储不可读时，可使用扩展从同一标签页请求中捕获的认证头。 */
test('页面存储不可见时可使用同一标签页捕获的认证请求', async () => {
  const requests: { url: string | URL; init: RequestInit }[] = [];
  const context = vm.createContext({
    Map, URL, AbortController, AbortSignal, TextEncoder, Uint8Array, crypto: webcrypto,
    setTimeout, clearTimeout, Date,
    location: { href: 'https://www.cc98.org/board/235', hostname: 'www.cc98.org', origin: 'https://www.cc98.org' },
    localStorage: { getItem: () => null },
    performance: { getEntriesByType: () => [] },
    fetch: async (url: string | URL, init: RequestInit) => {
      requests.push({ url, init });
      const data = String(url).endsWith('/me') ? { id: 42 } : [{ id: 235, name: '求职广场' }];
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  const inspect = vm.runInContext(`(${inspectPage.toString()})`, context);
  const identify = vm.runInContext(`(${identifyInPage.toString()})`, context);
  const read = vm.runInContext(`(${readInPage.toString()})`, context);
  const authorization = 'Bearer captured-token';
  const inspected = await inspect('https://www.cc98.org/', authorization);
  assert.equal(inspected.tokenFingerprint, createHash('sha256').update(authorization).digest('hex'));
  const identity = await identify({
    base: 'https://www.cc98.org/', apiBase: 'https://api.cc98.org',
    tokenFingerprint: inspected.tokenFingerprint, authorization,
  });
  assert.equal(identity.accountId, '42');
  const result = await read({
    base: 'https://www.cc98.org/', apiBase: 'https://api.cc98.org',
    tokenFingerprint: inspected.tokenFingerprint, authorization,
    path: '/board/all', id: 'captured',
  });
  assert.equal(result.status, 200);
  assert.equal((requests.at(-1)?.init.headers as Record<string, string>).Authorization, authorization);
  assert.equal(JSON.stringify({ inspected, identity, result }).includes('captured-token'), false);
});

/* 捕获请求头代表浏览器实际使用的凭据，不受页面内旧过期时间影响。 */
test('捕获认证头存在时忽略页面内旧过期时间', async () => {
  const context = vm.createContext({
    Map, AbortController, TextEncoder, Uint8Array, crypto: webcrypto,
    setTimeout, clearTimeout, Date,
    location: { href: 'https://www.cc98.org/board/235' },
    localStorage: { getItem: (key: string) => key === 'accessToken_expirationTime' ? '1' : null },
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
  });
  const read = vm.runInContext(`(${readInPage.toString()})`, context);
  const authorization = 'Bearer captured-token';
  const reply = await read({
    base: 'https://www.cc98.org/', apiBase: 'https://api.cc98.org',
    tokenFingerprint: createHash('sha256').update(authorization).digest('hex'),
    authorization, path: '/board/all', id: 'captured-expired',
  });
  assert.equal(reply.status, 200);
});

/* 验证登录诊断能区分无凭据、等待生成访问令牌和令牌过期。 */
test('登录状态错误明确区分未登录、等待令牌和过期', async () => {
  const storage = new Map<string, string>();
  const context = vm.createContext({
    URL, AbortSignal, TextEncoder, Uint8Array, crypto: webcrypto, Date,
    location: { href: 'https://www.cc98.org/' },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    performance: { getEntriesByType: () => [] },
    fetch: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
  });
  const inspect = vm.runInContext(`(${inspectPage.toString()})`, context);
  const loggedOut = await inspect('https://www.cc98.org/');
  assert.match(loggedOut.error, /没有可用/);
  assert.equal(loggedOut.code, 'LOGIN_REQUIRED');
  storage.set('refresh_token', 'str-refresh');
  const waiting = await inspect('https://www.cc98.org/');
  assert.match(waiting.error, /访问令牌尚未生成/);
  assert.equal(waiting.code, 'REQUEST_NEEDED');
  storage.set('accessToken', 'str-Bearer expired');
  storage.set('accessToken_expirationTime', '1');
  assert.match((await inspect('https://www.cc98.org/')).error, /登录已过期/);
});

/* 验证可根据公开 API 配置推导 WebVPN 同源代理地址，并通过地址校验。 */
test('WebVPN 页面能从公开配置推导 API 代理地址', async () => {
  const base = 'https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421e7e056d22433310830079bab/';
  const storage = new Map([
    ['accessToken', 'str-Bearer fixture-token'],
    ['accessToken_expirationTime', String(Math.floor(Date.now() / 1000) + 3600)],
  ]);
  const context = vm.createContext({
    URL, AbortSignal, TextEncoder, Uint8Array, crypto: webcrypto, Date,
    location: { href: base, hostname: 'webvpn.zju.edu.cn', origin: 'https://webvpn.zju.edu.cn' },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    performance: { getEntriesByType: () => [] },
    fetch: async () => new Response(JSON.stringify({ apiUrl: 'https://api.cc98.org' }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  const inspect = vm.runInContext(`(${inspectPage.toString()})`, context);
  const result = await inspect(base);
  assert.equal(result.configuredApi,
    'https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421f1e748d22433310830079bab');
  assert.equal(validApiBase(result.configuredApi, base), true);
});
