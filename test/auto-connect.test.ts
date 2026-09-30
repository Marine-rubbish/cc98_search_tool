import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import * as protocol from '../extension/protocol.js';
import * as local from '../extension/local.js';
import { startServer } from '../src/server.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const key = 'b'.repeat(64);

test('自动绑定仅接受环回根页面、产品标识和有效凭据', async () => {
  for (const url of ['https://127.0.0.1:9876/', 'http://localhost:9876/', 'http://127.0.0.1:9876/other',
    'http://127.0.0.1:9876/?redirect=1', 'http://user@127.0.0.1:9876/', 'https://example.com/']) {
    assert.equal(local.localPagePort(url), null);
  }
  assert.equal(local.localPagePort('http://127.0.0.1:9878/'), 9878);
  let product = 'cc98-local-search', marker = '1', token = key, calls = 0;
  const location = { href: 'http://127.0.0.1:9878/' };
  const context = vm.createContext({
    URL, AbortSignal, location,
    document: { querySelector: () => ({ content: marker }) },
    fetch: async (url: string, init: RequestInit) => {
      calls++;
      assert.equal(url, '/api/bootstrap');
      assert.equal((init.headers as Record<string, string>)['X-CC98-UI'], '1');
      assert.equal(init.redirect, 'error');
      return new Response(JSON.stringify({ product, token }));
    },
  });
  const bootstrap = vm.runInContext(`(${local.bootstrapInPage.toString()})`, context);
  assert.equal((await bootstrap(9878)).token, key);
  marker = 'other';
  assert.equal(await bootstrap(9878), null);
  assert.equal(calls, 1);
  marker = '1'; product = 'other';
  assert.equal(await bootstrap(9878), null);
  product = 'cc98-local-search'; token = 'invalid';
  assert.equal(await bootstrap(9878), null);
  location.href = 'https://example.com/';
  assert.equal(await bootstrap(9878), null);
  assert.equal(calls, 3);
});

test('bootstrap 来源限制仍生效，凭据不出现在页面源码中', async () => {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(resolve('test-artifacts', 'bootstrap-'));
  const app = await startServer({ port: 0, dataDir: dir });
  try {
    for (const site of [undefined, 'none', 'same-site', 'cross-site']) {
      const headers: Record<string, string> = { 'X-CC98-UI': '1' };
      if (site) headers['Sec-Fetch-Site'] = site;
      assert.equal((await fetch(app.origin + '/api/bootstrap', { headers })).status, 403);
    }
    const headers = { 'X-CC98-UI': '1', 'Sec-Fetch-Site': 'same-origin' };
    assert.equal((await fetch(app.origin + '/api/bootstrap', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    const data = await (await fetch(app.origin + '/api/bootstrap', { headers })).json();
    assert.equal(data.product, 'cc98-local-search');
    assert.equal(data.token, app.token);
    const html = await (await fetch(app.origin)).text();
    assert.match(html, /name="cc98-local-search" content="1"/);
    assert.equal(html.includes(app.token), false);
    assert.equal((await fetch(app.origin + '/api/doctor')).status, 401);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

type Tab = { id: number; url: string; active?: boolean };
type Saved = Record<string, any>;
type BackgroundBehavior = {
  identify?: (authorization: string | null) => Promise<any>;
  read?: (request: any, call: number) => Promise<any>;
};

async function waitFor(check: () => boolean, message: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

/* 执行实际后台脚本，模拟 Chrome 生命周期和 WebSocket 握手。 */
async function background(
  tabs: Tab[],
  saved: Saved = {},
  inspect?: (authorization: string | null) => Promise<any>,
  behavior: BackgroundBehavior = {},
) {
  const listeners: Record<string, (...args: any[]) => any> = {};
  const event = (name: string) => ({ addListener: (fn: (...args: any[]) => any) => { listeners[name] = fn; } });
  const scripts: { world: string; func: Function; target: { tabId: number }; args: any[] }[] = [];
  const sockets: Socket[] = [];
  const created: string[] = [];
  const reloaded: number[] = [];
  const sent: any[] = [];
  const hellos: any[] = [];
  let readCalls = 0;
  const sessionSaved: Saved = {};
  const storage = {
    get: async () => ({ ...saved }),
    set: async (data: Saved) => { Object.assign(saved, data); },
    remove: async (key: string) => { delete saved[key]; },
  };
  const sessionStorage = {
    get: async (key: string) => ({ [key]: sessionSaved[key] }),
    set: async (data: Saved) => { Object.assign(sessionSaved, data); },
    remove: async (key: string) => { delete sessionSaved[key]; },
  };
  class Socket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (event: { data: string }) => void | Promise<void>;
    onerror?: () => void;
    constructor(public url: string) {
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(data: string) {
      const message = JSON.parse(data);
      if (message.type === 'hello') {
        hellos.push(message);
        queueMicrotask(() => this.onmessage?.({ data: '{"type":"ready"}' }));
      }
      else sent.push(message);
    }
    close() { this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
  }
  const context = vm.createContext({
    ...protocol, ...local, URL, crypto: webcrypto, Map, setTimeout, clearTimeout, WebSocket: Socket,
    chrome: {
      storage: { local: storage, session: sessionStorage },
      webRequest: { onBeforeRequest: event('request'), onBeforeSendHeaders: event('headers') },
      runtime: { onMessage: event('message'), getManifest: () => ({ version: '0.2.3' }) },
      alarms: { create: () => {}, onAlarm: event('alarm') },
      tabs: {
        query: async () => [...tabs],
        get: async (id: number) => { const tab = tabs.find(t => t.id === id); if (!tab) throw Error('tab closed'); return tab; },
        update: async () => {}, reload: async (id: number) => { reloaded.push(id); },
        create: async ({ url }: { url: string }) => { created.push(url); },
        onUpdated: event('updated'), onRemoved: event('removed'),
      },
      scripting: { executeScript: async (script: typeof scripts[number]) => {
        /* Chrome 对每个位置参数单独做 JSON 序列化，不能直接传 undefined。 */
        script = { ...script, args: script.args.map((arg, index) => {
          const json = JSON.stringify(arg);
          if (json === undefined) throw new Error(`Error at property 'args': Error at index ${index}: Value is unserializable.`);
          return JSON.parse(json);
        }) };
        scripts.push(script);
        const name = script.func.name;
        if (name === 'bootstrapInPage') {
          assert.equal(script.world, 'ISOLATED');
          return [{ result: { port: script.args[0], token: key } }];
        }
        assert.equal(script.world, 'MAIN');
        if (name === 'inspectPage') return [{ result: inspect ? await inspect(script.args[1]) : {
          configuredApi: 'https://api.cc98.org', tokenFingerprint: 'fixture',
        } }];
        if (name === 'identifyInPage') return [{ result: behavior.identify
          ? await behavior.identify(script.args[0].authorization)
          : { status: 200, accountId: '42' } }];
        if (name === 'readInPage') return [{ result: behavior.read
          ? await behavior.read(script.args[0], ++readCalls)
          : { status: 200, data: [{ id: 235, name: '求职广场' }] } }];
        return [{ result: true }];
      } },
    },
  });
  const source = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8'))
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g, '');
  vm.runInContext(source, context);
  const settle = () => vm.runInContext('ensureConnected()', context);
  const message = (type: string) => new Promise<any>(reply => listeners.message!({ type }, {}, reply));
  return { saved, scripts, sockets, created, reloaded, sent, hellos, listeners, settle, message };
}

test('首次使用无需输入配置，自动发现非默认端口并完成连接', async () => {
  const worker = await background([
    { id: 1, url: 'http://127.0.0.1:9888/' },
    { id: 2, url: 'https://www.cc98.org/board/235' },
  ]);
  await worker.settle();
  assert.equal(worker.sockets.length, 1);
  assert.equal(worker.sockets[0]?.url, 'ws://127.0.0.1:9888/bridge');
  assert.equal(worker.hellos[0]?.extensionVersion, '0.2.3');
  assert.equal(worker.saved.connection.tabId, 2);
  const result = await worker.message('status');
  assert.equal(result.connected, true);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(worker.created.length, 0);
  worker.sockets[0]?.close();
});

test('未捕获认证头时仍能连接并读取版面，捕获后继续传递认证头', async () => {
  const worker = await background([{ id: 2, url: 'https://www.cc98.org/board/235' }], {
    localServer: { port: 9876, token: key },
  });
  await worker.settle();
  assert.equal((await worker.message('status')).state, '已连接');
  assert.equal(worker.scripts.find(s => s.func.name === 'inspectPage')?.args[1], null);
  assert.equal(worker.scripts.find(s => s.func.name === 'identifyInPage')?.args[0].authorization, null);
  const socket = worker.sockets[0]!;
  await socket.onmessage?.({ data: JSON.stringify({ type: 'read', id: 'boards', resource: { kind: 'boards' } }) });
  const reads = worker.scripts.filter(s => s.func.name === 'readInPage');
  assert.equal(reads.length, 2);
  assert.equal(reads.at(-1)?.args[0].authorization, null);
  worker.listeners.headers!({
    tabId: 2, requestHeaders: [{ name: 'Authorization', value: 'Bearer fixture-token' }],
  });
  await new Promise(resolve => setImmediate(resolve));
  await worker.message('connect');
  assert.equal((await worker.message('status')).connected, true);
  assert.equal(worker.scripts.filter(s => s.func.name === 'inspectPage').at(-1)?.args[1], 'Bearer fixture-token');
  worker.sockets.at(-1)?.close();
});

test('并发 401 只刷新绑定标签页一次，并用同账号新令牌重试', async () => {
  const rotated = 'Bearer rotated-token';
  const fingerprint = createHash('sha256').update(rotated).digest('hex');
  const worker = await background(
    [{ id: 2, url: 'https://www.cc98.org/board/235' }],
    { localServer: { port: 9876, token: key } },
    async authorization => ({
      configuredApi: 'https://api.cc98.org',
      tokenFingerprint: authorization ? createHash('sha256').update(authorization).digest('hex') : 'fixture',
    }),
    {
      read: async (_request, call) => call === 1 || call >= 4
        ? { status: 200, data: [{ id: 235, name: '求职广场' }] }
        : { status: 401 },
    },
  );
  await worker.settle();
  const socket = worker.sockets[0]!;
  const first = socket.onmessage?.({ data: JSON.stringify({ type: 'read', id: 'one', resource: { kind: 'boards' } }) });
  const second = socket.onmessage?.({ data: JSON.stringify({ type: 'read', id: 'two', resource: { kind: 'boards' } }) });
  await waitFor(() => worker.reloaded.length > 0, '401 后没有刷新绑定标签页');
  worker.listeners.headers!({
    tabId: 2, requestHeaders: [{ name: 'Authorization', value: rotated }],
  });
  await Promise.all([first, second]);
  assert.deepEqual(worker.reloaded, [2]);
  assert.equal(worker.saved.connection.tokenFingerprint, fingerprint);
  assert.deepEqual(worker.sent.map(message => [message.id, message.status]).sort(), [['one', 200], ['two', 200]]);
  assert.equal(worker.sockets.length, 1);
  socket.close();
});

test('同账号令牌轮换原地更新指纹，不刷新标签页或重建连接', async () => {
  const rotated = 'Bearer rotated-token';
  const fingerprint = createHash('sha256').update(rotated).digest('hex');
  const worker = await background(
    [{ id: 2, url: 'https://www.cc98.org/board/235' }],
    { localServer: { port: 9876, token: key } },
    async authorization => ({
      configuredApi: 'https://api.cc98.org',
      tokenFingerprint: authorization ? createHash('sha256').update(authorization).digest('hex') : 'fixture',
    }),
  );
  await worker.settle();
  worker.listeners.headers!({
    tabId: 2, requestHeaders: [{ name: 'Authorization', value: rotated }],
  });
  await waitFor(() => worker.saved.connection.tokenFingerprint === fingerprint, '同账号新令牌没有更新连接指纹');
  assert.deepEqual(worker.reloaded, []);
  assert.equal(worker.sockets.length, 1);
  assert.equal(JSON.stringify(worker.saved).includes('rotated-token'), false);
  await worker.sockets[0]?.onmessage?.({
    data: JSON.stringify({ type: 'read', id: 'rotated', resource: { kind: 'boards' } }),
  });
  assert.equal(worker.scripts.filter(s => s.func.name === 'readInPage').at(-1)?.args[0].tokenFingerprint, fingerprint);
  worker.sockets[0]?.close();
});

test('新令牌属于其他账号时关闭原连接且不更新会话', async () => {
  const rotated = 'Bearer other-account-token';
  const worker = await background(
    [{ id: 2, url: 'https://www.cc98.org/board/235' }],
    { localServer: { port: 9876, token: key } },
    async authorization => ({
      configuredApi: 'https://api.cc98.org',
      tokenFingerprint: authorization ? createHash('sha256').update(authorization).digest('hex') : 'fixture',
    }),
    {
      identify: async authorization => ({
        status: 200,
        accountId: authorization === rotated ? '99' : '42',
      }),
    },
  );
  await worker.settle();
  worker.listeners.headers!({
    tabId: 2, requestHeaders: [{ name: 'Authorization', value: rotated }],
  });
  await waitFor(() => worker.sockets[0]?.readyState === 3, '账号变化后没有关闭原连接');
  assert.equal(worker.saved.connection.session.accountId, '42');
  assert.equal(worker.saved.connection.tokenFingerprint, 'fixture');
  assert.match((await worker.message('status')).state, /账号已改变/);
});

test('旧配置无需本地页面即可迁移，论坛标签页变化和掉线后能恢复', async () => {
  const worker = await background([{ id: 7, url: 'https://www.cc98.org/board/235' }], {
    connection: { port: 9876, token: key, tabId: 99, apiBase: 'https://api.cc98.org' },
  });
  await worker.settle();
  assert.equal(worker.saved.connection.tabId, 7);
  worker.sockets[0]?.close();
  await new Promise(resolve => setImmediate(resolve));
  await worker.listeners.alarm!({ name: 'reconnect' });
  assert.equal(worker.sockets.length, 2);
  assert.equal((await worker.message('status')).connected, true);
  worker.sockets[1]?.close();
});

test('并发连接尝试合并，检查中主动断开不会迟到重连或重启后恢复', async () => {
  let finish!: (value: any) => void;
  const inspection = new Promise(resolve => { finish = resolve; });
  const tabs = [{ id: 2, url: 'https://www.cc98.org/' }];
  const worker = await background(tabs, { localServer: { port: 9876, token: key } }, () => inspection);
  const pending = worker.settle();
  await new Promise(resolve => setImmediate(resolve));
  const alarm = worker.listeners.alarm!({ name: 'reconnect' });
  assert.equal(worker.scripts.filter(s => s.func.name === 'inspectPage').length, 1);
  const disconnected = worker.message('disconnect');
  await new Promise(resolve => setImmediate(resolve));
  finish({ configuredApi: 'https://api.cc98.org', tokenFingerprint: 'fixture' });
  await pending; await alarm; await disconnected;
  assert.equal(worker.sockets.length, 0);
  await worker.listeners.alarm!({ name: 'reconnect' });
  assert.equal(worker.sockets.length, 0);
  const restarted = await background(tabs, worker.saved);
  await restarted.settle();
  assert.equal(restarted.scripts.length, 0);
  assert.equal((await restarted.message('status')).autoConnect, false);
  await restarted.message('connect');
  assert.equal(restarted.sockets.length, 1);
  restarted.sockets[0]?.close();
});

test('等待登录时保留操作入口；缺少服务或论坛时不自动新建标签页', async () => {
  const login = await background([{ id: 2, url: 'https://www.cc98.org/' }], {
    localServer: { port: 9876, token: key },
  }, async () => ({ error: '请登录 CC98', code: 'LOGIN_REQUIRED' }));
  await login.settle();
  assert.equal((await login.message('status')).needsLogin, true);
  const missing = await background([]);
  await missing.settle();
  assert.match((await missing.message('status')).state, /npm run open/);
  assert.equal(missing.created.length, 0);
  await missing.message('open-search');
  assert.deepEqual(missing.created, ['http://127.0.0.1:9876/']);
});
