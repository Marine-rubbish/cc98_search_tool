import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { startServer } from '../src/server.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { parseOptions, ScanError } from '../src/types.js';
import { Fixture } from './fixture.js';
import { wait } from '../src/pool.js';

const exec = promisify(execFile);
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;

/* 为每个集成测试创建独立临时数据目录，避免 SQLite 和配对信息互相影响。 */
async function directory() {
  await mkdir('test-artifacts', { recursive: true });
  return mkdtemp(resolve('test-artifacts', 'run-'));
}

/* 覆盖扩展桥、扫描器、HTTP、CLI 和本机访问限制组成的完整调用链。 */
test('模拟 Chrome 扩展 → WebSocket → 扫描 → HTTP/CLI 完整链路与访问限制', async () => {
  const dir = await directory();
  const app = await startServer({ port: 0, dataDir: dir });
  const fixture = new Fixture();
  const ws = new WebSocket(app.origin.replace('http:', 'ws:') + '/bridge', { origin: extensionOrigin });
  try {
    await once(ws, 'open');
    const ready = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'hello', token: app.token, session: fixture.session(), extensionVersion: '0.2.3' }));
    assert.equal(JSON.parse(String((await ready)[0])).type, 'ready');
    /* 模拟扩展处理心跳和只读资源请求，并把 Fixture 响应传回桥。 */
    ws.on('message', async raw => {
      const m = JSON.parse(String(raw));
      if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      if (m.type === 'read') ws.send(JSON.stringify({ type: 'reply', id: m.id, ...await fixture.read(m.resource) }));
    });
    const headers = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(app.origin + '/api/doctor')).status, 401);
    assert.equal((await fetch(app.origin + '/api/doctor', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    const wrongHostStatus = await new Promise<number | undefined>((done, reject) => {
      get(app.origin + '/api/doctor', { headers: { ...headers, Host: 'evil.example' } }, response => {
        response.resume(); done(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(wrongHostStatus, 403);
    assert.equal((await fetch(app.origin + '/api/bootstrap', { headers: { 'X-CC98-UI': '1' } })).status, 403);
    const bootstrap = await fetch(app.origin + '/api/bootstrap', { headers: { 'X-CC98-UI': '1', 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(bootstrap.status, 200);
    assert.equal((await bootstrap.json()).token, app.token);
    const home = await fetch(app.origin);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.match(await home.text(), /每一层回复/);
    const appScript = await fetch(app.origin + '/app.js');
    assert.equal(appScript.status, 200);
    const appSource = await appScript.text();
    assert.match(appSource, /waiting_connection:\s*'等待扩展'/);
    assert.match(appSource, /waiting_login:\s*'等待登录'/);
    assert.match(appSource, /activeStatuses/);
    const created = await fetch(app.origin + '/api/jobs', {
      method: 'POST', headers, body: JSON.stringify({ keyword: 'needle', boardIds: [235, 459], requestsPerSecond: 50 }),
    });
    assert.equal(created.status, 201);
    const job = await created.json();
    await app.scanner.settled();
    const exported = await (await fetch(`${app.origin}/api/jobs/${job.id}/export`, { headers })).json();
    assert.deepEqual(exported.results.map((r: { topicId: number }) => r.topicId), [1, 2, 3, 27]);
    assert.equal(exported.total, 4);
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'results', job.id, '--data-dir', dir, '--limit', '2']);
    const cli = JSON.parse(stdout);
    assert.equal(cli.total, 4);
    assert.equal(cli.results.length, 2);
    const doctor = JSON.parse((await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'doctor', '--data-dir', dir])).stdout);
    assert.equal(doctor.connected, true);
    assert.equal(doctor.defaultConcurrency, 20);
    assert.equal('session' in doctor, false);
    assert.equal(doctor.connection.connected, true);
    assert.equal(doctor.connection.extensionVersion, '0.2.3');
    assert.match(doctor.connection.connectedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(doctor.connection.lastMessageAt, /^\d{4}-\d{2}-\d{2}T/);
    const beforeResume = fixture.calls.length;
    const resumed = JSON.parse((await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'resume', job.id,
      '--data-dir', dir, '--topics', '4'])).stdout);
    assert.equal(resumed.run, 2);
    await app.scanner.settled();
    const resumeCalls = fixture.calls.slice(beforeResume);
    assert.ok(resumeCalls.some(r => r.kind === 'posts' && r.id === 4));
    assert.equal(resumeCalls.some(r => r.kind === 'posts' && r.id !== 4), false);
    assert.equal(resumeCalls.some(r => r.kind === 'board' || r.kind === 'topics' || r.kind === 'pinned'), false);
    const bad = new WebSocket(app.origin.replace('http:', 'ws:') + '/bridge', { origin: extensionOrigin });
    await once(bad, 'open');
    bad.send(JSON.stringify({ type: 'hello', token: 'wrong', session: fixture.session() }));
    assert.equal((await once(bad, 'close'))[0], 1008);
    assert.ok(app.bridge.session());
    const pending = app.bridge.read({ kind: 'boards' });
    await pending;
    ws.close();
    await once(ws, 'close');
    await wait(10);
    assert.equal(app.bridge.session(), null);
    const closed = app.bridge.diagnostics();
    assert.equal(closed.connected, false);
    assert.equal(typeof closed.lastClose?.code, 'number');
    assert.equal(closed.lastClose?.reason, 'socket_closed');
  } finally { ws.terminate(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

/* 验证桥的超时与断开都会拒绝 Promise，不留下永久挂起的扫描请求。 */
test('扩展超时和断开都拒绝挂起请求', async () => {
  const server = createServer();
  const bridge = new Bridge(server, 'test-key', 60);
  const sessions: Array<ReturnType<Bridge['session']>> = [];
  const unsubscribe = bridge.onSession(session => sessions.push(session));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/bridge`;

  /* 建立一个已完成 hello 握手的模拟扩展连接。 */
  async function connect() {
    const ws = new WebSocket(url, { origin: extensionOrigin });
    await once(ws, 'open');
    const ready = once(ws, 'message');
    ws.send(JSON.stringify({
      type: 'hello',
      token: 'test-key',
      session: new Fixture().session(),
      extensionVersion: '0.2.3',
    }));
    await ready;
    return ws;
  }
  try {
    const timeout = await connect();
    await assert.rejects(bridge.read({ kind: 'boards' }), /超时/);
    timeout.terminate();
    const disconnected = await connect();
    const request = bridge.read({ kind: 'boards' });
    disconnected.terminate();
    await assert.rejects(request, /断开/);
    const authentication = await connect();
    const read = once(authentication, 'message');
    const authRequest = bridge.read({ kind: 'boards' });
    const message = JSON.parse(String((await read)[0]));
    authentication.send(JSON.stringify({ type: 'reply', id: message.id, status: 0, errorCode: 'AUTH_REQUIRED' }));
    await assert.rejects(authRequest, (error: ScanError) => error.code === 'AUTH_REQUIRED');
    assert.equal(bridge.session(), null);
    assert.equal(bridge.diagnostics().lastClose?.reason, 'auth_required');
    assert.ok(sessions.some(session => session !== null));
    assert.equal(sessions.at(-1), null);
  } finally {
    unsubscribe();
    await bridge.close();
    await new Promise<void>(r => server.close(() => r()));
  }
});

/* 验证进程重启会把 running 改为 paused，同时保留已写入的命中结果。 */
test('服务重启后任务暂停，数据库仍保留结果', async () => {
  const dir = await directory();
  const path = resolve(dir, 'test.sqlite');
  let store = new Store(path);
  try {
    const job = store.create(parseOptions({ keyword: 'needle', boardIds: [235] }), new Fixture().session()!, []);
    store.add(job, { id: 1, boardId: 235, title: 'needle', replyCount: 0 });
    store.finishTopic(job, { id: 1, boardId: 235, title: 'needle', replyCount: 0 }, 'matched', {
      topicId: 1, boardId: 235, boardName: '求职广场', title: 'needle', kind: 'title', snippet: 'needle', url: 'https://www.cc98.org/topic/1/1',
    });
    job.directoryCursor = { pass: 0, boardIndex: 0, from: 18 };
    store.save(job);
    store.close();
    store = new Store(path);
    assert.equal(store.get(job.id).status, 'paused');
    assert.equal(store.results(job).length, 1);
    assert.deepEqual(store.get(job.id).directoryCursor, { pass: 0, boardIndex: 0, from: 18 });
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
