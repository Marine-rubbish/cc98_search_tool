import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Scanner } from '../src/scanner.js';
import { Store } from '../src/store.js';
import { parseOptions, type Reply, type Resource, type Topic } from '../src/types.js';
import { Fixture } from './fixture.js';

type ReadHook = (resource: Resource, fixture: Fixture) => Reply | undefined;

/* 通过完整扫描链路处理单个主题，调用记录只统计主题详情与楼层资源。 */
async function scanOne(t: TestContext, patch: Partial<Topic> = {}, hook?: ReadHook) {
  const fixture = new Fixture();
  fixture.topics.clear();
  fixture.topics.set(4, {
    id: 4, boardId: 235, title: '普通主题', replyCount: 0, lastPostTime: '2026-10-01T00:00:00Z', ...patch,
  });
  fixture.pinned = [];
  fixture.failure = resource => {
    const reply = hook?.(resource, fixture);
    if (reply) return reply;
    if (resource.kind === 'board')
      return { status: 200, data: { id: resource.id, name: '测试版面', canEntry: true, topicCount: resource.id === 235 ? 1 : 0 } };
    if (resource.kind === 'topics')
      return { status: 200, data: resource.id === 235 && resource.from === 0 ? [structuredClone(fixture.topics.get(4)!)] : [] };
  };
  const store = new Store();
  const scanner = new Scanner(store, fixture);
  t.after(async () => {
    await scanner.shutdown();
    store.close();
  });
  const started = await scanner.start(parseOptions({
    keyword: 'needle', boardIds: [235, 459], concurrency: 2, requestsPerSecond: 50,
  }));
  await scanner.settled();
  const job = store.get(started.id);
  return {
    store, job,
    calls: fixture.calls.filter(resource => (resource.kind === 'topic' || resource.kind === 'posts') && resource.id === 4),
  };
}

/* 对照缺失目录时间的原路径，验证优化只减少请求，不改变稳定短帖结论。 */
test('稳定短帖在 1 楼和 10 楼边界均从三次请求减到两次', async t => {
  for (const replyCount of [0, 9]) {
    await t.test(`${replyCount + 1} 楼`, async t => {
      const fast = await scanOne(t, { replyCount });
      const baseline = await scanOne(t, { replyCount }, (resource, fixture) =>
        resource.kind === 'topics' && resource.id === 235
          ? { status: 200, data: [{ ...fixture.topics.get(4)!, lastPostTime: undefined }] }
          : undefined);
      assert.deepEqual(fast.calls.map(call => call.kind), ['posts', 'topic']);
      assert.deepEqual(baseline.calls.map(call => call.kind), ['topic', 'posts', 'topic']);
      assert.equal(fast.job.status, 'finished_unverified');
      assert.equal(fast.store.counts(fast.job).no_match, 1);
      assert.deepEqual(fast.store.counts(fast.job), baseline.store.counts(baseline.job));
      assert.deepEqual(fast.store.results(fast.job), baseline.store.results(baseline.job));
    });
  }
});

/* 目录不能提供可靠基线时回退，长帖仍从最新详情确定页数。 */
test('目录字段缺失或无效时沿用原路径，长帖不启用优化', async t => {
  for (const patch of [{ boardId: undefined }, { lastPostTime: undefined }, { lastPostTime: '' }, { lastPostTime: 'invalid' }]) {
    await t.test(JSON.stringify(patch), async t => {
      const result = await scanOne(t, {}, (resource, fixture) =>
        resource.kind === 'topics' && resource.id === 235
          ? { status: 200, data: [{ ...fixture.topics.get(4)!, ...patch }] }
          : undefined);
      assert.deepEqual(result.calls.map(call => call.kind), ['topic', 'posts', 'topic']);
      assert.equal(result.store.counts(result.job).no_match, 1);
    });
  }
  const long = await scanOne(t, { replyCount: 10 });
  assert.deepEqual(long.calls.map(call => call.kind), ['topic', 'posts', 'posts', 'topic']);
  assert.equal(long.store.counts(long.job).no_match, 1);
});

/* 标题命中依然只查最新详情，正文命中必须经过末次详情验证。 */
test('短帖标题命中仍只读详情，正文命中经详情校验后保存', async t => {
  const title = await scanOne(t, { title: 'needle 招聘' });
  assert.deepEqual(title.calls.map(call => call.kind), ['topic']);
  assert.equal(title.store.results(title.job)[0]?.kind, 'title');
  const post = await scanOne(t, { replyCount: 9 }, (resource, fixture) => {
    if (resource.kind === 'posts') fixture.content.set('4:10', 'needle 职位');
    return undefined;
  });
  assert.deepEqual(post.calls.map(call => call.kind), ['posts', 'topic']);
  assert.equal(post.store.results(post.job)[0]?.floor, 10);
});

/* 目录仍显示短帖而正文已经增长时，最新详情触发重扫并找到后排楼层。 */
test('短帖新增回复后回退重扫，不遗漏第 11 楼的命中', async t => {
  let changed = false;
  const result = await scanOne(t, {}, (resource, fixture) => {
    if (resource.kind === 'posts' && !changed) {
      changed = true;
      Object.assign(fixture.topics.get(4)!, { replyCount: 19, lastPostTime: '2026-10-01T01:00:00Z' });
      fixture.content.set('4:11', 'needle 新回复');
    }
    return undefined;
  });
  assert.deepEqual(result.calls.map(call => call.kind), ['posts', 'topic', 'posts', 'posts']);
  assert.equal(result.store.results(result.job)[0]?.floor, 11);
  assert.equal(result.store.counts(result.job).error, 0);
});

/* 新标题可以直接命中；旧标题不能让已编辑主题跳过正文。 */
test('目录标题过期时按最新标题和正文判断', async t => {
  const renamed = await scanOne(t, {}, (resource, fixture) => {
    if (resource.kind === 'topic') fixture.topics.get(4)!.title = 'needle 新标题';
    return undefined;
  });
  assert.equal(renamed.store.results(renamed.job)[0]?.kind, 'title');
  assert.equal(renamed.store.results(renamed.job)[0]?.title, 'needle 新标题');
  const staleTitle = await scanOne(t, {}, (resource, fixture) =>
    resource.kind === 'topics' && resource.id === 235
      ? { status: 200, data: [{ ...fixture.topics.get(4)!, title: 'needle 旧标题' }] }
      : undefined);
  assert.equal(staleTitle.store.results(staleTitle.job).length, 0);
  assert.equal(staleTitle.store.counts(staleTitle.job).no_match, 1);
  assert.deepEqual(staleTitle.calls.map(call => call.kind), ['topic', 'posts', 'topic']);
});

/* 正文命中也须等到基线验证，不能保存已失效的暂存片段。 */
test('详情发现内容版本变化后丢弃旧命中并重读正文', async t => {
  let changed = false;
  const result = await scanOne(t, {}, (resource, fixture) => {
    if (resource.kind === 'posts' && !changed) fixture.content.set('4:1', 'needle 旧内容');
    if (resource.kind === 'topic' && !changed) {
      changed = true;
      fixture.content.delete('4:1');
      fixture.topics.get(4)!.lastPostTime = '2026-10-01T01:00:00Z';
    }
    return undefined;
  });
  assert.deepEqual(result.calls.map(call => call.kind), ['posts', 'topic', 'posts', 'topic']);
  assert.equal(result.store.results(result.job).length, 0);
  assert.equal(result.store.counts(result.job).no_match, 1);
});

/* 目录中的旧版面只能作为基线，输出必须遵守最新详情中的实际范围。 */
test('移帖后只保留当前范围内的结果', async t => {
  for (const boardId of [459, 68]) {
    await t.test(`移动至版面 ${boardId}`, async t => {
      const result = await scanOne(t, {}, (resource, fixture) => {
        if (resource.kind === 'posts') fixture.content.set('4:1', 'needle 命中');
        if (resource.kind === 'topic') fixture.topics.get(4)!.boardId = boardId;
        return undefined;
      });
      if (boardId === 459) {
        assert.equal(result.store.results(result.job)[0]?.boardId, 459);
        assert.deepEqual(result.calls.map(call => call.kind), ['posts', 'topic', 'posts']);
      } else {
        assert.equal(result.store.results(result.job).length, 0);
        assert.equal(result.store.counts(result.job).out_of_scope, 1);
      }
    });
  }
});

/* 回退后依然变化时沿用原错误处理，不能无界重扫或写入无匹配。 */
test('持续变化的短帖只回退一次，保留读取问题', async t => {
  let versions = 0;
  const result = await scanOne(t, {}, (resource, fixture) => {
    if (resource.kind === 'topic')
      fixture.topics.get(4)!.lastPostTime = `2026-10-01T0${++versions}:00:00Z`;
    return undefined;
  });
  assert.deepEqual(result.calls.map(call => call.kind), ['posts', 'topic', 'posts', 'topic']);
  assert.equal(result.store.counts(result.job).no_match, 0);
  assert.match(String(result.store.failures(result.job)[0]?.error), /变化/);
});

/* 隐藏楼层仍可能需要探测空页，不能为两次请求指标放宽分页检查。 */
test('短帖包含隐藏楼层时仍继续探测实际尾部', async t => {
  const result = await scanOne(t, { replyCount: 8 }, resource => {
    if (resource.kind !== 'posts') return undefined;
    return { status: 200, data: resource.from === 0
      ? [1, 3, 7, 8].map(floor => ({ id: 4000 + floor, topicId: 4, floor, content: '普通回复' }))
      : [] };
  });
  assert.deepEqual(result.calls.map(call => call.kind === 'posts' ? call.from : call.kind), [0, 8, 'topic']);
  assert.equal(result.store.counts(result.job).no_match, 1);
});

/* 读取和结构错误必须仍可诊断，不能变成优化路径的无匹配结论。 */
test('短帖正文异常或详情校验失败均保留问题', async t => {
  const cases: Record<string, ReadHook> = {
    '空正文': resource => resource.kind === 'posts' ? { status: 200, data: [] } : undefined,
    '重复楼层': resource => resource.kind === 'posts'
      ? { status: 200, data: [1, 1].map(floor => ({ id: 4000 + floor, floor, content: '普通回复' })) } : undefined,
    '未知格式': resource => resource.kind === 'posts'
      ? { status: 200, data: [{ id: 4001, floor: 1, content: '正文', contentType: 2 }] } : undefined,
    '详情无权限': resource => resource.kind === 'topic' ? { status: 403 } : undefined,
    '正文无权限': resource => resource.kind === 'posts' ? { status: 403 } : undefined,
    '详情 ID 不符': resource => resource.kind === 'topic'
      ? { status: 200, data: { id: 5, boardId: 235, title: '其他主题', replyCount: 0 } } : undefined,
  };
  for (const [name, hook] of Object.entries(cases)) {
    await t.test(name, async t => {
      const result = await scanOne(t, {}, hook);
      assert.equal(result.job.status, 'partial');
      assert.equal(result.store.counts(result.job).error, 1);
      assert.equal(result.store.counts(result.job).no_match, 0);
      assert.equal(result.store.results(result.job).length, 0);
    });
  }
});

/* 已找到正文命中但详情尚未确认时，用户停止必须丢弃暂存结果。 */
test('短帖详情核对期间暂停或取消，不写入迟到命中', async t => {
  for (const paused of [true, false]) {
    await t.test(paused ? '暂停' : '取消', async () => {
      const fixture = new Fixture();
      const topic = { ...fixture.topics.get(4)!, replyCount: 0 };
      fixture.topics.set(4, topic);
      fixture.content.set('4:1', 'needle 命中');
      const store = new Store();
      const job = store.create(parseOptions({ keyword: 'needle', boardIds: [235], requestsPerSecond: 50 }),
        fixture.session()!, [fixture.boardList[0]!]);
      store.add(job, topic);
      job.status = 'paused';
      job.desiredRunning = false;
      store.save(job);
      const scanner = new Scanner(store, fixture);
      let stopped: ReturnType<Scanner['cancel']> | undefined;
      fixture.failure = resource => {
        if (resource.kind === 'topic') stopped = scanner.cancel(job.id, paused);
        return undefined;
      };
      try {
        scanner.resume(job.id, [4]);
        await scanner.settled();
        await stopped;
        const result = store.get(job.id);
        assert.ok(stopped);
        assert.deepEqual(fixture.calls.map(call => call.kind), ['posts', 'topic']);
        assert.equal(result.status, paused ? 'paused' : 'cancelled');
        assert.equal(result.desiredRunning, false);
        assert.equal(store.counts(result).pending, 1);
        assert.equal(store.results(result).length, 0);
      } finally {
        await scanner.shutdown();
        store.close();
      }
    });
  }
});
