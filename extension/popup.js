/* 按元素 ID 获取弹窗控件。 */
const $ = id => document.getElementById(id);

/* 显示连接状态，并按错误类型展示登录或刷新入口。 */
const show = result => {
  $('status').textContent = result.error || result.state;
  $('login').hidden = result.needsLogin !== true;
  $('refresh').hidden = result.needsRefresh !== true;
  $('disconnect').hidden = !result.autoConnect;
  $('forum').hidden = result.connected || result.needsLogin || result.needsRefresh;
};

/* 操作只表达意图，服务地址、论坛标签页与凭据统一由后台发现。 */
for (const [id, type] of Object.entries({
  open: 'open-search', connect: 'connect', login: 'open-login',
  refresh: 'reload-page', disconnect: 'disconnect', forum: 'open-forum',
})) $(id).addEventListener('click', async () => {
  $(id).disabled = true;
  try { show(await chrome.runtime.sendMessage({ type })); }
  catch { $('status').textContent = '扩展已更新，请关闭并重新打开弹窗'; }
  finally { $(id).disabled = false; }
});

/* 自动连接可能在弹窗打开后完成，保持状态同步。 */
async function poll() {
  try { show(await chrome.runtime.sendMessage({ type: 'status' })); }
  catch { $('status').textContent = '请在扩展管理页重新加载扩展'; }
  setTimeout(poll, 1000);
}
void poll();
