/* 本地服务与扩展之间只传递这些论坛资源描述，由扩展转换为固定的只读路径。 */
export type Resource =
  | { kind: 'boards' }
  | { kind: 'board' | 'pinned' | 'topic'; id: number }
  | { kind: 'topics' | 'posts'; id: number; from: number; size: number };

/* 会话只记录账号和站点，用于阻止跨账号恢复；论坛访问令牌留在浏览器中。 */
export interface Session {
  accountId: string;
  forumBase: string;
}

/* 浏览器读取结果；status=0 表示网络或页面执行失败，retryAfterMs 用于限频退避。 */
export interface Reply {
  status: number;
  data?: unknown;
  retryAfterMs?: number;
  error?: string;
}

/* 扫描器依赖的读取接口：实际运行使用 Bridge，测试使用固定数据 Fixture。 */
export interface Transport {
  /* 返回当前连接的账号与站点；未连接时返回 null。 */
  session(): Session | null;
  /* 订阅连接会话变化；返回取消订阅函数。 */
  onSession(listener: (session: Session | null) => void): () => void;
  /* 读取一个受限资源，支持取消；HTTP 状态由请求池统一判断是否重试。 */
  read(resource: Resource, signal?: AbortSignal): Promise<Reply>;
}

/* 版面目录项；详情接口还应提供用于分页的 topicCount。 */
export interface Board {
  id: number;
  name: string;
  groupName?: string;
  canEntry?: boolean;
  topicCount?: number;
}
/* 主题摘要；replyCount 不含主楼，boardId 在读取主题详情后必须有效。 */
export interface Topic { id: number; title: string; boardId?: number; replyCount: number; lastPostTime?: string }
/* 楼层号从 1 开始；contentType 为 0 时按 UBB 解析，为 1 时按 Markdown 解析。 */
export interface Post { id: number; floor: number; content: string; isDeleted: boolean; contentType?: number }
/* finished_unverified 表示已发现主题均有结论；partial 表示仍有读取问题或未处理项。 */
export type JobStatus =
  | 'running'
  | 'waiting_connection'
  | 'waiting_login'
  | 'paused'
  | 'cancelled'
  | 'finished_unverified'
  | 'partial';
/* 并发数限制同时占用的请求槽位，请求频率限制每秒启动的请求数。 */
export interface SearchOptions { keyword: string; boardIds: number[]; concurrency: number; requestsPerSecond: number; caseSensitive: boolean }
/* 每个主题仅保存首次命中及上下文片段；标题命中没有 floor 和 postId。 */
export interface Match {
  topicId: number;
  boardId: number;
  boardName: string;
  title: string;
  kind: 'title' | 'post';
  floor?: number;
  postId?: number;
  snippet: string;
  url: string;
}
/* 目录、置顶等资源的读取问题；单个主题的失败另存于 topics 表。 */
export interface Issue { resource: string; code: string; message: string }
/* 目录复查的下一读取位置；pass=2 表示两轮目录扫描均已完成。 */
export interface DirectoryCursor { pass: number; boardIndex: number; from: number }
/* 一个搜索任务的当前轮次；恢复时递增 run，历史状态和结果仍留在数据库。 */
export interface Job {
  id: string;
  run: number;
  status: JobStatus;
  desiredRunning: boolean;
  options: SearchOptions;
  session: Session;
  boards: Board[];
  startedAt: string;
  endedAt?: string;
  message?: string;
  requests: number;
  directoryPasses: number;
  directoryCursor?: DirectoryCursor;
  issues: Issue[];
  /* 动态论坛无法保证扫描期间目录或正文不变，因此不宣称完整快照。 */
  coverage: {
    directoryVerified: false;
    snapshotConsistent: false;
    note: string;
  };
}
/* pending 等待领取，working 正在读取；其余状态记录命中、无匹配、失败或超出范围。 */
export type TopicState = 'pending' | 'working' | 'matched' | 'no_match' | 'error' | 'out_of_scope';
/* 当前轮次的主题总数及各处理状态的数量。 */
export type Counts = Record<TopicState, number> & { total: number };

/* 携带业务错误码；pause=true 表示需暂停整个任务，等待登录或连接恢复。 */
export class ScanError extends Error {
  /* 保存可供接口返回的错误码、提示和暂停标志。 */
  constructor(public code: string, message: string, public pause = false) { super(message); }
}

/* 将任意异常转换成统一结构；普通异常默认记录为错误，不自动要求暂停。 */
export function errorInfo(error: unknown): { code: string; message: string; pause: boolean } {
  if (error instanceof ScanError) return error;
  return { code: 'ERROR', message: error instanceof Error ? error.message : String(error), pause: false };
}

/* 校验外部搜索参数，补上默认值并去重版面 ID；不合法时抛出 INPUT。 */
export function parseOptions(input: unknown): SearchOptions {
  if (!input || typeof input !== 'object') throw new ScanError('INPUT', '请输入搜索参数');
  const v = input as Record<string, unknown>;
  const keyword = typeof v.keyword === 'string' ? v.keyword.trim() : '';
  const boardIds = v.boardIds;
  const concurrency = v.concurrency ?? 20;
  const requestsPerSecond = v.requestsPerSecond ?? 10;
  /* 参数进入扫描器前统一限制范围，避免页面和 CLI 使用不同的边界。 */
  if (!keyword || keyword.length > 200) throw new ScanError('INPUT', '关键词长度应为 1–200');
  if (!Array.isArray(boardIds) || !boardIds.length || boardIds.length > 1000 ||
      boardIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new ScanError('INPUT', '请选择有效版面');
  if (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20)
    throw new ScanError('INPUT', '并发数应为 1–20');
  if (typeof requestsPerSecond !== 'number' || !Number.isFinite(requestsPerSecond) || requestsPerSecond < 1 || requestsPerSecond > 50)
    throw new ScanError('INPUT', '每秒请求数应为 1–50');
  if (v.caseSensitive !== undefined && typeof v.caseSensitive !== 'boolean') throw new ScanError('INPUT', '大小写选项必须是布尔值');
  return { keyword, boardIds: [...new Set(boardIds)], concurrency, requestsPerSecond, caseSensitive: v.caseSensitive === true };
}
