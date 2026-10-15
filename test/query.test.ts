import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, type SearchQuery } from '../src/types.js';
import { parseQuery, formatQuery } from '../src/query.js';
import { suggestQuery } from '../src/dictionary.js';
import { compileQuery } from '../src/matcher.js';

/* 构造同组条件，测试数据中的词完全按字面匹配。 */
function query(operator: 'and' | 'or', ...words: string[]): SearchQuery {
  return { operator: 'and', groups: [{ facet: 'other', operator, terms: words.map(keyword => ({ keyword })) }] };
}

/* 不改变既有 keyword-only 请求的序列化形状。 */
test('旧单关键词保持原义，新查询有独立快照和可读描述', () => {
  const legacy = parseOptions({ keyword: ' Linux, C++ ', boardIds: [235, 235] });
  assert.deepEqual(legacy, { keyword: 'Linux, C++', boardIds: [235], concurrency: 20, requestsPerSecond: 10, caseSensitive: false });
  const input = query('and', 'Linux', 'C++');
  const options = parseOptions({ query: input, boardIds: [235] });
  input.groups[0]!.terms[0]!.keyword = 'changed';
  assert.equal(options.keyword, '("Linux" AND "C++")');
  assert.equal(options.query!.groups[0]!.terms[0]!.keyword, 'Linux');
  assert.throws(() => parseOptions({ query: input, keyword: 'Linux', boardIds: [235] }), /只能提供一个/);
});

/* 所有数组和文本入口都有界，防止一份查询引入无界匹配开销。 */
test('拒绝空条件、错误关系和超限的词与别名', () => {
  const invalid: unknown[] = [null, [], {}, { ...query('and', 'x'), operator: 'not' },
    query('and'), query('or', ''), query('or', 'x'.repeat(201)), query('or', ...Array(21).fill('x')),
    { operator: 'and', groups: [{ facet: 'bad', operator: 'or', terms: [{ keyword: 'x' }] }] },
    { operator: 'and', groups: [{ facet: 'other', operator: 'not', terms: [{ keyword: 'x' }] }] },
    { operator: 'and', groups: [{ facet: 'other', operator: 'or', terms: [{ keyword: 'x', aliases: ['', 'a'] }] }] },
    { operator: 'and', groups: [{ facet: 'other', operator: 'or', terms: [{ keyword: 'x', aliases: Array(6).fill('a') }] }] },
    { operator: 'and', groups: [{ facet: 'other', operator: 'or', terms: [{ keyword: 'x', aliases: 'a' }] }] },
    { operator: 'and', groups: [{ facet: 'other', operator: 'or', terms: Array.from({ length: 20 }, () => ({ keyword: 'x'.repeat(200), aliases: ['a'] })) }] },
  ];
  for (const value of invalid) assert.throws(() => parseQuery(value), { code: 'INPUT' });
  assert.throws(() => suggestQuery({ text: ' , ， ; ' }), { code: 'INPUT' });
  assert.throws(() => suggestQuery({ text: 'Linux', caseSensitive: 'yes' }), { code: 'INPUT' });
});

/* 等价 Unicode 和大小写去重不改变词内部空格、标点。 */
test('规范化去重保留 C++ 和未知英文短语', () => {
  const value = parseQuery({ operator: 'and', groups: [{ facet: 'other', operator: 'and', terms: [
    { keyword: ' Café ', aliases: ['cafe\u0301', 'CAFE', 'cafe'] }, { keyword: 'café', aliases: ['CAFE'] },
    { keyword: 'C++' }, { keyword: 'machine  learning' },
  ] }] });
  assert.deepEqual(value.groups[0]!.terms, [{ keyword: 'Café', aliases: ['CAFE'] }, { keyword: 'C++' }, { keyword: 'machine  learning' }]);
  assert.equal(parseQuery(query('and', 'Linux', 'linux'), true).groups[0]!.terms.length, 2);
  assert.match(formatQuery(value), /machine  learning/);
});

/* 建议只用明确别名，不把相关技术混成一个逻辑词。 */
test('词典建议同分面 OR、跨分面 AND，保留未知文本', () => {
  const value = suggestQuery({ text: 'ByteDance 阿里 杭州 Linux C++，machine learning；某家新公司\nAndroid' });
  assert.equal(value.query.operator, 'and');
  assert.deepEqual(value.query.groups.map(g => [g.facet, g.operator, g.terms.map(t => t.keyword)]), [
    ['company', 'or', ['字节跳动', '阿里巴巴']], ['location', 'or', ['杭州']],
    ['skill', 'or', ['Linux', 'C++', 'Android']], ['other', 'or', ['machine learning', '某家新公司']],
  ]);
  assert.deepEqual(value.unknownTerms, ['machine learning', '某家新公司']);
  assert.deepEqual(value.query.groups[2]!.terms[0], { keyword: 'Linux' });
  assert.deepEqual(suggestQuery({ text: 'JavaScript Java' }).query.groups[0]!.terms.map(t => t.keyword), ['JavaScript', 'Java']);
  assert.deepEqual(suggestQuery({ text: '想去杭州工作' }).unknownTerms, ['想去杭州工作']);
});

/* 全部分面和组内关系组合均以独立的真值表作为预期。 */
test('两层布尔逻辑满足真值表，别名始终折叠为 OR', () => {
  for (const outer of ['and', 'or'] as const) for (const inner of ['and', 'or'] as const) {
    const expression: SearchQuery = { operator: outer, groups: [
      { facet: 'company', operator: inner, terms: [{ keyword: '甲', aliases: ['alpha'] }, { keyword: '乙' }] },
      { facet: 'location', operator: 'or', terms: [{ keyword: '杭州' }] },
    ] };
    const compiled = compileQuery({ keyword: '', query: expression, caseSensitive: false });
    for (let mask = 0; mask < 8; mask++) {
      const state = compiled.createState();
      ['alpha', '乙', '杭州'].forEach((text, index) => { if (mask & (1 << index)) state.feed(text, 'plain'); });
      const first = inner === 'and' ? (mask & 3) === 3 : !!(mask & 3);
      const second = !!(mask & 4);
      assert.equal(state.satisfied(), outer === 'and' ? first && second : first || second, `${outer}/${inner}/${mask}`);
    }
  }
});

/* 不重置同帖状态，但必须隔离不同主题；所有未命中的叶子都检查一次。 */
test('跨片段累计，包含关系、格式和大小写均为字面匹配', () => {
  const compiled = compileQuery({ keyword: '', query: query('and', 'Java', 'JavaScript', 'C++', 'Café'), caseSensitive: false });
  const state = compiled.createState();
  assert.equal(state.feed('[b]JavaScript[/b]', 'ubb').length, 2);
  assert.equal(state.satisfied(), false);
  assert.equal(state.feed('[img]C++[/img]', 'ubb').length, 0);
  assert.equal(state.feed('[link](https://x/C++) <script>C++</script>', 'markdown').length, 0);
  assert.equal(state.feed('**C++** cafe\u0301', 'markdown').length, 2);
  assert.equal(state.satisfied(), true);
  assert.equal(state.feed('JavaScript C++ Café', 'plain').length, 0);
  assert.equal(compiled.createState().satisfied(), false);
  const sensitive = compileQuery({ keyword: '', query: query('and', 'Linux'), caseSensitive: true }).createState();
  assert.equal(sensitive.feed('linux', 'plain').length, 0);
  assert.equal(sensitive.feed('Linux', 'plain').length, 1);
});
