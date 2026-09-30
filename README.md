# Litefuse Observability Plugin for MiniMax Code

把 MiniMax Code 的每个 Agent turn 上传到 **Litefuse**，与已有的 Langfuse 插件**并行运行**，实现同一条 trace 双写两个后端。

- 一个 `MiniMax Code Turn` agent observation 对应一次 Stop Hook 对应的 turn；
- 每次模型响应对应一个 `LLM` generation；
- 模型发起的 shell、编辑、MCP 和其他工具调用对应 tool observations；
- 同一个 MiniMax session 使用同一个 session id 归组（两个后端保持一致）；
- 保留 session、turn、turn number、model、cwd 等元数据。

trace 的形状与 `mcode-langfuse-observability-plugin` **逐字一致**：`transcript.ts` 与 `types.ts` 原样复用（同一个宿主 CLI → 同一份 transcript schema），`trace.ts` 仅新增一个可选的 `version` 字段，因此两个后端里的 trace 可以直接对比。

## 双写架构

```
                    ┌─ Stop hook ─→ langfuse-observability ─→ <langfuse base_url>
MiniMax Code turn ──┤
                    └─ Stop hook ─→ litefuse-observability ─→ <litefuse base_url>
```

两个插件各自注册一个 `Stop` hook，宿主会把所有已启用插件的 hook 拼接执行（按 plugin root 去重，不同安装目录互不覆盖）。每个 hook 是独立进程，互不影响。

### 共存时必须不同的东西

两个插件只要有任何一项重名，就会出现「后启动的那个静默丢数据」或「配置互相覆盖」的问题，因此本插件做了完整 re-key：

| 关注点         | Langfuse 插件                   | 本插件                            |
| -------------- | ------------------------------- | --------------------------------- |
| 配置文件       | `langfuse.json`                 | `litefuse.json`                   |
| 全局配置路径   | `~/.minimax-code/langfuse.json` | `~/.minimax-code/litefuse.json`   |
| 项目配置路径   | `.minimax/langfuse.json`        | `.minimax/litefuse.json`          |
| 环境变量前缀   | `LANGFUSE_MINIMAX_*`            | `LITEFUSE_MINIMAX_*`              |
| 启用开关       | `TRACE_TO_LANGFUSE`             | `TRACE_TO_LITEFUSE`               |
| 默认 base_url  | `https://cloud.langfuse.com`    | `http://localhost:3000`（自托管） |
| 调试日志前缀   | `[langfuse-minimax]`            | `[litefuse-minimax]`              |
| 去重状态文件名 | `<hash>.json`                   | `<hash>.litefuse.json`            |

其中 **去重状态文件名** 是双写下最容易踩的坑：两个插件如果写同一个状态文件，先完成上传的一方会把该 turn 记为「已上传」，另一方读到后就会**直接跳过整个 turn**，表现和插件坏了完全一样。宿主通常已经按插件名分配了独立的 `PLUGIN_DATA`（`<data>/plugin-data/hooks/<pluginName>`），本插件再加一层文件名后缀，保证即使两个插件被指向同一个数据目录也不会互相吞数据 —— 这一条有专门的回归测试和端到端验证覆盖。

## 安装

从 GitHub 克隆并构建单文件 Hook：

```bash
git clone https://github.com/ai-native-thinking/mcode-litefuse-plugin.git
cd mcode-litefuse-plugin
pnpm install
pnpm build                       # 生成 dist/index.mjs（单文件、已内置全部依赖）
```

把插件安装到 MiniMax Code 的本地插件目录（默认 `~/.minimax/plugins`），目录名保持 `litefuse-observability`。**必须用复制，不能用软链**——宿主扫描本地插件目录时会静默跳过软链，软链会「看起来装好了但永远不加载」：

```bash
pnpm sync                        # 复制仓库（去除 node_modules 与 .git）到 ~/.minimax/plugins/litefuse-observability
```

或手动复制：

```bash
cp -R "$PWD" ~/.minimax/plugins/litefuse-observability
```

确认宿主已识别并启用：

```bash
mcode plugin list --marketplace local --available --json
```

`dist/index.mjs` 是运行时实际执行的自包含 Hook。宿主加载的是 `~/.minimax/plugins/` 下的**副本**，编辑仓库不会改变宿主实际执行的文件——**修改 `src/` 后必须重新 `pnpm build && pnpm sync`**。

## 配置

默认关闭上传，必须显式设置 `enabled: true`。推荐使用全局配置文件（Hook runner 会过滤子进程环境变量）：

文件路径：`~/.minimax-code/litefuse.json`

```json
{
  "enabled": true,
  "public_key": "pk-lf-...",
  "secret_key": "sk-lf-...",
  "base_url": "http://<litefuse-host>/litefuse",
  "environment": "development",
  "user_id": "<your-id>",
  "tags": ["mcode-litefuse"]
}
```

`base_url` 直接填 Litefuse 实例根地址即可，SDK 会原样拼接 `/api/public/otel/v1/traces`；带路径前缀的自托管部署（例如 `https://host/litefuse`）可以正确工作。

直接运行 Hook 或做本地调试时也可以用环境变量：

```bash
export TRACE_TO_LITEFUSE=true
export LITEFUSE_PUBLIC_KEY="pk-lf-..."
export LITEFUSE_SECRET_KEY="sk-lf-..."
export LITEFUSE_BASE_URL="http://<litefuse-host>/litefuse"
```

也可以使用项目级 `.minimax/litefuse.json`。配置合并顺序是：默认值 → 全局文件 → 项目文件 → 环境变量，环境变量优先。对于 MiniMax Code 的实际 Hook 子进程，环境变量通常不会被宿主透传，所以应把凭证放在 JSON 配置中。

| 配置            | 环境变量                                              | 默认值                  | 说明                                     |
| --------------- | ----------------------------------------------------- | ----------------------- | ---------------------------------------- |
| `enabled`       | `TRACE_TO_LITEFUSE`                                   | `false`                 | 是否上传 trace                           |
| `public_key`    | `LITEFUSE_MINIMAX_PUBLIC_KEY` / `LITEFUSE_PUBLIC_KEY` | —                       | Litefuse public key                      |
| `secret_key`    | `LITEFUSE_MINIMAX_SECRET_KEY` / `LITEFUSE_SECRET_KEY` | —                       | Litefuse secret key                      |
| `base_url`      | `LITEFUSE_MINIMAX_BASE_URL` / `LITEFUSE_BASE_URL`     | `http://localhost:3000` | Litefuse 实例地址，可带路径前缀          |
| `environment`   | `LITEFUSE_MINIMAX_ENVIRONMENT`                        | —                       | trace 环境标签                           |
| `version`       | `LITEFUSE_MINIMAX_VERSION`                            | —                       | trace 版本标识（SDK 字段名为 `version`） |
| `user_id`       | `LITEFUSE_MINIMAX_USER_ID`                            | —                       | 用户标识                                 |
| `tags`          | `LITEFUSE_MINIMAX_TAGS`                               | —                       | JSON 数组或逗号分隔                      |
| `metadata`      | `LITEFUSE_MINIMAX_METADATA`                           | —                       | JSON object                              |
| `trace_seed`    | `LITEFUSE_MINIMAX_TRACE_SEED`                         | —                       | 用 `seed:session:turn` 派生稳定 trace id |
| `max_chars`     | `LITEFUSE_MINIMAX_MAX_CHARS`                          | `20000`                 | 输入输出截断长度                         |
| `debug`         | `LITEFUSE_MINIMAX_DEBUG`                              | `false`                 | 输出诊断日志到 stderr                    |
| `fail_on_error` | `LITEFUSE_MINIMAX_FAIL_ON_ERROR`                      | `false`                 | 上传失败时让 Hook 返回非零               |

**让两个后端的 trace id 对齐**：给两个插件配置**相同**的 `trace_seed`，同一 turn 在 Langfuse 和 Litefuse 里会得到同一个 trace id，方便跨后端对照。

### Litefuse 版本兼容

Litefuse fork 的 OTLP 入口对客户端有硬性版本门槛：请求必须带 `x-langfuse-sdk-name: javascript` 且 `x-langfuse-sdk-version >= 5.0.0`（或显式 `x-langfuse-ingestion-version: 4`），否则返回 HTTP 400。本插件使用 `@langfuse/tracing` / `@langfuse/otel` 5.x（当前锁定 5.11.1），由 SDK 自动带上这两个 header，因此满足门槛。**不要**手工伪造版本 header —— 那会让后端的 span 语义静默错乱。

## 数据和隐私

启用后，插件会发送用户 prompt、模型文本、工具参数和工具输出，以及 session、turn、model、cwd 等元数据。MiniMax Code 的临时 transcript 会在 Hook 生命周期结束后清理；插件只在 `${PLUGIN_DATA}` 中保留小型去重状态。不要对包含不应外传内容的 session 开启 tracing，可以用 `max_chars` 限制单个字段大小。

MiniMax 的临时 Codex 投影没有 provider token usage，因此当前版本不会伪造 token 数量；Litefuse 中 generation 的 `usageDetails` 为空。

## 开发和验证

```bash
pnpm test            # 单元测试：transcript 解析、配置 re-key、状态隔离
pnpm lint:tsc        # 类型检查
pnpm build           # 生成 dist/index.mjs
pnpm verify          # 双写端到端验证（起一个假 OTLP collector）
```

`pnpm verify` 会同时把**已安装的 Langfuse 插件 bundle** 和**本插件 bundle** 打向同一份合成 transcript，并断言：两个后端各收到一次请求、请求路径正确、Basic 认证分别是各自的 key、`javascript@>=5.0.0` 满足 Litefuse 门槛、span 嵌套为 `agent → generation → tool`、replay 被去重、以及**两个插件共用同一个 `PLUGIN_DATA` 时仍然互不吞数据**。

Hook 采用 fail-open 策略，默认不会阻塞 MiniMax Code；调试时可同时设置 `LITEFUSE_MINIMAX_DEBUG=true` 和 `LITEFUSE_MINIMAX_FAIL_ON_ERROR=true`。

排查时按这个顺序看：状态文件没生成 → hook 根本没触发（确认该 turn 是否真的以 `Stop` 结束）；状态文件有但后端没数据 → 用 `DEBUG` 手动重跑 bundle；数据被拒 → 回到上面的版本门槛。

## License

MIT
