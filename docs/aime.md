# Aime 调用说明

Aime 指字节内部 Agent。当前提供本机 CLI 和 JSON 接口；Aime 需要能在运行本项目的电脑上执行命令。纯远端环境不能直接访问本机服务，具体接入方式尚未验证。

## 可交给 Agent 的指令

```text
使用 CC98 本地搜索工具，工作目录为本项目根目录。
前置条件：用户已双击启动文件或运行 npm run open，并在 Chrome 中打开已登录的 CC98。
首次使用需加载本项目的 Chrome 扩展；扩展会自动连接，无需手填配对码。

执行 npm run --silent cli -- doctor，确认 connected 为 true。
默认就业范围为求职广场 235、实习兼职 459，并发 20。
执行 npm run --silent cli -- search "用户关键词" --preset employment --concurrency 20。
从 JSON 读取任务 id，定期用 status 查询，再用 results 分页取结果。
默认关键词区分不同任务，不复用旧任务结果。

出现 paused 时提示用户检查 Chrome 登录和连接，再用 resume 恢复。
出现 partial 时同时报告 failures 和 issues，不能把失败项视为无匹配。
finished_unverified 只表示已处理已发现的主题，不能声称找齐范围内全部匹配。
需要完整结果时执行 export；results 单页结果不能冒充完整结果。
向用户报告关键词、实际版面范围、命中主题、原帖链接和覆盖限制。
```

用户关键词应作为独立进程参数传入，不要拼接到未经转义的 shell 命令中。

## 调用示例

```bash
npm run --silent cli -- search "字节" --boards 235,459 --concurrency 20
npm run --silent cli -- status JOB_ID
npm run --silent cli -- results JOB_ID --from 0 --limit 100
npm run --silent cli -- export JOB_ID
```

搜索立即返回任务对象。状态查询包含 `counts` 和 `failures`。结果接口返回：

```json
{
  "job": {
    "id": "任务ID",
    "status": "finished_unverified",
    "boards": [{"id": 235, "name": "求职广场"}],
    "coverage": {
      "directoryVerified": false,
      "snapshotConsistent": false,
      "note": "目录完整性未验证"
    }
  },
  "results": [
    {
      "topicId": 123,
      "boardId": 235,
      "boardName": "求职广场",
      "title": "示例主题",
      "kind": "post",
      "floor": 100,
      "postId": 456,
      "snippet": "包含关键词的片段",
      "url": "https://www.cc98.org/topic/123/10#0"
    }
  ],
  "total": 1,
  "from": 0
}
```

以上是字段示例，不是真实搜索结果。停止条件应结合 `job.status`，不要根据当前结果数量判断任务是否结束。

## 本地 HTTP API

CLI 从 `.cc98/server.json` 读取服务地址和本地连接凭据。调用 HTTP 时使用 `Authorization: Bearer <本地凭据>`，不要把凭据写进 Agent 回复或日志。页面和扩展的自动绑定不改变 CLI 调用方式。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/doctor` | 连接与运行状态 |
| GET | `/api/boards` | 论坛版面目录 |
| POST | `/api/jobs` | 创建任务 |
| GET | `/api/jobs` | 任务列表 |
| GET | `/api/jobs/{id}` | 当前任务与问题项 |
| GET | `/api/jobs/{id}/results?from=0&limit=100` | 分页命中结果 |
| GET | `/api/jobs/{id}/export` | 完整导出 |
| POST | `/api/jobs/{id}/pause` | 暂停 |
| POST | `/api/jobs/{id}/cancel` | 取消 |
| POST | `/api/jobs/{id}/resume` | 同账号从目录游标恢复，可指定主题 |
| GET | `/api/jobs/{id}/history` | 轮次状态 |

创建任务的请求体：

```json
{
  "keyword": "字节",
  "boardIds": [235, 459],
  "concurrency": 20,
  "requestsPerSecond": 10,
  "caseSensitive": false
}
```

普通恢复、取消和暂停使用空 JSON 对象 `{}`。普通恢复保留已有结论，只重试未完成项，并从保存的目录游标继续。仅重试指定主题时使用：

```json
{
  "topicIds": [5557650]
}
```

版面目录刷新在扫描期间会返回忙碌状态，避免额外请求叠加扫描并发。
