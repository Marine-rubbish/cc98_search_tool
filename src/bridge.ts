import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { Reply, Resource, Session, Transport } from './types.js';
import { ScanError } from './types.js';

/* 使用定时安全比较配对信息，并先比较字节长度以满足 timingSafeEqual 的要求。 */
export function sameSecret(a: unknown, b: string): boolean {
  return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/* 只允许 CC98 官方站点根路径或 WebVPN 映射后的 CC98 根路径作为会话站点。 */
export function validForumBase(input: unknown): input is string {
  if (typeof input !== 'string') return false;
  try {
    const u = new URL(input);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash &&
      ((/^(www\.)?cc98\.org$/.test(u.hostname) && u.pathname === '/') ||
       (u.hostname === 'webvpn.zju.edu.cn' && /^\/https?\/[a-zA-Z0-9,._~-]+\/$/.test(u.pathname)));
  } catch { return false; }
}

/*
 * 本地服务与 Chrome 扩展之间的 WebSocket 桥接层。
 * 扫描器只发送受限 Resource；扩展在已登录页面中读取，并按请求 ID 返回结果。
 */
export class Bridge implements Transport {
  private wss: WebSocketServer;
  private socket?: WebSocket;
  private identity: Session | null = null;
  private sessionListeners = new Set<(session: Session | null) => void>();
  private pending = new Map<string, { resolve: (r: Reply) => void; reject: (e: Error) => void; clean: () => void }>();
  private closeReasons = new WeakMap<WebSocket, string>();
  private connectedAt?: string;
  private lastMessageAt?: string;
  private lastClose?: { at: string; code: number; reason: string };
  private extensionVersion?: string;
  private heartbeat: NodeJS.Timeout;

  /* 接管 /bridge 升级请求，限制本机 Host、扩展 Origin、负载大小和心跳周期。 */
  constructor(server: Server, private token: string, private timeoutMs = 30000) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      /* 非指定路径、非当前本机端口或非 Chrome 扩展来源的连接直接销毁。 */
      if (req.url !== '/bridge' || req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}` ||
          !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin ?? '')) {
        socket.destroy(); return;
      }
      this.wss.handleUpgrade(req, socket, head, ws => this.accept(ws));
    });
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'ping' }));
    }, 15000);
    this.heartbeat.unref();
  }

  /* 验证扩展首包，维护心跳，并将后续 reply 消息交给对应的挂起请求。 */
  private accept(ws: WebSocket) {
    let authenticated = false;
    let lastSeen = Date.now();
    const helloTimeout = setTimeout(() => { if (!authenticated) ws.close(1008, 'Pairing required'); }, 5000);
    const alive = setInterval(() => {
      if (Date.now() - lastSeen > 45000) {
        this.closeReasons.set(ws, 'heartbeat_timeout');
        ws.terminate();
      }
    }, 15000);
    ws.on('error', () => {
      this.closeReasons.set(ws, 'socket_error');
      ws.terminate();
    });
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw.toString());
        if (!authenticated) {
          /* 首包必须同时证明配对码、账号格式和论坛根地址有效。 */
          if (m.type !== 'hello' || !sameSecret(m.token, this.token) || !validForumBase(m.session?.forumBase) ||
              typeof m.session?.accountId !== 'string' || !/^\d+$/.test(m.session.accountId)) {
            ws.close(1008, 'Invalid pairing'); return;
          }
          /* 只保留最新连接，避免两个标签页并存时会话身份含糊。 */
          this.disconnect();
          authenticated = true;
          clearTimeout(helloTimeout);
          this.socket = ws;
          this.identity = { accountId: m.session.accountId, forumBase: m.session.forumBase };
          this.extensionVersion = typeof m.extensionVersion === 'string' && /^\d+\.\d+\.\d+$/.test(m.extensionVersion)
            ? m.extensionVersion : undefined;
          this.connectedAt = new Date().toISOString();
          this.lastMessageAt = this.connectedAt;
          this.emitSession();
          ws.send(JSON.stringify({ type: 'ready' }));
          return;
        }
        lastSeen = Date.now();
        this.lastMessageAt = new Date(lastSeen).toISOString();
        if (m.type === 'pong') return;
        if (m.type !== 'reply' || typeof m.id !== 'string') return;
        const p = this.pending.get(m.id);
        if (!p) return;
        p.clean();
        /* 会话与认证错误会使整条连接失效，所有并发请求统一进入恢复等待。 */
        if (['SESSION_CHANGED', 'DISCONNECTED', 'AUTH_REQUIRED'].includes(m.errorCode) || m.status === 401) {
          const code = m.status === 401 ? 'AUTH_REQUIRED' : m.errorCode;
          const message = code === 'AUTH_REQUIRED'
            ? 'CC98 登录需要恢复'
            : code === 'SESSION_CHANGED'
              ? 'Chrome 标签页、账号或站点已改变'
              : 'Chrome 扩展连接已断开';
          const failure = new ScanError(code, message, true);
          p.reject(failure);
          this.disconnect(failure, code.toLowerCase());
        } else if (!Number.isInteger(m.status) || m.status < 0 || m.status > 599) {
          p.reject(new ScanError('SCHEMA', '扩展响应格式无效'));
        } else {
          p.resolve({ status: m.status, data: m.data, error: typeof m.error === 'string' ? m.error : undefined,
            retryAfterMs: typeof m.retryAfterMs === 'number' && Number.isFinite(m.retryAfterMs) ? m.retryAfterMs : undefined });
        }
      } catch { ws.close(1008, 'Invalid message'); }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(helloTimeout);
      clearInterval(alive);
      if (this.socket === ws) {
        const known = this.closeReasons.get(ws);
        this.lastClose = {
          at: new Date().toISOString(),
          code,
          reason: known || (reason.length ? 'peer_closed' : 'socket_closed'),
        };
        this.disconnect();
      }
    });
  }

  /* 清除当前会话，并拒绝所有仍在等待扩展响应的请求。 */
  private disconnect(error = new ScanError('DISCONNECTED', 'Chrome 扩展连接已断开', true), reason?: string) {
    const old = this.socket;
    const hadSession = !!this.identity;
    if (old && reason) {
      this.closeReasons.set(old, reason);
      this.lastClose = { at: new Date().toISOString(), code: 0, reason };
    }
    this.socket = undefined;
    this.identity = null;
    old?.close();
    for (const p of [...this.pending.values()]) {
      p.clean();
      p.reject(error);
    }
    if (old || hadSession) this.emitSession();
  }

  /* 返回当前扩展声明的账号和论坛站点；断开时返回 null。 */
  session() { return this.identity; }

  /* 返回不含账号和凭据的连接诊断，供本地页面与长跑监控器使用。 */
  diagnostics() {
    return {
      connected: !!this.identity && this.socket?.readyState === WebSocket.OPEN,
      extensionVersion: this.extensionVersion,
      connectedAt: this.connectedAt,
      lastMessageAt: this.lastMessageAt,
      lastClose: this.lastClose,
    };
  }

  /* 会话监听用于扫描器在同账号重连后继续当前轮次。 */
  onSession(listener: (session: Session | null) => void) {
    this.sessionListeners.add(listener);
    queueMicrotask(() => listener(this.identity));
    return () => this.sessionListeners.delete(listener);
  }

  private emitSession() {
    for (const listener of this.sessionListeners) listener(this.identity);
  }

  /* 向扩展发送一次资源读取请求，并处理取消、超时和按 ID 匹配的响应。 */
  read(resource: Resource, signal?: AbortSignal): Promise<Reply> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new ScanError('DISCONNECTED', '请先连接 Chrome 扩展', true));
    const ws = this.socket;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      /* 扫描取消时同时通知页面中止 fetch，防止浏览器继续消耗请求额度。 */
      const cancel = () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancel', id }));
        clean();
        reject(signal?.reason ?? new ScanError('CANCELLED', '请求已取消'));
      };
      /* 超时说明扩展或标签页已失去响应，终止连接使扫描进入可恢复的暂停状态。 */
      const timer = setTimeout(() => {
        clean();
        reject(new ScanError('DISCONNECTED', 'Chrome 请求超时，请检查标签页', true));
        this.closeReasons.set(ws, 'request_timeout');
        ws.terminate();
      }, this.timeoutMs);
      /* 无论成功、失败还是取消，都移除计时器、映射和事件监听。 */
      const clean = () => { clearTimeout(timer); this.pending.delete(id); signal?.removeEventListener('abort', cancel); };
      this.pending.set(id, { resolve, reject, clean });
      signal?.addEventListener('abort', cancel, { once: true });
      ws.send(JSON.stringify({ type: 'read', id, resource }));
    });
  }

  /* 停止心跳、断开扩展、拒绝挂起请求并关闭 WebSocket 服务。 */
  async close() {
    clearInterval(this.heartbeat);
    this.disconnect(undefined, 'service_shutdown');
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
  }
}
