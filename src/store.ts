import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Board, Counts, DirectoryCursor, Job, Match, SearchOptions, Session, Topic, TopicState } from './types.js';
import { ScanError } from './types.js';

/*
 * 用 SQLite 保存任务、每轮扫描记录和主题处理状态。
 * jobs 保存任务的最新状态，runs 保留各轮记录，topics 保存候选主题和命中片段。
 * 主题按任务、轮次、主题 ID 唯一，避免置顶和重叠分页产生重复结果。
 */
export class Store {
  private db: DatabaseSync;

  /* 打开数据库并建表；默认使用内存库，重启时将未结束的任务改为暂停。 */
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (job TEXT, run INTEGER, data TEXT NOT NULL, PRIMARY KEY(job, run));
      CREATE TABLE IF NOT EXISTS topics (
        job TEXT, run INTEGER, id INTEGER, data TEXT NOT NULL, state TEXT NOT NULL,
        result TEXT, error TEXT, PRIMARY KEY(job, run, id)
      );
      CREATE INDEX IF NOT EXISTS topic_state ON topics(job, run, state);
    `);
    /* 旧进程的请求已丢失；保留运行意图，等待同账号扩展连接后继续原轮次。 */
    for (const job of this.list()) {
      const interrupted = ['running', 'waiting_connection', 'waiting_login'].includes(job.status);
      let changed = false;
      if (job.desiredRunning === undefined) {
        job.desiredRunning = interrupted;
        changed = true;
      }
      if (interrupted) {
        job.status = 'paused';
        job.message = '服务已重启，连接 Chrome 后可恢复';
        changed = true;
      }
      if (changed) this.save(job);
    }
  }

  /* 创建第一轮任务，固定搜索范围和账号；目录覆盖始终标记为未验证。 */
  create(options: SearchOptions, session: Session, boards: Board[]): Job {
    const job: Job = {
      id: randomUUID(), run: 1, status: 'running', desiredRunning: true, options, session, boards,
      startedAt: new Date().toISOString(), requests: 0, directoryPasses: 0,
      directoryCursor: { pass: 0, boardIndex: 0, from: 0 }, issues: [],
      coverage: {
        directoryVerified: false, snapshotConsistent: false,
        note: '目录完整性未验证：已采用重叠分页和两遍目录复查；扫描期间的顶帖、编辑、删除或移帖仍可能影响结果。',
      },
    };
    this.save(job);
    return job;
  }

  /* 同时更新任务最新状态和本轮历史记录，供页面查询与恢复使用。 */
  save(job: Job) {
    this.db.prepare('INSERT OR REPLACE INTO jobs VALUES (?, ?)').run(job.id, JSON.stringify(job));
    this.db.prepare('INSERT OR REPLACE INTO runs VALUES (?, ?, ?)').run(job.id, job.run, JSON.stringify(job));
  }

  /* 按任务 ID 读取最新状态；找不到时抛出 NOT_FOUND，交由接口层处理。 */
  get(id: string): Job {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id);
    if (!row) throw new ScanError('NOT_FOUND', '任务不存在');
    return JSON.parse(String(row.data));
  }

  /* 按 jobs 表的 rowid 倒序读取任务；save 使用替换写入，因此会影响顺序。 */
  list(): Job[] {
    return this.db.prepare('SELECT data FROM jobs ORDER BY rowid DESC').all().map(row => JSON.parse(String(row.data)));
  }

  /*
   * 旧任务没有精确游标。按已发现的版面主题数估算位置并回退 100 个主题，
   * 让首次迁移只重读一小段，同时给目录移动和置顶变化留下重叠空间。
   */
  private legacyDirectoryCursor(job: Job): DirectoryCursor {
    const pass = Math.max(0, Math.min(2, job.directoryPasses));
    if (pass !== 0) return { pass, boardIndex: 0, from: 0 };
    for (let boardIndex = 0; boardIndex < job.boards.length; boardIndex++) {
      const board = job.boards[boardIndex]!;
      const known = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM topics
        WHERE job=? AND run=? AND json_extract(data,'$.boardId')=?`).get(job.id, job.run, board.id)!.n);
      if (board.topicCount === undefined || known < board.topicCount)
        return { pass: 0, boardIndex, from: Math.max(0, known - 100) };
    }
    return { pass: 1, boardIndex: 0, from: 0 };
  }

  /*
   * 在原任务上开启新一轮扫描。默认只重试未完成项；指定主题时仅重置这些主题，
   * 其余主题的状态、结果和错误原样复制，旧轮次始终保留。
   */
  resume(job: Job, topicIds?: readonly number[]): Job {
    const previous = job.run;
    const selected = topicIds ? [...new Set(topicIds)] : undefined;
    if (selected && (!selected.length || selected.some(id => !Number.isSafeInteger(id) || id <= 0)))
      throw new ScanError('INPUT', '请提供有效的主题 ID');
    if (selected) {
      const placeholders = selected.map(() => '?').join(',');
      const found = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM topics
        WHERE job=? AND run=? AND id IN (${placeholders})`).get(job.id, previous, ...selected)!.n);
      if (found !== selected.length) throw new ScanError('NOT_FOUND', '指定主题不在该任务的当前轮次中');
    }
    if (!selected && !job.directoryCursor) job.directoryCursor = this.legacyDirectoryCursor(job);
    job.run++;
    job.status = 'running';
    job.desiredRunning = true;
    job.startedAt = new Date().toISOString();
    delete job.endedAt;
    delete job.message;
    if (!selected) job.issues = [];
    job.requests = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO topics(job,run,id,data,state,result,error)
        SELECT job,?,id,data,state,result,error FROM topics WHERE job=? AND run=?`)
        .run(job.run, job.id, previous);
      /* 进程中断时遗留的 working 没有仍在执行的请求，应恢复为 pending。 */
      this.db.prepare(`UPDATE topics SET state='pending',result=NULL,error=NULL
        WHERE job=? AND run=? AND state='working'`).run(job.id, job.run);
      if (selected) {
        const placeholders = selected.map(() => '?').join(',');
        this.db.prepare(`UPDATE topics SET state='pending',result=NULL,error=NULL
          WHERE job=? AND run=? AND id IN (${placeholders})`).run(job.id, job.run, ...selected);
      } else {
        this.db.prepare(`UPDATE topics SET state='pending',result=NULL,error=NULL
          WHERE job=? AND run=? AND state='error'`).run(job.id, job.run);
      }
      this.save(job);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return job;
  }

  /* 服务或连接恢复时继续当前轮次，只放回遗留 working，不重试已完成或错误主题。 */
  continueRun(job: Job): Job {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE topics SET state='pending',result=NULL,error=NULL
        WHERE job=? AND run=? AND state='working'`).run(job.id, job.run);
      job.status = 'running';
      job.desiredRunning = true;
      delete job.endedAt;
      delete job.message;
      this.save(job);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return job;
  }

  /* 加入待扫描主题；同一轮重复发现时忽略，保留已有处理状态。 */
  add(job: Job, topic: Topic) {
    this.db.prepare(`INSERT OR IGNORE INTO topics(job,run,id,data,state) VALUES(?,?,?,?,'pending')`)
      .run(job.id, job.run, topic.id, JSON.stringify(topic));
  }

  /* 返回本轮尚未领取的主题数，供目录发现流程判断是否应等待工作协程。 */
  pendingCount(job: Job): number {
    return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM topics WHERE job=? AND run=? AND state='pending'`)
      .get(job.id, job.run)!.n);
  }

  /*
   * 领取 ID 最小的待处理主题并立即标记为 working；队列为空时返回 undefined。
   * 查询和更新均为同步操作且中间没有 await，在当前单进程内不会被其他协程插入。
   */
  claim(job: Job, topicIds?: readonly number[]): Topic | undefined {
    const selected = topicIds?.length ? ` AND id IN (${topicIds.map(() => '?').join(',')})` : '';
    const row = this.db.prepare(`SELECT id,data FROM topics
      WHERE job=? AND run=? AND state='pending'${selected} ORDER BY id LIMIT 1`)
      .get(job.id, job.run, ...(topicIds ?? []));
    if (!row) return;
    this.db.prepare(`UPDATE topics SET state='working' WHERE job=? AND run=? AND id=?`).run(job.id, job.run, row.id!);
    return JSON.parse(String(row.data));
  }

  /* 写回主题信息、处理结论和可选命中或错误；中断时也可放回 pending。 */
  finishTopic(job: Job, topic: Topic, state: TopicState, result?: Match, error?: string) {
    this.db.prepare('UPDATE topics SET data=?,state=?,result=?,error=? WHERE job=? AND run=? AND id=?')
      .run(JSON.stringify(topic), state, result ? JSON.stringify(result) : null, error ?? null, job.id, job.run, topic.id);
  }

  /* 统计本轮各状态的主题数；未出现的状态补零，方便页面直接显示。 */
  counts(job: Job): Counts {
    const counts: Counts = { total: 0, pending: 0, working: 0, matched: 0, no_match: 0, error: 0, out_of_scope: 0 };
    const rows = this.db.prepare('SELECT state,COUNT(*) AS n FROM topics WHERE job=? AND run=? GROUP BY state').all(job.id, job.run);
    for (const row of rows) {
      counts[row.state as TopicState] = Number(row.n);
      counts.total += Number(row.n);
    }
    return counts;
  }

  /* 按主题 ID 分页读取命中；默认当前轮，指定 run 可查历史，limit=-1 导出全部。 */
  results(job: Job, from = 0, limit = 100, run = job.run): Match[] {
    return this.db.prepare(`SELECT result FROM topics WHERE job=? AND run=? AND state='matched' ORDER BY id LIMIT ? OFFSET ?`)
      .all(job.id, run, limit, from).map(row => JSON.parse(String(row.result)));
  }

  /* 返回本轮读取失败的主题及原因；版面级问题另存于 job.issues。 */
  failures(job: Job) {
    return this.db.prepare(`SELECT id AS topicId,error FROM topics WHERE job=? AND run=? AND state='error' ORDER BY id`)
      .all(job.id, job.run);
  }

  /* 按轮次读取任务历史状态；各轮的命中结果仍由 results 查询。 */
  history(job: Job): Job[] {
    return this.db.prepare('SELECT data FROM runs WHERE job=? ORDER BY run').all(job.id).map(row => JSON.parse(String(row.data)));
  }

  /* 释放 SQLite 连接；调用前应先等待扫描协程结束。 */
  close() { this.db.close(); }
}
