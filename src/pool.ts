import { setTimeout as sleep } from 'node:timers/promises';
import type { Reply, Resource, Transport } from './types.js';
import { ScanError } from './types.js';

/* 等待指定毫秒数；任务取消时立即拒绝 Promise，供限速和轮询共用。 */
export const wait = (ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal });

/*
 * 所有目录和楼层请求共用的调度器，同时限制并发数与请求启动频率。
 * 一个 read 从排队结束到重试完成始终占用一个槽位，结束后再放行排队请求。
 */
export class RequestPool {
  private active = 0;
  private queue: (() => void)[] = [];
  /* nextStart 控制请求间隔；cooldown 是收到 429 后所有请求共同遵守的冷却时间。 */
  private nextStart = 0;
  private cooldown = 0;
  private interval: number;
  requests = 0;
  peak = 0;

  /* 将每秒请求数换算为最小启动间隔，并使用同一个信号取消整池任务。 */
  constructor(private transport: Transport, private concurrency: number, rate: number, private signal: AbortSignal) {
    this.interval = 1000 / rate;
  }

  /* 排队读取资源并返回响应数据；最多尝试四次，登录或会话错误交由扫描器暂停。 */
  async read(resource: Resource): Promise<unknown> {
    this.signal.throwIfAborted();
    await new Promise<void>(resolve => {
      /* 由 drain 分配槽位后才唤醒请求，避免多个等待者同时越过并发限制。 */
      this.queue.push(() => { this.active++; resolve(); });
      this.drain();
    });
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        this.signal.throwIfAborted();
        while (true) {
          /* 等待后重新计算：其他协程可能已更新下次启动时间或全局冷却时间。 */
          const delay = Math.max(this.nextStart, this.cooldown) - Date.now();
          if (delay <= 0) break;
          await wait(delay, this.signal);
        }
        this.nextStart = Date.now() + this.interval;
        this.requests++;
        let reply: Reply;
        try {
          reply = await this.transport.read(resource, this.signal);
        } catch (error) {
          this.signal.throwIfAborted();
          /* 会话断开需要人工恢复；其余传输异常按 0.5、1、2 秒间隔重试。 */
          if (error instanceof ScanError && error.pause) throw error;
          if (attempt === 3) throw error;
          await wait(500 * 2 ** attempt, this.signal);
          continue;
        }
        if (reply.status === 200) return reply.data;
        if (reply.status === 401) throw new ScanError('AUTH', '登录已失效或当前主题需要重新认证，请在 Chrome 中检查', true);
        if (reply.status === 429) {
          /* 限频后将间隔翻倍，并把服务端建议的冷却时间限制在 1 秒到 5 分钟。 */
          this.interval = Math.min(5000, this.interval * 2);
          this.cooldown = Date.now() + Math.max(1000, Math.min(reply.retryAfterMs ?? 2000 * 2 ** attempt, 300000));
        } else if (reply.status < 500 && reply.status !== 408 && reply.status !== 0) {
          /* 权限不足、资源不存在等错误直接返回，重复请求通常无法解决。 */
          throw new ScanError(`HTTP_${reply.status}`, reply.status === 403 ? '当前账号无权读取该资源' : `读取失败（HTTP ${reply.status}）`);
        }
        if (attempt === 3) throw new ScanError(`HTTP_${reply.status}`, reply.error ?? `重试后仍读取失败（HTTP ${reply.status}）`);
        await wait(500 * 2 ** attempt, this.signal);
      }
      throw new ScanError('ERROR', '读取未返回结果');
    } finally {
      /* 成功、失败和取消都必须归还槽位，让队列继续运行或结束。 */
      this.active--;
      this.drain();
    }
  }

  /* 按先进先出的顺序启动等待者，直到槽位用满，并记录占用峰值。 */
  private drain() {
    while (this.active < this.concurrency && this.queue.length) {
      this.queue.shift()!();
      this.peak = Math.max(this.peak, this.active);
    }
  }
}
