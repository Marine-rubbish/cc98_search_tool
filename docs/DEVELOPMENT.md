# CC98 帖子搜索开发者文档

[返回用户使用说明](../README.md) · [系统架构](ARCHITECTURE.md)

## 系统结构

```text
本地页面 / CLI
       |
       v
Node.js HTTP 服务 -> Scanner -> RequestPool -> WebSocket Bridge
       |                                      |
       v                                      v
    SQLite                              Chrome MV3 扩展
                                              |
                                              v
                                  已登录的 CC98 标签页
```

本地服务负责扫描调度、匹配、持久化、HTTP API 和 CLI。Chrome 扩展只负责在已登录标签页中执行受限的只读请求，不承担搜索逻辑。

| 路径 | 职责 |
| --- | --- |
| `src/scanner.ts` | 目录发现、主题扫描、任务状态和恢复调度 |
| `src/topic-verifier.ts` | 短帖按来源页批量核对、异常回退和未确认项释放 |
| `src/site.ts` | CC98 资源读取与响应解析 |
| `src/pool.ts` | 全局并发、请求频率、重试和退避 |
| `src/matcher.ts` | UBB、Markdown 和可见文本匹配 |
| `src/query.ts`、`src/dictionary.ts` | 分组条件校验、可读表达式和本地领域词典建议 |
| `src/store.ts` | SQLite 任务、轮次、游标、主题状态和结果 |
| `src/bridge.ts` | 本地服务与扩展之间的 WebSocket 协议 |
| `src/server.ts` | 本机 HTTP API、静态页面和访问控制 |
| `src/cli.ts` | JSON CLI 与前台服务入口 |
| `extension/` | 无需构建的 Chrome MV3 连接器 |
| `web/` | 无需构建的本地搜索页面 |
| `scripts/launch.mjs` | 后台启动、复用服务和打开 Chrome |
| `scripts/stop.mjs` | 校验本地服务身份并停止后台进程 |
| `test/` | Fixture、扫描器、协议、集成和启动器测试 |

## 本地开发

环境要求：

- macOS、Linux 或 Windows
- Node.js 24 或更新版本
- Chrome 116 或更新版本

安装依赖：

```bash
npm ci
```

前台启动：

```bash
npm start
```

后台启动并打开页面：

```bash
npm run open
npm run open -- --no-open
```

默认服务地址为 <http://127.0.0.1:9876>，默认数据目录为 `.cc98/`。

平台启动入口：

```text
start-cc98-search.sh    macOS / Linux
start-cc98-search.cmd   Windows
stop-cc98-search.sh     macOS / Linux
stop-cc98-search.cmd    Windows
```

启动用 `.sh` 入口查找常见 Node.js 安装位置；`.cmd` 入口使用 Windows `PATH` 中的 `node.exe`。两个启动入口最终都调用 `scripts/launch.mjs`，业务行为保持一致。Windows 会通过 `cmd.exe start` 打开默认浏览器，Linux 当前只打印搜索页地址。

停止入口调用 `scripts/stop.mjs`。停止器读取数据目录中的 `server.json`，先通过本地鉴权确认服务身份，再发送 `SIGTERM` 并等待退出。它不会按端口或进程名模糊终止进程。也可以运行：

```bash
npm run stop
npm run stop -- --data-dir .cc98-other
```

Windows 入口和浏览器打开分支已有自动化测试，但尚未在真实 Windows 环境验证。

### 代码生效方式

| 修改范围 | 生效方式 |
| --- | --- |
| `src/` | 重启本地服务 |
| `web/` | 刷新本地搜索页 |
| `extension/` | 在 `chrome://extensions` 重新加载扩展 |
| `extension/manifest.json` 权限 | 重新加载扩展，并按 Chrome 提示确认权限 |

搜索行为主要由 `src/` 决定。只修改本地服务后，已经加载的扩展通常不用重新加载；协议或扩展读取逻辑改变时，两端需要一起更新。

自定义端口或数据目录：

```bash
npm start -- --port 9878 --data-dir .cc98-other
npm run open -- --port 9878 --data-dir .cc98-other
npm run --silent cli -- doctor --data-dir .cc98-other
```

同一数据目录只能对应一个运行中的服务。启动器会优先复用已有服务，不会覆盖其端口。

## CLI

服务启动后，CLI 只向标准输出写 JSON；失败时退出码为 `1`。

```bash
npm run --silent cli -- doctor
npm run --silent cli -- boards

npm run --silent cli -- search "字节" --preset employment --concurrency 20
npm run --silent cli -- search "实习" --boards 235,459 --rate 10
npm run --silent cli -- search "租房" --preset all
npm run --silent cli -- search "Go" --boards 235 --case-sensitive
npm run --silent cli -- suggest "字节 杭州 Linux C++" > query.json
npm run --silent cli -- search --query-file query.json --preset employment

npm run --silent cli -- status JOB_ID
npm run --silent cli -- results JOB_ID --from 0 --limit 100
npm run --silent cli -- export JOB_ID
npm run --silent cli -- pause JOB_ID
npm run --silent cli -- resume JOB_ID
npm run --silent cli -- resume JOB_ID --topics 5557650
npm run --silent cli -- cancel JOB_ID
npm run --silent cli -- history JOB_ID
```

`results` 每页最多返回 `1000` 条。`export` 包含全部命中、任务范围、覆盖说明和问题项。一次只允许一个任务运行。

`resume` 会创建新轮次，保留已有结论并重试未完成项；`--topics` 只重试指定主题。连接或登录短时中断后的自动恢复不会创建新轮次。

`suggest` 可离线执行，输出纯查询 JSON。编辑其中的 `operator`、词和别名后，用 `--query-file` 搜索。文件内容为下面请求示例中的 `query` 对象。`--query-file` 与位置参数关键词不能同时使用；单关键词 CLI 和 soak 参数保持原义。

## 真实长跑

查看参数：

```bash
npm run soak -- --help
```

启动真实搜索并监控：

```bash
npm run soak -- --keyword "麒麟软件"
npm run soak -- --keyword "麒麟软件" --boards 235,459 \
  --concurrency 12 --rate 6 --duration-minutes 120
```

命令会先检查服务版本、扩展版本、连接状态和任务占用。运行记录写入 `.cc98/soak/`；普通进度只记录计数，错误明细仅在变化时写入 `errors_changed`。达到时间上限、发生未恢复中断或收到终止信号时，会安全暂停自己创建的任务。`--attach JOB_ID` 只监控已有任务，退出时不改变任务状态。

失败后，使用 `.cc98/soak/latest.json` 定位 `incident.json` 和 `repair-request.md`，再让 AI 根据真实证据修复。自动化测试只验证监控器逻辑，不能替代真实长跑。

## HTTP API

CLI 从 `<data-dir>/server.json` 读取本机地址和鉴权凭据。不要把该凭据写入日志、文档或命令输出。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/doctor` | 服务、扩展和扫描器状态 |
| `GET` | `/api/boards` | 当前账号可见的版面目录 |
| `POST` | `/api/query/suggest` | 本地词典建议，无需连接论坛 |
| `POST` | `/api/jobs` | 创建搜索任务 |
| `GET` | `/api/jobs` | 查询任务列表 |
| `GET` | `/api/jobs/{id}` | 查询任务、计数和问题项 |
| `GET` | `/api/jobs/{id}/results` | 分页读取命中结果 |
| `GET` | `/api/jobs/{id}/export` | 导出完整结果 |
| `POST` | `/api/jobs/{id}/pause` | 暂停任务 |
| `POST` | `/api/jobs/{id}/cancel` | 取消任务 |
| `POST` | `/api/jobs/{id}/resume` | 恢复任务，可指定主题 |
| `GET` | `/api/jobs/{id}/history` | 查询轮次历史 |

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

多条件请求用 `query` 替代 `keyword`，其他参数相同：

```json
{
  "query": {
    "operator": "and",
    "groups": [
      {"facet": "company", "operator": "or", "terms": [
        {"keyword": "字节跳动", "aliases": ["字节", "ByteDance"]}
      ]},
      {"facet": "location", "operator": "or", "terms": [{"keyword": "杭州", "aliases": ["Hangzhou"]}]},
      {"facet": "skill", "operator": "and", "terms": [{"keyword": "Linux"}, {"keyword": "C++"}]}
    ]
  },
  "boardIds": [235, 459],
  "concurrency": 20,
  "requestsPerSecond": 10,
  "caseSensitive": false
}
```

`facet` 可选 `company`、`location`、`skill`、`other`，用于编辑和展示，不限制词出现的位置。两层 `operator` 都接受 `and` 或 `or`；同一词的别名固定按 OR 匹配。

拒绝空组、空词和无效关系。最多 20 个逻辑词，每词最多 5 个别名，每个字符串最长 200 字符，总长度不超过 4000。输入按 NFC 规范化，结合大小写选项去重。词内部空格、C++ 等标点保留。

建议接口接收 `{"text":"字节 杭州 Linux C++","caseSensitive":false}`，返回 `query`、可读 `description` 和 `unknownTerms`。仍需本机 Bearer 鉴权，无论坛请求。提交 `query` 后不会隐式查词典补别名；任务保存完整条件快照，后续词典修改不影响恢复。

新任务的 `options.keyword` 是完整可读表达式，`options.query` 是结构化快照。新结果在原 `Match` 字段之外增加 `evidence` 数组：每项含从 0 开始的 `groupIndex`、`termIndex`、`keyword`、实际命中的 `matchedKeyword`、`kind`、`snippet`、`url`；正文证据另有 `floor` 和 `postId`。旧任务和单关键词结果不增加这些字段。

## 扫描与完整性

扫描器按版面读取普通主题并合并置顶主题，以主题 ID 去重。目录读取采用重叠分页和两遍复查；遇到非空短页时，会探测下一偏移并确认实际尾部。论坛报告的主题数只作为目录上界。

普通主题先读取最新详情，确认实际所属版面并检查标题，再分页读取主楼和回复。满足完整条件后结束该主题；未满足时读取到预期楼层范围或实际空页，再核对一次详情。重复帖子 ID、楼层倒序和读取失败会保留为错误。

每轮只编译一次查询，每个主题单独累计各词证据。每段正文只提取一次可见文本，匹配所有尚未命中的词；AND 可以跨标题和楼层成立。多条件正文命中还需核对元数据，变化回退时清空全部证据。标题满足完整条件时无需读正文。旧单关键词保持既有请求路径。

目录中版面 ID、标题、回复数和最后回复时间齐全且有效，回复数为 0–9、版面在搜索范围内、标题未命中时，扫描器复用目录信息作为基线，省去首次详情请求。标题已命中时仍先读详情，保持一次请求。

普通目录候选附带本地 `directoryPage`（版面、偏移、页大小），论坛响应中的同名字段会被解析器丢弃。正文读取结束后，`TopicVerifier` 暂存结论并按来源页合并核对。同页 20 个稳定短帖在固定数据测试中使用 20 次正文请求和 1 次新目录请求，不含目录发现开销。

核对按主题 ID 对照标题、版面、回复数和最后回复时间，均一致才保存结论。缺项、字段变化、重复 ID、异常响应或目录失败时回退详情；详情发现基线变化则重扫正文，并保留原流程的末次核对。单条分组和没有有效来源的候选直接核对详情。字段缺失和长帖走原流程，隐藏楼层仍可能需要额外探测空页。

每次核对先截取已读完正文的候选，不复用发现阶段的响应，后完成的候选进入下一批。同组详情回退并发执行，仍共用原请求池。待核对集合达到 40 条时，工作协程启动共享批次并等待空位；有空位就继续领取，正在读取的正文允许收尾。目录发现和正文扫描结束后排空余项，主动停止也须等待后台核对退出。未确认项在 SQLite 中保持 `working`，停止时退回 `pending`，崩溃恢复时重读正文。无需新增数据库状态或缓存全量正文。

论坛目录没有稳定快照。扫描期间发生顶帖、删帖或移帖时，偏移分页仍可能产生遗漏；不改变基线字段的旧楼层编辑也无法被本次核对识别。因此成功状态使用 `finished_unverified`，不会宣称目录完整。

## 任务状态与恢复

| 状态 | 含义 |
| --- | --- |
| `running` | 正在读取目录或主题 |
| `waiting_connection` | 扩展连接暂时不可用，保留运行意图 |
| `waiting_login` | 自动令牌恢复失败，等待登录恢复 |
| `paused` | 任务停止，可手动恢复 |
| `cancelled` | 任务已取消，已有数据保留 |
| `finished_unverified` | 已发现主题均有结论，目录完整性未验证 |
| `partial` | 仍有目录问题、读取错误或未处理项 |

`desiredRunning` 区分临时中断和用户主动停止。断线或登录恢复后，扫描器会核对账号和论坛站点；一致时继续当前轮次，只把遗留的 `working` 主题放回队列。账号变化会清除自动续跑意图并保持暂停。

进程启动时，SQLite 会把遗留的活动任务改为 `paused`，同时保留 `desiredRunning=true`。原账号扩展连接后，扫描器继续同一轮次。

## 扩展协议与安全边界

- 本地 HTTP 服务只接受环回访问，并要求 Bearer 鉴权。
- WebSocket 只接受 Chrome 扩展来源、固定 `/bridge` 路径和有效配对信息。
- 本地服务只发送 `boards`、`board`、`pinned`、`topics`、`topic`、`posts` 等固定资源描述。
- 扩展将资源描述转换为只读 CC98 API 请求，不接受任意 URL。
- 论坛访问令牌只保存在 `chrome.storage.session` 和页面执行上下文中。
- 本地服务只保存账号 ID 和论坛站点，用于阻止跨账号恢复；不会收到论坛令牌。
- 并发请求遇到 401 时共用一次恢复流程，扩展最多自动刷新绑定标签页一次。
- 新令牌必须通过 `/me` 核对为同一账号，随后才会重试原请求。

## 本地数据

默认数据位于 `.cc98/`：

| 文件 | 内容 |
| --- | --- |
| `tasks.sqlite` | 任务、轮次、目录游标、主题状态和命中结果 |
| `tasks.sqlite-wal`、`tasks.sqlite-shm` | SQLite WAL 文件，运行期间可能存在 |
| `server.json` | 本地服务地址、进程信息和本机鉴权凭据 |
| `server.log` | 后台服务日志 |

数据库不保存全量帖子正文，只保存任务状态和命中片段；多条件查询保存各词的首次证据。条件和证据存入已有 JSON 字段，无需改表。整个 `.cc98/` 已加入 `.gitignore`。

## 验证

```bash
npm run typecheck
npm test
node --check web/app.js
node --check web/query-editor.js
node --check extension/background.js
node --check extension/local.js
node --check extension/popup.js
node --check extension/protocol.js
```

自动化测试使用固定论坛数据，不需要真实账号。测试覆盖扫描一致性、短帖请求数与变化回退、批量核对时序和容量、后排楼层命中、目录短页、并发与限频、认证续期、断线续跑、账号切换、服务重启、HTTP 访问控制、CLI 和启动器。批量回归还会挂起一条详情，验证其他回退保持并发，缓冲释放后正文能继续，暂停则等待全部后台读取退出。

自动化测试不能证明真实论坛目录完整，也不能替代 WebVPN、权限和线上吞吐量验证。

多条件回归覆盖真值表、别名、跨楼层证据、与逐词集合运算对照、版本变化清空证据、暂停与恢复、HTTP/CLI 和持久化。延迟测试以每请求 150ms、并发 4 扫描 20 个稳定短帖：三词合并为 21 次请求，逐词扫描共 63 次，同时比较实际耗时。测试不访问真实论坛。

## 相关文档

- [系统架构](ARCHITECTURE.md)
- [Aime 调用说明](aime.md)
