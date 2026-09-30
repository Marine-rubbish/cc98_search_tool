import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseOptions, ScanError } from './types.js';

type JsonObject = Record<string, unknown>;
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export type IncidentKind =
  | 'service_unreachable'
  | 'extension_disconnected'
  | 'login_not_recovered'
  | 'session_changed'
  | 'task_stopped'
  | 'stalled_unknown'
  | 'transient_recovered'
  | 'completed_early'
  | 'duration_reached'
  | 'user_stopped'
  | 'setup_failed';

export interface SoakOptions {
  keyword?: string;
  preset: 'employment' | 'all';
  boardIds?: number[];
  concurrency: number;
  requestsPerSecond: number;
  caseSensitive: boolean;
  durationMs: number;
  pollMs: number;
  stallMs: number;
  disconnectGraceMs: number;
  loginGraceMs: number;
  dataDir: string;
  outputDir: string;
  attach?: string;
  help: boolean;
}

export interface SoakSnapshot {
  at: number;
  elapsedMs: number;
  serviceReachable: boolean;
  connection: {
    connected: boolean;
    extensionVersion?: string;
    connectedAt?: string;
    lastMessageAt?: string;
    lastClose?: { at: string; code: number; reason: string };
  };
  busy: boolean;
  job: {
    id: string;
    run: number;
    status: string;
    desiredRunning: boolean;
    message?: string;
    requests: number;
    directoryPasses: number;
    directoryCursor?: { pass: number; boardIndex: number; from: number };
    counts: {
      total: number;
      pending: number;
      working: number;
      matched: number;
      no_match: number;
      error: number;
      out_of_scope: number;
    };
    issueCount: number;
    failureCount: number;
    issues: { resource: string; code: string; message: string }[];
    failures: { topicId: number; error: string }[];
  };
}

export interface SoakEvent {
  kind: IncidentKind | 'started' | 'status_changed' | 'progress' | 'errors_changed';
  at: number;
  message: string;
  snapshot?: SoakSnapshot;
}

export interface SoakOutcome {
  kind: IncidentKind;
  success: boolean;
  at: number;
  message: string;
  snapshot?: SoakSnapshot;
}

const defaults = {
  concurrency: 20,
  requestsPerSecond: 10,
  durationMs: 90 * 60_000,
  pollMs: 5000,
  stallMs: 10 * 60_000,
  disconnectGraceMs: 120_000,
  loginGraceMs: 75_000,
};

function integer(value: string | undefined, fallback: number, name: string, min: number, max: number) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new ScanError('INPUT', `${name}应为 ${min}–${max} 的整数`);
  return parsed;
}

/* 将命令行参数解析为稳定配置；这里只校验，不访问服务或创建任务。 */
export function parseSoakOptions(args: string[], cwd = process.cwd()): SoakOptions {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      keyword: { type: 'string' },
      preset: { type: 'string' },
      boards: { type: 'string' },
      concurrency: { type: 'string' },
      rate: { type: 'string' },
      'case-sensitive': { type: 'boolean' },
      'duration-minutes': { type: 'string' },
      'poll-seconds': { type: 'string' },
      'stall-minutes': { type: 'string' },
      'disconnect-grace-seconds': { type: 'string' },
      'login-grace-seconds': { type: 'string' },
      'data-dir': { type: 'string' },
      'output-dir': { type: 'string' },
      attach: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const help = values.help === true;
  const attach = values.attach?.trim() || undefined;
  const keyword = values.keyword?.trim() || undefined;
  const preset = values.preset ?? 'employment';
  if (!['employment', 'all'].includes(preset)) throw new ScanError('INPUT', '版面预设仅支持 employment 或 all');
  const boardIds = values.boards === undefined ? undefined :
    [...new Set(values.boards.split(',').map(Number))];
  if (boardIds && (!boardIds.length || boardIds.length > 1000 ||
      boardIds.some(id => !Number.isSafeInteger(id) || id <= 0)))
    throw new ScanError('INPUT', '版面 ID 应为 1–1000 个逗号分隔的正整数');
  if (attach && (keyword || values.boards !== undefined || values.preset !== undefined ||
      values.concurrency !== undefined || values.rate !== undefined || values['case-sensitive']))
    throw new ScanError('INPUT', '附加模式不能修改关键词、版面、并发或请求频率');
  if (!help && !attach && !keyword) throw new ScanError('INPUT', '请使用 --keyword 提供搜索关键词');
  if (keyword && keyword.length > 200) throw new ScanError('INPUT', '关键词长度应为 1–200');
  const concurrency = integer(values.concurrency, defaults.concurrency, '并发数', 1, 20);
  const requestsPerSecond = integer(values.rate, defaults.requestsPerSecond, '请求频率', 1, 50);
  const durationMinutes = integer(values['duration-minutes'], defaults.durationMs / 60_000, '运行时间', 5, 1440);
  const pollSeconds = integer(values['poll-seconds'], defaults.pollMs / 1000, '采样间隔', 1, 60);
  const stallMinutes = integer(
    values['stall-minutes'], Math.min(defaults.stallMs / 60_000, durationMinutes), '无进展阈值', 2, durationMinutes,
  );
  const disconnectGraceSeconds = integer(
    values['disconnect-grace-seconds'], defaults.disconnectGraceMs / 1000, '断线宽限', 15, 1800,
  );
  const loginGraceSeconds = integer(
    values['login-grace-seconds'], defaults.loginGraceMs / 1000, '登录宽限', 75, 1800,
  );
  const dataDir = resolve(cwd, values['data-dir'] ?? '.cc98');
  return {
    keyword,
    preset: preset as 'employment' | 'all',
    boardIds,
    concurrency,
    requestsPerSecond,
    caseSensitive: values['case-sensitive'] === true,
    durationMs: durationMinutes * 60_000,
    pollMs: pollSeconds * 1000,
    stallMs: stallMinutes * 60_000,
    disconnectGraceMs: disconnectGraceSeconds * 1000,
    loginGraceMs: loginGraceSeconds * 1000,
    dataDir,
    outputDir: resolve(cwd, values['output-dir'] ?? resolve(dataDir, 'soak')),
    attach,
    help,
  };
}

export const soakHelp = `CC98 真实长跑测试

用法：
  npm run soak -- --keyword "关键词" [参数]
  npm run soak -- --attach JOB_ID [监控参数]

搜索参数：
  --preset employment|all       默认 employment
  --boards 235,459              覆盖 preset
  --concurrency 1-20            默认 20
  --rate 1-50                   默认 10
  --case-sensitive

监控参数：
  --duration-minutes 5-1440     默认 90
  --poll-seconds 1-60           默认 5
  --stall-minutes 2-duration    默认 10
  --disconnect-grace-seconds    默认 120，范围 15-1800
  --login-grace-seconds         默认 75，范围 75-1800
  --data-dir PATH               默认 .cc98
  --output-dir PATH             默认 <data-dir>/soak
`;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function finiteInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function safeText(value: unknown) {
  if (typeof value !== 'string') return undefined;
  if (/(?:bearer|authorization|cookie|refresh[_-]?token|access[_-]?token)/i.test(value)) return '[REDACTED]';
  return value.slice(0, 500);
}

function safeTimestamp(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/* 只从 API 响应中挑选诊断白名单，避免账号、凭据和正文进入长跑产物。 */
export function safeSnapshot(doctorInput: unknown, jobInput: unknown, at: number, elapsedMs: number): SoakSnapshot {
  const doctor = object(doctorInput), connection = object(doctor.connection);
  const close = object(connection.lastClose), job = object(jobInput), cursor = object(job.directoryCursor);
  const counts = object(job.counts);
  const issues = Array.isArray(job.issues) ? job.issues.slice(-20).map(value => object(value)) : [];
  const failures = Array.isArray(job.failures) ? job.failures.slice(-20).map(value => object(value)) : [];
  const snapshot: SoakSnapshot = {
    at,
    elapsedMs,
    serviceReachable: true,
    connection: {
      connected: connection.connected === true || doctor.connected === true,
      extensionVersion: safeText(connection.extensionVersion),
      connectedAt: safeTimestamp(connection.connectedAt),
      lastMessageAt: safeTimestamp(connection.lastMessageAt),
      lastClose: close.at ? {
        at: safeTimestamp(close.at) ?? '',
        code: finiteInteger(close.code),
        reason: safeText(close.reason) ?? 'unknown',
      } : undefined,
    },
    busy: doctor.busy === true,
    job: {
      id: typeof job.id === 'string' ? job.id : '',
      run: finiteInteger(job.run),
      status: typeof job.status === 'string' ? job.status : 'unknown',
      desiredRunning: job.desiredRunning === true,
      message: safeText(job.message),
      requests: finiteInteger(job.requests),
      directoryPasses: finiteInteger(job.directoryPasses),
      directoryCursor: job.directoryCursor ? {
        pass: finiteInteger(cursor.pass),
        boardIndex: finiteInteger(cursor.boardIndex),
        from: finiteInteger(cursor.from),
      } : undefined,
      counts: {
        total: finiteInteger(counts.total),
        pending: finiteInteger(counts.pending),
        working: finiteInteger(counts.working),
        matched: finiteInteger(counts.matched),
        no_match: finiteInteger(counts.no_match),
        error: finiteInteger(counts.error),
        out_of_scope: finiteInteger(counts.out_of_scope),
      },
      issueCount: Array.isArray(job.issues) ? job.issues.length : 0,
      failureCount: Array.isArray(job.failures) ? job.failures.length : 0,
      issues: issues.map(issue => ({
        resource: safeText(issue.resource) ?? 'unknown',
        code: safeText(issue.code) ?? 'unknown',
        message: safeText(issue.message) ?? '未提供错误信息',
      })),
      failures: failures.map(failure => ({
        topicId: finiteInteger(failure.topicId),
        error: safeText(failure.error) ?? '未提供错误信息',
      })),
    },
  };
  return JSON.parse(JSON.stringify(snapshot));
}

function progressSignature(snapshot: SoakSnapshot) {
  const job = snapshot.job;
  return JSON.stringify([
    job.requests,
    job.directoryPasses,
    job.directoryCursor?.pass,
    job.directoryCursor?.boardIndex,
    job.directoryCursor?.from,
    job.counts.total,
    job.counts.pending,
    job.counts.working,
    job.counts.matched,
    job.counts.no_match,
    job.counts.error,
    job.counts.out_of_scope,
  ]);
}

function errorSignature(snapshot: SoakSnapshot) {
  return JSON.stringify([snapshot.job.issueCount, snapshot.job.failureCount, snapshot.job.issues, snapshot.job.failures]);
}

/* 高频进度事件只保留计数；完整问题明细由 errors_changed 和终止报告承载。 */
function compactSnapshot(snapshot: SoakSnapshot): SoakSnapshot {
  return {
    ...snapshot,
    job: { ...snapshot.job, issues: [], failures: [] },
  };
}

/* 根据真实采样时间线判断恢复、终止和停滞，不猜测证据不足的底层原因。 */
export class SoakClassifier {
  private lastSignature?: string;
  private lastErrorSignature?: string;
  private lastProgressAt: number;
  private waiting?: { kind: 'connection' | 'login'; since: number };
  private unavailableCount = 0;
  private previousStatus?: string;

  constructor(private options: SoakOptions, private startedAt: number) {
    this.lastProgressAt = startedAt;
  }

  observe(snapshot: SoakSnapshot): { events: SoakEvent[]; terminal?: SoakOutcome } {
    const events: SoakEvent[] = [];
    const compact = compactSnapshot(snapshot);
    this.unavailableCount = 0;
    const signature = progressSignature(snapshot);
    if (this.lastSignature === undefined || signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.lastProgressAt = snapshot.at;
      events.push({ kind: 'progress', at: snapshot.at, message: '搜索进度已更新', snapshot: compact });
    }
    if (snapshot.job.status !== this.previousStatus) {
      events.push({ kind: 'status_changed', at: snapshot.at,
        message: `任务状态变为 ${snapshot.job.status}`, snapshot: compact });
      this.previousStatus = snapshot.job.status;
    }
    const errors = errorSignature(snapshot);
    if (this.lastErrorSignature === undefined) {
      this.lastErrorSignature = errors;
      if (snapshot.job.issueCount || snapshot.job.failureCount)
        events.push({ kind: 'errors_changed', at: snapshot.at, message: '读取问题已更新', snapshot });
    } else if (errors !== this.lastErrorSignature) {
      this.lastErrorSignature = errors;
      events.push({ kind: 'errors_changed', at: snapshot.at, message: '读取问题已更新', snapshot });
    }

    const waitKind = snapshot.job.status === 'waiting_login' ? 'login' :
      snapshot.job.status === 'waiting_connection' || !snapshot.connection.connected ? 'connection' : undefined;
    if (waitKind) {
      if (!this.waiting || this.waiting.kind !== waitKind) this.waiting = { kind: waitKind, since: snapshot.at };
      const limit = waitKind === 'login' ? this.options.loginGraceMs : this.options.disconnectGraceMs;
      if (snapshot.at - this.waiting.since > limit) {
        const kind = waitKind === 'login' ? 'login_not_recovered' : 'extension_disconnected';
        return { events, terminal: { kind, success: false, at: snapshot.at,
          message: waitKind === 'login' ? '登录状态未在宽限期内恢复' : '扩展连接未在宽限期内恢复', snapshot } };
      }
      return { events };
    }
    if (this.waiting) {
      events.push({ kind: 'transient_recovered', at: snapshot.at,
        message: this.waiting.kind === 'login' ? '登录状态已恢复' : '扩展连接已恢复', snapshot: compact });
      this.waiting = undefined;
    }

    if (snapshot.job.status === 'paused') {
      const sessionChanged = /账号|站点/.test(snapshot.job.message ?? '');
      return { events, terminal: { kind: sessionChanged ? 'session_changed' : 'task_stopped',
        success: false, at: snapshot.at, message: snapshot.job.message ?? '任务提前暂停', snapshot } };
    }
    if (snapshot.job.status === 'cancelled' || snapshot.job.status === 'partial')
      return { events, terminal: { kind: 'task_stopped', success: false, at: snapshot.at,
        message: snapshot.job.message ?? `任务提前进入 ${snapshot.job.status}`, snapshot } };
    if (snapshot.job.status === 'finished_unverified')
      return { events, terminal: { kind: 'completed_early', success: true, at: snapshot.at,
        message: '真实搜索在运行上限前正常完成', snapshot } };
    if (snapshot.at - this.startedAt >= this.options.durationMs)
      return { events, terminal: { kind: 'duration_reached', success: true, at: snapshot.at,
        message: '真实搜索达到设定运行上限', snapshot } };
    if (snapshot.at - this.lastProgressAt > this.options.stallMs)
      return { events, terminal: { kind: 'stalled_unknown', success: false, at: snapshot.at,
        message: '服务和扩展在线，但搜索长时间没有进展', snapshot } };
    return { events };
  }

  unavailable(at: number, message: string): { events: SoakEvent[]; terminal?: SoakOutcome } {
    this.unavailableCount++;
    const event: SoakEvent = { kind: 'status_changed', at, message: safeText(message) ?? '本地服务不可访问' };
    if (this.unavailableCount < 3) return { events: [event] };
    return { events: [event], terminal: {
      kind: 'service_unreachable',
      success: false,
      at,
      message: '本地服务连续三次不可访问',
    } };
  }
}

function serializableOptions(options: SoakOptions) {
  return {
    keyword: options.keyword,
    preset: options.preset,
    boardIds: options.boardIds,
    concurrency: options.concurrency,
    requestsPerSecond: options.requestsPerSecond,
    caseSensitive: options.caseSensitive,
    durationMs: options.durationMs,
    pollMs: options.pollMs,
    stallMs: options.stallMs,
    disconnectGraceMs: options.disconnectGraceMs,
    loginGraceMs: options.loginGraceMs,
    dataDir: options.dataDir,
    outputDir: options.outputDir,
    attach: options.attach,
  };
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function createSoakReporter(
  options: SoakOptions,
  environment: { sourceFiles?: string[]; extensionVersion?: string; expectedExtensionVersion?: string } = {},
) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const runDir = resolve(options.outputDir, id);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await chmod(runDir, 0o700);
  const sourceFiles = environment.sourceFiles ?? [
    'src/scanner.ts', 'src/bridge.ts', 'src/server.ts', 'extension/background.js', 'extension/protocol.js',
  ];
  const sourceHashes: Record<string, string> = {};
  for (const file of sourceFiles) {
    try {
      sourceHashes[file] = createHash('sha256').update(await readFile(resolve(projectRoot, file))).digest('hex');
    } catch { sourceHashes[file] = 'unavailable'; }
  }
  const run = {
    id,
    startedAt: new Date().toISOString(),
    options: serializableOptions(options),
    environment: {
      nodeVersion: process.version,
      extensionVersion: environment.extensionVersion,
      expectedExtensionVersion: environment.expectedExtensionVersion,
      sourceHashes,
    },
    jobId: options.attach,
  };
  const runPath = resolve(runDir, 'run.json');
  const eventsPath = resolve(runDir, 'events.ndjson');
  await atomicJson(runPath, run);
  await writeFile(eventsPath, '', { mode: 0o600 });
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
  await atomicJson(resolve(options.outputDir, 'latest.json'), { runDir, runId: id });

  return {
    runDir,
    async setEnvironment(values: { extensionVersion?: string; expectedExtensionVersion?: string }) {
      run.environment.extensionVersion = values.extensionVersion;
      run.environment.expectedExtensionVersion = values.expectedExtensionVersion;
      await atomicJson(runPath, run);
    },
    async setJob(jobId: string) {
      run.jobId = jobId;
      await atomicJson(runPath, run);
    },
    async event(value: SoakEvent) {
      await appendFile(eventsPath, JSON.stringify(value) + '\n', { mode: 0o600 });
    },
    async finish(outcome: SoakOutcome) {
      const summary = {
        runId: id,
        jobId: run.jobId,
        finishedAt: new Date(outcome.at).toISOString(),
        classification: outcome.kind,
        success: outcome.success,
        message: safeText(outcome.message) ?? '未提供诊断消息',
        snapshot: outcome.snapshot,
      };
      await atomicJson(resolve(runDir, 'summary.json'), summary);
      if (!outcome.success && !['user_stopped', 'setup_failed'].includes(outcome.kind)) {
        await atomicJson(resolve(runDir, 'incident.json'), {
          classification: outcome.kind,
          observedAt: summary.finishedAt,
          message: outcome.message,
          evidence: { run: runPath, events: eventsPath, summary: resolve(runDir, 'summary.json') },
          snapshot: outcome.snapshot,
          unverified: outcome.kind === 'stalled_unknown' ? ['底层阻塞原因'] : [],
        });
        await writeFile(resolve(runDir, 'repair-request.md'),
          `# CC98 长跑中断修复\n\n` +
          `读取 \`${resolve(runDir, 'incident.json')}\` 和 \`${eventsPath}\`，核实真实中断原因。\n` +
          `只修改有证据支持的代码，运行定向测试、\`npm run typecheck\` 和 \`npm test\`。\n` +
          `不要启动真实长跑，不要提交或发布；完成后给出本次参数对应的重跑命令。\n`,
          { mode: 0o600 });
      }
      return summary;
    },
  };
}

class LocalApi {
  constructor(private origin: string, private token: string) {}

  async request(path: string, data?: unknown) {
    const response = await fetch(`${this.origin}/api/${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (!response.ok) throw new ScanError(
      typeof result.code === 'string' ? result.code : 'HTTP',
      typeof result.error === 'string' ? result.error : `本地服务返回 HTTP ${response.status}`,
    );
    return result;
  }
}

async function localApi(dataDir: string) {
  let settings: JsonObject;
  try { settings = object(JSON.parse(await readFile(resolve(dataDir, 'server.json'), 'utf8'))); }
  catch { throw new ScanError('SETUP', '尚未启动本地服务'); }
  if (typeof settings.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.origin) ||
      typeof settings.token !== 'string' || !/^[a-f0-9]{64}$/.test(settings.token))
    throw new ScanError('SETUP', '本地服务配置无效');
  return new LocalApi(settings.origin, settings.token);
}

function active(status: string) {
  return ['running', 'waiting_connection', 'waiting_login'].includes(status);
}

export async function runSoak(
  options: SoakOptions,
  signal = new AbortController().signal,
  hooks: { onStarted?: (value: { runDir: string; jobId: string; deadline: string; attached: boolean }) => void } = {},
) {
  let reporter: Awaited<ReturnType<typeof createSoakReporter>> | undefined;
  let api: LocalApi | undefined;
  let jobId = options.attach;
  let owned = false;
  let latest: SoakSnapshot | undefined;
  let outcome: SoakOutcome | undefined;
  const startedAt = Date.now();
  try {
    reporter = await createSoakReporter(options);
    api = await localApi(options.dataDir);
    const doctor = object(await api.request('doctor'));
    if (!doctor.connection || typeof doctor.connection !== 'object')
      throw new ScanError('SETUP', '本地服务版本过旧，请先重启服务');
    const connection = object(doctor.connection);
    const manifest = object(JSON.parse(await readFile(resolve(projectRoot, 'extension/manifest.json'), 'utf8')));
    const expectedExtensionVersion = typeof manifest.version === 'string' ? manifest.version : undefined;
    const extensionVersion = typeof connection.extensionVersion === 'string' ? connection.extensionVersion : undefined;
    await reporter.setEnvironment({
      extensionVersion,
      expectedExtensionVersion,
    });
    if (!extensionVersion || extensionVersion !== expectedExtensionVersion)
      throw new ScanError('SETUP',
        `Chrome 扩展版本不匹配：当前 ${extensionVersion ?? '未知'}，需要 ${expectedExtensionVersion ?? '最新版'}，请在扩展管理页重新加载`);
    if (!options.attach) {
      if (doctor.connected !== true) throw new ScanError('SETUP', 'Chrome 扩展尚未连接');
      if (doctor.busy === true) throw new ScanError('BUSY', '已有搜索任务运行，请先等待、暂停或取消');
      const boards = options.boardIds ?? (options.preset === 'employment'
        ? [235, 459]
        : (await api.request('boards') as JsonObject[]).filter(board => board.canEntry !== false)
          .map(board => Number(board.id)));
      const search = parseOptions({
        keyword: options.keyword,
        boardIds: boards,
        concurrency: options.concurrency,
        requestsPerSecond: options.requestsPerSecond,
        caseSensitive: options.caseSensitive,
      });
      const job = object(await api.request('jobs', search));
      if (typeof job.id !== 'string' || !job.id) throw new ScanError('SCHEMA', '本地服务没有返回任务 ID');
      jobId = job.id;
      owned = true;
      await reporter.setJob(jobId);
    } else {
      await api.request(`jobs/${encodeURIComponent(options.attach)}`);
    }
    hooks.onStarted?.({
      runDir: reporter.runDir,
      jobId: jobId!,
      deadline: new Date(startedAt + options.durationMs).toISOString(),
      attached: !owned,
    });
    await reporter.event({ kind: 'started', at: startedAt,
      message: owned ? '真实搜索任务已启动' : '已附加到真实搜索任务' });
    const classifier = new SoakClassifier(options, startedAt);
    while (!outcome) {
      if (signal.aborted) {
        outcome = { kind: 'user_stopped', success: false, at: Date.now(), message: '用户终止长跑监控', snapshot: latest };
        break;
      }
      const now = Date.now();
      try {
        const [doctorState, jobState] = await Promise.all([
          api.request('doctor'),
          api.request(`jobs/${encodeURIComponent(jobId!)}`),
        ]);
        latest = safeSnapshot(doctorState, jobState, now, now - startedAt);
        const decision = classifier.observe(latest);
        for (const event of decision.events) await reporter.event(event);
        outcome = decision.terminal;
      } catch (error) {
        const decision = classifier.unavailable(now, error instanceof Error ? error.message : String(error));
        for (const event of decision.events) await reporter.event(event);
        outcome = decision.terminal;
      }
      if (!outcome) {
        try { await delay(options.pollMs, undefined, { signal }); }
        catch { outcome = { kind: 'user_stopped', success: false, at: Date.now(),
          message: '用户终止长跑监控', snapshot: latest }; }
      }
    }
  } catch (error) {
    outcome = {
      kind: 'setup_failed',
      success: false,
      at: Date.now(),
      message: error instanceof Error ? error.message : String(error),
      snapshot: latest,
    };
  } finally {
    if (owned && api && jobId && outcome?.kind !== 'completed_early') {
      try {
        const job = object(await api.request(`jobs/${encodeURIComponent(jobId)}`));
        if (typeof job.status === 'string' && active(job.status))
          await api.request(`jobs/${encodeURIComponent(jobId)}/pause`, {});
      } catch { /* 诊断摘要仍保留原始退出原因。 */ }
    }
  }
  const summary = await reporter?.finish(outcome!);
  return { ...outcome!, runDir: reporter?.runDir, summary };
}
