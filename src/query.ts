import { ScanError } from './types.js';
import type { SearchQuery, QueryTerm } from './types.js';

export const facetLabels = { company: '公司', location: '地点', skill: '方向 / 技能', other: '普通词' } as const;

/* 统一字面比较规则；保留短语内部空格和标点，不做分词或语义推断。 */
export function queryKey(text: string, caseSensitive = false): string {
  const normalized = text.normalize('NFC');
  return caseSensitive ? normalized : normalized.toLowerCase();
}

/* 将外部条件复制为有界、规范化的快照，恢复任务时直接使用已保存的别名。 */
export function parseQuery(input: unknown, caseSensitive = false): SearchQuery {
  let terms = 0, length = 0;
  /* 只接受 JSON 对象，避免数组等结构绕过字段校验。 */
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScanError('INPUT', '搜索条件必须是对象');
    return value as Record<string, unknown>;
  };
  /* 两层均只允许明确的交集或并集。 */
  const operator = (value: unknown): 'and' | 'or' => {
    if (value !== 'and' && value !== 'or') throw new ScanError('INPUT', '条件关系必须为 and 或 or');
    return value;
  };
  /* 限制每个字面词以及整个表达式的开销。 */
  const text = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200)
      throw new ScanError('INPUT', '关键词或别名长度应为 1–200');
    const result = value.trim().normalize('NFC');
    length += result.length;
    if (length > 4000) throw new ScanError('INPUT', '关键词和别名的总长度不能超过 4000');
    return result;
  };
  const root = object(input);
  const relation = operator(root.operator);
  if (!Array.isArray(root.groups) || !root.groups.length || root.groups.length > 20)
    throw new ScanError('INPUT', '请提供 1–20 个非空条件组');
  const groups = root.groups.map(value => {
    const group = object(value);
    if (typeof group.facet !== 'string' || !Object.hasOwn(facetLabels, group.facet))
      throw new ScanError('INPUT', '未知分面类型');
    const relation = operator(group.operator);
    if (!Array.isArray(group.terms) || !group.terms.length || (terms += group.terms.length) > 20)
      throw new ScanError('INPUT', '请提供非空条件组，逻辑关键词总数最多 20 个');
    const unique = new Map<string, QueryTerm>();
    for (const value of group.terms) {
      const term = object(value), keyword = text(term.keyword);
      if (term.aliases !== undefined && (!Array.isArray(term.aliases) || term.aliases.length > 5))
        throw new ScanError('INPUT', '每个关键词最多 5 个别名');
      const keys = new Set([queryKey(keyword, caseSensitive)]);
      const aliases: string[] = [];
      for (const value of (term.aliases ?? []) as unknown[]) {
        const alias = text(value), key = queryKey(alias, caseSensitive);
        if (!keys.has(key)) { keys.add(key); aliases.push(alias); }
      }
      /* 完全相同的叶子条件可去重；别名不同的同名词仍是不同条件。 */
      const identity = JSON.stringify([...keys].sort());
      if (!unique.has(identity)) unique.set(identity, { keyword, ...(aliases.length ? { aliases } : {}) });
    }
    return { facet: group.facet as keyof typeof facetLabels, operator: relation, terms: [...unique.values()] };
  });
  return { operator: relation, groups };
}

/* 用带引号的字面词显示实际逻辑，别名始终用 OR，与两层组关系分开。 */
export function formatQuery(query: SearchQuery): string {
  return query.groups.map(group => `(${group.terms.map(term => {
    const words = [term.keyword, ...(term.aliases ?? [])].map(word => JSON.stringify(word));
    return words.length > 1 ? `(${words.join(' OR ')})` : words[0];
  }).join(group.operator === 'and' ? ' AND ' : ' OR ')})`).join(query.operator === 'and' ? ' AND ' : ' OR ');
}
