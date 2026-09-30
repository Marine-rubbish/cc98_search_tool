import type { Board, Reply, Resource, Session, Topic, Transport } from '../src/types.js';
import { wait } from '../src/pool.js';

/*
 * 为扫描器测试提供可预测的内存论坛和 Transport 实现。
 * 调用方可调整延迟、会话、正文和 failure 回调来模拟并发与错误。
 */
export class Fixture implements Transport {
  identity: Session | null = { accountId: '42', forumBase: 'https://www.cc98.org/' };
  private sessionListeners = new Set<(session: Session | null) => void>();
  calls: Resource[] = [];
  active = 0;
  peak = 0;
  delay = 2;
  failure?: (r: Resource) => Reply | Error | undefined;
  boardList: Board[] = [{ id: 235, name: '求职广场' }, { id: 459, name: '实习兼职' }, { id: 68, name: '学习天地' }];
  topics = new Map<number, Topic>(Array.from({ length: 26 }, (_, index) => {
    const id = index + 1;
    return [id, { id, title: id === 2 ? 'Needle 招聘信息' : `普通主题 ${id}`, boardId: 235, replyCount: id === 1 ? 100 : 11, lastPostTime: '2026-09-25' }];
  }));
  content = new Map<string, string>([['1:100', '第 100 楼中包含 needle'], ['3:1', '[quote]NEEDLE[/quote]']]);
  pinned = [2, 27, 28];

  /* 补充范围内和范围外置顶主题，用于验证去重与实际版面过滤。 */
  constructor() {
    this.topics.set(27, { id: 27, boardId: 459, title: 'needle 实习置顶', replyCount: 0 });
    this.topics.set(28, { id: 28, boardId: 68, title: 'needle 学习置顶', replyCount: 0 });
  }

  /* 返回当前模拟账号；设为 null 可模拟扩展未连接。 */
  session() { return this.identity; }

  /* 更新模拟会话并通知扫描器，供连接恢复测试使用。 */
  setSession(session: Session | null) {
    this.identity = session;
    for (const listener of this.sessionListeners) listener(session);
  }

  /* 订阅模拟会话变化；注册后异步发送当前状态，与真实 Bridge 保持一致。 */
  onSession(listener: (session: Session | null) => void) {
    this.sessionListeners.add(listener);
    queueMicrotask(() => listener(this.identity));
    return () => this.sessionListeners.delete(listener);
  }

  /* 按 Resource 生成论坛响应，并记录调用次数、活动请求数和并发峰值。 */
  async read(r: Resource, signal?: AbortSignal): Promise<Reply> {
    this.calls.push(r);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      await wait(this.delay, signal);
      const failed = this.failure?.(r);
      if (failed instanceof Error) throw failed;
      if (failed) return failed;
      let data: unknown;
      /* 各资源使用同一份主题和正文数据，保证目录、详情与楼层相互一致。 */
      switch (r.kind) {
        case 'boards': data = this.boardList; break;
        case 'board': data = { ...this.boardList.find(b => b.id === r.id), canEntry: true, topicCount: r.id === 235 ? 26 : 0 }; break;
        case 'topics': data = r.id === 235 ? [...this.topics.values()].slice(0, 26).slice(r.from, r.from + r.size) : []; break;
        case 'pinned': data = this.pinned.map(id => this.topics.get(id)); break;
        case 'topic': data = this.topics.get(r.id); break;
        case 'posts': {
          const topic = this.topics.get(r.id)!;
          data = Array.from({ length: Math.max(0, Math.min(r.size, topic.replyCount + 1 - r.from)) }, (_, index) => {
            const floor = r.from + index + 1;
            return { id: r.id * 1000 + floor, topicId: r.id, floor, content: this.content.get(`${r.id}:${floor}`) ?? '普通回复', contentType: 0 };
          });
          break;
        }
      }
      return { status: 200, data: structuredClone(data) };
    } finally { this.active--; }
  }
}
