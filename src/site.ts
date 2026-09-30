import type { Board, Post, Topic, Resource } from './types.js';
import { ScanError } from './types.js';

/* 校验接口值为非空、非数组的对象，避免将登录页或异常响应当成论坛数据。 */
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ScanError('SCHEMA', '接口未返回预期对象');
  return v as Record<string, unknown>;
}
/* 校验安全整数和最小值；用于 ID、主题数、回复数和楼层号。 */
function integer(v: unknown, min = 0): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new ScanError('SCHEMA', '接口返回了无效数字');
  return v;
}
/* 校验必需文本字段，缺失时抛出 SCHEMA，避免被当成空内容继续扫描。 */
function text(v: unknown): string {
  if (typeof v !== 'string') throw new ScanError('SCHEMA', '接口缺少文本字段');
  return v;
}
/* 校验列表响应；格式不符时保留读取问题，不当成空列表。 */
function array(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new ScanError('SCHEMA', '接口未返回预期列表，可能已跳转登录页');
  return v;
}
/* 提取并校验版面字段；列表允许省略权限标志和主题数，详情再检查。 */
export function parseBoard(v: unknown, groupName?: string): Board {
  const b = object(v);
  return { id: integer(b.id, 1), name: text(b.name),
    groupName,
    canEntry: typeof b.canEntry === 'boolean' ? b.canEntry : undefined,
    topicCount: b.topicCount === undefined ? undefined : integer(b.topicCount) };
}
/* 提取并校验主题字段；列表允许省略所属版面，扫描前会重新读取详情。 */
export function parseTopic(v: unknown): Topic {
  const t = object(v);
  return { id: integer(t.id, 1), title: text(t.title), replyCount: integer(t.replyCount),
    boardId: t.boardId === undefined ? undefined : integer(t.boardId, 1),
    lastPostTime: typeof t.lastPostTime === 'string' ? t.lastPostTime : undefined };
}

/* 将论坛原始响应转换成扫描器使用的类型，并集中检查必需字段。 */
export class Site {
  /* 注入只读资源请求函数，使接口解析与浏览器传输、限速策略分离。 */
  constructor(private read: (r: Resource) => Promise<unknown>) {}

  /* 展开“分类 -> 版面”目录，供界面选择具体扫描范围。 */
  async boards() {
    const result: Board[] = [];
    /* 递归兼容分类节点和直接版面节点，并把最近一级分类名传给版面。 */
    const flatten = (values: unknown[], groupName?: string) => {
      for (const value of values) {
        const item = object(value);
        if (Array.isArray(item.boards)) {
          flatten(item.boards, text(item.name));
        } else {
          result.push(parseBoard(item, groupName));
        }
      }
    };
    flatten(array(await this.read({ kind: 'boards' })));
    return [...new Map(result.map(board => [board.id, board])).values()];
  }

  /* 读取版面详情，确认 ID、访问权限和主题总数可用于目录分页。 */
  async board(id: number) {
    const b = parseBoard(await this.read({ kind: 'board', id }));
    if (b.id !== id || b.topicCount === undefined) throw new ScanError('SCHEMA', '版面信息缺少主题数或 ID 不一致');
    if (b.canEntry === false) throw new ScanError('FORBIDDEN', `无权访问版面 ${b.name}`);
    return b;
  }

  /* 读取主题详情，确认 ID 和实际所属版面，避免跨版置顶扩大搜索范围。 */
  async topic(id: number) {
    const t = parseTopic(await this.read({ kind: 'topic', id }));
    if (t.id !== id || !t.boardId) throw new ScanError('SCHEMA', '主题所属版面或 ID 无效');
    return t;
  }

  /* 按主题偏移量读取一页目录；from 从 0 开始，size 由调用方指定。 */
  async topics(id: number, from: number, size: number) {
    return array(await this.read({ kind: 'topics', id, from, size })).map(parseTopic);
  }

  /* 单独读取置顶主题，随后由存储层与普通目录去重。 */
  async pinned(id: number) { return array(await this.read({ kind: 'pinned', id })).map(parseTopic); }

  /* 从指定偏移量读取最多 10 个楼层，校验楼层字段及可选的所属主题 ID。 */
  async posts(id: number, from: number): Promise<Post[]> {
    return array(await this.read({ kind: 'posts', id, from, size: 10 })).map(value => {
      const p = object(value);
      if (p.topicId !== undefined && p.topicId !== id) throw new ScanError('SCHEMA', '楼层所属主题不一致');
      /* 删除楼层可能没有正文，仍保留 ID 和楼层号供扫描器检查分页连续性。 */
      return { id: integer(p.id, 1), floor: integer(p.floor, 1), isDeleted: p.isDeleted === true,
        content: p.isDeleted === true ? '' : text(p.content),
        contentType: typeof p.contentType === 'number' ? p.contentType : undefined };
    });
  }
}
