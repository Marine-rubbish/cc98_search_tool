import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Bridge, sameSecret } from './bridge.js';
import { Store } from './store.js';
import { Scanner } from './scanner.js';
import { parseOptions, errorInfo, ScanError } from './types.js';
import type { Transport } from './types.js';

const root = fileURLToPath(new URL('../', import.meta.url));

/* 读取最多 16 KiB 的 JSON 请求体；空请求按空对象处理。 */
async function body(req: IncomingMessage): Promise<unknown> {
  let content = '';
  for await (const chunk of req) {
    content += chunk;
    if (content.length > 16384) throw new ScanError('INPUT', '请求内容过长');
  }
  try { return JSON.parse(content || '{}'); }
  catch { throw new ScanError('INPUT', '请求内容不是有效 JSON'); }
}

/* 解析非负整数分页参数，并限制最大值，缺失时使用默认值。 */
function numberParam(value: string | null, fallback: number, max: number) {
  const n = value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new ScanError('INPUT', '无效分页参数');
  return n;
}

/* 恢复请求可选指定主题列表；不指定时恢复所有未完成项。 */
function resumeTopicIds(input: unknown): number[] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ScanError('INPUT', '恢复参数无效');
  const value = (input as Record<string, unknown>).topicIds;
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length || value.length > 100 ||
      value.some(id => !Number.isSafeInteger(id) || Number(id) <= 0))
    throw new ScanError('INPUT', 'topicIds 应为 1–100 个有效主题 ID');
  return [...new Set(value as number[])];
}

/*
 * 启动仅监听 127.0.0.1 的本地服务，组合 HTTP API、静态页面、扫描器和扩展桥。
 * 测试可注入 Transport 和配对码；实际运行使用 Bridge 与持久化数据目录。
 */
export async function startServer(options: { port?: number; dataDir?: string; transport?: Transport; token?: string } = {}) {
  const dataDir = resolve(options.dataDir ?? resolve(root, '.cc98'));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  let token = options.token;
  if (!token) {
    /* 首次运行没有配对码文件，后续逻辑会生成新值。 */
    try { token = (await readFile(resolve(dataDir, 'pairing-key'), 'utf8')).trim(); } catch { /* 首次运行。 */ }
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      /* 配对码只写入用户可读文件，避免其他本机账号直接调用接口。 */
      token = randomBytes(32).toString('hex');
      await writeFile(resolve(dataDir, 'pairing-key'), token, { mode: 0o600 });
    }
  }
  const secret = token;
  let store: Store;
  let origin = '';
  let scanner: Scanner;
  const server = createServer((req, res) => { void handle(req, res); });
  const bridge = new Bridge(server, secret);
  const transport = options.transport ?? bridge;

  /* 为任务详情补充当前轮次计数和主题级失败项。 */
  const summary = (id: string) => {
    const job = store.get(id);
    return { ...job, counts: store.counts(job), failures: store.failures(job) };
  };

  /* 以 UTF-8 JSON 写回响应，并统一序列化接口结果。 */
  function json(res: ServerResponse, value: unknown, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  }

  /* 处理本地页面、鉴权后的 API 和有限的静态文件；所有错误统一转为 JSON。 */
  async function handle(req: IncomingMessage, res: ServerResponse) {
    /* 本地页面也禁用缓存、嗅探、外部资源和被嵌入，缩小配对码泄露面。 */
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      /* Host、Origin 和 Fetch Metadata 必须指向当前本地服务，拒绝外站借浏览器发请求。 */
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) ||
          (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))))
        return json(res, { error: '拒绝非本机页面请求' }, 403);
      const url = new URL(req.url ?? '/', origin);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/api/bootstrap') {
        /* 页面及扩展的隔离世界通过同源请求自动绑定；其他 API 仍需 Bearer 鉴权。 */
        if (req.headers['x-cc98-ui'] !== '1' || req.headers['sec-fetch-site'] !== 'same-origin')
          return json(res, { error: '请打开本地搜索页面' }, 403);
        return json(res, { product: 'cc98-local-search', token: secret });
      }
      if (path.startsWith('/api/')) {
        if (!sameSecret(req.headers.authorization, `Bearer ${secret}`)) return json(res, { error: '本地连接凭据无效，请刷新搜索页' }, 401);
        if (req.method === 'GET' && path === '/api/doctor') {
          const connected = !!transport.session();
          return json(res, {
            connected,
            connection: transport === bridge ? bridge.diagnostics() : { connected },
            busy: scanner.busy(),
            defaultConcurrency: 20,
          });
        }
        if (req.method === 'GET' && path === '/api/boards') return json(res, await scanner.boards());
        if (req.method === 'GET' && path === '/api/jobs') return json(res, store.list().map(job => summary(job.id)));
        if (req.method === 'POST' && path === '/api/jobs') return json(res, await scanner.start(parseOptions(await body(req))), 201);

        /* 单个任务的详情、结果、导出、控制和历史共用一条受限路由。 */
        const match = path.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)(?:\/(results|export|cancel|resume|history|pause))?$/);
        if (match) {
          const id = match[1]!, action = match[2];
          const job = store.get(id);
          if (req.method === 'GET' && !action) return json(res, summary(id));
          if (req.method === 'GET' && action === 'history') return json(res, store.history(job));
          if (req.method === 'GET' && (action === 'results' || action === 'export')) {
            const from = numberParam(url.searchParams.get('from'), 0, Number.MAX_SAFE_INTEGER);
            /* SQLite 的 LIMIT -1 表示不限制条数，用于完整导出当前轮次。 */
            const limit = action === 'export' ? -1 : numberParam(url.searchParams.get('limit'), 100, 1000);
            if (action === 'export') res.setHeader('Content-Disposition', `attachment; filename="cc98-${id}.json"`);
            return json(res, { job: summary(id), results: store.results(job, action === 'export' ? 0 : from, limit),
              total: store.counts(job).matched, from: action === 'export' ? 0 : from });
          }
          if (req.method === 'POST' && (action === 'cancel' || action === 'pause')) return json(res, await scanner.cancel(id, action === 'pause'));
          if (req.method === 'POST' && action === 'resume')
            return json(res, scanner.resume(id, resumeTopicIds(await body(req))));
        }
        return json(res, { error: '接口不存在' }, 404);
      }

      /* 静态文件使用固定白名单，不接受用户输入拼接文件路径。 */
      const files: Record<string, [string, string]> = {
        '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'],
      };
      const file = files[path];
      if (req.method !== 'GET' || !file) return json(res, { error: '页面不存在' }, 404);
      const data = await readFile(resolve(root, 'web', file[0]));
      res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
      res.end(data);
    } catch (error) {
      const info = errorInfo(error);
      /* 可预期的输入、资源和忙碌错误映射到明确状态，其余错误返回服务不可用。 */
      json(res, { error: info.message, code: info.code }, info.code === 'NOT_FOUND' ? 404 : info.code === 'INPUT' ? 400 : info.code === 'BUSY' ? 409 : 503);
    }
  }

  /* 先完成端口监听，再根据实际端口生成 origin；port=0 供测试随机分配。 */
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 9876, '127.0.0.1', () => { server.off('error', reject); done(); });
  }).catch(async error => { await bridge.close(); throw error; });
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;

  /* 监听成功后再打开数据库；失败时关闭已创建的桥和 HTTP 服务。 */
  try { store = new Store(resolve(dataDir, 'tasks.sqlite')); }
  catch (error) {
    await bridge.close();
    server.close();
    throw error;
  }
  scanner = new Scanner(store, transport);
  /* CLI 通过该文件发现服务地址并携带同一配对码调用 API。 */
  await writeFile(resolve(dataDir, 'server.json'), JSON.stringify({ origin, token: secret, pid: process.pid }), { mode: 0o600 });
  return {
    origin, token: secret, store, scanner, bridge,
    /* 按扫描器、桥、HTTP、数据库的顺序释放资源，活动任务会先落盘为暂停。 */
    async close() {
      await scanner.shutdown();
      await bridge.close();
      await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeIdleConnections(); });
      store.close();
    },
  };
}
