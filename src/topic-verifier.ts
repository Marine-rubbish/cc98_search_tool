import type { Site } from './site.js';
import type { Match, Topic } from './types.js';
import { errorInfo } from './types.js';

interface PendingTopic { topic: Topic; match?: Match }

/* 目录和详情共用同一套基线比较；无法据此识别不改变这些字段的旧楼层编辑。 */
export function sameTopic(before: Topic, after: Topic) {
  return before.id === after.id && before.boardId === after.boardId && before.title === after.title &&
    before.replyCount === after.replyCount && before.lastPostTime === after.lastPostTime;
}

/*
 * 暂存已读正文的短帖结论，以一次新目录请求核对同页主题。
 * 只保存基线和可选片段，数据库仍为 working；调用方在达到上限时暂停领取。
 */
export class TopicVerifier {
  private queued: PendingTopic[] = [];
  private outstanding = new Set<PendingTopic>();
  private flushing?: Promise<void>;
  private room?: Promise<void>;
  private wakeRoom?: () => void;

  constructor(
    private site: Site,
    private signal: AbortSignal,
    private concurrency: number,
    private accept: (topic: Topic, match?: Match) => void,
    private fallback: (topic: Topic, match?: Match) => Promise<void>,
    private failed: (topic: Topic, error: unknown) => void,
  ) {}

  /* 上限包含正在核对的批次，另允许已经在读正文的工作协程收尾。 */
  full() { return this.outstanding.size >= 40; }
  pending() { return this.outstanding.size > 0; }

  /* 缓冲有空位即可继续读正文，慢回退无需拖住全部工作协程。 */
  waitForRoom(): Promise<void> {
    if (!this.full()) return Promise.resolve();
    if (this.room) return this.room;
    const available = new Promise<void>(resolve => { this.wakeRoom = resolve; });
    const shared = Promise.race([this.flush(), available]).finally(() => {
      this.room = undefined;
      this.wakeRoom = undefined;
    });
    this.room = shared;
    return shared;
  }

  /* 主动停止后也须等后台核对退出，再释放未确认项。 */
  async settled() { await this.flushing; }

  private finished(entry: PendingTopic) {
    this.outstanding.delete(entry);
    if (!this.full()) this.wakeRoom?.();
  }

  /* 缺失或无效来源的旧记录、置顶主题继续逐帖核对。 */
  add(topic: Topic, match?: Match) {
    const page = topic.directoryPage;
    if (!page || page.boardId !== topic.boardId || !Number.isSafeInteger(page.boardId) || page.boardId <= 0 ||
        !Number.isSafeInteger(page.from) || page.from < 0 ||
        !Number.isSafeInteger(page.size) || page.size < 1 || page.size > 20) return false;
    const entry = { topic, match };
    this.queued.push(entry);
    this.outstanding.add(entry);
    return true;
  }

  /* 所有调用者等待同一次核对；先截取快照，迟到的正文只能进入下一批。 */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const groups = new Map<string, PendingTopic[]>();
    for (const entry of this.queued.splice(0)) {
      const page = entry.topic.directoryPage!;
      const key = `${page.boardId}:${page.from}:${page.size}`;
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    const remaining = [...groups.values()];
    /* #region debug-point A:batch-start */
    if (process.env.CC98_DEBUG_URL) void fetch(process.env.CC98_DEBUG_URL, { method: 'POST', body: JSON.stringify({ sessionId: 'search-throughput', runId: process.env.CC98_DEBUG_RUN, hypothesisId: 'A', location: 'TopicVerifier.flush', msg: '[DEBUG] batch-start', data: { outstanding: this.outstanding.size, groups: remaining.map(group => group.length) }, ts: Date.now() }) }).catch(() => {});
    /* #endregion */
    const worker = async () => {
      while (!this.signal.aborted) {
        const group = remaining.shift();
        if (!group) return;
        try { await this.verifyGroup(group); }
        catch (error) {
          if (this.signal.aborted) return;
          /* 会话错误交由扫描器中止整轮；未完成的其余成员留待释放。 */
          const unfinished = group.find(entry => this.outstanding.has(entry));
          if (unfinished) {
            this.failed(unfinished.topic, error);
            this.finished(unfinished);
          }
        }
      }
    };
    /* 等所有核对协程结束才允许收尾，防止中止后仍有迟到写入。 */
    const promise = Promise.allSettled(Array.from({ length: Math.min(this.concurrency, remaining.length) }, worker))
      .then(results => {
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      });
    this.flushing = promise.finally(() => {
      /* #region debug-point A:batch-end */
      if (process.env.CC98_DEBUG_URL) void fetch(process.env.CC98_DEBUG_URL, { method: 'POST', body: JSON.stringify({ sessionId: 'search-throughput', runId: process.env.CC98_DEBUG_RUN, hypothesisId: 'A', location: 'TopicVerifier.flush', msg: '[DEBUG] batch-end', data: { outstanding: this.outstanding.size }, ts: Date.now() }) }).catch(() => {});
      /* #endregion */
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async verifyGroup(group: PendingTopic[]) {
    let topics: Map<number, Topic> | undefined;
    if (group.length > 1) {
      const source = group[0]!.topic.directoryPage!;
      try {
        const page = await this.site.topics(source.boardId, source.from, source.size);
        this.signal.throwIfAborted();
        const byId = new Map(page.map(topic => [topic.id, topic]));
        /* 超长页或重复 ID 不能用于确认任何结论。短页按 ID 分别核对。 */
        if (page.length <= source.size && byId.size === page.length) topics = byId;
      } catch (error) {
        this.signal.throwIfAborted();
        if (errorInfo(error).pause) throw error;
        /* 目录不可用时逐帖核对，最终失败仍由原详情路径记录。 */
      }
    }
    /* 同页回退并发执行，请求槽位仍由共享请求池限制。 */
    const results = await Promise.allSettled(group.map(async entry => {
      if (this.signal.aborted) return;
      try {
        const after = topics?.get(entry.topic.id);
        if (after && sameTopic(entry.topic, after)) this.accept(entry.topic, entry.match);
        else {
          /* #region debug-point B:fallback-start */
          if (process.env.CC98_DEBUG_URL) void fetch(process.env.CC98_DEBUG_URL, { method: 'POST', body: JSON.stringify({ sessionId: 'search-throughput', runId: process.env.CC98_DEBUG_RUN, hypothesisId: 'B', location: 'TopicVerifier.verifyGroup', msg: '[DEBUG] fallback-start', data: { id: entry.topic.id }, ts: Date.now() }) }).catch(() => {});
          /* #endregion */
          await this.fallback(entry.topic, entry.match);
          /* #region debug-point B:fallback-end */
          if (process.env.CC98_DEBUG_URL) void fetch(process.env.CC98_DEBUG_URL, { method: 'POST', body: JSON.stringify({ sessionId: 'search-throughput', runId: process.env.CC98_DEBUG_RUN, hypothesisId: 'B', location: 'TopicVerifier.verifyGroup', msg: '[DEBUG] fallback-end', data: { id: entry.topic.id }, ts: Date.now() }) }).catch(() => {});
          /* #endregion */
        }
        this.finished(entry);
      } catch (error) {
        if (this.signal.aborted) return;
        this.failed(entry.topic, error);
        this.finished(entry);
      }
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /* 仅在工作协程全部结束后调用；未核对项放回 pending，恢复时重读正文。 */
  release(putBack: (topic: Topic) => void) {
    for (const entry of this.outstanding) putBack(entry.topic);
    this.outstanding.clear();
    this.queued = [];
  }
}
