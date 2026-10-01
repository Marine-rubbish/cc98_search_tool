import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Scanner } from '../src/scanner.js';
import { Store } from '../src/store.js';
import { wait } from '../src/pool.js';
import { parseOptions, ScanError, type Reply, type Resource, type Topic } from '../src/types.js';
import { Fixture } from './fixture.js';

/* 保留真实扫描器、请求池和 SQLite，只替换论坛读响应并记录请求时序。 */
class BatchFixture extends Fixture {
  events: { phase: 'start' | 'end'; resource: Resource }[] = [];
  before?: (resource: Resource, signal?: AbortSignal) => Promise<void>;
  respond?: (resource: Resource) => Reply | Error | undefined;
  constructor(count = 20, secondBoard = 0) {
    super();
    this.topics.clear();
    this.content.clear();
    this.pinned = [];
    for (let id = 1; id <= count + secondBoard; id++) {
      this.topics.set(id, {
        id, boardId: id <= count ? 235 : 459, title: `普通主题 ${id}`,
        replyCount: id % 2 ? 0 : 9, lastPostTime: '2026-10-01T00:00:00Z',
      });
    }
    this.failure = r => {
      const response = this.respond?.(r);
      if (response) return response;
      if (r.kind === 'board') return { status: 200, data: {
        ...this.boardList.find(board => board.id === r.id), topicCount: this.page(r.id).length,
      } };
      if (r.kind === 'topics') return { status: 200, data: structuredClone(this.page(r.id).slice(r.from, r.from + r.size)) };
    };
  }
  page(boardId: number) { return [...this.topics.values()].filter(topic => topic.boardId === boardId); }
  override async read(resource: Resource, signal?: AbortSignal) {
    this.events.push({ phase: 'start', resource });
    await this.before?.(resource, signal);
    const reply = await super.read(resource, signal);
    this.events.push({ phase: 'end', resource });
    return reply;
  }
}

const options = (concurrency = 20) =>
  parseOptions({ keyword: 'needle', boardIds: [235, 459], concurrency, requestsPerSecond: 50 });

function setup(t: TestContext, fixture: BatchFixture) {
  const store = new Store();
  const scanner = new Scanner(store, fixture);
  t.after(async () => { await scanner.shutdown(); store.close(); });
  return { store, scanner };
}

/* 创建已有来源页的持久化候选，便于单独控制正文与批量核对的先后。 */
function seed(store: Store, fixture: BatchFixture, concurrency = 20, patch?: (topic: Topic) => Topic) {
  const job = store.create(options(concurrency), fixture.session()!, fixture.boardList.slice(0, 2));
  for (const topic of fixture.topics.values()) {
    const page = fixture.page(topic.boardId!);
    const index = page.findIndex(item => item.id === topic.id);
    const from = index < 20 ? 0 : Math.ceil((index - 19) / 18) * 18;
    const candidate = { ...topic, directoryPage: { boardId: topic.boardId!, from, size: Math.min(20, page.length - from) } };
    store.add(job, patch ? patch(candidate) : candidate);
  }
  job.directoryCursor = { pass: 2, boardIndex: 0, from: 0 };
  job.directoryPasses = 2;
  job.status = 'paused';
  job.desiredRunning = false;
  store.save(job);
  return job;
}

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!check() && Date.now() < deadline) await wait(5);
  assert.ok(check(), '扫描应在超时前达到预期状态');
}

test('同页 20 个稳定短帖使用 20 次正文加 1 次新目录核对，串行与并发结果相同', async t => {
  for (const concurrency of [1, 20]) {
    await t.test(`并发 ${concurrency}`, async t => {
      const fixture = new BatchFixture();
      fixture.content.set('1:1', 'needle 主楼');
      fixture.content.set('20:10', 'needle 末楼');
      const { store, scanner } = setup(t, fixture);
      const job = await scanner.start(options(concurrency));
      await scanner.settled();
      const final = store.get(job.id);
      assert.equal(final.status, 'finished_unverified');
      assert.equal(final.directoryPasses, 2);
      assert.equal(fixture.calls.filter(r => r.kind === 'posts').length, 20);
      assert.equal(fixture.calls.filter(r => r.kind === 'topic').length, 0);
      assert.equal(fixture.calls.filter(r => r.kind === 'topics').length, 3);
      assert.deepEqual(store.results(final).map(m => [m.topicId, m.floor]), [[1, 1], [20, 10]]);
      assert.equal(store.counts(final).no_match, 18);
      const validation = fixture.events.findLastIndex(e => e.phase === 'start' && e.resource.kind === 'topics');
      const lastBody = fixture.events.findLastIndex(e => e.phase === 'end' && e.resource.kind === 'posts');
      assert.ok(validation > lastBody, '核对请求须晚于该批所有正文响应');
      assert.ok(fixture.peak <= concurrency);
    });
  }
});

test('跨页跨版面和超过缓冲上限时收敛，结果与逐帖路径相同', async t => {
  let baseline: unknown;
  for (const concurrency of [1, 20]) {
    for (const batch of [false, true]) {
      await t.test(`并发 ${concurrency}，批量 ${batch}`, async t => {
        const fixture = new BatchFixture(65, 21);
        fixture.content.set('2:10', 'needle 第十楼');
        fixture.content.set('70:10', 'needle 第二版面');
        const { store, scanner } = setup(t, fixture);
        if (!batch) fixture.respond = r => r.kind === 'topics'
          ? { status: 200, data: fixture.page(r.id).slice(r.from, r.from + r.size).map(topic => ({ ...topic, lastPostTime: undefined })) }
          : undefined;
        let peakWorking = 0;
        fixture.before = async () => {
          const job = store.list()[0];
          if (job) peakWorking = Math.max(peakWorking, store.counts(job).working);
        };
        const started = await scanner.start(options(concurrency));
        await scanner.settled();
        const job = store.get(started.id);
        assert.equal(job.status, 'finished_unverified');
        assert.equal(job.directoryPasses, 2);
        assert.equal(store.counts(job).total, 86);
        assert.equal(store.counts(job).working, 0);
        assert.equal(store.counts(job).pending, 0);
        const result = { counts: store.counts(job), matches: store.results(job) };
        if (!baseline) baseline = result;
        else assert.deepEqual(result, baseline);
        assert.ok(peakWorking <= 40 + concurrency, `待确认主题峰值 ${peakWorking}`);
        if (batch) {
          assert.equal(fixture.calls.filter(r => r.kind === 'posts').length, 86);
          assert.ok(fixture.calls.filter(r => r.kind === 'topic').length < 10);
        }
      });
    }
  }
});

test('空页、缺项、字段不足、重复 ID 和目录失败均回退详情，详情失败仍列为问题', async t => {
  const cases: Record<string, (page: Topic[]) => Reply> = {
    '空页': () => ({ status: 200, data: [] }),
    '缺项': page => ({ status: 200, data: page.slice(1) }),
    '版面缺失': page => ({ status: 200, data: page.map(topic => ({ ...topic, boardId: undefined })) }),
    '时间缺失': page => ({ status: 200, data: page.map(topic => ({ ...topic, lastPostTime: undefined })) }),
    '重复 ID': page => ({ status: 200, data: [page[0], page[0]] }),
    '过长页': page => ({ status: 200, data: [...page, { ...page[0], id: 999 }] }),
    '格式错误': () => ({ status: 200, data: '<html>error</html>' }),
    '目录无权限': () => ({ status: 403 }),
  };
  for (const [name, reply] of Object.entries(cases)) {
    await t.test(name, async t => {
      const fixture = new BatchFixture(2);
      const { store, scanner } = setup(t, fixture);
      const job = seed(store, fixture);
      fixture.respond = r => r.kind === 'topics' ? reply(fixture.page(r.id)) : undefined;
      scanner.resume(job.id);
      await scanner.settled();
      const final = store.get(job.id);
      assert.equal(final.status, 'finished_unverified');
      assert.equal(store.counts(final).no_match, 2);
      assert.equal(fixture.calls.filter(r => r.kind === 'topics').length, 1);
      assert.equal(fixture.calls.filter(r => r.kind === 'topic').length, name === '缺项' ? 1 : 2);
    });
  }
  const fixture = new BatchFixture(2);
  const { store, scanner } = setup(t, fixture);
  const job = seed(store, fixture);
  fixture.respond = r => r.kind === 'topics' ? { status: 200, data: [] }
    : r.kind === 'topic' && r.id === 1 ? { status: 404 } : undefined;
  scanner.resume(job.id);
  await scanner.settled();
  const final = store.get(job.id);
  assert.equal(final.status, 'partial');
  assert.equal(store.counts(final).error, 1);
  assert.equal(store.counts(final).no_match, 1);
});

test('批量核对发现新增回复、新标题、移帖和旧命中失效后重扫', async t => {
  const fixture = new BatchFixture(6);
  for (const id of [3, 4, 5]) fixture.content.set(`${id}:1`, 'needle 旧内容');
  const { store, scanner } = setup(t, fixture);
  const job = seed(store, fixture);
  fixture.respond = r => {
    if (r.kind !== 'topics') return;
    Object.assign(fixture.topics.get(1)!, { replyCount: 19, lastPostTime: '2026-10-01T01:00:00Z' });
    fixture.content.set('1:11', 'needle 新增第十一楼');
    fixture.topics.get(2)!.title = 'needle 新标题';
    fixture.topics.get(3)!.boardId = 459;
    fixture.topics.get(4)!.boardId = 68;
    fixture.topics.get(5)!.lastPostTime = '2026-10-01T01:00:00Z';
    fixture.content.delete('5:1');
    return undefined;
  };
  scanner.resume(job.id);
  await scanner.settled();
  const final = store.get(job.id);
  assert.equal(final.status, 'finished_unverified');
  assert.deepEqual(store.results(final).map(m => [m.topicId, m.boardId, m.kind, m.floor]),
    [[1, 235, 'post', 11], [2, 235, 'title', undefined], [3, 459, 'post', 1]]);
  assert.equal(store.counts(final).out_of_scope, 1);
  assert.equal(store.counts(final).no_match, 2);
  assert.equal(fixture.calls.filter(r => r.kind === 'topic' && r.id === 6).length, 0);
});

test('核对中途完成的正文不能复用已发起的目录响应', { timeout: 15000 }, async t => {
  const fixture = new BatchFixture(56);
  const { store, scanner } = setup(t, fixture);
  const job = seed(store, fixture);
  let releaseBody = () => {};
  const heldBody = new Promise<void>(resolve => { releaseBody = resolve; });
  let pageStarted = false;
  let pageReadCount = 0;
  fixture.before = async (r, signal) => {
    if (r.kind === 'posts' && r.id === 40) await heldBody;
    if (r.kind === 'topics' && r.from === 36 && ++pageReadCount === 1) {
      pageStarted = true;
      releaseBody();
      await waitUntil(() => fixture.events.some(e => e.phase === 'end' && e.resource.kind === 'posts' && e.resource.id === 40));
      await wait(30, signal);
    }
  };
  fixture.respond = r => {
    if (r.kind !== 'topics' || r.from !== 36 || pageReadCount !== 1) return;
    /* 返回较早快照后产生新回复，晚加入的主题必须使用另一次核对。 */
    const snapshot = structuredClone(fixture.page(r.id).slice(r.from, r.from + r.size));
    fixture.topics.get(40)!.replyCount = 19;
    fixture.topics.get(40)!.lastPostTime = '2026-10-01T01:00:00Z';
    fixture.content.set('40:11', 'needle 晚到的新回复');
    return { status: 200, data: snapshot };
  };
  t.after(releaseBody);
  scanner.resume(job.id);
  await scanner.settled();
  assert.ok(pageStarted);
  assert.equal(store.get(job.id).status, 'finished_unverified');
  assert.equal(store.results(store.get(job.id)).find(m => m.topicId === 40)?.floor, 11);
  assert.ok(fixture.calls.filter(r => r.kind === 'topics' && r.from === 36).length >= 2 ||
    fixture.calls.some(r => r.kind === 'topic' && r.id === 40));
});

test('核对期间暂停和取消均丢弃暂存命中，恢复后重新读取', async t => {
  for (const paused of [true, false]) {
    await t.test(paused ? '暂停' : '取消', async t => {
      const fixture = new BatchFixture();
      fixture.content.set('1:1', 'needle 命中');
      const { store, scanner } = setup(t, fixture);
      const job = seed(store, fixture);
      let stopped: ReturnType<Scanner['cancel']> | undefined;
      fixture.respond = r => {
        if (r.kind !== 'topics') return;
        assert.equal(store.counts(store.get(job.id)).working, 20);
        assert.equal(store.results(store.get(job.id)).length, 0);
        stopped = scanner.cancel(job.id, paused);
        return undefined;
      };
      scanner.resume(job.id);
      await scanner.settled();
      await stopped;
      const final = store.get(job.id);
      assert.ok(stopped);
      assert.equal(final.status, paused ? 'paused' : 'cancelled');
      assert.equal(store.counts(final).pending, 20);
      assert.equal(store.counts(final).working, 0);
      assert.equal(store.results(final).length, 0);
      fixture.respond = undefined;
      scanner.resume(job.id);
      await scanner.settled();
      assert.equal(store.get(job.id).status, 'finished_unverified');
      assert.equal(store.results(store.get(job.id)).length, 1);
      assert.equal(fixture.calls.filter(r => r.kind === 'posts').length, 40);
    });
  }
});

test('批量核对断线后同账号续跑，切换账号保持暂停', async t => {
  for (const accountId of ['42', '43']) {
    await t.test(`恢复账号 ${accountId}`, async t => {
      const fixture = new BatchFixture(2);
      const { store, scanner } = setup(t, fixture);
      const job = seed(store, fixture);
      let failed = false;
      fixture.respond = r => {
        if (r.kind !== 'topics' || failed) return;
        failed = true;
        fixture.setSession(null);
        return new ScanError('DISCONNECTED', '连接中断', true);
      };
      scanner.resume(job.id);
      await waitUntil(() => store.get(job.id).status === 'waiting_connection');
      assert.equal(store.counts(store.get(job.id)).working, 2);
      fixture.setSession({ accountId, forumBase: 'https://www.cc98.org/' });
      await scanner.settled();
      const final = store.get(job.id);
      assert.equal(final.run, 2);
      assert.equal(final.status, accountId === '42' ? 'finished_unverified' : 'paused');
      assert.equal(store.counts(final).error, 0);
      assert.equal(store.counts(final).pending, accountId === '42' ? 0 : 2);
    });
  }
});

test('旧记录和无效来源沿用逐帖核对，接口伪造的来源不用于置顶批量核对', async t => {
  for (const marker of [undefined, { boardId: 459, from: 0, size: 2 },
    { boardId: 235, from: -1, size: 2 }, { boardId: 235, from: 0, size: 21 }]) {
    await t.test(JSON.stringify(marker) ?? '旧记录', async t => {
      const fixture = new BatchFixture(2);
      const { store, scanner } = setup(t, fixture);
      const job = seed(store, fixture, 20, topic => ({ ...topic, directoryPage: marker }));
      scanner.resume(job.id);
      await scanner.settled();
      assert.equal(store.get(job.id).status, 'finished_unverified');
      assert.equal(fixture.calls.filter(r => r.kind === 'topic').length, 2);
      assert.equal(fixture.calls.filter(r => r.kind === 'topics').length, 0);
    });
  }
  const fixture = new BatchFixture(2);
  fixture.pinned = [1, 2];
  for (const topic of fixture.topics.values()) topic.directoryPage = { boardId: 235, from: 0, size: 2 };
  const { store, scanner } = setup(t, fixture);
  const job = await scanner.start(options());
  await scanner.settled();
  assert.equal(store.get(job.id).status, 'finished_unverified');
  assert.equal(fixture.calls.filter(r => r.kind === 'topic').length, 2);
  assert.equal(fixture.calls.filter(r => r.kind === 'topics').length, 2);
});

test('进程重启后重读遗留 working，保留已确认主题', async t => {
  await mkdir('test-artifacts', { recursive: true });
  const directory = await mkdtemp(resolve('test-artifacts', 'batch-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, 'tasks.sqlite');
  let store = new Store(path);
  const fixture = new BatchFixture(3);
  fixture.content.set('1:1', 'needle 重启后读取');
  const job = seed(store, fixture);
  const finished = store.claim(job)!;
  store.finishTopic(job, finished, 'no_match');
  assert.equal(store.claim(job)?.id, 2);
  assert.equal(store.claim(job)?.id, 3);
  job.status = 'running';
  job.desiredRunning = true;
  store.save(job);
  store.close();
  store = new Store(path);
  const scanner = new Scanner(store, fixture);
  t.after(async () => { await scanner.shutdown(); store.close(); });
  await waitUntil(() => store.get(job.id).status !== 'paused');
  await scanner.settled();
  const final = store.get(job.id);
  assert.equal(final.run, 1);
  assert.equal(final.status, 'finished_unverified');
  assert.equal(store.counts(final).no_match, 3);
  assert.equal(store.results(final).length, 0);
  assert.deepEqual(fixture.calls.flatMap(r => r.kind === 'posts' ? [r.id] : []).sort(), [2, 3]);
  assert.equal(fixture.calls.filter(r => r.kind === 'topics').length, 1);
});

test('短页探测得到的缓冲目录保留来源，仍可批量核对', async t => {
  const fixture = new BatchFixture(4);
  const { store, scanner } = setup(t, fixture);
  fixture.respond = r => {
    if (r.kind === 'board' && r.id === 235)
      return { status: 200, data: { id: 235, name: '测试版面', topicCount: 6 } };
    if (r.kind === 'topics' && r.id === 235)
      return { status: 200, data: structuredClone(fixture.page(235).slice(r.from, r.from + 2)) };
  };
  const job = await scanner.start(options());
  await scanner.settled();
  const final = store.get(job.id);
  assert.equal(final.directoryPasses, 2);
  assert.equal(store.counts(final).no_match, 4);
  assert.equal(fixture.calls.filter(r => r.kind === 'topic').length, 0);
  assert.equal(fixture.calls.filter(r => r.kind === 'topics' && r.from === 2 && r.size === 4).length, 3);
  assert.equal(final.issues.length, 2);
});

test('批量回退重扫期间暂停，不保存迟到的正文命中', async t => {
  const fixture = new BatchFixture(2);
  const { store, scanner } = setup(t, fixture);
  const job = seed(store, fixture);
  let stopped: ReturnType<Scanner['cancel']> | undefined;
  let checking = false;
  fixture.respond = r => {
    if (r.kind === 'topics') {
      checking = true;
      fixture.topics.get(1)!.lastPostTime = '2026-10-01T01:00:00Z';
    }
    if (checking && r.kind === 'posts' && r.id === 1) {
      stopped = scanner.cancel(job.id, true);
      return { status: 200, data: [{ id: 1001, floor: 1, content: 'needle 迟到命中' }] };
    }
    return undefined;
  };
  scanner.resume(job.id);
  await scanner.settled();
  await stopped;
  assert.ok(stopped);
  const final = store.get(job.id);
  assert.equal(final.status, 'paused');
  assert.equal(store.results(final).length, 0);
  assert.equal(store.counts(final).pending, 1);
  assert.equal(store.counts(final).no_match, 1);
});

test('同页逐帖回退保持并发，不等待上一条详情结束', async t => {
  const fixture = new BatchFixture(20);
  const { store, scanner } = setup(t, fixture);
  const job = seed(store, fixture);
  const started = new Set<number>();
  let release = () => {};
  fixture.respond = r => r.kind === 'topics' ? { status: 200, data: [] } : undefined;
  fixture.before = async (r, signal) => {
    if (r.kind !== 'topic') return;
    started.add(r.id);
    if (r.id === 1) await new Promise<void>((resolve, reject) => {
      release = resolve;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  scanner.resume(job.id);
  try {
    await waitUntil(() => started.size === 20);
    await waitUntil(() => store.counts(store.get(job.id)).no_match === 19);
    assert.equal(store.counts(store.get(job.id)).working, 1);
  } finally { release(); }
  await scanner.settled();
  assert.equal(store.get(job.id).status, 'finished_unverified');
  assert.equal(store.counts(store.get(job.id)).no_match, 20);
  assert.ok(fixture.peak <= 20);
});

test('批次释放空位后继续读正文，暂停仍等待慢回退退出', async t => {
  const fixture = new BatchFixture(80);
  for (const topic of fixture.topics.values()) topic.replyCount = 0;
  const { store, scanner } = setup(t, fixture);
  const job = seed(store, fixture);
  let release = () => {};
  let releasePages = () => {};
  const pages = new Promise<void>(resolve => { releasePages = resolve; });
  let waiting = false;
  let stopped: Promise<unknown> | undefined;
  let stopFinished = false;
  fixture.respond = r => r.kind === 'topics' ? {
    status: 200, data: structuredClone(fixture.page(r.id).slice(r.from, r.from + r.size).filter(topic => topic.id !== 1)),
  } : undefined;
  fixture.before = async r => {
    if (r.kind === 'topics') await pages;
    if (r.kind !== 'topic' || r.id !== 1) return;
    waiting = true;
    /* 模拟传输已经开始、不能立即取消的响应，停止必须等待它退出。 */
    await new Promise<void>(resolve => {
      release = resolve;
    });
  };
  scanner.resume(job.id);
  try {
    /* 先让全部正文协程进入容量等待，再释放核对页，排除在读协程代为继续的情况。 */
    await waitUntil(() => fixture.events.filter(e => e.phase === 'end' && e.resource.kind === 'posts').length >= 59);
    await wait(30);
    releasePages();
    await waitUntil(() => waiting);
    await waitUntil(() => fixture.events.some(e => e.phase === 'start' && e.resource.kind === 'posts' && e.resource.id >= 61));
    assert.ok(store.counts(store.get(job.id)).working <= 60);
    stopped = scanner.cancel(job.id, true).then(() => { stopFinished = true; });
    await wait(30);
    assert.equal(stopFinished, false);
    assert.equal(scanner.busy(), true);
  } finally { releasePages(); release(); }
  await stopped;
  await scanner.settled();
  assert.equal(store.get(job.id).status, 'paused');
  assert.equal(store.counts(store.get(job.id)).working, 0);
  assert.ok(store.counts(store.get(job.id)).pending > 0);
});
