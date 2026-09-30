import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Scanner } from '../src/scanner.js';
import { Store } from '../src/store.js';
import { RequestPool, wait } from '../src/pool.js';
import { matchText, visibleText } from '../src/matcher.js';
import { Site } from '../src/site.js';
import { parseOptions, ScanError } from '../src/types.js';
import { Fixture } from './fixture.js';

/* 生成固定关键词和版面范围的测试参数，只让用例调整并发数。 */
const options = (concurrency = 20) => parseOptions({ keyword: 'needle', boardIds: [235, 459], concurrency, requestsPerSecond: 50 });

/* 使用独立内存库运行一次完整扫描，并返回最终任务及可继续控制的对象。 */
async function scan(fixture: Fixture, concurrency = 20) {
  const store = new Store();
  const scanner = new Scanner(store, fixture);
  const job = await scanner.start(options(concurrency));
  await scanner.settled();
  return { store, scanner, job: store.get(job.id) };
}

/* 等待异步扫描达到指定状态，超时后让断言给出明确失败。 */
async function waitUntil(check: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await wait(5);
  assert.equal(check(), true);
}

/* 验证分类目录被展开为具体版面，并把分类名附到各版面上。 */
test('版面目录展开分类并保留分类名', async () => {
  const site = new Site(async () => [
    { id: 3, name: '学习', boards: [
      { id: 68, name: '学习天地', topicCount: 100 },
      { id: 235, name: '求职广场', topicCount: 200 },
    ] },
    { id: 5, name: '信息', boards: [{ id: 459, name: '实习兼职', topicCount: 50 }] },
  ]);
  assert.deepEqual(await site.boards(), [
    { id: 68, name: '学习天地', groupName: '学习', canEntry: undefined, topicCount: 100 },
    { id: 235, name: '求职广场', groupName: '学习', canEntry: undefined, topicCount: 200 },
    { id: 459, name: '实习兼职', groupName: '信息', canEntry: undefined, topicCount: 50 },
  ]);
});

/* 验证并发不改变结果，并覆盖深楼层、标题短路、置顶去重和跨版过滤。 */
test('串行和并发 20 返回相同主题，包含第 100 楼与范围内置顶', async () => {
  const serial = new Fixture(), parallel = new Fixture();
  const a = await scan(serial, 1), b = await scan(parallel);
  try {
    /* 将命中结果压缩为主题 ID，方便比较串行和并发输出。 */
    const ids = (r: typeof a) => r.store.results(r.job).map(m => m.topicId);
    assert.deepEqual(ids(a), [1, 2, 3, 27]);
    assert.deepEqual(ids(a), ids(b));
    assert.equal(b.store.results(b.job).find(m => m.topicId === 1)?.floor, 100);
    assert.match(b.store.results(b.job)[0]!.url, /\/topic\/1\/10#0$/);
    assert.equal(b.job.status, 'finished_unverified');
    assert.equal(b.job.coverage.directoryVerified, false);
    assert.equal(b.job.directoryPasses, 2);
    assert.ok(parallel.peak <= 20);
    assert.equal(b.store.counts(b.job).total, 28);
    assert.equal(b.store.counts(b.job).out_of_scope, 1);
    assert.equal(parallel.calls.filter(r => r.kind === 'posts' && r.id === 2).length, 0);
    assert.equal(parallel.calls.filter(r => r.kind === 'posts' && r.id === 3).length, 1);
    assert.equal(parallel.calls.filter(r => r.kind === 'posts' && r.id === 4).length, 2);
  } finally { a.store.close(); b.store.close(); }
});

/* 验证普通恢复只重试未完成项，既有结论和旧轮次保持不变。 */
test('失败楼层不能变成无匹配，恢复只重试未完成项并保留历史', async () => {
  const fixture = new Fixture();
  fixture.failure = r => r.kind === 'posts' && r.id === 1 && r.from === 90 ? { status: 404 } : undefined;
  const { scanner, store, job } = await scan(fixture);
  try {
    assert.equal(job.status, 'partial');
    assert.equal(store.counts(job).error, 1);
    assert.equal(store.failures(job)[0]?.topicId, 1);
    fixture.failure = undefined;
    fixture.content.set('4:1', 'needle 新回复内容');
    const resumedCalls = fixture.calls.length;
    scanner.resume(job.id);
    await scanner.settled();
    const resumed = store.get(job.id);
    assert.equal(resumed.run, 2);
    assert.deepEqual(store.results(resumed).map(m => m.topicId), [1, 2, 3, 27]);
    assert.equal(store.history(resumed).length, 2);
    assert.equal(store.results(resumed, 0, 100, 1).some(m => m.topicId === 4), false);
    assert.equal(fixture.calls.slice(resumedCalls).some(r => r.kind === 'posts' && r.id === 4), false);
  } finally { store.close(); }
});

/* 验证定向恢复跳过目录和其他失败项，只领取明确指定的主题。 */
test('定向恢复只重试指定主题', async () => {
  const fixture = new Fixture();
  fixture.failure = r => r.kind === 'posts' &&
    ((r.id === 1 && r.from === 90) || (r.id === 4 && r.from === 10)) ? { status: 404 } : undefined;
  const { scanner, store, job } = await scan(fixture);
  try {
    assert.equal(store.counts(job).error, 2);
    fixture.failure = undefined;
    const resumedCalls = fixture.calls.length;
    scanner.resume(job.id, [4]);
    await scanner.settled();
    const resumed = store.get(job.id);
    const calls = fixture.calls.slice(resumedCalls);
    assert.equal(resumed.run, 2);
    assert.equal(store.counts(resumed).error, 1);
    assert.deepEqual(store.failures(resumed).map(f => f.topicId), [1]);
    assert.ok(calls.some(r => r.kind === 'posts' && r.id === 4));
    assert.equal(calls.some(r => r.kind === 'posts' && r.id !== 4), false);
    assert.equal(calls.some(r => r.kind === 'board' || r.kind === 'topics' || r.kind === 'pinned'), false);
  } finally { store.close(); }
});

/* 验证暂停后沿用已保存的目录偏移，不从第 0 页重新读取。 */
test('普通恢复从持久化目录游标继续', async () => {
  const fixture = new Fixture();
  fixture.delay = 40;
  const store = new Store();
  const scanner = new Scanner(store, fixture);
  const job = await scanner.start(options(1));
  try {
    await waitUntil(() => store.get(job.id).directoryCursor?.from === 18);
    await scanner.cancel(job.id, true);
    const cursor = store.get(job.id).directoryCursor!;
    const resumedCalls = fixture.calls.length;
    scanner.resume(job.id);
    await waitUntil(() => fixture.calls.slice(resumedCalls).some(r => r.kind === 'topics'));
    await scanner.cancel(job.id, true);
    const firstPage = fixture.calls.slice(resumedCalls).find(r => r.kind === 'topics');
    assert.equal(firstPage?.kind === 'topics' ? firstPage.from : -1, cursor.from);
    const resumedCursor = store.get(job.id).directoryCursor;
    assert.ok(resumedCursor);
    assert.equal(resumedCursor.from >= cursor.from, true);
  } finally { store.close(); }
});

/* 验证旧任务没有游标时按已发现数量回退 100 个位置接续。 */
test('旧任务恢复时生成带缓冲的目录游标', () => {
  const store = new Store();
  const fixture = new Fixture();
  try {
    const job = store.create(options(), fixture.session()!, [{ id: 235, name: '求职广场', topicCount: 300 }]);
    for (let id = 1; id <= 150; id++)
      store.add(job, { id, boardId: 235, title: `主题 ${id}`, replyCount: 0 });
    delete job.directoryCursor;
    job.status = 'paused';
    store.save(job);
    const resumed = store.resume(job);
    assert.deepEqual(resumed.directoryCursor, { pass: 0, boardIndex: 0, from: 50 });
  } finally { store.close(); }
});

/* 验证认证恢复后继续当前轮次，不重建 run 或丢失已完成主题。 */
test('登录失效进入等待，同账号恢复后继续当前轮次', async () => {
  const fixture = new Fixture();
  let failed = false;
  fixture.failure = r => {
    if (r.kind !== 'posts' || failed) return;
    failed = true;
    fixture.setSession(null);
    return { status: 401 };
  };
  const store = new Store();
  const scanner = new Scanner(store, fixture);
  const job = await scanner.start(options());
  try {
    await waitUntil(() => store.get(job.id).status === 'waiting_login');
    assert.equal(store.get(job.id).desiredRunning, true);
    fixture.failure = undefined;
    fixture.setSession({ accountId: '42', forumBase: 'https://www.cc98.org/' });
    await scanner.settled();
    const recovered = store.get(job.id);
    assert.equal(recovered.run, 1);
    assert.equal(recovered.status, 'finished_unverified');
    assert.equal(recovered.desiredRunning, false);
  } finally { store.close(); }
});

/* 验证断线等待由所有协程共享，主动暂停后不能被迟到重连重新启动。 */
test('断线等待期间主动暂停会关闭自动续跑意图', async () => {
  const fixture = new Fixture();
  let failed = false;
  fixture.failure = r => {
    if (r.kind !== 'posts' || failed) return;
    failed = true;
    fixture.setSession(null);
    return new ScanError('DISCONNECTED', 'Chrome 扩展连接已断开', true);
  };
  const store = new Store();
  const scanner = new Scanner(store, fixture);
  const job = await scanner.start(options());
  try {
    await waitUntil(() => store.get(job.id).status === 'waiting_connection');
    await scanner.cancel(job.id, true);
    const count = fixture.calls.length;
    fixture.failure = undefined;
    fixture.setSession({ accountId: '42', forumBase: 'https://www.cc98.org/' });
    await wait(50);
    assert.equal(fixture.calls.length, count);
    assert.equal(store.get(job.id).status, 'paused');
    assert.equal(store.get(job.id).desiredRunning, false);
  } finally { store.close(); }
});

/* 取消与暂停使用同一等待退出链路，但必须保留 cancelled 终态。 */
test('断线等待期间取消不会被迟到重连覆盖', async () => {
  const fixture = new Fixture();
  let failed = false;
  fixture.failure = r => {
    if (r.kind !== 'posts' || failed) return;
    failed = true;
    fixture.setSession(null);
    return new ScanError('DISCONNECTED', 'Chrome 扩展连接已断开', true);
  };
  const store = new Store();
  const scanner = new Scanner(store, fixture);
  const job = await scanner.start(options());
  try {
    await waitUntil(() => store.get(job.id).status === 'waiting_connection');
    await scanner.cancel(job.id);
    fixture.failure = undefined;
    fixture.setSession({ accountId: '42', forumBase: 'https://www.cc98.org/' });
    await wait(50);
    assert.equal(store.get(job.id).status, 'cancelled');
    assert.equal(store.get(job.id).desiredRunning, false);
  } finally { store.close(); }
});

/* 验证等待期间出现其他账号时硬暂停，不能跨账号继续当前任务。 */
test('断线后连接其他账号会停止自动续跑', async () => {
  const fixture = new Fixture();
  let failed = false;
  fixture.failure = r => {
    if (r.kind !== 'posts' || failed) return;
    failed = true;
    fixture.setSession(null);
    return new ScanError('DISCONNECTED', 'Chrome 扩展连接已断开', true);
  };
  const store = new Store();
  const scanner = new Scanner(store, fixture);
  const job = await scanner.start(options());
  try {
    await waitUntil(() => store.get(job.id).status === 'waiting_connection');
    fixture.setSession({ accountId: '43', forumBase: 'https://www.cc98.org/' });
    await scanner.settled();
    const stopped = store.get(job.id);
    assert.equal(stopped.status, 'paused');
    assert.equal(stopped.desiredRunning, false);
    assert.match(stopped.message!, /账号或站点/);
    assert.equal(store.counts(stopped).error, 0);
  } finally { store.close(); }
});

/* 验证服务重启保留运行意图，同账号连接后在原轮次继续遗留工作。 */
test('服务重启后按运行意图恢复原轮次', async () => {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(resolve('test-artifacts', 'same-run-'));
  const path = resolve(dir, 'tasks.sqlite');
  let store = new Store(path);
  const fixture = new Fixture();
  const job = store.create(options(), fixture.session()!, [{ id: 235, name: '求职广场', topicCount: 0 }]);
  store.add(job, fixture.topics.get(2)!);
  assert.equal(store.claim(job)?.id, 2);
  job.status = 'waiting_connection';
  job.desiredRunning = true;
  job.directoryCursor = { pass: 2, boardIndex: 0, from: 0 };
  store.save(job);
  store.close();
  store = new Store(path);
  const scanner = new Scanner(store, fixture);
  try {
    await waitUntil(() => store.get(job.id).status !== 'paused');
    await scanner.settled();
    const recovered = store.get(job.id);
    assert.equal(recovered.run, 1);
    assert.equal(recovered.status, 'finished_unverified');
    assert.equal(store.counts(recovered).matched, 1);
    assert.equal(recovered.desiredRunning, false);
    const stopped = store.create(options(), fixture.session()!, [{ id: 235, name: '求职广场', topicCount: 0 }]);
    stopped.status = 'paused';
    stopped.desiredRunning = false;
    store.save(stopped);
    store.close();
    store = new Store(path);
    new Scanner(store, fixture);
    await wait(20);
    assert.equal(store.get(stopped.id).status, 'paused');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/* 验证异常空页被记录为目录问题，任务不能标记为完整结束。 */
test('异常空目录保留读取问题', async () => {
  const fixture = new Fixture();
  fixture.failure = r => r.kind === 'topics' ? { status: 200, data: [] } : undefined;
  const { store, job } = await scan(fixture);
  try { assert.equal(job.status, 'partial'); assert.ok(job.issues.some(i => i.code === 'PAGINATION')); }
  finally { store.close(); }
});

/* 验证非空短页经下一空页确认后，仍继续其他版面和第二遍目录复查。 */
test('目录短页确认实际尾部后继续后续版面和第二遍复查', async () => {
  const fixture = new Fixture();
  const boardTopics = [...fixture.topics.values()].filter(topic => topic.boardId === 235);
  fixture.failure = r => {
    if (r.kind === 'board') {
      const board = fixture.boardList.find(item => item.id === r.id);
      return { status: 200, data: { ...board, canEntry: true, topicCount: r.id === 235 ? 30 : 1 } };
    }
    if (r.kind !== 'topics') return;
    if (r.id === 459)
      return { status: 200, data: r.from === 0 ? [fixture.topics.get(27)] : [] };
    if (r.from === 0) return { status: 200, data: boardTopics.slice(0, 20) };
    if (r.from === 18) return { status: 200, data: boardTopics.slice(18, 22) };
    if (r.from === 22) return { status: 200, data: boardTopics.slice(22, 26) };
    if (r.from === 26) return { status: 200, data: [] };
  };
  const { store, job } = await scan(fixture);
  try {
    assert.equal(job.status, 'partial');
    assert.equal(job.directoryPasses, 2);
    assert.deepEqual(job.directoryCursor, { pass: 2, boardIndex: 0, from: 0 });
    assert.equal(fixture.calls.filter(r => r.kind === 'topics' && r.id === 459).length, 2);
    assert.equal(fixture.calls.filter(r => r.kind === 'topics' && r.id === 235 && r.from === 22).length, 2);
    assert.equal(fixture.calls.filter(r => r.kind === 'topics' && r.id === 235 && r.from === 26).length, 2);
    assert.ok(fixture.calls.some(r => r.kind === 'topic' && r.id === 26));
    const tailIssues = job.issues.filter(issue => issue.resource.startsWith('board/235/pass/'));
    assert.equal(tailIssues.length, 2);
    assert.ok(tailIssues.every(issue => issue.message.includes('实际在 26 结束') && issue.message.includes('已继续后续版面')));
  } finally { store.close(); }
});

/* 验证尾部确认请求失败时不推进游标，恢复后会重新读取原短页。 */
test('目录尾部确认失败时保留原短页游标', async () => {
  const fixture = new Fixture();
  const boardTopics = [...fixture.topics.values()].filter(topic => topic.boardId === 235);
  fixture.failure = r => {
    if (r.kind === 'board') {
      const board = fixture.boardList.find(item => item.id === r.id);
      return { status: 200, data: { ...board, canEntry: true, topicCount: r.id === 235 ? 30 : 1 } };
    }
    if (r.kind !== 'topics' || r.id !== 235) return;
    if (r.from === 0) return { status: 200, data: boardTopics.slice(0, 20) };
    if (r.from === 18) return { status: 200, data: boardTopics.slice(18, 22) };
    if (r.from === 22) return { status: 400 };
  };
  const { store, job } = await scan(fixture);
  try {
    assert.equal(job.status, 'partial');
    assert.deepEqual(job.directoryCursor, { pass: 0, boardIndex: 0, from: 18 });
    assert.equal(fixture.calls.filter(r => r.kind === 'topics' && r.id === 235 && r.from === 22).length, 1);
    assert.equal(fixture.calls.some(r => r.kind === 'topics' && r.id === 459), false);
  } finally { store.close(); }
});

/* 验证目录页失败时游标停在失败偏移，恢复后从同一页重试。 */
test('目录失败保留游标并从失败页恢复', async () => {
  const fixture = new Fixture();
  fixture.failure = r => r.kind === 'topics' && r.from === 18 ? { status: 200, data: [] } : undefined;
  const { scanner, store, job } = await scan(fixture);
  try {
    assert.deepEqual(job.directoryCursor, { pass: 0, boardIndex: 0, from: 18 });
    fixture.failure = undefined;
    const resumedCalls = fixture.calls.length;
    scanner.resume(job.id);
    await scanner.settled();
    const firstPage = fixture.calls.slice(resumedCalls).find(r => r.kind === 'topics');
    assert.equal(firstPage?.kind === 'topics' ? firstPage.from : -1, 18);
    assert.equal(store.get(job.id).directoryPasses, 2);
  } finally { store.close(); }
});

/* 验证目录或楼层不前进时保留问题，避免错误地产生无匹配结论。 */
test('目录重复页和楼层重复页不会被记成扫描成功', async () => {
  const fixture = new Fixture();
  fixture.failure = r => {
    if (r.kind === 'topics' && r.from > 0)
      return { status: 200, data: [...fixture.topics.values()].slice(0, r.size) };
    if (r.kind === 'posts' && r.id === 4 && r.from === 10)
      return { status: 200, data: [1, 2].map(floor => ({ id: 4000 + floor, floor, content: '普通回复' })) };
    return undefined;
  };
  const { store, job } = await scan(fixture);
  try {
    assert.equal(job.status, 'partial');
    assert.ok(job.issues.some(i => i.message.includes('重复')));
    assert.ok(store.failures(job).some(f => f.topicId === 4));
  } finally { store.close(); }
});

/* 验证删除或隐藏楼层造成短页时，按实际返回数继续并允许楼层号有缺口。 */
test('回复数高于可读楼层数时继续读取到空页', async () => {
  const fixture = new Fixture();
  fixture.topics.get(4)!.replyCount = 8;
  fixture.failure = r => {
    if (r.kind !== 'posts' || r.id !== 4) return;
    if (r.from === 0) {
      const floors = [1, 2, 3, 5, 6, 7, 8];
      return { status: 200, data: floors.map(floor => ({
        id: 4000 + floor, topicId: 4, floor, content: '普通回复', contentType: 0,
      })) };
    }
    if (r.from === 8) return { status: 200, data: [] };
  };
  const { store, job } = await scan(fixture);
  try {
    assert.equal(job.status, 'finished_unverified');
    assert.equal(store.failures(job).some(f => f.topicId === 4), false);
    assert.deepEqual(fixture.calls.filter(r => r.kind === 'posts' && r.id === 4)
      .map(r => r.kind === 'posts' ? r.from : -1), [0, 8]);
  } finally { store.close(); }
});

/* 验证服务端返回条数超过请求 size 时仍处理有效楼层，不把客户端批量大小当成协议上限。 */
test('楼层页超过 10 条时继续处理', async () => {
  const fixture = new Fixture();
  fixture.topics.get(4)!.replyCount = 11;
  fixture.failure = r => {
    if (r.kind !== 'posts' || r.id !== 4 || r.from !== 0) return;
    return { status: 200, data: Array.from({ length: 11 }, (_, index) => {
      const floor = index + 1;
      return { id: 4000 + floor, topicId: 4, floor, content: '普通回复', contentType: 0 };
    }) };
  };
  const { store, job } = await scan(fixture);
  try {
    assert.equal(store.failures(job).some(f => f.topicId === 4), false);
    assert.deepEqual(fixture.calls.filter(r => r.kind === 'posts' && r.id === 4)
      .map(r => r.kind === 'posts' ? r.from : -1), [0, 11]);
  } finally { store.close(); }
});

/* 验证共享请求池达到但不超过并发上限，并遵守 429 冷却。 */
test('共用请求池实际达到 20 并发且不超过上限，429 退避后重试', async () => {
  const fixture = new Fixture();
  fixture.delay = 50;
  const pool = new RequestPool(fixture, 20, 100000, new AbortController().signal);
  await Promise.all(Array.from({ length: 60 }, () => pool.read({ kind: 'boards' })));
  assert.equal(fixture.peak, 20);
  let attempts = 0;
  fixture.failure = () => ++attempts === 1 ? { status: 429, retryAfterMs: 1 } : undefined;
  const start = Date.now();
  await pool.read({ kind: 'boards' });
  assert.equal(attempts, 2);
  assert.ok(Date.now() - start >= 1000);
});

/* 验证可见文字提取、格式处理、大小写选项和媒体过滤。 */
test('匹配保留引用、代码符号，忽略链接地址和媒体内容', () => {
  assert.ok(matchText('[quote]NEEDLE[/quote]', 'needle'));
  assert.ok(matchText('foo_bar <T>', 'foo_bar <T>'));
  assert.ok(matchText('**foo**bar', 'foobar', false, 'markdown'));
  assert.ok(matchText('`foo_bar`', 'foo_bar', false, 'markdown'));
  assert.ok(matchText('[职位](https://example.com/needle)', '职位', false, 'markdown'));
  assert.equal(matchText('[职位](https://example.com/needle)', 'needle', false, 'markdown'), undefined);
  assert.equal(matchText('[img]needle[/img]', 'needle'), undefined);
  assert.equal(matchText('NEEDLE', 'needle', true), undefined);
  assert.equal(visibleText('A &amp; B'), 'A & B');
  assert.equal(matchText('<script>needle</script>', 'needle', false, 'markdown'), undefined);
  assert.ok(matchText('标题 foo_bar', 'foo_bar', false, 'plain'));
});
