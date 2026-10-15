import { QueryEditor } from './query-editor.js';

/* 按元素 ID 获取页面控件。 */
const $ = id => document.getElementById(id);
let token, boards = [], selected = new Set([235, 459]), jobId = '', shown = 100, previousConnected = false, pollingError;
const activeStatuses = new Set(['running', 'waiting_connection', 'waiting_login']);
const labels = {
  running: '扫描中',
  waiting_connection: '等待扩展',
  waiting_login: '等待登录',
  paused: '已暂停',
  cancelled: '已取消',
  finished_unverified: '扫描结束 · 覆盖未验证',
  partial: '扫描结束 · 有读取问题',
};

/* 显示或清空页面顶部错误信息。 */
const notice = error => { $('notice').textContent = error?.message || String(error || ''); $('notice').hidden = !error; };

/* 使用页面启动时取得的本地凭据调用 API，并将失败转换为异常。 */
async function api(path, data) {
  const response = await fetch(`/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

/* 包装异步事件处理器，统一清空旧错误并显示新错误。 */
function guarded(fn) { return async event => { try { notice(null); await fn(event); } catch (error) { notice(error); } }; }

const queryEditor = new QueryEditor(api, guarded);

/* 根据筛选词和当前选择集合重绘版面复选框列表。 */
function drawBoards() {
  const filter = $('boardFilter').value.trim().toLowerCase();
  $('boards').replaceChildren();
  for (const board of boards.filter(b => `${b.name} ${b.id}`.toLowerCase().includes(filter))) {
    const label = document.createElement('label');
    label.className = 'board-option';
    const check = document.createElement('input');
    check.type = 'checkbox'; check.checked = selected.has(board.id); check.disabled = board.canEntry === false;
    /* 选择集合是搜索范围的唯一状态，重绘不会丢失未被筛选词显示的选项。 */
    check.addEventListener('change', () => { check.checked ? selected.add(board.id) : selected.delete(board.id); scopeHint(); });
    const name = document.createElement('span'); name.textContent = board.name;
    const id = document.createElement('small'); id.textContent = board.groupName ? `${board.groupName} · ${board.id}` : String(board.id);
    label.append(check, name, id); $('boards').append(label);
  }
  if (!boards.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '连接 Chrome 后点击「刷新版面」。'; $('boards').append(p); }
  scopeHint();
}

/* 汇总当前选中版面名称，明确展示实际搜索范围。 */
function scopeHint() {
  const actual = boards.filter(b => selected.has(b.id)).map(b => b.name);
  $('scopeHint').textContent = actual.length ? `已选 ${actual.length} 个版面：${actual.join('、')}` : '请选择版面。就业组合只包含求职广场、实习兼职。';
}

/* 从论坛刷新版面目录，并移除已经不可见或不可访问的旧选择。 */
async function loadBoards() {
  boards = await api('boards');
  selected = new Set([...selected].filter(id => boards.some(b => b.id === id && b.canEntry !== false)));
  drawBoards();
}

/* 读取当前任务及一页结果，刷新状态、计数、问题项和命中列表。 */
async function drawJob() {
  $('empty').hidden = !!jobId; $('jobPanel').hidden = !jobId;
  if (!jobId) return;
  const result = await api(`jobs/${jobId}/results?limit=${shown}`);
  const job = result.job, counts = job.counts;
  $('jobState').textContent = labels[job.status] || job.status;
  $('jobState').classList.toggle('waiting', job.status === 'waiting_connection' || job.status === 'waiting_login');
  $('jobQuery').textContent = `「${job.options.keyword}」`;
  $('jobScope').textContent = `范围：${job.boards.map(b => `${b.name} (${b.id})`).join('、')} · 并发 ${job.options.concurrency}`;
  $('matched').textContent = counts.matched;
  $('processed').textContent = counts.matched + counts.no_match + counts.out_of_scope;
  $('pending').textContent = counts.pending + counts.working;
  $('failed').textContent = counts.error + job.issues.length;
  const cursor = job.directoryCursor;
  const cursorBoard = cursor?.pass < 2 ? job.boards[cursor.boardIndex] : undefined;
  const directory = cursorBoard
    ? `目录第 ${cursor.pass + 1}/2 遍：${cursorBoard.name} ${cursor.from}/${cursorBoard.topicCount ?? '?'}`
    : `目录复查 ${job.directoryPasses}/2`;
  const activity = job.message || (cursorBoard && counts.pending + counts.working === 0 ? '正在读取目录' : '正在读取主题');
  $('progress').textContent = `已发现 ${counts.total} 个主题 · ${directory} · 请求 ${job.requests} 次 · ${activity}`;
  $('coverage').textContent = job.coverage.note;
  const active = activeStatuses.has(job.status);
  $('pause').hidden = !active; $('cancel').hidden = !active;
  $('resume').hidden = active;
  const issues = [...job.issues.map(i => `${i.resource}：${i.message}`), ...job.failures.map(f => `主题 ${f.topicId}：${f.error}`)];
  $('failurePanel').hidden = !issues.length;
  $('failures').replaceChildren(...issues.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  $('results').replaceChildren();
  for (const hit of result.results) {
    /* 全部论坛数据使用 textContent 输出，链接只接受服务端生成的 HTTPS 地址。 */
    const article = document.createElement('article'); article.className = 'result';
    const meta = document.createElement('div'); meta.className = 'result-meta';
    meta.textContent = `${hit.boardName} / ${hit.kind === 'title' ? '标题命中' : `第 ${hit.floor} 楼命中`} / #${hit.topicId}`;
    const heading = document.createElement('h3'), link = document.createElement('a');
    const url = new URL(hit.url);
    if (url.protocol === 'https:') link.href = url.href;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = hit.title; heading.append(link);
    article.append(meta, heading);
    if (hit.evidence) {
      const hint = document.createElement('p'); hint.className = 'muted';
      hint.textContent = '已确认的命中证据（满足条件后停止读取）'; article.append(hint);
      for (const evidence of hit.evidence) {
        const item = document.createElement('div'); item.className = 'evidence';
        const source = document.createElement('a'), snippet = document.createElement('p');
        const url = new URL(evidence.url);
        if (url.protocol === 'https:') source.href = url.href;
        source.target = '_blank'; source.rel = 'noopener noreferrer';
        source.textContent = `组 ${evidence.groupIndex + 1} · ${evidence.keyword}${evidence.matchedKeyword !== evidence.keyword ? `（命中 ${evidence.matchedKeyword}）` : ''} · ${evidence.kind === 'title' ? '标题' : `第 ${evidence.floor} 楼`}`;
        snippet.textContent = evidence.snippet; item.append(source, snippet); article.append(item);
      }
    } else {
      const snippet = document.createElement('p'); snippet.textContent = hit.snippet; article.append(snippet);
    }
    $('results').append(article);
  }
  $('noResults').textContent = result.total ? `显示 ${result.results.length} / ${result.total} 条结果` :
    active ? '暂未发现匹配，任务仍在运行。' : '当前没有已确认的命中；请结合覆盖说明和读取问题判断。';
  $('more').hidden = result.results.length >= result.total || shown >= 1000;
  if (result.total > 1000) $('noResults').textContent += '。完整结果请导出 JSON。';
}

/* 刷新连接状态和任务列表，并在首次连上 Chrome 时自动加载版面。 */
async function refresh() {
  const doctor = await api('doctor');
  $('connection').textContent = doctor.connected ? 'Chrome 已连接' : '等待扩展自动连接';
  $('connection').classList.toggle('connected', doctor.connected);
  $('setupHint').textContent = doctor.connected ? '已连接，可直接搜索' : '打开已登录的 CC98 即可自动连接';
  $('start').disabled = !doctor.connected || doctor.busy;
  $('refreshBoards').disabled = !doctor.connected || doctor.busy;
  if (doctor.connected && !previousConnected) {
    $('setup').open = false;
    if (!doctor.busy) await loadBoards();
  }
  previousConnected = doctor.connected;
  const jobs = await api('jobs');
  if (!jobId || !jobs.some(j => j.id === jobId)) jobId = jobs[0]?.id || '';
  $('jobSelect').replaceChildren();
  if (!jobs.length) $('jobSelect').add(new Option('暂无任务', ''));
  for (const job of jobs) $('jobSelect').add(new Option(`${job.options.keyword} · ${labels[job.status]}`, job.id));
  $('jobSelect').value = jobId;
  await drawJob();
}

/* 提交搜索参数并切换到新任务；失败时恢复开始按钮。 */
$('searchForm').addEventListener('submit', guarded(async event => {
  event.preventDefault();
  $('start').disabled = true;
  try {
    const job = await api('jobs', { ...queryEditor.payload(), boardIds: [...selected],
      concurrency: Number($('concurrency').value), requestsPerSecond: Number($('rate').value), caseSensitive: $('caseSensitive').checked });
    jobId = job.id; shown = 100;
    await refresh();
  } catch (error) {
    $('start').disabled = false;
    throw error;
  }
}));

/* 版面刷新、筛选和三个快捷选择操作。 */
$('refreshBoards').addEventListener('click', guarded(loadBoards));
$('boardFilter').addEventListener('input', drawBoards);
$('employment').addEventListener('click', () => { selected = new Set([235, 459].filter(id => boards.some(b => b.id === id && b.canEntry !== false))); drawBoards(); });
$('allBoards').addEventListener('click', () => { selected = new Set(boards.filter(b => b.canEntry !== false).map(b => b.id)); drawBoards(); });
$('clearBoards').addEventListener('click', () => { selected.clear(); drawBoards(); });

/* 切换历史任务时回到前 100 条，并重新绘制任务详情。 */
$('jobSelect').addEventListener('change', guarded(async () => { jobId = $('jobSelect').value; shown = 100; await drawJob(); }));

/* 暂停、取消和恢复共用同一任务控制接口。 */
for (const action of ['pause', 'cancel', 'resume']) $(action).addEventListener('click', guarded(async () => {
  await api(`jobs/${jobId}/${action}`, {}); shown = 100; await refresh();
}));

/* 每次多显示 100 条，页面最多渲染 1000 条，更多结果通过导出获取。 */
$('more').addEventListener('click', guarded(async () => { shown = Math.min(1000, shown + 100); await drawJob(); }));

/* 获取完整结果并生成临时 Blob 下载，不在服务端额外写导出文件。 */
$('export').addEventListener('click', guarded(async () => {
  const data = await api(`jobs/${jobId}/export`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `cc98-${jobId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}));

/* 每两秒轮询连接和任务进度；单次失败只提示，不终止后续轮询。 */
async function poll() {
  try {
    await refresh();
    /* 自动恢复后清除这次轮询留下的错误，保留用户操作产生的其他提示。 */
    if (pollingError && $('notice').textContent === pollingError.message) notice(null);
    pollingError = null;
  } catch (error) { pollingError = error; notice(error); }
  setTimeout(poll, 2000);
}

/* 仅从同源 bootstrap 接口取得本地凭据；凭据不显示在页面中。 */
try {
  const response = await fetch('/api/bootstrap', { headers: { 'X-CC98-UI': '1' } });
  if (!response.ok) throw new Error('初始化失败，请双击启动文件重新打开搜索页');
  token = (await response.json()).token;
  await poll();
} catch (error) { notice(error); }
