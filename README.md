<div align="center">

# pi-wanchuan（万川）

**万池归于此 · 百川东到海** — 免费优先的 pi 模型池扩展

`/model` 只显示免费模型 · 纯文本模型自动看图 · 图像生成/嵌入/TTS/ASR/重排 池

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![pi extension](https://img.shields.io/badge/pi-extension-4B32C3)](https://github.com/earendil-works/pi)

> **slogan：百川东到海** —— 众多模型服务商如百川，汇聚入池体系如归海。

</div>

---

## 📖 简介

`pi-wanchuan`（万川）为 [pi](https://github.com/earendil-works/pi)（AI 编程助手）提供模型池体系，且共享同一份模型数据（整个扩展启动只拉取**一次**网络）：

1. **免费 Provider 注册**：`/model` 选择器中 openrouter 提供商**只显示免费模型**——不再被几百个付费模型淹没
2. **视觉模型池**：纯文本模型也能"看"图片——上传图片时自动交给视觉池中优先级最高的多模态模型识别，识别结果以文字注入对话
3. **六池全自动化**：视觉 / 图像生成 / 嵌入 / TTS / ASR / 重排 全部支持自然语言触发，无需用户记命令

> 视觉/图像/免费 provider 共享同一份 OpenRouter 目录缓存；端点池到期时按 `output_modalities` 精确拉取。所有文件路径参数均支持绝对路径与相对路径。

---

## ✨ 功能一览

| 功能 | 说明 |
|------|------|
| 🆓 **免费 Provider** | openrouter 提供商只保留免费模型（定价 0/0），`/model` 干净清爽 |
| 🔄 **全池自动刷新** | 各池过期（默认 24h）自动重拉新模型：视觉/图像池从 OpenRouter 目录，嵌入/TTS/ASR/重排端点池按 `output_modalities` 精确拉取并端点验证；免费 provider 缓存 6h 自动重拉；失败自动回退旧池/缓存 |
| 📷 **自动看图** | 文本模型收到图片时，自动调用视觉池最高优先级的多模态模型描述 |
| 🚫 **伪多模态屏蔽** | 自动检测声明支持图片但实际无法处理图片的模型（如 sensenova），跳过并回退下一个候选 |
| 🗣️ **自然语言触发** | 发音频自动转写、说"读出来"自动合成语音、问相似度自动嵌入、说"画图"自动生图、问"哪个最相关"自动重排——六池全部自动 |
| 🖼️ **图像生成池** | `/img-generate <提示词>` 或 `generate_image` 工具：按优先级生成图片；支持 `outputPath` 指定任意保存路径 |
| 🔢 **嵌入池** | `/embed <文本>` 或 `embed_text` 工具：文本 → 向量（相似度/检索） |
| 🎙️ **TTS 池** | `/tts <文本>` 或 `text_to_speech` 工具：文本 → 语音文件；支持 `outputPath` 指定保存路径 |
| 🗣️ **ASR 池** | `/asr <音频>` 或 `transcribe_audio` 工具：音频 → 文本；绝对/相对路径自动处理 |
| 📊 **重排池** | `/rerank <查询> \| <文档…>` 或 `rerank_text` 工具：文档按相关性排序（检索/搜索排序） |
| 🎯 **优先级管理** | 免费优先、性能其次；手动优先级刷新后永久保留 |
| 🤖 **AI 自动发现** | 读取你配置的模型服务商，用你的模型分析多模态模型并实测验证后入池 |
| 🛡️ **容错设计** | 下架感知、失败自动刷新重试、伪多模态自动回退、网络失败回退缓存 |
| 🔇 **静默运行** | 不污染 TUI 终端（console 日志全部静默） |
| 🪶 **零依赖** | 纯 TypeScript，无 npm 包 |

---

## 🚀 快速开始

### 1. 安装

```bash
# 把整个 pi-wanchuan 目录复制到 pi 的全局扩展目录
cp -r pi-wanchuan ~/.pi/agent/extensions/

# 重启 pi（目录结构扩展必须重启才能识别）
```

### 2. 配置 API key

```bash
# OpenRouter（视觉池调用的必需项；拉取模型列表本身不需要 key）
setx OPENROUTER_API_KEY "sk-or-..."
```

也可以 `pi` 内执行 `/login openrouter`（凭据存入 `auth.json`，二选一）。

### 3. 验证

```
/mm-status       # 查看视觉池状态、当前模型、API key
/model           # openrouter 提供商应该只剩免费模型
/mm-pool free    # 查看视觉池中的免费多模态模型
```

### 4. 日常使用（全自动，说人话即可）

```
直接发图片            → 自动识别并描述（视觉池）
发音频文件路径        → 自动转写并注入文本（ASR 池）
"把这段话读出来"      → 自动合成语音（TTS 池）
"这两个文本相似吗"    → 自动计算向量（嵌入池）
"哪个结果最相关"     → 自动重排（重排池）
"画一只太空猫"       → 自动生成图片（图像生成池，付费）
```

所有池都支持**自然语言触发**（模型根据工具引导自动调用），命令与工具仅作兜底。所有文件路径参数（`outputPath` / `audioPath` / `image`）均自动区分绝对路径与相对路径。

---

## 📖 功能详解

### 1️⃣ 免费 Provider（/model 只显示免费模型）

```
pi 启动 ──► 拉取 OpenRouter 全量目录（或读 6h 内缓存）
              │
              ├─ 成功 → 注册 openrouter provider = 仅免费模型（20 个左右）
              └─ 失败 → 回退文件缓存；再失败 → 保留 pi 内置目录
```

- 免费判定：OpenRouter 对 prompt/completion 均定价 `0`
- `models.json` 中自定义的 openrouter 模型按 id 合并保留（你手动 pin 的模型不会被删掉）
- 免费模型通常每周变化，缓存 6 小时后自动重拉
- 命令：`/openrouter-free`（强制刷新）、`/openrouter-free list`（交互查看列表）

### 2️⃣ 视觉模型池（文本模型自动看图）

```
用户上传图片 ──► input 事件拦截（消息进入 LLM 之前）
                   │
                   ├─ 当前模型支持图片？──是──► 原样透传（多模态模型直接看）
                   │
                   └─ 否（文本模型）──► 按优先级调用视觉池模型：
                                         ① OpenRouter 免费多模态（REST）
                                         ② pi 注册表多模态（走 pi 调用层，鉴权零配置）
                                         ③ AI 自动发现的多模态（走服务商端点）
                                        │
                                        ▼
                        识别文字替换原图，文本模型正常处理
```

**池的三个来源：**

| 来源 | 说明 | 默认优先级 |
|------|------|-----------|
| OpenRouter 免费多模态 | 免费优先，同档按上下文长度（性能代理）降序 | 1..N |
| 注册表模型（`includeRegistryModels`） | pi 中已配置鉴权的多模态模型（如 `xiaomi-clean/mimo-v2.5`），走 pi 自身调用层 | 100+ |
| AI 自动发现（`autoDiscover`） | 读取你的服务商，LLM 分析 + 实测验证后加入 | 免费层末尾 / 1000+ |

**刷新策略（混合式）**：

| 策略 | 说明 |
|------|------|
| 懒刷新 + TTL | 池过期（默认 24h）后，第一次需要视觉能力时先刷新再用 |
| 启动后台刷新 | 启动时若池过期，后台异步刷新（不阻塞启动、离线可用旧池） |
| 手动刷新 | `/mm-refresh` 随时强制 |
| 失败触发 | 池中所有候选都失败（典型：免费模型被下架）时自动强制刷新一次并重试 |
| 伪多模态回退 | 某个模型调用返回"无法查看图片"等回复时，自动判定为伪多模态并跳过，尝试下一个 |

**优先级规则**：

- 数字越小越优先（1 = 最高）
- 默认：免费模型排 1..N（按上下文长度降序），付费/自定义排 100+，AI 发现排其后
- 手动设置过的优先级（`/mm-priority`）在每次刷新时**永久保留**
- 下架的模型不删除，标记 `⚠下架` 并跳过调用；恢复上架后自动解除标记

### 3️⃣ 伪多模态自动检测

某些模型在 `models.json` 中配置了 `input: ["text", "image"]`，但实际 API **无法真正处理图片**——请求返回 200 但模型回复"我无法查看图片"。如果不检测，用户上传图片后会得到毫无价值的回复。

万川通过两层信号自动检测并跳过这类模型：

| 检测维度 | 说明 |
|----------|------|
| **否定信号** | 回复包含"无法查看图片""没有图片""cannot see image"等 25+ 种模式 |
| **确认信号** | 回复缺少颜色/人物/场景/头发/眼睛等图片特征词（20+ 种） |
| **判定** | 有否定信号 + 无确认信号 → 判定为伪多模态，抛出错误回退下一个模型 |

OpenRouter 路径不受影响（HTTP 状态码已有兜底），仅对 `registry` 和 `discovered` 来源的模型生效。

---

## 🧩 嵌入 / TTS / ASR / 重排 端点池

四个专用端点池（`/embed`、`/tts`、`/asr`、`/rerank`）与视觉池一样**全自动维护**——OpenRouter 上新的免费 embeddings / TTS / transcription / rerank 模型会自动被发现并加入。

**关键点**：OpenRouter 的 `/models` 接口**默认只返回 chat 模型**，embeddings / 语音 / 重排等专用端点模型必须用 `output_modalities` 过滤参数才能列出。万川据此精确拉取：

| 池 | OpenRouter 目录过滤参数 | 目录中的 free 示例 |
|----|------------------------|-------------------|
| 嵌入 | `output_modalities=embeddings` | `liquid/lfm-2.5-embedding-350m:free`、`nvidia/nemotron-3-embed-1b:free`、`nvidia/llama-nemotron-embed-vl-1b-v2:free` |
| TTS | `output_modalities=speech` | `deepgram/flux-tts:free`、`fish-audio/s2.1-pro-free:free` |
| ASR | `output_modalities=transcription` | 暂无 free（有 `qwen/qwen3-asr-*`、`mistralai/voxtral-*-stt` 等付费） |
| 重排 | `output_modalities=rerank` | `nvidia/llama-nemotron-rerank-vl-1b-v2:free`（其余目录标注 free 的 rerank 模型端点验证返回 402，被自动剔除） |

**发现与入池流程**：

```
池过期（默认 24h）或首次启动 ──► 拉 OpenRouter 目录（按 output_modalities 过滤）
                                      │
                                      ├─ 筛选 free（prompt/completion 均定价 0）
                                      ├─ 逐候选【端点实测验证】（发最小请求，200 才入池）
                                      └─ 合并用户 models.json 服务商关键词候选 + 内置免费候选
```

**刷新策略（与视觉池同款）**：

| 策略 | 说明 |
|------|------|
| 懒刷新 + TTL | 池过期（默认 24h）后，第一次使用时先刷新再用 |
| 启动后台刷新 | 启动时池为空或过期，后台异步刷新 |
| 手动刷新 | `/embed-refresh` / `/tts-refresh` / `/asr-refresh` / `/rerank-refresh` 随时强制 |
| 失败触发 | 调用时全部候选失败（免费模型被下架）自动强制刷新一次并重试 |
| 端点验真 | 目录标注只作候选；`/embeddings`、`/audio/speech`、`/audio/transcriptions`、`/rerank` 请求 200 才入池（目录里标 free 但端点返回 402 的假免费模型自动剔除），LLM 不参与、零幻觉 |

**兜底来源**：OpenRouter 目录拉取失败、或目录外的隐藏模型（如 `nvidia/nv-embed-v1`、Cloudflare `bge`、小米 `mimo-v2.5-tts/asr`），由内置候选清单与用户服务商 `/models` 关键词发现补齐。

**配置**：每个池的 `~/.pi/agent/<embed|tts|asr|rerank>-pool.json` 支持 `config` 字段（旧文件无 config 自动用默认值）：

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `ttlHours` | `24` | 池过期时间（小时） |
| `refreshOnStartup` | `true` | 启动时池为空/过期则后台刷新 |
| `refreshOnAllFailed` | `true` | 全部候选失败时强制刷新重试 |
| `maxModels` | `100` | 池容量上限 |

---

## 🤖 AI 自动发现（autoDiscover）

> 适配冷门模型服务商的正解：不为每家写适配器，让 LLM 自适应。

默认**关闭**。开启后：

```
读取 models.json 中的服务商（有 baseUrl + API key）
      ↓ 逐个调 /models 接口
服务商返回的模型列表
      ↓ LLM（你的模型）分析：多模态识别 + 参数估计 + 免费判定
候选多模态模型
      ↓ 🔍 带图片实测验证（1x1 PNG 最小请求，max_tokens=1）
      ✅ 200 → 加入池（discovered 来源）
      ❌ 4xx → 剔除（图像生成/编辑等假多模态、或模型不可用）
```

**开启方式**（编辑 `~/.pi/agent/vision-pool.json` 的 `config`）：

```json
{
  "config": {
    "autoDiscover": true,
    "discoverModel": "modelscope/deepseek-ai/DeepSeek-V4-Flash-0731"
  }
}
```

- `discoverModel`：用于分析的模型（`provider/model`），空则用当前激活模型；推荐免费模型
- 首次运行自动做一次**全量发现**；之后 `/mm-refresh` 时**增量发现**新模型
- 手动触发：`/mm-discover`（增量）/ `/mm-discover full`（全量）
- 发现的模型在 `/mm-pool` 中标记为 `发现`，走服务商自己的 OpenAI 兼容端点调用

**成本**：每次发现 = 1 次 LLM 分析调用（几百 token）+ 每模型 1 次验证调用（1 token 级）——免费额度完全扛得住。

**防幻觉设计**：

| 风险 | 对策 |
|------|------|
| LLM 编造模型 id | 输出 id 必须与列表完全一致，否则丢弃 |
| 编造上下文/参数 | 带图片实测验证，实际请求会暴露真实限制 |
| 误判"免费" | `discoverFreeOnly` 默认 false（免费标记只影响排序，不阻断收录） |
| 假多模态（图像生成模型） | 验证请求**带图片**——生成模型不接受 image_url 输入，被 4xx 剔除 |

---

## 🛠️ 命令参考

| 命令 | 说明 |
|------|------|
| `/openrouter-free [list]` | 强制刷新免费模型并重新注册 provider / 交互查看列表 |
| `/mm-pool [free\|paid\|all\|offline]` | 查看视觉池（按优先级排序，TUI 下打开编辑器展示完整列表） |
| `/mm-refresh` | 强制刷新视觉池（免费模型不定期上架/下架） |
| `/mm-priority [数字] [关键字]` | 设置模型优先级（无参数时交互选择） |
| `/mm-discover [full]` | AI 自动发现（增量 / 全量） |
| `/img-pool` · `/img-refresh` · `/img-priority` | 图像生成池管理 |
| `/img-add [provider] [modelId]` | 把用户服务商的图像生成模型（如 agnes-image-2.1-flash）加入池，端点验证后入池 |
| `/img-remove [关键字]` | 从图像池移除模型 |
| `/img-generate <提示词>` | 生成图片并保存（默认 Downloads 目录）；尺寸不被支持时自动回退 |
| `/embed-pool` · `/embed-refresh` · `/embed-discover` · `/embed <文本>` | 嵌入池：查看 / 强制刷新 / 发现 / 文本转向量 |
| `/tts-pool` · `/tts-refresh` · `/tts-discover` · `/tts <文本>` | TTS 池：查看 / 强制刷新 / 发现 / 文本转语音 |
| `/asr-pool` · `/asr-refresh` · `/asr-discover` · `/asr <音频>` | ASR 池：查看 / 强制刷新 / 发现 / 音频转文本 |
| `/rerank-pool` · `/rerank-refresh` · `/rerank-discover` · `/rerank <查询> \| <文档…>` | 重排池：查看 / 强制刷新 / 发现 / 文档重排 |
| `/mm-status` | 当前模型、视觉池、API key、自动发现状态 |
| `/mm-config` | 查看视觉池配置 |

**LLM 可调用工具**：

| 工具 | 参数 | 说明 |
|------|------|------|
| `describe_image` | `image` / `prompt` | 显式描述图片（本地路径 / data URL / 裸 base64） |
| `generate_image` | `prompt` / `outputPath` | 生成图片（走图像生成池，支持指定保存路径） |
| `embed_text` | `text` | 文本 → 向量（走嵌入池） |
| `text_to_speech` | `text` / `outputPath` | 文本 → 语音文件（支持指定保存路径） |
| `transcribe_audio` | `audioPath` | 音频 → 文本（绝对/相对路径自动处理） |
| `rerank_text` | `query` / `documents` | 文档列表按与查询的相关性排序（走重排池） |
| `mm_pool_info` | `limit` | 查询视觉池信息（数量、优先级、免费/付费等） |

> 所有文件路径参数均自动区分绝对路径与相对路径：传入 `D:\xxx\file.ext` 等绝对路径直接使用，传入相对路径时以当前工作目录为基准拼接。

---

## ⚙️ 配置参考

配置文件：`~/.pi/agent/vision-pool.json`（`config` 字段，修改后 `/reload` 生效）

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `ttlHours` | `24` | 池过期时间（小时） |
| `refreshOnStartup` | `true` | 启动时后台异步刷新 |
| `refreshOnAllFailed` | `true` | 全部候选失败时强制刷新重试 |
| `freeFirst` | `true` | 免费模型默认排前面 |
| `includePaid` | `false` | 池中是否包含付费模型 |
| `includeRegistryModels` | `true` | 自动纳入 pi 中已配置鉴权的多模态模型 |
| `maxModels` | `200` | 池容量上限 |
| `describeMaxTokens` | `2048` | 识别输出最大 token |
| `forceDescribe` | `false` | 即使当前模型支持图片也强制走视觉池 |
| `autoDiscover` | `false` | AI 自动发现开关 |
| `discoverModel` | `""` | 用于分析的模型（`provider/model`，空=当前激活模型） |
| `discoverFreeOnly` | `false` | 严格模式：只收录 LLM 判定为免费的模型 |
| `openrouterBaseUrl` | `https://openrouter.ai/api/v1` | OpenRouter API 地址 |
| `describePrompt` | （中文提示词） | 发给视觉模型的识别提示词 |

完整示例：

```json
{
  "updatedAt": 1787000000000,
  "config": {
    "ttlHours": 24,
    "refreshOnStartup": true,
    "refreshOnAllFailed": true,
    "freeFirst": true,
    "includePaid": false,
    "includeRegistryModels": true,
    "maxModels": 200,
    "describeMaxTokens": 2048,
    "forceDescribe": false,
    "autoDiscover": false,
    "discoverModel": "",
    "discoverFreeOnly": false,
    "openrouterBaseUrl": "https://openrouter.ai/api/v1"
  },
  "models": []
}
```

---

## ❓ 常见问题（FAQ）

**Q：为什么 `/model` 里看不到某些 provider？**
pi 的规则：**没有配置鉴权的 provider 不显示**。检查对应环境变量/`/login` 是否已配置，然后重启 pi。

**Q：`/mm-pool` 里出现 `⚠下架` 是什么？**
该模型已从 OpenRouter 下架（免费模型上架/下架很频繁）。扩展保留它并跳过调用，恢复上架后自动解除标记。

**Q：为什么识别图片时偶尔会失败/变慢？**
视觉池按优先级逐个尝试，免费模型可能限流（429）或临时不可用，会**自动回退到下一个模型**；如果某个模型回复"无法查看图片"会被自动判定为伪多模态并跳过；全部失败会触发强制刷新重试。

**Q：`discovered` 来源的模型是什么？**
AI 自动发现（`autoDiscover`）从你的模型服务商（如魔搭）发现的、经带图片实测验证的多模态模型。走服务商自己的端点调用。

**Q：为什么 AI 发现出的模型上下文是 131072？**
LLM 对未公布上下文的模型填保守估计值（131072）。如果你知道真实值，用 `/mm-priority` 无法修改上下文——需要手动编辑 `vision-pool.json` 中该条目的 `contextLength`。

**Q：`includePaid: true` 后付费模型还是排最后吗？**
是的。免费模型（`freeFirst`）永远排前面，付费模型排 10000+；手动设置过优先级的除外。

**Q：拉取模型列表需要 key 吗？**
不需要。OpenRouter `/models` 是公开接口；但**调用模型描述图片**需要 `OPENROUTER_API_KEY`（或 `/login openrouter`）。

**Q：`generate_image` / `text_to_speech` 的 `outputPath` 支持绝对路径吗？**
支持。传入 `D:\xxx\file.ext` 等绝对路径直接使用，不需要写相对于当前工作目录的路径。相对路径以当前工作目录为基准拼接。`transcribe_audio` 的 `audioPath` 同理。

**Q：某个模型声明支持图片但实际上不能处理图片怎么办？**
不需要手动处理。万川会**自动检测**这类伪多模态模型并跳过，自动尝试池中下一个候选模型。

---

## 🗂️ 项目结构

```
pi-wanchuan/              # 复制整个目录到 ~/.pi/agent/extensions/
├── index.ts                 # 入口（协调五个模块）
├── or-free.ts               # 共享数据层（拉取/缓存/防并发）+ 免费 provider 注册
├── vision-pool.ts           # 视觉模型池（自动看图 + AI 自动发现 + 伪多模态检测）
├── image-gen.ts             # 图像生成池
├── endpoint-pool.ts         # 嵌入/TTS/ASR/重排 端点池（OpenRouter 目录自动发现 + 服务商发现 + 端点实测验证 + TTL 自动刷新）
└── filter-providers.ts      # 内置 provider 模型筛选（nvidia/cloudflare/zai 只留旗舰）
```

---

## 📝 更新日志

| 版本 | 内容 |
|------|------|
| 2026-08 | 初始版本：免费 provider 注册 + 视觉池 + 图像生成池（共享数据层，一次拉取） |
| 2026-08 | 新增嵌入/TTS/ASR 端点池（服务商发现 + 端点实测验证，含首次启动自动发现） |
| 2026-08 | 新增内置 provider 筛选（nvidia / cloudflare-workers-ai / zai 只保留旗舰模型） |
| 2026-08 | 新增 AI 自动发现（autoDiscover：服务商 /models + LLM 分析 + 带图片实测验证） |
| 2026-08 | 图像生成池兼容性升级：支持用户服务商图像生成模型（/img-add 端点验证入池）、尺寸自动回退、OpenRouter key 按需获取；视觉池/端点池不再强制依赖 OpenRouter；修复 Windows 注册表环境变量读取 |
| 2026-08 | 路径处理修复：`generate_image` 的 `outputPath` 与 `transcribe_audio` 的 `audioPath` 增加 `isAbsolute` 判断，绝对路径不再被拼接到 cwd 后 |
| 2026-08 | `text_to_speech` 工具新增 `outputPath` 参数，支持指定任意保存路径 |
| 2026-08 | 伪多模态检测：自动识别声明支持图片但实际无法处理图片的模型（如 sensenova），跳过并回退下一个候选，提升视觉池鲁棒性 |
| 2026-08 | 端点池全自动刷新：嵌入/TTS/ASR 池改为 TTL（默认 24h）自动刷新 + 启动后台刷新 + 懒刷新 + 全失败重试；新增 `/embed-refresh` `/tts-refresh` `/asr-refresh`；修复 OpenRouter 目录发现（`/models` 默认只返回 chat 模型，改用 `output_modalities=embeddings/speech/transcription` 精确拉取），未来 OpenRouter 新上免费 embeddings/TTS/transcription 模型时自动入池 |
| 2026-08 | 新增重排池（rerank）：`/rerank`、`/rerank-pool`、`/rerank-discover`、`/rerank-refresh`、`/rerank-priority` 命令 + `rerank_text` 工具；按 `output_modalities=rerank` 自动发现，端点验证剔除 402 假免费模型，当前可用免费模型为 `nvidia/llama-nemotron-rerank-vl-1b-v2:free` |

---

## 🤝 贡献

欢迎提交 Issue 和 PR：

- 新平台适配建议（AI 自动发现让大多数平台无需硬编码适配）
- 视觉池新特性
- 伪多模态检测规则优化
- 文档改进

开发时用 `CHAT_MARKS_DEBUG=1` 环境变量可临时打开日志（对应 chat-marks 项目）。

---

## 📄 License

本项目采用 **MIT License**，全文本见 [LICENSE](LICENSE)。

```
MIT License

Copyright (c) 2026 Chen-shan-ren

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
