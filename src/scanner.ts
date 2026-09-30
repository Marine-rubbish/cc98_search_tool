import { Store } from './store.js';
import { Site } from './site.js';
import { RequestPool, wait } from './pool.js';
import { matchText } from './matcher.js';
import { errorInfo, ScanError } from './types.js';
import type { Board, Job, Match, SearchOptions, Topic, Transport } from './types.js';

/*
 * 组织一次完整搜索：读取版面目录、发现主题、并发扫描楼层并持久化结果。
 * 同一时刻只允许一个任务运行；暂停、取消和致命错误通过共享 AbortController 收束。
 */
export class Scanner {
  private active?: { job: Job; abort: AbortController; done: Promise<void> };
  private recovery?: { jobId: string; promise: Promise<void> };
  private starting = false;

  /* 注入持久化存储和浏览器传输；Scanner 不直接依赖 SQLite 或 WebSocket 细节。 */
  constructor(readonly store: Store, private transport: Transport) {
    this.transport.onSession(session => this.resumeDesired(session));
  }

  /* 启动准备阶段和实际扫描阶段都算忙碌，用于拒绝并行任务和目录刷新。 */
  busy() { return this.starting || !!this.active; }

  /* 使用低并发读取当前账号可见的版面目录，扫描期间禁止刷新。 */
  async boards(): Promise<Board[]> {
    if (this.busy()) throw new ScanError('BUSY', '扫描期间请沿用已加载的版面目录');
    this.starting = true;
    try {
      this.requireSession();
      const pool = new RequestPool(this.transport, 1, 5, new AbortController().signal);
      return await new Site(r => pool.read(r)).boards();
    } finally { this.starting = false; }
  }

  /* 返回当前浏览器会话；未连接时抛出可暂停错误，提示用户重新连接。 */
  private requireSession() {
    const session = this.transport.session();
    if (!session) throw new ScanError('DISCONNECTED', '请先在 Chrome 扩展中连接已登录的 CC98 标签页', true);
    return session;
  }

  /* 校验版面范围和会话稳定性，创建任务后在后台启动扫描。 */
  async start(options: SearchOptions): Promise<Job> {
    if (this.busy()) throw new ScanError('BUSY', '已有任务运行，请先暂停或取消');
    this.starting = true;
    try {
      const session = this.requireSession();
      const pool = new RequestPool(this.transport, 1, options.requestsPerSecond, new AbortController().signal);
      const boards = await new Site(r => pool.read(r)).boards();
      const selected = options.boardIds.map(id => {
        const b = boards.find(b => b.id === id);
        if (!b || b.canEntry === false) throw new ScanError('INPUT', `版面 ${id} 不可访问或不在目录中`);
        return b;
      });
      /* 目录读取期间可能切换账号或标签页，创建任务前再核对一次会话。 */
      const current = this.requireSession();
      if (current.accountId !== session.accountId || current.forumBase !== session.forumBase)
        throw new ScanError('SESSION_CHANGED', '浏览器会话已改变，请重新开始', true);
      const job = this.store.create(options, session, selected);
      this.launch(job);
      return this.store.get(job.id);
    } finally { this.starting = false; }
  }

  /* 使用原账号和站点开启新一轮扫描；指定主题时跳过目录发现并只领取这些主题。 */
  resume(id: string, topicIds?: readonly number[]) {
    if (this.busy()) throw new ScanError('BUSY', '已有任务运行');
    const job = this.store.get(id);
    const session = this.requireSession();
    if (session.accountId !== job.session.accountId || session.forumBase !== job.session.forumBase)
      throw new ScanError('ACCOUNT', '请连接创建该任务时使用的账号和站点');
    const selected = topicIds ? [...new Set(topicIds)] : undefined;
    this.launch(this.store.resume(job, selected), selected);
    return this.store.get(id);
  }

  /* 暂停或取消任务；活动任务先中止并等待协程落盘，非活动任务直接改状态。 */
  async cancel(id: string, paused = false) {
    const active = this.active;
    if (active?.job.id === id) {
      active.job.status = paused ? 'paused' : 'cancelled';
      active.job.desiredRunning = false;
      active.job.message = paused ? '任务已暂停，可以恢复' : '任务已取消，可以恢复';
      this.store.save(active.job);
      active.abort.abort();
      await active.done;
    } else {
      const job = this.store.get(id);
      if (['running', 'waiting_connection', 'waiting_login', 'paused'].includes(job.status)) {
        job.status = paused ? 'paused' : 'cancelled';
        job.desiredRunning = false;
        this.store.save(job);
      }
    }
    return this.store.get(id);
  }

  /* 服务关闭时保留运行意图，使同账号扩展重连后继续当前轮次。 */
  async shutdown() {
    if (!this.active) return;
    this.active.job.status = 'paused';
    this.active.job.desiredRunning = true;
    this.active.job.message = '服务已停止，等待原账号的 Chrome 扩展连接';
    this.store.save(this.active.job);
    this.active.abort.abort();
    await this.active.done;
  }

  /* 等待当前后台任务结束；测试和服务关闭流程使用。 */
  async settled() { await this.active?.done; }

  /* 建立本轮取消控制器并保存完成 Promise，结束后仅清理同一个活动记录。 */
  private launch(job: Job, topicIds?: readonly number[]) {
    const abort = new AbortController();
    const active = { job, abort, done: Promise.resolve() };
    this.active = active;
    active.done = this.run(job, abort, topicIds).finally(() => { if (this.active === active) this.active = undefined; });
  }

  /* 服务重启后只恢复仍有运行意图的同账号任务，不创建新轮次。 */
  private resumeDesired(session: ReturnType<Transport['session']>) {
    if (!session || this.busy()) return;
    const job = this.store.list().find(candidate => candidate.desiredRunning && candidate.status === 'paused');
    if (!job) return;
    if (session.accountId !== job.session.accountId || session.forumBase !== job.session.forumBase) {
      job.desiredRunning = false;
      job.message = '浏览器账号或站点与待恢复任务不一致，任务保持暂停';
      this.store.save(job);
      return;
    }
    this.launch(this.store.continueRun(job));
  }

  /* 所有工作协程共享一个会话等待，恢复后继续原请求和原扫描轮次。 */
  private waitForRecovery(job: Job, error: ScanError, signal: AbortSignal) {
    if (this.recovery?.jobId === job.id) return this.recovery.promise;
    job.status = ['AUTH', 'AUTH_REQUIRED'].includes(error.code) ? 'waiting_login' : 'waiting_connection';
    job.desiredRunning = true;
    job.message = error.message;
    this.store.save(job);
    let unsubscribe = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      const finish = (action: () => void) => {
        signal.removeEventListener('abort', aborted);
        unsubscribe();
        action();
      };
      const aborted = () => finish(() => reject(signal.reason));
      const connected = (session: ReturnType<Transport['session']>) => {
        if (!session) return;
        if (session.accountId !== job.session.accountId || session.forumBase !== job.session.forumBase) {
          job.status = 'paused';
          job.desiredRunning = false;
          job.message = '浏览器账号或站点已改变，任务保持暂停';
          this.store.save(job);
          finish(() => reject(new ScanError('ACCOUNT', job.message!, true)));
          return;
        }
        if (!job.desiredRunning) {
          finish(() => reject(new ScanError('CANCELLED', '任务已停止')));
          return;
        }
        job.status = 'running';
        delete job.message;
        this.store.save(job);
        finish(resolve);
      };
      signal.addEventListener('abort', aborted, { once: true });
      unsubscribe = this.transport.onSession(connected);
    });
    const shared = promise.finally(() => {
      if (this.recovery?.promise === shared) this.recovery = undefined;
    });
    this.recovery = { jobId: job.id, promise: shared };
    return this.recovery.promise;
  }

  /* 并行运行目录发现和主题工作协程，最后根据问题项决定任务结束状态。 */
  private async run(job: Job, abort: AbortController, topicIds?: readonly number[]) {
    const signal = abort.signal;
    const pool = new RequestPool(this.transport, job.options.concurrency, job.options.requestsPerSecond, signal);
    const site = new Site(async r => {
      while (true) {
        try {
          /* 每个实际请求前核对账号和站点，避免任务跨会话继续读取。 */
          const session = this.requireSession();
          if (session.accountId !== job.session.accountId || session.forumBase !== job.session.forumBase)
            throw new ScanError('SESSION_CHANGED', '浏览器账号或标签页已改变', true);
          return await pool.read(r);
        } catch (error) {
          const info = errorInfo(error);
          if (!(error instanceof ScanError) ||
              !['AUTH', 'AUTH_REQUIRED', 'DISCONNECTED'].includes(info.code)) throw error;
          job.requests = pool.requests;
          await this.waitForRecovery(job, error, signal);
        }
      }
    });
    let discovering = !topicIds;
    /* 将请求数和任务状态同步到数据库，页面轮询可看到最新进度。 */
    const persist = () => { job.requests = pool.requests; this.store.save(job); };

    /* 处理会影响整轮扫描的错误：登录类错误暂停，其余错误结束为 partial。 */
    const fatal = (error: unknown) => {
      if (signal.aborted) return;
      const info = errorInfo(error);
      job.status = info.pause ? 'paused' : 'partial';
      job.desiredRunning = false;
      job.message = info.message;
      abort.abort();
    };

    /* 记录单个目录或置顶资源的问题；需人工恢复的错误继续上抛。 */
    const issue = (resource: string, error: unknown) => {
      const info = errorInfo(error);
      if (info.pause) throw error;
      job.issues.push({ resource, code: info.code, message: info.message });
      persist();
    };

    /* 两遍读取各版面目录，并将发现的主题持续写入待处理队列。 */
    const discover = async () => {
      if (topicIds) return;
      const initial = job.directoryCursor ?? { pass: job.directoryPasses, boardIndex: 0, from: 0 };
      job.directoryCursor = initial;
      try {
        /* 第二遍复查用于降低扫描期间顶帖、删帖或移帖造成的目录遗漏。 */
        for (let pass = initial.pass; pass < 2; pass++) {
          const firstBoard = pass === initial.pass ? initial.boardIndex : 0;
          for (let boardIndex = firstBoard; boardIndex < job.boards.length; boardIndex++) {
            const selected = job.boards[boardIndex]!;
            signal.throwIfAborted();
            try {
              const board = await site.board(selected.id);
              Object.assign(selected, board);
              try {
                for (const topic of await site.pinned(board.id)) this.store.add(job, topic);
              } catch (error) {
                signal.throwIfAborted();
                issue(`board/${board.id}/pinned`, error);
                return;
              }
              const count = board.topicCount!;
              const seen = new Set<number>();
              let from = pass === initial.pass && boardIndex === initial.boardIndex ? initial.from : 0;
              let bufferedPage: { from: number; topics: Topic[] } | undefined;
              for (; from < count;) {
                signal.throwIfAborted();
                /* 限制待处理积压，避免目录过快写入导致内存和数据库压力持续增长。 */
                while (this.store.pendingCount(job) > job.options.concurrency * 4) await wait(50, signal);
                const size = Math.min(20, count - from);
                const topics = bufferedPage?.from === from
                  ? bufferedPage.topics
                  : await site.topics(board.id, from, size);
                bufferedPage = undefined;
                if (!topics.length || topics.length > size) throw new ScanError('PAGINATION', `主题目录 ${from} 返回异常页`);
                let fresh = 0;
                /* seen 只判断本次版面遍历能否前进；Store 负责跨页和跨遍去重。 */
                for (const topic of topics) {
                  if (!seen.has(topic.id)) fresh++;
                  seen.add(topic.id);
                  this.store.add(job, topic);
                }
                if (!fresh) throw new ScanError('PAGINATION', `主题目录 ${from} 重复，未能继续翻页`);
                if (topics.length < size) {
                  /*
                   * topicCount 可能包含当前账号不可见的主题。短页后从实际末尾探测，
                   * 下一页为空才确认尾部；非空探测页留给下一轮直接处理。
                   */
                  const tailFrom = from + topics.length;
                  const tailSize = Math.min(20, count - tailFrom);
                  const tailTopics = await site.topics(board.id, tailFrom, tailSize);
                  if (!tailTopics.length) {
                    issue(`board/${board.id}/pass/${pass + 1}`,
                      new ScanError('PAGINATION', `主题目录实际在 ${tailFrom} 结束，版面统计为 ${count}，已继续后续版面`));
                    break;
                  }
                  bufferedPage = { from: tailFrom, topics: tailTopics };
                  from = tailFrom;
                  job.directoryCursor = { pass, boardIndex, from };
                  persist();
                  continue;
                }
                if (from + topics.length >= count) break;
                /* 每页回退两个主题形成重叠，降低翻页过程中目录移动造成的漏项。 */
                from += Math.max(1, topics.length - 2);
                job.directoryCursor = { pass, boardIndex, from };
                persist();
              }
              job.directoryCursor = { pass, boardIndex: boardIndex + 1, from: 0 };
              persist();
            } catch (error) {
              signal.throwIfAborted();
              issue(`board/${selected.id}/pass/${pass + 1}`, error);
              return;
            }
          }
          job.directoryPasses = pass + 1;
          job.directoryCursor = { pass: pass + 1, boardIndex: 0, from: 0 };
          persist();
        }
      } catch (error) { fatal(error); }
      finally { discovering = false; }
    };

    /* 不断领取持久化候选并扫描；目录尚未结束且暂时无任务时短暂等待。 */
    const worker = async () => {
      try {
        while (!signal.aborted) {
          const candidate = this.store.claim(job, topicIds);
          if (!candidate) {
            if (!discovering) break;
            await wait(30, signal);
            continue;
          }
          try { await this.scanTopic(job, candidate, site, signal); }
          catch (error) {
            const info = errorInfo(error);
            /* 整轮中断不应污染主题错误统计，当前主题放回 pending 等待恢复。 */
            this.store.finishTopic(job, candidate, signal.aborted || info.pause ? 'pending' : 'error', undefined, info.message);
            if (info.pause) throw error;
          }
          persist();
        }
      } catch (error) { fatal(error); }
    };

    /* 目录发现与工作协程同时运行，所有请求共用同一个并发和限速池。 */
    await Promise.all([discover(), ...Array.from({ length: job.options.concurrency }, worker)]);
    job.requests = pool.requests;
    if (job.status === 'running') {
      const counts = this.store.counts(job);
      job.status = job.issues.length || counts.error || counts.pending || counts.working ? 'partial' : 'finished_unverified';
      job.desiredRunning = false;
      job.message = job.status === 'partial' ? '扫描结束，仍有读取失败项' : '已处理已发现的主题；目录完整性未验证';
    }
    job.endedAt = new Date().toISOString();
    persist();
  }

  /* 扫描一个主题的标题和全部楼层；首次命中立即保存，不再读取后续楼层。 */
  private async scanTopic(job: Job, candidate: Topic, site: Site, signal: AbortSignal) {
    const topic = await site.topic(candidate.id);
    const board = job.boards.find(b => b.id === topic.boardId);
    /* 置顶主题可能来自其他版面，以主题详情中的实际 boardId 为准。 */
    if (!board) { this.store.finishTopic(job, topic, 'out_of_scope'); return; }

    /* 构造统一命中结果；楼层命中附带分页路径和页内锚点。 */
    const makeMatch = (snippet: string, floor?: number, postId?: number): Match => ({
      topicId: topic.id, boardId: board.id, boardName: board.name, title: topic.title,
      kind: floor === undefined ? 'title' : 'post', floor, postId, snippet,
      url: new URL(`topic/${topic.id}/${floor ? Math.ceil(floor / 10) : 1}${floor ? `#${floor % 10}` : ''}`, job.session.forumBase).href,
    });

    /* 标题先匹配，命中后无需请求任何楼层。 */
    const title = matchText(topic.title, job.options.keyword, job.options.caseSensitive, 'plain');
    if (title !== undefined) { this.store.finishTopic(job, topic, 'matched', makeMatch(title)); return; }
    const seen = new Map<number, number>();
    let lastFloor = 0;
    const expected = topic.replyCount + 1;
    for (let from = 0;;) {
      signal.throwIfAborted();
      const posts = await site.posts(topic.id, from);
      if (!posts.length) {
        if (from === 0) throw new ScanError('PAGINATION', `主题 ${topic.id} 未返回可读楼层`);
        break;
      }
      /*
       * 删除或隐藏楼层会让可读数量少于 replyCount，楼层号也可能不连续。
       * 只要求响应持续前进。隐藏楼层可能不在响应中，但仍占用接口偏移，
       * 因此下一页同时参考实际返回数和最后楼层号，避免再次读到短页末项。
       */
      for (const post of posts) {
        const previousFloor = seen.get(post.id);
        if (previousFloor !== undefined)
          throw new ScanError('PAGINATION',
            `主题 ${topic.id} 在偏移 ${from} 返回帖子 ID ${post.id}，此前楼层 ${previousFloor}，本次楼层 ${post.floor}`);
        if (post.floor <= lastFloor)
          throw new ScanError('PAGINATION', `主题 ${topic.id} 在楼层 ${lastFloor} 后返回楼层 ${post.floor}，需要复查`);
        seen.set(post.id, post.floor);
        lastFloor = post.floor;
        if (post.isDeleted) continue;
        if (post.contentType !== undefined && post.contentType !== 0 && post.contentType !== 1)
          throw new ScanError('FORMAT', '该楼层的文本格式尚不支持');
        /* contentType=1 为 Markdown；缺失或 0 按 CC98 的 UBB 正文处理。 */
        const snippet = matchText(post.content, job.options.keyword, job.options.caseSensitive, post.contentType === 1 ? 'markdown' : 'ubb');
        if (snippet !== undefined) {
          this.store.finishTopic(job, topic, 'matched', makeMatch(snippet, post.floor, post.id));
          return;
        }
      }
      from = Math.max(from + posts.length, lastFloor);
      if (from >= expected) break;
    }

    /* 得出无匹配前重读主题元数据；扫描期间变化的主题留到恢复时复查。 */
    const after = await site.topic(topic.id);
    if (after.replyCount !== topic.replyCount || after.boardId !== topic.boardId || after.title !== topic.title ||
        after.lastPostTime !== topic.lastPostTime) throw new ScanError('CHANGED', '主题在读取期间发生变化，需要恢复复查');
    this.store.finishTopic(job, topic, 'no_match');
  }
}
