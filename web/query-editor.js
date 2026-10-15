const facets = { company: '公司', location: '地点', skill: '方向 / 技能', other: '普通词' };

/* 创建普通 DOM 元素；用户提供的词只进入 textContent 或表单 value。 */
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/* 为动态表单添加可访问名称，不依赖占位文字来说明字段含义。 */
function field(label, control) {
  const wrapper = element('label', label);
  wrapper.append(control);
  return wrapper;
}

/* 构建有明确取值的选择控件。 */
function select(options, value, change) {
  const node = element('select');
  for (const [key, label] of Object.entries(options)) node.add(new Option(label, key));
  node.value = value;
  node.addEventListener('change', () => change(node.value));
  return node;
}

/* 构建不会提交外层搜索表单的编辑按钮。 */
function button(text, action) {
  const node = element('button', text, 'secondary');
  node.type = 'button'; node.addEventListener('click', action);
  return node;
}

/* 编辑器持有任务创建前的草稿；生成建议不会自动开始搜索。 */
export class QueryEditor {
  query = { operator: 'and', groups: [] };
  source = '';

  /* 绑定模式、建议和组间关系；原关键词输入在单词模式下保持原义。 */
  constructor(api, guarded) {
    this.$ = id => document.getElementById(id);
    this.$('queryMode').addEventListener('change', () => this.modeChanged());
    this.$('queryText').addEventListener('input', () => this.preview());
    this.$('groupOperator').addEventListener('change', () => {
      this.query.operator = this.$('groupOperator').value; this.preview();
    });
    this.$('suggestQuery').addEventListener('click', guarded(async () => {
      const text = this.$('queryText').value;
      this.$('suggestQuery').disabled = true;
      try {
        const suggestion = await api('query/suggest', { text, caseSensitive: this.$('caseSensitive').checked });
        /* 请求期间若草稿又变了，不用旧响应覆盖新输入。 */
        if (this.$('queryText').value !== text) throw new Error('输入已改变，请重新生成分组');
        this.query = suggestion.query; this.source = text;
        this.$('groupOperator').value = this.query.operator;
        this.$('suggestionHint').textContent = suggestion.unknownTerms.length
          ? `未识别的短语已保留在普通词组：${suggestion.unknownTerms.join('、')}。请检查组内关系。`
          : '已按词典分组。请检查简称、别名和各组关系，可直接修改。';
        this.render();
      } finally { this.$('suggestQuery').disabled = false; }
    }));
    this.$('addGroup').addEventListener('click', () => {
      this.query.groups.push({ facet: 'other', operator: 'or', terms: [{ keyword: '' }] }); this.render();
    });
    this.modeChanged();
  }

  /* 关闭另一模式的原生表单校验，切回时保留各自草稿。 */
  modeChanged() {
    const combined = this.$('queryMode').value === 'query';
    this.$('keywordPanel').hidden = combined;
    this.$('keyword').disabled = combined;
    this.$('queryPanel').hidden = !combined;
    this.$('queryPanel').disabled = !combined;
    this.preview();
  }

  /* 显式展示带括号的完整条件；别名永远为 OR，避免用户误读组内 AND。 */
  preview() {
    const quote = value => JSON.stringify(value.trim() || '待填写');
    this.$('queryPreview').textContent = this.query.groups.length ? this.query.groups.map(group =>
      `(${group.terms.map(term => {
        const words = [term.keyword, ...(term.aliases ?? [])].map(quote);
        return words.length > 1 ? `(${words.join(' OR ')})` : words[0];
      }).join(group.operator === 'and' ? ' AND ' : ' OR ')})`
    ).join(this.query.operator === 'and' ? ' AND ' : ' OR ') : '生成建议或手动添加条件组。';
    this.$('queryStale').hidden = this.$('queryText').value === this.source;
    const count = this.query.groups.reduce((sum, group) => sum + group.terms.length, 0);
    this.$('addGroup').disabled = count >= 20;
    for (const control of this.$('queryGroups').querySelectorAll('[data-add-term]')) control.disabled = count >= 20;
  }

  /* 结构修改时重画条件组；输入词时仅刷新预览，保留焦点和输入法状态。 */
  render() {
    const container = this.$('queryGroups');
    container.replaceChildren();
    this.query.groups.forEach((group, groupIndex) => {
      const box = element('section', undefined, 'query-group');
      const title = element('div', undefined, 'query-group-title');
      title.append(element('strong', `条件组 ${groupIndex + 1}`), button('删除组', () => {
        this.query.groups.splice(groupIndex, 1); this.render();
      }));
      const controls = element('div', undefined, 'query-controls');
      controls.append(field('分面', select(facets, group.facet, value => { group.facet = value; })),
        field('组内关系', select({ or: '任一满足 OR（并集）', and: '全部满足 AND（交集）' }, group.operator,
          value => { group.operator = value; this.preview(); })));
      box.append(title, controls);
      group.terms.forEach((term, termIndex) => {
        const row = element('div', undefined, 'query-term');
        const keyword = element('input');
        keyword.value = term.keyword; keyword.required = true; keyword.maxLength = 200;
        keyword.addEventListener('input', () => { term.keyword = keyword.value; this.preview(); });
        const aliases = element('textarea');
        aliases.rows = 2; aliases.value = (term.aliases ?? []).join('\n'); aliases.placeholder = '可留空，每行一个，最多 5 个';
        aliases.addEventListener('input', () => {
          term.aliases = aliases.value.split('\n').map(word => word.trim()).filter(Boolean); this.preview();
        });
        row.append(field(`关键词 ${termIndex + 1}`, keyword), field('等价别名（任一命中即可）', aliases),
          button('删除词', () => { group.terms.splice(termIndex, 1); this.render(); }));
        box.append(row);
      });
      const add = button('＋ 添加关键词', () => { group.terms.push({ keyword: '' }); this.render(); });
      add.dataset.addTerm = '1'; box.append(add); container.append(box);
    });
    this.preview();
  }

  /* 创建任务时读取当前显式条件，阻止悄悄提交与新词列表不一致的旧分组。 */
  payload() {
    if (this.$('queryMode').value !== 'query') return { keyword: this.$('keyword').value };
    if (this.$('queryText').value !== this.source) throw new Error('词列表已修改，请点击「生成分组」后再搜索');
    if (!this.query.groups.length || this.query.groups.some(group => !group.terms.length))
      throw new Error('请为每个条件组添加关键词，或删除空组');
    return { query: this.query };
  }
}
