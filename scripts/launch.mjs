import { spawn } from 'node:child_process';
import { readFile, mkdir, open } from 'node:fs/promises';
import { dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(root, 'package.json'));

/* 只接受本服务写出的环回地址，禁止把本地凭据带到其他地址。 */
async function settingsIn(dataDir) {
  try {
    const data = JSON.parse(await readFile(resolve(dataDir, 'server.json'), 'utf8'));
    if (/^http:\/\/127\.0\.0\.1:\d+$/.test(data.origin) && /^[a-f0-9]{64}$/.test(data.token)) return data;
  } catch { /* 首次启动或服务尚未写完发现文件。 */ }
}

/* 健康检查只返回地址与进程信息，凭据不进入输出或日志。 */
async function running(dataDir) {
  const settings = await settingsIn(dataDir);
  if (!settings) return;
  try {
    const response = await fetch(settings.origin + '/api/doctor', {
      headers: { Authorization: `Bearer ${settings.token}` },
      redirect: 'error', signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return;
    const data = await response.json();
    if (typeof data.connected === 'boolean' && typeof data.busy === 'boolean' && data.defaultConcurrency === 20)
      return { origin: settings.origin, pid: settings.pid };
  } catch { /* 未运行时由启动器创建服务。 */ }
}

/* 不使用 shell 拼接命令，目录含空格时仍按独立参数传递。 */
function run(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root, ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new Error(`命令执行失败（退出码 ${code}）`)));
  });
}

async function dependencies() {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  try {
    for (const name of [...Object.keys(pkg.dependencies), 'tsx']) require.resolve(name);
    return;
  } catch { /* 首次运行时安装锁文件指定的依赖。 */ }
  console.log('首次运行，正在安装依赖…');
  const install = dependencyInstallCommand(process.platform);
  try {
    await run(install.command, install.args, {
      stdio: 'inherit', env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}` },
    });
  } catch { throw new Error('依赖安装失败，请检查网络后重新双击启动文件，或在项目目录运行 npm ci'); }
}

/* Windows 的 npm 是批处理入口，必须经 cmd.exe 执行。 */
export function dependencyInstallCommand(platform) {
  if (platform === 'win32')
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm ci --include=dev --no-audit --no-fund'] };
  return { command: 'npm', args: ['ci', '--include=dev', '--no-audit', '--no-fund'] };
}

/* 返回各桌面系统的浏览器打开命令；Linux 缺少统一可用入口时只打印地址。 */
export function browserLaunchCommand(platform, origin) {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: ['-a', 'Google Chrome', origin] };
  if (platform === 'win32') return { command: 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${origin}"`] };
}

async function launchBrowser(origin) {
  const launch = browserLaunchCommand(process.platform, origin);
  if (!launch) {
    console.log(`请在 Chrome 打开 ${origin}`);
    return;
  }
  try { await run(launch.command, launch.args, { stdio: 'ignore' }); }
  catch { throw new Error(`服务已启动，请安装或打开 Chrome 后访问 ${origin}`); }
}

/**
 * 重复启动复用已有服务，新服务独立于终端运行，始终保留原数据目录。
 * @param {{ dataDir?: string, port?: number, openBrowser?: boolean, timeoutMs?: number }} options
 */
export async function launch({ dataDir = resolve(root, '.cc98'), port, openBrowser = true, timeoutMs = 12000 } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本，请安装后重试');
  dataDir = resolve(dataDir);
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535))
    throw new Error('端口范围为 1024–65535');
  let service = await running(dataDir);
  if (service) {
    if (port !== undefined && Number(new URL(service.origin).port) !== port)
      throw new Error(`该数据目录已有服务运行于 ${service.origin}，请先停止原服务再更改端口`);
    if (openBrowser) await launchBrowser(service.origin);
    return { ...service, started: false };
  }
  await dependencies();
  const saved = await settingsIn(dataDir);
  const selectedPort = port ?? (saved ? Number(new URL(saved.origin).port) : 9876);
  if (!Number.isInteger(selectedPort) || selectedPort < 1024 || selectedPort > 65535)
    throw new Error('保存的服务端口无效，请使用 --port 指定端口');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const logPath = resolve(dataDir, 'server.log');
  const log = await open(logPath, 'a', 0o600);
  let child;
  let failed = false;
  try {
    child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href,
      resolve(root, 'src/cli.ts'), 'start', '--port', String(selectedPort), '--data-dir', dataDir], {
      cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    child.once('error', () => { failed = true; });
    child.once('exit', () => { failed = true; });
    child.unref();
  } finally { await log.close(); }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    service = await running(dataDir);
    if (service && Number(new URL(service.origin).port) === selectedPort) {
      if (openBrowser) await launchBrowser(service.origin);
      return { ...service, started: !failed && service.pid === child.pid };
    }
    if (failed) break;
    await delay(200);
  }
  /* 启动超时只停止本次创建的进程，不触碰已存在的服务。 */
  if (!failed) child.kill('SIGTERM');
  throw new Error(`服务启动失败，端口 ${selectedPort} 可能被占用。请查看 ${logPath}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: {
      'data-dir': { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' },
    } });
    const service = await launch({ dataDir: values['data-dir'],
      port: values.port === undefined ? undefined : Number(values.port), openBrowser: !values['no-open'] });
    console.log(`${service.started ? '搜索服务已在后台启动' : '已打开现有搜索服务'}：${service.origin}`);
    console.log('可以关闭此终端。首次使用请按搜索页指引加载 Chrome 扩展。');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
