import { ScanError } from './types.js';
import type { SearchQuery } from './types.js';
import { formatQuery, parseQuery, queryKey } from './query.js';

/* 词典只收等价叫法，不把相关技术、子品牌或业务领域扩展成同义词。 */
export const dictionary: readonly { facet: SearchQuery['groups'][number]['facet']; keyword: string; aliases: readonly string[] }[] = [
  { facet: 'company', keyword: '字节跳动', aliases: ['字节', 'ByteDance'] },
  { facet: 'company', keyword: '阿里巴巴', aliases: ['阿里', 'Alibaba'] },
  { facet: 'company', keyword: '腾讯', aliases: ['Tencent'] },
  { facet: 'company', keyword: '华为', aliases: ['Huawei'] },
  { facet: 'company', keyword: '网易', aliases: ['NetEase'] },
  { facet: 'company', keyword: '百度', aliases: ['Baidu'] },
  { facet: 'company', keyword: '美团', aliases: ['Meituan'] },
  { facet: 'company', keyword: '微软', aliases: ['Microsoft'] },
  { facet: 'location', keyword: '杭州', aliases: ['Hangzhou'] },
  { facet: 'location', keyword: '北京', aliases: ['Beijing'] },
  { facet: 'location', keyword: '上海', aliases: ['Shanghai'] },
  { facet: 'location', keyword: '深圳', aliases: ['Shenzhen'] },
  { facet: 'location', keyword: '广州', aliases: ['Guangzhou'] },
  { facet: 'location', keyword: '成都', aliases: ['Chengdu'] },
  { facet: 'location', keyword: '南京', aliases: ['Nanjing'] },
  { facet: 'skill', keyword: 'Android', aliases: ['安卓'] },
  { facet: 'skill', keyword: 'Linux', aliases: [] },
  { facet: 'skill', keyword: 'C++', aliases: [] },
  { facet: 'skill', keyword: 'Java', aliases: [] },
  { facet: 'skill', keyword: 'Python', aliases: [] },
  { facet: 'skill', keyword: 'JavaScript', aliases: ['JS'] },
  { facet: 'skill', keyword: 'TypeScript', aliases: ['TS'] },
  { facet: 'skill', keyword: 'iOS', aliases: [] },
  { facet: 'skill', keyword: '前端', aliases: [] },
  { facet: 'skill', keyword: '后端', aliases: [] },
  { facet: 'skill', keyword: '嵌入式', aliases: [] },
];

/* 按显式分隔符和已知词给出建议；未知连续短语保留原文，由用户确认关系。 */
export function suggestQuery(input: unknown): { query: SearchQuery; description: string; unknownTerms: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ScanError('INPUT', '请输入词列表');
  const { text, caseSensitive } = input as Record<string, unknown>;
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new ScanError('INPUT', '词列表长度应为 1–4000');
  if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') throw new ScanError('INPUT', '大小写选项必须是布尔值');
  const lookup = new Map(dictionary.flatMap(entry => [entry.keyword, ...entry.aliases].map(word => [queryKey(word), entry] as const)));
  const groups: SearchQuery['groups'] = [], unknownTerms: string[] = [];
  /* 添加完整逻辑词和显式别名；同分面只创建一组。 */
  const add = (word: string) => {
    const entry = lookup.get(queryKey(word));
    const facet = entry?.facet ?? 'other';
    let group = groups.find(group => group.facet === facet);
    if (!group) { group = { facet, operator: 'or', terms: [] }; groups.push(group); }
    const keyword = entry?.keyword ?? word;
    if (!group.terms.some(term => queryKey(term.keyword, caseSensitive === true) === queryKey(keyword, caseSensitive === true)))
      group.terms.push({ keyword, ...(entry?.aliases.length ? { aliases: [...entry.aliases] } : {}) });
    if (!entry && !unknownTerms.includes(word)) unknownTerms.push(word);
  };
  for (const chunk of text.trim().split(/[,，、;；\r\n]+/).map(part => part.trim()).filter(Boolean)) {
    const tokens = [...chunk.matchAll(/\S+/g)];
    let unknownStart: number | undefined;
    for (const token of tokens) {
      if (lookup.has(queryKey(token[0]))) {
        if (unknownStart !== undefined) { add(chunk.slice(unknownStart, token.index).trim()); unknownStart = undefined; }
        add(token[0]);
      } else unknownStart ??= token.index;
    }
    if (unknownStart !== undefined) add(chunk.slice(unknownStart));
  }
  const query = parseQuery({ operator: 'and', groups }, caseSensitive === true);
  return { query, description: formatQuery(query), unknownTerms };
}
