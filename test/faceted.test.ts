import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Scanner } from '../src/scanner.js';
import { Store } from '../src/store.js';
import { startServer } from '../src/server.js';
import { parseOptions, type SearchQuery } from '../src/types.js';
import { Fixture } from './fixture.js';
import { wait } from '../src/pool.js';

const exec = promisify(execFile);

/* 创建按整帖取交集或并集的测试表达式。 */
function query(operator: 'and' | 'or', ...keywords: string[]): SearchQuery {
  return { operator: 'and', groups: [{ facet: 'other', operator, terms: keywords.map(keyword => ({ keyword })) }] };
}

/* 只保留测试所需主题；来源页让测试覆盖真实批量核对路径。 */
function forum(count = 1): Fixture {
  const fixture = new Fixture();
  fixture.topics.clear(); fixture.content.clear(); fixture.pinned = [];
  for (let id = 1; id <= count; id++) fixture.topics.set(id, {
    id, boardId: 235, title: `普通主题 ${id}`, replyCount: 2, lastPostTime: '2026-10-01T00:00:00Z',
    directoryPage: { boardId: 235, from: 0, size: Math.min(20, count) },
  });
  return fixture;
}

/* 以恢复指定主题的公共入口扫描固定数据，排除目录发现耗时干扰。 */
function prepare(t: TestContext, fixture: Fixture, condition: { query: SearchQuery } | { keyword: string }, concurrency = 4) {
  const store = new Store();
  const job = store.create(parseOptions({ ...condition, boardIds: [235], concurrency, requestsPerSecond: 50 }),
    fixture.session()!, [fixture.boardList[0]!]);
  for (const topic of fixture.topics.values()) store.add(job, topic);
  job.status = 'paused'; job.desiredRunning = false; store.save(job);
  const scanner = new Scanner(store, fixture);
  t.after(async () => { await scanner.shutdown(); store.close(); });
  return { store, scanner, job, run: async () => {
    const before = performance.now();
    scanner.resume(job.id, [...fixture.topics.keys()]);
    await scanner.settled();
    const final = store.get(job.id);
    return { job: final, hits: store.results(final), counts: store.counts(final), elapsed: performance.now() - before };
  } };
}

/* 标题只满足部分条件时继续扫描；第 100 楼可以补齐最后一个条件。 */
test('交集累计标题和后排回复的别名证据，正文每页只请求一次', async t => {
  const fixture = forum();
  Object.assign(fixture.topics.get(1)!, { title: 'ByteDance 招聘', replyCount: 100 });
  fixture.content.set('1:2', '工作地点 Hangzhou');
  fixture.content.set('1:100', '[b]Linux C++[/b]');
  const q: SearchQuery = { operator: 'and', groups: [
    { facet: 'company', operator: 'or', terms: [{ keyword: '字节跳动', aliases: ['ByteDance'] }] },
    { facet: 'location', operator: 'or', terms: [{ keyword: '杭州', aliases: ['Hangzhou'] }] },
    { facet: 'skill', operator: 'and', terms: [{ keyword: 'Linux' }, { keyword: 'C++' }] },
  ] };
  const { hits, counts } = await prepare(t, fixture, { query: q }).run();
  assert.equal(counts.matched, 1);
  assert.deepEqual(hits[0]!.evidence!.map(e => [e.keyword, e.matchedKeyword, e.floor]),
    [['字节跳动', 'ByteDance', undefined], ['杭州', 'Hangzhou', 2], ['Linux', 'Linux', 100], ['C++', 'C++', 100]]);
  assert.equal(hits[0]!.evidence![3]!.url, 'https://www.cc98.org/topic/1/10#0');
  assert.equal(fixture.calls.filter(r => r.kind === 'posts').length, 10);
  assert.equal(fixture.calls.filter(r => r.kind === 'topic').length, 2);
});

/* 完整标题或首楼 OR 可提前结束，不能伪造未读楼层中的其他词证据。 */
test('标题交集和正文并集短路，只保存已读证据', async t => {
  const titleForum = forum();
  titleForum.topics.get(1)!.title = 'Linux C++';
  const title = await prepare(t, titleForum, { query: query('and', 'Linux', 'C++') }).run();
  assert.equal(title.hits[0]!.evidence!.length, 2);
  assert.deepEqual(titleForum.calls.map(r => r.kind), ['topic']);
  const fixture = forum();
  fixture.topics.get(1)!.replyCount = 100;
  fixture.content.set('1:1', 'Linux');
  fixture.content.set('1:100', 'C++');
  const result = await prepare(t, fixture, { query: query('or', 'Linux', 'C++') }).run();
  assert.deepEqual(result.hits[0]!.evidence!.map(e => e.keyword), ['Linux']);
  assert.equal(fixture.calls.filter(r => r.kind === 'posts').length, 1);
});

/* 单词集合运算独立于多条件实现，既验证结果，也防止主题之间串用状态。 */
test('稳定论坛上的 AND/OR 等于各单词结果集合的交并', async t => {
  const create = () => {
    const f = forum(6);
    for (const id of [1, 2, 5]) f.content.set(`${id}:1`, 'alpha');
    for (const id of [2, 3, 5]) f.content.set(`${id}:2`, 'beta');
    for (const id of [4, 5]) f.content.set(`${id}:3`, 'gamma');
    return f;
  };
  const sets: Set<number>[] = [];
  for (const keyword of ['alpha', 'beta', 'gamma']) {
    const result = await prepare(t, create(), { keyword }).run();
    assert.ok(result.hits.every(hit => !Object.hasOwn(hit, 'evidence')));
    sets.push(new Set(result.hits.map(hit => hit.topicId)));
  }
  for (const operator of ['and', 'or'] as const) {
    const result = await prepare(t, create(), { query: query(operator, 'alpha', 'beta', 'gamma') }).run();
    const expected = [...create().topics.keys()].filter(id => operator === 'and' ? sets.every(s => s.has(id)) : sets.some(s => s.has(id)));
    assert.deepEqual(result.hits.map(hit => hit.topicId), expected);
    assert.equal(result.counts.error, 0);
  }
});

/* 基线变化后整份证据作废，旧标题不能与新正文拼成交集。 */
test('短帖变化回退清空所有词证据，长帖变化保留错误', async t => {
  for (const long of [false, true]) {
    const fixture = forum();
    Object.assign(fixture.topics.get(1)!, { title: 'alpha', replyCount: long ? 10 : 2 });
    fixture.content.set('1:1', 'beta');
    let changed = false, detailReads = 0;
    fixture.failure = r => {
      if (r.kind === 'topic' && ++detailReads === (long ? 2 : 1)) {
        changed = true;
        Object.assign(fixture.topics.get(1)!, { title: '普通主题', lastPostTime: '2026-10-01T01:00:00Z' });
      }
      return undefined;
    };
    const result = await prepare(t, fixture, { query: query('and', 'alpha', 'beta') }).run();
    assert.ok(changed);
    assert.equal(result.hits.length, 0);
    assert.equal(result.counts[long ? 'error' : 'no_match'], 1);
  }
});

/* 多词结果也必须等待核对；取消后迟到的核对不允许落成命中。 */
test('暂停或取消丢弃待确认的交集，恢复保留词和别名快照', async t => {
  for (const paused of [true, false]) {
    const fixture = forum();
    fixture.content.set('1:1', 'alpha'); fixture.content.set('1:2', 'beta');
    const q = query('and', '公司A', 'beta');
    q.groups[0]!.terms[0]!.aliases = ['alpha'];
    const prepared = prepare(t, fixture, { query: q });
    let stopped: Promise<unknown> | undefined;
    fixture.failure = r => {
      if (r.kind === 'topic') stopped = prepared.scanner.cancel(prepared.job.id, paused);
      return undefined;
    };
    const result = await prepared.run(); await stopped;
    assert.ok(stopped); assert.equal(result.hits.length, 0);
    assert.equal(result.counts.pending, 1);
    assert.equal(result.job.status, paused ? 'paused' : 'cancelled');
    fixture.failure = undefined;
    q.groups[0]!.terms[0]!.aliases = ['不会匹配'];
    const resumed = await prepared.run();
    assert.equal(resumed.hits[0]!.evidence![0]!.matchedKeyword, 'alpha');
    assert.deepEqual(resumed.job.options.query!.groups[0]!.terms[0]!.aliases, ['alpha']);
  }
});

/* 已累计一个词后断线，原账号重连可以继续；失败正文不能算作无匹配。 */
test('多词扫描支持同账号自动恢复，权限错误保持可见', async t => {
  const fixture = forum();
  Object.assign(fixture.topics.get(1)!, { title: 'alpha', replyCount: 10 });
  fixture.content.set('1:11', 'beta');
  let interrupted = false;
  fixture.failure = r => {
    if (r.kind === 'posts' && r.from === 10 && !interrupted) {
      interrupted = true; fixture.setSession(null); return { status: 401 };
    }
    return undefined;
  };
  const prepared = prepare(t, fixture, { query: query('and', 'alpha', 'beta') });
  const running = prepared.run();
  for (let i = 0; i < 400 && prepared.store.get(prepared.job.id).status !== 'waiting_login'; i++) await wait(5);
  assert.equal(prepared.store.get(prepared.job.id).status, 'waiting_login');
  fixture.setSession({ accountId: '42', forumBase: 'https://www.cc98.org/' });
  assert.equal((await running).hits[0]!.evidence!.length, 2);
  const denied = forum();
  denied.failure = r => r.kind === 'posts' ? { status: 403 } : undefined;
  const failed = await prepare(t, denied, { query: query('and', 'alpha', 'beta') }).run();
  assert.equal(failed.counts.error, 1); assert.equal(failed.counts.no_match, 0);
});

/* 带网络延迟比较实际耗时，防止仅减少请求数却破坏正文或回退并发。 */
test('150ms 延迟下三词交集共享 20 次正文和一次核对，快于逐词扫描', async t => {
  const create = () => {
    const f = forum(20); f.delay = 150;
    for (let id = 1; id <= 20; id++) {
      f.content.set(`${id}:1`, 'alpha'); f.content.set(`${id}:2`, 'beta'); f.content.set(`${id}:3`, 'gamma');
    }
    return f;
  };
  let separateTime = 0, separateCalls = 0;
  for (const keyword of ['alpha', 'beta', 'gamma']) {
    const f = create(), result = await prepare(t, f, { keyword }).run();
    separateTime += result.elapsed; separateCalls += f.calls.length;
    assert.equal(result.counts.matched, 20);
  }
  const f = create(), combined = await prepare(t, f, { query: query('and', 'alpha', 'beta', 'gamma') }).run();
  assert.equal(combined.counts.matched, 20);
  assert.equal(f.calls.filter(r => r.kind === 'posts').length, 20);
  assert.equal(f.calls.filter(r => r.kind === 'topics').length, 1);
  assert.equal(f.calls.length, 21);
  assert.equal(separateCalls, 63);
  assert.ok(combined.elapsed < separateTime * 0.8, `${combined.elapsed} vs ${separateTime}`);
  t.diagnostic(`150ms/请求，并发4：合并 ${combined.elapsed.toFixed(0)}ms/21请求；逐词 ${separateTime.toFixed(0)}ms/63请求`);
});

/* 离线建议、HTTP 校验、CLI 文件输入、导出和持久化覆盖同一查询协议。 */
test('建议无需论坛连接，CLI 查询文件与 HTTP 导出保留条件和证据', async t => {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(resolve('test-artifacts', 'facets-'));
  const fixture = forum(); fixture.identity = null;
  const app = await startServer({ port: 0, dataDir: dir, transport: fixture });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
  const suggested = await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'suggest', 'ByteDance 杭州 Linux C++', '--data-dir', dir]);
  const q = JSON.parse(suggested.stdout) as SearchQuery;
  assert.equal(q.groups.length, 3);
  const apiSuggestion = await fetch(app.origin + '/api/query/suggest', { method: 'POST', headers, body: JSON.stringify({ text: 'ByteDance 杭州 Linux C++' }) });
  assert.deepEqual((await apiSuggestion.json()).query, q);
  assert.equal(fixture.calls.length, 0);
  assert.equal((await fetch(app.origin + '/api/query/suggest', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(app.origin + '/api/jobs', { method: 'POST', headers,
    body: JSON.stringify({ keyword: 'x', query: q, boardIds: [235] }) })).status, 400);
  assert.equal((await fetch(app.origin + '/query-editor.js')).status, 200);
  fixture.setSession({ accountId: '42', forumBase: 'https://www.cc98.org/' });
  fixture.content.set('1:1', 'ByteDance'); fixture.content.set('1:2', 'Hangzhou Linux');
  fixture.failure = r => r.kind === 'board'
    ? { status: 200, data: { id: r.id, name: '测试版面', topicCount: r.id === 235 ? 1 : 0 } } : undefined;
  const file = resolve(dir, 'query.json');
  await writeFile(file, JSON.stringify(q));
  const created = JSON.parse((await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'search', '--query-file', file,
    '--boards', '235', '--rate', '50', '--data-dir', dir])).stdout);
  await app.scanner.settled();
  const exported = await (await fetch(`${app.origin}/api/jobs/${created.id}/export`, { headers })).json();
  assert.equal(exported.total, 1);
  assert.deepEqual(exported.job.options.query, q);
  assert.deepEqual(exported.results[0].evidence.map((e: { matchedKeyword: string }) => e.matchedKeyword), ['ByteDance', 'Hangzhou', 'Linux']);
  await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'search', 'extra', '--query-file', file, '--data-dir', dir]));
  /* 用同一数据库重新打开，只读已结束的任务，检查实际 JSON 持久化形状。 */
  const persisted = new Store(resolve(dir, 'tasks.sqlite'));
  try {
    assert.deepEqual(persisted.get(created.id).options.query, q);
    assert.deepEqual(persisted.results(persisted.get(created.id)), exported.results);
  } finally { persisted.close(); }
});
