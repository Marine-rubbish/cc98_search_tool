import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));

/* 只读取本服务生成的环回地址、凭据和 PID，不根据端口或进程名模糊查找。 */
async function settingsIn(dataDir) {
  let content;
  try { content = await readFile(resolve(dataDir, 'server.json'), 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  let value;
  try { value = JSON.parse(content); }
  catch { throw new Error('服务配置不是有效 JSON，未停止任何进程'); }
  if (!value || typeof value !== 'object' ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin) ||
      !/^[a-f0-9]{64}$/.test(value.token) ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0)
    throw new Error('服务配置无效，未停止任何进程');
  return value;
}

/* 使用无副作用的信号检查 PID 是否仍存在。 */
function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

/* 鉴权读取服务特征，避免陈旧 PID 恰好指向其他进程时误杀。 */
async function confirmService(settings) {
  try {
    const response = await fetch(settings.origin + '/api/doctor', {
      headers: { Authorization: `Bearer ${settings.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return typeof data.connected === 'boolean' &&
      typeof data.busy === 'boolean' &&
      data.defaultConcurrency === 20;
  } catch { return false; }
}

/**
 * 停止指定数据目录对应的本地服务。服务未运行属于幂等成功。
 * @param {{ dataDir?: string, timeoutMs?: number }} options
 */
export async function stop({ dataDir = resolve(root, '.cc98'), timeoutMs = 12000 } = {}) {
  dataDir = resolve(dataDir);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('停止超时时间必须大于 0');
  const settings = await settingsIn(dataDir);
  if (!settings || !processExists(settings.pid))
    return { stopped: false, alreadyStopped: true };
  if (settings.pid === process.pid) throw new Error('拒绝停止当前脚本进程');
  if (!await confirmService(settings))
    throw new Error(`PID ${settings.pid} 仍存在，但无法确认其为 CC98 搜索服务，未停止任何进程`);

  process.kill(settings.pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(settings.pid)) return { stopped: true, alreadyStopped: false, pid: settings.pid };
    await delay(100);
  }
  throw new Error(`服务 PID ${settings.pid} 未在 ${timeoutMs}ms 内退出`);
}

/* 命令行仅输出可读状态；失败时不泄露本地鉴权凭据。 */
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
    const result = await stop({ dataDir: values['data-dir'] });
    console.log(result.stopped ? 'CC98 搜索服务已停止。' : 'CC98 搜索服务未运行。');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
