import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const defaults = fileURLToPath(new URL('../.cc98', import.meta.url));

/* CLI 的标准输出始终为 JSON，便于 Aime 或其他脚本稳定解析。 */
const output = (v: unknown) => console.log(JSON.stringify(v, null, 2));

/* 解析命令行，启动本地服务或通过 server.json 调用已运行的 HTTP API。 */
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' }, 'data-dir': { type: 'string' }, boards: { type: 'string' },
      preset: { type: 'string' }, concurrency: { type: 'string' }, rate: { type: 'string' },
      from: { type: 'string' }, limit: { type: 'string' }, topics: { type: 'string' },
      'case-sensitive': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const [command, argument] = positionals;
  const dataDir = resolve(values['data-dir'] ?? defaults);
  if (command === 'start') {
    const port = Number(values.port ?? 9876);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口范围为 1024–65535');
    const { startServer } = await import('./server.js');
    const app = await startServer({ port, dataDir });
    output({ status: 'listening', url: app.origin, instruction: '打开本地页面，按连接指引加载 Chrome 扩展' });
    let closing = false;
    /* 防止 SIGINT 和 SIGTERM 重复触发关闭流程。 */
    const stop = async () => { if (closing) return; closing = true; await app.close(); };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
    return;
  }
  if (!command || values.help) {
    output({ commands: ['start [--port 9876]', 'doctor', 'boards', 'search "关键词" --preset employment [--concurrency 20]',
      'search "关键词" --boards 235,459 [--rate 10] [--case-sensitive]', 'search "关键词" --preset all',
      'status [任务ID]', 'results 任务ID [--from 0 --limit 100]', 'export 任务ID',
      'pause 任务ID', 'cancel 任务ID', 'resume 任务ID [--topics 5557650]', 'history 任务ID'], dataDir });
    return;
  }
  let settings: { origin: string; token: string };
  try { settings = JSON.parse(await readFile(resolve(dataDir, 'server.json'), 'utf8')); }
  catch { throw new Error('尚未启动服务，请先运行 npm start'); }
  /* 只接受服务写出的本机环回地址，避免配置文件被替换后向外部发送配对码。 */
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.origin)) throw new Error('本地服务地址无效');

  /* 调用本地 API；有 data 时使用 POST，否则使用 GET，并统一处理超时和错误响应。 */
  async function request(path: string, data?: unknown) {
    let response: Response;
    try {
      response = await fetch(settings.origin + '/api/' + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(60000),
      });
    } catch { throw new Error('无法连接本地服务，请检查 npm start 是否仍在运行'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  }
  if (command === 'doctor' || command === 'boards') return output(await request(command));
  if (command === 'status') return output(await request(argument ? `jobs/${encodeURIComponent(argument)}` : 'jobs'));
  if (command === 'search') {
    let boardIds: number[];
    /* 自定义版面优先，其次是全部可访问版面，默认使用就业组合。 */
    if (values.boards) boardIds = values.boards.split(',').map(Number);
    else if (values.preset === 'all') boardIds = (await request('boards')).filter((b: { canEntry?: boolean }) => b.canEntry !== false).map((b: { id: number }) => b.id);
    else if (!values.preset || values.preset === 'employment') boardIds = [235, 459];
    else throw new Error('版面预设仅支持 employment 或 all');
    return output(await request('jobs', { keyword: argument, boardIds, concurrency: Number(values.concurrency ?? 20),
      requestsPerSecond: Number(values.rate ?? 10), caseSensitive: values['case-sensitive'] ?? false }));
  }
  if (['results', 'export', 'cancel', 'pause', 'resume', 'history'].includes(command)) {
    if (!argument) throw new Error('请提供任务 ID');
    let path = `jobs/${encodeURIComponent(argument)}/${command}`;
    if (command === 'results') path += `?from=${encodeURIComponent(values.from ?? '0')}&limit=${encodeURIComponent(values.limit ?? '100')}`;
    let data: unknown;
    if (command === 'cancel' || command === 'pause') data = {};
    if (command === 'resume') data = values.topics
      ? { topicIds: values.topics.split(',').map(Number) }
      : {};
    return output(await request(path, data));
  }
  throw new Error(`未知命令：${command}`);
}

/* 所有失败也写成 JSON 并设置退出码 1，不向标准输出混入堆栈。 */
main().catch(error => {
  output({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
