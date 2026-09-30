import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { browserLaunchCommand, dependencyInstallCommand, launch } from '../scripts/launch.mjs';
import { Store } from '../src/store.js';
import { parseOptions } from '../src/types.js';
import { Fixture } from './fixture.js';

async function directory() {
  await mkdir('test-artifacts', { recursive: true });
  return mkdtemp(resolve('test-artifacts', 'launcher with spaces-'));
}

test('启动器为 macOS 和 Windows 选择对应的浏览器打开命令', () => {
  const origin = 'http://127.0.0.1:9876';
  assert.deepEqual(browserLaunchCommand('darwin', origin), {
    command: '/usr/bin/open',
    args: ['-a', 'Google Chrome', origin],
  });
  assert.deepEqual(browserLaunchCommand('win32', origin), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `start "" "${origin}"`],
  });
  assert.equal(browserLaunchCommand('linux', origin), undefined);
  assert.deepEqual(dependencyInstallCommand('win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm ci --include=dev --no-audit --no-fund'],
  });
  assert.deepEqual(dependencyInstallCommand('linux'), {
    command: 'npm',
    args: ['ci', '--include=dev', '--no-audit', '--no-fund'],
  });
});

test('启动器进程退出后服务仍可用，重复打开复用进程并保留原任务', async () => {
  const dir = await directory();
  const store = new Store(resolve(dir, 'tasks.sqlite'));
  const job = store.create(parseOptions({ keyword: 'fixture', boardIds: [235] }), new Fixture().session()!, []);
  store.close();
  const reserved = createServer();
  reserved.listen(0, '127.0.0.1');
  await once(reserved, 'listening');
  const port = (reserved.address() as { port: number }).port;
  await new Promise<void>(done => reserved.close(() => done()));
  let pid: number | undefined;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      'scripts/launch.mjs', '--data-dir', dir, '--port', String(port), '--no-open',
    ]);
    const service = JSON.parse(await readFile(resolve(dir, 'server.json'), 'utf8'));
    pid = service.pid;
    assert.match(stdout, /已在后台启动/);
    assert.ok(pid && pid !== process.pid);
    const second = await launch({ dataDir: dir, openBrowser: false });
    assert.equal(second.started, false);
    assert.equal(second.pid, pid);
    assert.equal(second.origin, service.origin);
    const settings = JSON.parse(await readFile(resolve(dir, 'server.json'), 'utf8'));
    const response = await fetch(service.origin + `/api/jobs/${job.id}`, {
      headers: { Authorization: `Bearer ${settings.token}` },
    });
    const persisted = await response.json();
    assert.equal(persisted.id, job.id);
    assert.equal(persisted.status, 'paused');
    assert.equal(persisted.options.keyword, 'fixture');
    const log = await readFile(resolve(dir, 'server.log'), 'utf8');
    assert.equal(log.includes(settings.token), false);
    await assert.rejects(launch({ dataDir: dir, port: port === 65535 ? port - 1 : port + 1, openBrowser: false }), /已有服务/);
  } finally {
    if (pid) {
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await delay(100);
      }
      assert.throws(() => process.kill(pid!, 0));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('端口被其他程序占用时启动失败，不覆盖数据库或终止其他程序', async () => {
  const dir = await directory();
  const occupied = createServer((_req, res) => { res.writeHead(404); res.end(); });
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const port = (occupied.address() as { port: number }).port;
  try {
    await assert.rejects(launch({ dataDir: dir, port, openBrowser: false, timeoutMs: 3000 }), /启动失败/);
    assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 404);
    await assert.rejects(readFile(resolve(dir, 'tasks.sqlite')), { code: 'ENOENT' });
  } finally {
    await new Promise<void>(done => { occupied.close(() => done()); occupied.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  }
});
