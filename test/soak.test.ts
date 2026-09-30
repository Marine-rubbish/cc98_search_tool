import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  SoakClassifier,
  createSoakReporter,
  parseSoakOptions,
  runSoak,
  safeSnapshot,
} from '../src/soak.js';

test('长跑参数支持搜索负载、时间上限和监控阈值', () => {
  const options = parseSoakOptions([
    '--keyword', '麒麟软件',
    '--boards', '235,459',
    '--concurrency', '12',
    '--rate', '6',
    '--duration-minutes', '120',
    '--poll-seconds', '8',
    '--stall-minutes', '15',
    '--disconnect-grace-seconds', '180',
    '--login-grace-seconds', '90',
    '--case-sensitive',
  ], '/workspace');
  assert.equal(options.keyword, '麒麟软件');
  assert.deepEqual(options.boardIds, [235, 459]);
  assert.equal(options.concurrency, 12);
  assert.equal(options.requestsPerSecond, 6);
  assert.equal(options.durationMs, 120 * 60_000);
  assert.equal(options.pollMs, 8000);
  assert.equal(options.stallMs, 15 * 60_000);
  assert.equal(options.disconnectGraceMs, 180_000);
  assert.equal(options.loginGraceMs, 90_000);
  assert.equal(options.caseSensitive, true);
  assert.equal(options.dataDir, '/workspace/.cc98');
  assert.equal(options.outputDir, '/workspace/.cc98/soak');
});

test('长跑参数拒绝越界数值和附加模式搜索参数', () => {
  assert.equal(parseSoakOptions(['--keyword', 'x', '--duration-minutes', '5']).stallMs, 5 * 60_000);
  assert.throws(() => parseSoakOptions(['--keyword', 'x', '--concurrency', '21']), /并发/);
  assert.throws(() => parseSoakOptions(['--keyword', 'x', '--duration-minutes', '1']), /运行时间/);
  assert.throws(() => parseSoakOptions(['--keyword', 'x', '--duration-minutes', '5', '--stall-minutes', '6']), /无进展/);
  assert.throws(() => parseSoakOptions(['--attach', 'job-1', '--keyword', 'x']), /附加模式/);
  assert.throws(() => parseSoakOptions([]), /关键词/);
});

test('安全快照只保留诊断字段', () => {
  const snapshot = safeSnapshot({
    connected: false,
    busy: true,
    session: { accountId: '764166', forumBase: 'secret-site' },
    token: 'secret-token',
    connection: {
      connected: false,
      connectedAt: '2026-09-30T10:00:00.000Z',
      lastMessageAt: '2026-09-30T10:10:00.000Z',
      lastClose: { at: '2026-09-30T10:11:00.000Z', code: 1006, reason: 'request_timeout' },
    },
  }, {
    id: 'job-1',
    run: 3,
    status: 'waiting_connection',
    desiredRunning: true,
    message: 'Bearer should-not-survive',
    requests: 42,
    directoryPasses: 0,
    directoryCursor: { pass: 0, boardIndex: 0, from: 20 },
    counts: { total: 10, pending: 2, working: 1, matched: 1, no_match: 6, error: 0, out_of_scope: 0 },
    issues: [{ resource: 'board/235', code: 'AUTH', message: 'Authorization Bearer secret-token' }],
    failures: [{ topicId: 10, error: '普通读取错误' }],
    content: '正文',
  }, 1000, 500);
  assert.equal(snapshot.elapsedMs, 500);
  assert.equal(snapshot.job.status, 'waiting_connection');
  assert.equal(snapshot.job.message, '[REDACTED]');
  assert.equal(snapshot.connection.lastClose?.reason, 'request_timeout');
  assert.equal(snapshot.job.issues[0]?.message, '[REDACTED]');
  assert.equal(snapshot.job.failures[0]?.error, '普通读取错误');
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('764166'), false);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('secret-site'), false);
  assert.equal(serialized.includes('should-not-survive'), false);
  assert.equal(serialized.includes('正文'), false);
});

test('分类器区分短暂恢复、长期断线、登录等待和无进展', () => {
  const options = parseSoakOptions([
    '--keyword', 'x',
    '--duration-minutes', '5',
    '--stall-minutes', '2',
    '--disconnect-grace-seconds', '15',
    '--login-grace-seconds', '75',
  ]);
  const classifier = new SoakClassifier(options, 0);
  const running = (at: number, requests: number) => safeSnapshot(
    { connected: true, busy: true, connection: { connected: true } },
    { id: 'job', run: 1, status: 'running', desiredRunning: true, requests, directoryPasses: 0,
      counts: { total: 1, pending: 1, working: 0, matched: 0, no_match: 0, error: 0, out_of_scope: 0 },
      issues: [], failures: [] },
    at, at,
  );
  assert.equal(classifier.observe(running(0, 1)).terminal, undefined);
  const disconnected = safeSnapshot(
    { connected: false, busy: true, connection: { connected: false } },
    { ...running(0, 1).job, status: 'waiting_connection' },
    5000, 5000,
  );
  assert.equal(classifier.observe(disconnected).terminal, undefined);
  const recovered = classifier.observe(running(10_000, 2));
  assert.equal(recovered.events.some(event => event.kind === 'transient_recovered'), true);

  const disconnectFailure = new SoakClassifier(options, 0);
  disconnectFailure.observe(disconnected);
  assert.equal(disconnectFailure.observe({ ...disconnected, at: 21_000, elapsedMs: 21_000 }).terminal?.kind,
    'extension_disconnected');

  const loginFailure = new SoakClassifier(options, 0);
  const login = { ...disconnected, job: { ...disconnected.job, status: 'waiting_login' as const } };
  loginFailure.observe(login);
  assert.equal(loginFailure.observe({ ...login, at: 81_000, elapsedMs: 81_000 }).terminal?.kind, 'login_not_recovered');

  const stalled = new SoakClassifier(options, 0);
  stalled.observe(running(0, 1));
  assert.equal(stalled.observe(running(121_000, 1)).terminal?.kind, 'stalled_unknown');
});

test('普通进度不重复错误明细，错误变化时单独记录', () => {
  const options = parseSoakOptions(['--keyword', 'x']);
  const classifier = new SoakClassifier(options, 0);
  const snapshot = safeSnapshot(
    { connected: true, busy: true, connection: { connected: true } },
    {
      id: 'job', run: 1, status: 'running', desiredRunning: true, requests: 1, directoryPasses: 0,
      counts: { total: 2, pending: 1, working: 0, matched: 0, no_match: 0, error: 1, out_of_scope: 0 },
      issues: [], failures: [{ topicId: 10, error: '没有可读楼层' }],
    },
    0, 0,
  );
  const first = classifier.observe(snapshot);
  assert.equal(first.events.find(event => event.kind === 'progress')?.snapshot?.job.failures.length, 0);
  assert.equal(first.events.find(event => event.kind === 'errors_changed')?.snapshot?.job.failures.length, 1);
  const second = classifier.observe({
    ...snapshot,
    at: 5000,
    elapsedMs: 5000,
    job: { ...snapshot.job, requests: 2 },
  });
  assert.equal(second.events.some(event => event.kind === 'errors_changed'), false);
  assert.equal(second.events.find(event => event.kind === 'progress')?.snapshot?.job.failures.length, 0);
  const changed = classifier.observe({
    ...snapshot,
    at: 10_000,
    elapsedMs: 10_000,
    job: {
      ...snapshot.job,
      requests: 3,
      failureCount: 2,
      failures: [...snapshot.job.failures, { topicId: 11, error: '请求失败' }],
    },
  });
  assert.equal(changed.events.find(event => event.kind === 'errors_changed')?.snapshot?.job.failures.length, 2);
});

test('诊断写入器生成受限权限文件和 AI 修复入口', async () => {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(resolve('test-artifacts', 'soak-'));
  try {
    const options = parseSoakOptions(['--keyword', 'needle', '--output-dir', dir]);
    const reporter = await createSoakReporter(options, { sourceFiles: [] });
    await reporter.setJob('job-1');
    await reporter.event({ kind: 'started', at: 1, message: '开始' });
    await reporter.finish({
      kind: 'stalled_unknown',
      success: false,
      at: 2,
      message: '没有进展',
    });
    const latest = JSON.parse(await readFile(resolve(dir, 'latest.json'), 'utf8'));
    const run = JSON.parse(await readFile(resolve(latest.runDir, 'run.json'), 'utf8'));
    const incident = JSON.parse(await readFile(resolve(latest.runDir, 'incident.json'), 'utf8'));
    const repair = await readFile(resolve(latest.runDir, 'repair-request.md'), 'utf8');
    assert.equal(run.jobId, 'job-1');
    assert.equal(incident.classification, 'stalled_unknown');
    assert.match(repair, /npm run typecheck/);
    assert.equal((await stat(resolve(latest.runDir, 'incident.json'))).mode & 0o777, 0o600);
    assert.equal(JSON.stringify({ latest, run, incident, repair }).includes('secret'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('真实任务编排通过本地 API 创建、采样并在到时后暂停任务', async () => {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(resolve('test-artifacts', 'soak-api-'));
  const token = 'a'.repeat(64);
  let requests = 0, paused = false;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const path = new URL(request.url!, 'http://127.0.0.1').pathname;
    let result: unknown;
    if (path === '/api/doctor') result = {
      connected: true,
      busy: false,
      connection: { connected: true, extensionVersion: '0.2.3' },
    };
    else if (path === '/api/jobs' && request.method === 'POST')
      result = { id: 'job-real-api' };
    else if (path === '/api/jobs/job-real-api/pause' && request.method === 'POST') {
      paused = true;
      result = { id: 'job-real-api', status: 'paused' };
    } else if (path === '/api/jobs/job-real-api') {
      result = {
        id: 'job-real-api', run: 1, status: 'running', desiredRunning: true,
        requests: ++requests, directoryPasses: 0,
        directoryCursor: { pass: 0, boardIndex: 0, from: requests },
        counts: { total: requests, pending: 0, working: 1, matched: 0, no_match: 0, error: 0, out_of_scope: 0 },
        issues: [], failures: [],
      };
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'missing' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await writeFile(resolve(dir, 'server.json'), JSON.stringify({ origin: `http://127.0.0.1:${port}`, token }));
  const options = parseSoakOptions(['--keyword', 'needle', '--data-dir', dir, '--output-dir', resolve(dir, 'out')]);
  options.durationMs = 20;
  options.pollMs = 2;
  let started: { jobId: string; attached: boolean } | undefined;
  try {
    const result = await runSoak(options, new AbortController().signal, {
      onStarted: value => { started = value; },
    });
    assert.equal(result.kind, 'duration_reached');
    assert.equal(result.success, true);
    assert.equal(paused, true);
    assert.equal(started?.jobId, 'job-real-api');
    assert.equal(started?.attached, false);
    const run = JSON.parse(await readFile(resolve(result.runDir!, 'run.json'), 'utf8'));
    assert.equal(run.environment.extensionVersion, '0.2.3');
    assert.equal(JSON.stringify(run).includes(token), false);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});
