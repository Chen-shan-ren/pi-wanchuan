/**
 * endpoint-pool.ts — 端点池（嵌入 / TTS / ASR / 重排）· pi-wanchuan 万川扩展模块
 *
 * 四个专用端点池，模型联合发现自：
 *   1. OpenRouter 目录（按 output_modalities=embeddings/speech/transcription/rerank 精确拉取，
 *      因为 /models 默认只返回 chat 模型）+ 筛 free
 *   2. 用户配置的服务商（models.json 有 baseUrl + API key）：/models 关键词候选
 *   3. 内置免费候选（OpenRouter 隐藏模型 + Cloudflare/NVIDIA/小米兜底）
 * 候选逐个【端点实测验证】后入池——发对应端点最小请求，200 才入池（LLM 不参与，零幻觉）。
 *
 * 自动刷新：池为空或过期（默认 24h）自动重拉；/<kind>-refresh 手动强制；调用全失败自动刷新重试。
 *
 * 命令（kind = embed | tts | asr | rerank）：
 *   /<kind>-pool             查看池
 *   /<kind>-refresh          强制刷新池
 *   /<kind>-discover         发现模型（端点验证）
 *   /<kind>-priority [n] [k] 设置优先级
 *   /embed <文本>            文本 → 向量（显示维度/前几维）
 *   /tts <文本>              文本 → 语音文件（保存到本地）
 *   /asr <音频路径>          音频 → 文本
 *   /rerank <查询> | <文档1> | <文档2> …   按相关性重排文档
 *
 * 工具：embed_text / text_to_speech / transcribe_audio / rerank_text
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join, isAbsolute } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isFreeModel, type RawORModel } from "./or-free.ts";
import { getEnvValue, resolveApiKey, readUserProviders, type UserProvider } from "./shared.ts";

// ---------------------------------------------------------------------------
// 池种类定义
// ---------------------------------------------------------------------------

type PoolKind = "embed" | "tts" | "asr" | "rerank";

interface KindSpec {
  label: string;
  /** 候选模型 id 关键词（启发式） */
  keywords: RegExp;
  /** 端点路径 */
  endpoint: string;
  /** 验证请求构造：返回 { body, contentType? }，contentType 缺省为 json */
  verifyBody: (modelId: string) => { body: unknown; formData?: boolean };
  /** 验证是否通过（状态码 200 且满足条件） */
  verifyOk: (status: number, bodyText: string) => boolean;
}

const KIND_SPECS: Record<PoolKind, KindSpec> = {
  embed: {
    label: "嵌入",
    keywords: /embed|bge|m3e|retriev|e5-|gte-/i,
    endpoint: "embeddings",
    verifyBody: (modelId) => ({ body: { model: modelId, input: "hi" } }),
    verifyOk: (status, body) => status === 200 && body.includes('"embedding"'),
  },
  tts: {
    label: "TTS",
    keywords: /tts|speech|voice|audio|kokoro|cartesia|eleven/i,
    endpoint: "audio/speech",
    verifyBody: (modelId) => ({
      body: { model: modelId, input: "hi", voice: "alloy" },
    }),
    // TTS 返回音频字节（200 + 非 JSON），有些模型返回 JSON 错误时剔除
    verifyOk: (status, body) => status === 200 && !body.startsWith("{"),
  },
  asr: {
    label: "ASR",
    keywords: /whisper|transcrib|asr|audio|parakeet|seamless|mms/i,
    endpoint: "audio/transcriptions",
    verifyBody: (modelId) => ({
      body: { model: modelId },
      formData: true,
    }),
    verifyOk: (status, _body) => status === 200,
  },
  rerank: {
    label: "重排",
    keywords: /rerank|rank|relevan|jina|cohere|cross-encoder/i,
    endpoint: "rerank",
    verifyBody: (modelId) => ({
      body: { model: modelId, query: "hi", documents: ["hello", "world"] },
    }),
    verifyOk: (status, body) => status === 200 && body.includes('"relevance_score"'),
  },
};

// ---------------------------------------------------------------------------
// 池状态
// ---------------------------------------------------------------------------

interface EPPoolModel {
  id: string;
  provider: string;
  baseUrl: string;
  apiKeyRef?: string;
  priority: number;
  userSet?: boolean;
}

interface EPPoolConfig {
  ttlHours: number; // 池过期时间（小时），默认 24
  refreshOnStartup: boolean; // 启动时后台异步刷新（池为空或过期时），默认 true
  refreshOnAllFailed: boolean; // 全部候选调用失败后强制刷新重试，默认 true
  maxModels: number; // 池容量上限，默认 100
}

interface EPPoolState {
  updatedAt: number;
  models: EPPoolModel[];
  config: EPPoolConfig;
}

const DEFAULT_CONFIG: EPPoolConfig = {
  ttlHours: 24,
  refreshOnStartup: true,
  refreshOnAllFailed: true,
  maxModels: 100,
};

function poolFile(kind: PoolKind): string {
  return join(getAgentDir(), `${kind}-pool.json`);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadPool(kind: PoolKind): Promise<EPPoolState> {
  try {
    const raw = await readFile(poolFile(kind), "utf8");
    const parsed = JSON.parse(raw) as Partial<EPPoolState>;
    if (parsed && Array.isArray(parsed.models)) {
      return {
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
        models: parsed.models.filter((m) => m && typeof m.id === "string"),
        config: { ...DEFAULT_CONFIG, ...(parsed.config ?? {}) },
      };
    }
  } catch {
    // 首次运行
  }
  return { updatedAt: 0, models: [], config: { ...DEFAULT_CONFIG } };
}

async function savePool(kind: PoolKind, pool: EPPoolState): Promise<void> {
  await mkdir(join(getAgentDir()), { recursive: true });
  await writeFile(poolFile(kind), JSON.stringify(pool, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// 环境变量与用户服务商
// ---------------------------------------------------------------------------

/** 解析池条目里的 key 引用：兼容 $"NAME" 与 "NAME" 两种格式。 */
function resolvePoolKey(apiKeyRef: string | undefined): string | undefined {
  if (!apiKeyRef) return undefined;
  const name = apiKeyRef.startsWith("$") ? apiKeyRef.slice(1) : apiKeyRef;
  return getEnvValue(name);
}

/** 小米 MiMo key：MIMO_API_KEY env → auth.json 的 xiaomi-clean →
 *  models.json 中 baseUrl 含 xiaomimimo.com 的任意 provider（兼容自定义命名）。 */
function getXiaomiKey(): string | undefined {
  const env = getEnvValue("MIMO_API_KEY");
  if (env) return env;
  try {
    const auth = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8"));
    const v = auth?.["xiaomi-clean"]?.key;
    if (typeof v === "string" && v) return v;
  } catch {
    // 继续尝试 models.json
  }
  try {
    const cfg = JSON.parse(readFileSync(join(getAgentDir(), "models.json"), "utf8"));
    for (const def of Object.values(cfg?.providers ?? {})) {
      const base = typeof def?.baseUrl === "string" ? def.baseUrl : "";
      if (!base.includes("xiaomimimo.com")) continue;
      const k = resolveApiKey(def?.apiKey);
      if (k) return k;
    }
  } catch {
    // 无 models.json
  }
  return undefined;
}

/** OpenRouter API key：环境变量优先，回退 pi 注册表凭据（/login openrouter 存 auth.json）。 */
async function getOpenRouterKey(ctx: ExtensionContext): Promise<string | undefined> {
  const env = getEnvValue("OPENROUTER_API_KEY");
  if (env) return env;
  try {
    const key = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
    if (key) return key;
  } catch {
    // 回退 undefined
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 发现：关键词候选 + 端点实测验证
// ---------------------------------------------------------------------------

/** 发送端点请求（验证或真实调用共用）。 */
async function sendEndpointRequest(
  baseUrl: string,
  apiKey: string,
  kind: PoolKind,
  modelId: string,
  payload: unknown,
  signal: AbortSignal,
  formData?: boolean,
): Promise<{ status: number; text: string; buffer?: Buffer }> {
  const spec = KIND_SPECS[kind];
  let res: Response;
  if (formData) {
    const fd = new FormData();
    fd.append("model", modelId);
    // 用一个 1 秒静音 wav 作为验证音频
    const wav = Buffer.from(
      "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
      "base64",
    );
    fd.append(
      "file",
      new Blob([wav], { type: "audio/wav" }),
      "silence.wav",
    );
    res = await fetch(`${baseUrl}/${spec.endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
      signal,
    });
  } else {
    res = await fetch(`${baseUrl}/${spec.endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal,
    });
  }
  // 先读 body 字节，再转文本（text() 会消费响应体，音频/JSON 都从字节取）
  const bytes = res.ok ? Buffer.from(await res.arrayBuffer().catch(() => Buffer.from(""))) : undefined;
  const text = bytes ? bytes.toString("utf8") : await res.text().catch(() => "");
  return { status: res.status, text, buffer: bytes };
}

/** 从用户服务商发现某类池的模型（关键词候选 + 端点验证）。返回新增数量。 */
async function discoverKind(ctx: ExtensionContext, kind: PoolKind): Promise<number> {
  const spec = KIND_SPECS[kind];
  const pool = await loadPool(kind);
  const providers = readUserProviders();
  let added = 0;
  for (const p of providers) {
    let modelList: string[] = [];
    try {
      const res = await fetch(`${p.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${p.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { data?: { id?: string }[] };
      modelList = Array.isArray(j?.data) ? j.data.map((m) => m.id).filter((x): x is string => !!x) : [];
    } catch {
      continue;
    }
    // 关键词候选（无候选时取列表前 20 个兜底，靠端点验证分辨）
    const candidates = modelList.filter((id) => spec.keywords.test(id));
    const poolIds = new Set(pool.models.map((m) => m.id));
    for (const id of candidates) {
      if (poolIds.has(id)) continue;
      try {
        const { body, formData } = spec.verifyBody(id);
        const r = await sendEndpointRequest(p.baseUrl, p.apiKey, kind, id, body, AbortSignal.timeout(20_000), formData);
        if (!spec.verifyOk(r.status, r.text)) continue;
        const maxP = Math.max(0, ...pool.models.map((m) => m.priority));
        pool.models.push({
          id,
          provider: p.id,
          baseUrl: p.baseUrl,
          apiKeyRef: p.apiKeyRef,
          priority: maxP + 1,
        });
        poolIds.add(id);
        added++;
      } catch {
        // 跳过失败候选
      }
    }
  }
  // 内置服务商免费候选（嵌入池：Cloudflare bge / NVIDIA nv-embed）
  added += await discoverBuiltinCandidates(kind, ctx, pool);
  // OpenRouter 目录动态候选（embed/TTS/ASR 的 free 模型，按 output_modalities 精确拉取）
  added += await discoverOpenRouterCatalog(kind, ctx, pool);
  // 统一保存：一次 loadPool、一次 savePool（三个来源共享同一份池快照）
  if (added > 0) {
    pool.updatedAt = Date.now();
    await savePool(kind, pool);
  }
  return added;
}

// ---------------------------------------------------------------------------
// 动态发现：从 OpenRouter /models 目录（带 output_modalities 过滤）拉取各池 free 模型
// ---------------------------------------------------------------------------

const OR_BASE = "https://openrouter.ai/api/v1";

/** OpenRouter 各池对应的 /models?output_modalities= 过滤值。
 *  不带该参数时 /models 默认只返回 chat 模型，embeddings/speech/transcription/rerank
 *  等专用端点模型不会出现在默认列表里，必须用过滤参数才能列出来。 */
const OR_MODALITY_QUERY: Record<PoolKind, string> = {
  embed: "embeddings",
  tts: "speech",
  asr: "transcription",
  rerank: "rerank",
};

/** 从 OpenRouter 目录动态发现 free 模型并端点验证入池。返回新增数量。
 *  验证即真相：目录标注只作候选，端点请求 200 通过才入池。 */
async function discoverOpenRouterCatalog(kind: PoolKind, ctx: ExtensionContext, pool: EPPoolState): Promise<number> {
  const apiKey = await getOpenRouterKey(ctx);
  if (!apiKey) return 0;
  const modality = OR_MODALITY_QUERY[kind];
  let raw: RawORModel[];
  try {
    const res = await fetch(`${OR_BASE}/models?output_modalities=${modality}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return 0;
    const j = (await res.json()) as { data?: RawORModel[] };
    raw = Array.isArray(j.data) ? j.data : [];
  } catch {
    return 0;
  }
  const free = raw.filter(isFreeModel);
  if (free.length === 0) return 0;
  const poolIds = new Set(pool.models.map((m) => m.id));
  let added = 0;
  for (const m of free) {
    const id = m.id;
    if (poolIds.has(id)) continue;
    try {
      const spec = KIND_SPECS[kind];
      const { body, formData } = spec.verifyBody(id);
      const r = await sendEndpointRequest(
        OR_BASE,
        apiKey,
        kind,
        id,
        body,
        AbortSignal.timeout(20_000),
        formData,
      );
      if (!spec.verifyOk(r.status, r.text)) continue;
      const maxP = Math.max(0, ...pool.models.map((mm) => mm.priority));
      pool.models.push({
        id,
        provider: "openrouter",
        baseUrl: OR_BASE,
        apiKeyRef: "$OPENROUTER_API_KEY",
        priority: maxP + 1,
      });
      poolIds.add(id);
      added++;
    } catch {
      // 跳过失败候选
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// 刷新调度（TTL）：池为空或过期时自动重新发现（启动后台 / 用到时懒刷新 / 手动）
// ---------------------------------------------------------------------------

function isFresh(pool: EPPoolState): boolean {
  return (
    pool.models.length > 0 &&
    Date.now() - pool.updatedAt < pool.config.ttlHours * 3_600_000
  );
}

const refreshingKind = new Map<PoolKind, Promise<EPPoolState>>();

async function refreshKind(kind: PoolKind, ctx: ExtensionContext): Promise<EPPoolState> {
  const existing = refreshingKind.get(kind);
  if (existing) return existing;
  const task = (async () => {
    await discoverKind(ctx, kind);
    const pool = await loadPool(kind);
    pool.updatedAt = Date.now();
    await savePool(kind, pool);
    return pool;
  })();
  refreshingKind.set(kind, task);
  try {
    return await task;
  } finally {
    refreshingKind.delete(kind);
  }
}

async function ensureFreshPool(kind: PoolKind, ctx: ExtensionContext): Promise<EPPoolState> {
  const pool = await loadPool(kind);
  if (isFresh(pool)) return pool;
  try {
    return await refreshKind(kind, ctx);
  } catch {
    return pool; // 刷新失败不阻塞，用旧池
  }
}

// ---------------------------------------------------------------------------
// 内置服务商免费候选（端点验证后入池，不依赖 /models 列表）
// ---------------------------------------------------------------------------

interface BuiltinCandidate {
  provider: string;
  keyEnv: string;
  baseUrl: () => string | undefined;
  models: Array<{ id: string; body?: Record<string, unknown> }>;
}

/** 已知可用的免费端点模型候选（OpenRouter 隐藏模型 + 内置服务商） */
const BUILTIN_CANDIDATES: Record<PoolKind, BuiltinCandidate[]> = {
  embed: [
    {
      provider: "openrouter",
      keyEnv: "OPENROUTER_API_KEY",
      baseUrl: () => "https://openrouter.ai/api/v1",
      models: [
        { id: "nvidia/nemotron-3-embed-1b:free" },
        { id: "nvidia/llama-nemotron-embed-vl-1b-v2:free" },
      ],
    },
    {
      provider: "cloudflare-workers-ai",
      keyEnv: "CLOUDFLARE_API_KEY",
      baseUrl: () => {
        const acc = getEnvValue("CLOUDFLARE_ACCOUNT_ID");
        return acc ? `https://api.cloudflare.com/client/v4/accounts/${acc}/ai/v1` : undefined;
      },
      models: [
        { id: "@cf/baai/bge-base-en-v1.5" },
        { id: "@cf/baai/bge-small-en-v1.5" },
        { id: "@cf/baai/bge-m3" },
      ],
    },
    {
      provider: "nvidia",
      keyEnv: "NVIDIA_API_KEY",
      baseUrl: () => "https://integrate.api.nvidia.com/v1",
      models: [
        { id: "nvidia/nv-embed-v1" },
        { id: "nvidia/embed-qa-4" },
        { id: "nvidia/nv-embedqa-e5-v5", body: { input_type: "query" } },
      ],
    },
  ],
  tts: [
    {
      provider: "xiaomi-clean",
      keyEnv: "MIMO_API_KEY",
      baseUrl: () => "https://api.xiaomimimo.com/v1",
      models: [{ id: "mimo-v2.5-tts" }],
    },
    {
      provider: "openrouter",
      keyEnv: "OPENROUTER_API_KEY",
      baseUrl: () => "https://openrouter.ai/api/v1",
      models: [
        { id: "deepgram/flux-tts:free" },
        { id: "fish-audio/s2.1-pro-free:free" },
      ],
    },
  ],
  asr: [
    {
      provider: "xiaomi-clean",
      keyEnv: "MIMO_API_KEY",
      baseUrl: () => "https://api.xiaomimimo.com/v1",
      models: [{ id: "mimo-v2.5-asr" }],
    },
  ],
  rerank: [
    {
      provider: "openrouter",
      keyEnv: "OPENROUTER_API_KEY",
      baseUrl: () => "https://openrouter.ai/api/v1",
      models: [{ id: "nvidia/llama-nemotron-rerank-vl-1b-v2:free" }],
    },
  ],
};

/** 从 TTS 400 错误信息里提取受支持的 voice（优先带 -en 后缀的）。 */
function extractSupportedVoice(errorText: string): string | undefined {
  const names = errorText.match(/[a-z0-9-]+-en|[a-z0-9]+-[a-z0-9]+-en|[a-z0-9-]+/g) ?? [];
  return names.find((v) => /-en$/.test(v) || v.includes("-"));
}

/** TTS 等端点：400 时从错误信息提取支持的 voice 并重试（自动适配）。 */
async function sendWithVoiceAdapt(baseUrl: string, apiKey: string, kind: PoolKind, m: { id: string; body?: Record<string, unknown> }, signal: AbortSignal): Promise<{ status: number; text: string; buffer?: Buffer }> {
  let body = { model: m.id, input: "hi", voice: kind === "tts" ? "alloy" : undefined, ...(m.body ?? {}) };
  let r = await sendEndpointRequest(baseUrl, apiKey, kind, m.id, body, signal);
  if (r.status === 400 && kind === "tts" && r.text.includes("Supported voices")) {
    const voice = extractSupportedVoice(r.text);
    if (voice) {
      body = { model: m.id, input: "hi", voice, ...(m.body ?? {}) };
      r = await sendEndpointRequest(baseUrl, apiKey, kind, m.id, body, signal);
    }
  }
  return r;
}

/** 小米验证：TTS/ASR 走 chat/completions 特殊格式（api-key header）。 */
async function verifyXiaomi(kind: PoolKind, key: string): Promise<boolean> {
  try {
    const headers = { "Content-Type": "application/json", "api-key": key };
    const base = "https://api.xiaomimimo.com/v1/chat/completions";
    let body: unknown;
    if (kind === "tts") {
      body = {
        model: "mimo-v2.5-tts",
        messages: [
          { role: "user", content: "正常语速，中文朗读" },
          { role: "assistant", content: "你好。" },
        ],
        audio: { format: "wav", voice: "Chloe" },
      };
    } else {
      // 真实正弦波 wav（1 秒 440Hz）：小米 ASR 对静音音频返回 500
      const sr = 16000;
      const n = sr;
      const samples = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) {
        samples.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 8000), i * 2);
      }
      const header = Buffer.alloc(44);
      header.write("RIFF", 0);
      header.writeUInt32LE(36 + samples.length, 4);
      header.write("WAVE", 8);
      header.write("fmt ", 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(sr, 24);
      header.writeUInt32LE(sr * 2, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write("data", 36);
      header.writeUInt32LE(samples.length, 40);
      const wav = Buffer.concat([header, samples]);
      body = {
        model: "mimo-v2.5-asr",
        messages: [
          {
            role: "user",
            content: [
              { type: "input_audio", input_audio: { data: "data:audio/wav;base64," + wav.toString("base64") } },
            ],
          },
        ],
      };
    }
    const r = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const t = await r.text();
    if (r.status !== 200) return false;
    if (kind === "tts") return t.includes("audio") && t.includes("UklGR");
    return t.includes("content");
  } catch {
    return false;
  }
}

/** 发现已知免费端点模型候选（OpenRouter 隐藏模型 + 内置服务商 + 小米特殊格式）并入池。返回新增数量。 */
async function discoverBuiltinCandidates(kind: PoolKind, ctx: ExtensionContext, pool: EPPoolState): Promise<number> {
  const candidates = BUILTIN_CANDIDATES[kind];
  if (candidates.length === 0) return 0;
  const poolIds = new Set(pool.models.map((m) => m.id));
  let added = 0;
  for (const c of candidates) {
    const apiKey = c.provider === "xiaomi-clean"
      ? getXiaomiKey()
      : c.provider === "openrouter"
        ? await getOpenRouterKey(ctx)
        : getEnvValue(c.keyEnv);
    const baseUrl = c.baseUrl();
    if (!apiKey || !baseUrl) continue;
    for (const m of c.models) {
      if (poolIds.has(m.id)) continue;
      try {
        if (c.provider === "xiaomi-clean") {
          const ok = await verifyXiaomi(kind, apiKey);
          if (!ok) continue;
        } else {
          const r = await sendWithVoiceAdapt(baseUrl, apiKey, kind, m, AbortSignal.timeout(20_000));
          if (!KIND_SPECS[kind].verifyOk(r.status, r.text)) continue;
        }
        const maxP = Math.max(0, ...pool.models.map((mm) => mm.priority));
        pool.models.push({
          id: m.id,
          provider: c.provider,
          baseUrl,
          apiKeyRef: `$${c.keyEnv}`,
          priority: maxP + 1,
        });
        poolIds.add(m.id);
        added++;
      } catch {
        // 跳过
      }
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

/** 按优先级返回候选模型（数字越小越优先）。modelId 匹配项排最前，其余兜底。 */
function candidatesOf(pool: EPPoolState, modelId?: string): EPPoolModel[] {
  const sorted = pool.models
    .slice()
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  if (!modelId) return sorted;
  const matched = sorted.filter((m) => m.id.includes(modelId));
  return matched.length > 0
    ? [...matched, ...sorted.filter((m) => !matched.includes(m))]
    : sorted;
}

/** 嵌入：文本 → 向量 JSON（按优先级依次尝试，全失败可刷新重试）。 */
async function embedText(ctx: ExtensionContext, text: string, signal?: AbortSignal): Promise<{ model: string; dim: number; vector: number[] }> {
  const attempt = async (pool: EPPoolState): Promise<{ model: string; dim: number; vector: number[] }> => {
    const errors: string[] = [];
    for (const m of candidatesOf(pool)) {
      try {
        const key = resolvePoolKey(m.apiKeyRef);
        const r = await sendEndpointRequest(m.baseUrl, key ?? "", "embed", m.id, { model: m.id, input: text }, signal ?? AbortSignal.timeout(60_000));
        if (r.status !== 200) throw new Error(`HTTP ${r.status} ${r.text.slice(0, 150)}`);
        const j = JSON.parse(r.text) as { data?: Array<{ embedding?: number[] }> };
        const vec = j.data?.[0]?.embedding;
        if (!vec) throw new Error("响应中没有 embedding");
        return { model: m.id, dim: vec.length, vector: vec.slice(0, 8) };
      } catch (err) {
        errors.push(`${m.id}: ${errMsg(err)}`);
      }
    }
    throw new Error(errors.length ? errors.join("；") : "嵌入池为空");
  };
  const pool = await ensureFreshPool("embed", ctx);
  if (pool.models.length === 0) throw new Error("嵌入池为空，请先运行 /embed-discover");
  try {
    return await attempt(pool);
  } catch (firstErr) {
    if (!pool.config.refreshOnAllFailed) throw firstErr;
    try {
      return await attempt(await refreshKind("embed", ctx));
    } catch {
      throw firstErr;
    }
  }
}

/** TTS 单模型调用（小米特殊格式 + 通用 /audio/speech 两路径）。 */
async function synthesizeOnce(m: EPPoolModel, text: string, signal: AbortSignal): Promise<{ path: string; model: string }> {
  if (m.provider === "xiaomi-clean") {
    const key = getXiaomiKey();
    if (!key) throw new Error("未找到小米 API key（MIMO_API_KEY 或 auth.json xiaomi-clean）");
    const r = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": key },
      body: JSON.stringify({
        model: "mimo-v2.5-tts",
        messages: [
          { role: "user", content: "正常语速，中文朗读，发音清晰" },
          { role: "assistant", content: text },
        ],
        audio: { format: "wav", voice: "Chloe" },
      }),
      signal,
    });
    const t = await r.text();
    if (r.status !== 200) throw new Error("HTTP " + r.status + " " + t.slice(0, 150));
    const j = JSON.parse(t) as { choices?: Array<{ message?: { audio?: { data?: string } } }> };
    const audioData = j.choices?.[0]?.message?.audio?.data;
    if (!audioData) throw new Error("响应中没有音频数据");
    const outDir = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "Downloads");
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = join(outDir, "wanchuan-tts-" + stamp + ".wav");
    await writeFile(file, Buffer.from(audioData, "base64"));
    return { path: file, model: "mimo-v2.5-tts" };
  }
  const key = resolvePoolKey(m.apiKeyRef);
  let body: Record<string, unknown> = { model: m.id, input: text, voice: "alloy", response_format: "mp3" };
  let r = await sendEndpointRequest(m.baseUrl, key ?? "", "tts", m.id, body, signal);
  if (r.status === 400 && r.text.includes("Supported voices")) {
    const voice = extractSupportedVoice(r.text);
    if (voice) {
      body = { model: m.id, input: text, voice, response_format: "mp3" };
      r = await sendEndpointRequest(m.baseUrl, key ?? "", "tts", m.id, body, signal);
    }
  }
  if (r.status !== 200 || !r.buffer || r.buffer.length === 0) {
    throw new Error(`HTTP ${r.status} ${r.text.slice(0, 150)}`);
  }
  const outDir = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "Downloads");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = join(outDir, `wanchuan-tts-${stamp}.mp3`);
  await writeFile(file, r.buffer);
  return { path: file, model: m.id };
}

/** TTS：文本 → 音频文件路径（按优先级依次尝试，全失败可刷新重试）。 */
async function synthesizeSpeech(
  ctx: ExtensionContext,
  text: string,
  signal?: AbortSignal,
): Promise<{ path: string; model: string }> {
  const attempt = async (pool: EPPoolState): Promise<{ path: string; model: string }> => {
    const errors: string[] = [];
    for (const m of candidatesOf(pool)) {
      try {
        return await synthesizeOnce(m, text, signal ?? AbortSignal.timeout(120_000));
      } catch (err) {
        errors.push(`${m.id}: ${errMsg(err)}`);
      }
    }
    throw new Error(errors.length ? errors.join("；") : "TTS 池为空");
  };
  const pool = await ensureFreshPool("tts", ctx);
  if (pool.models.length === 0) throw new Error("TTS 池为空，请先运行 /tts-discover");
  try {
    return await attempt(pool);
  } catch (firstErr) {
    if (!pool.config.refreshOnAllFailed) throw firstErr;
    try {
      return await attempt(await refreshKind("tts", ctx));
    } catch {
      throw firstErr;
    }
  }
}

/** ASR 单模型调用（小米特殊格式 + 通用 /audio/transcriptions 两路径）。 */
async function transcribeOnce(m: EPPoolModel, audioPath: string, signal: AbortSignal): Promise<{ text: string; model: string }> {
  if (m.provider === "xiaomi-clean") {
    const key = getXiaomiKey();
    if (!key) throw new Error("未找到小米 API key（MIMO_API_KEY 或 auth.json xiaomi-clean）");
    const buf = await readFile(audioPath);
    const r = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": key },
      body: JSON.stringify({
        model: "mimo-v2.5-asr",
        messages: [
          {
            role: "user",
            content: [
              { type: "input_audio", input_audio: { data: "data:audio/wav;base64," + buf.toString("base64") } },
            ],
          },
        ],
      }),
      signal,
    });
    const t = await r.text();
    if (r.status !== 200) throw new Error("HTTP " + r.status + " " + t.slice(0, 150));
    const j = JSON.parse(t) as { choices?: Array<{ message?: { content?: string } }> };
    return { text: j.choices?.[0]?.message?.content ?? "", model: "mimo-v2.5-asr" };
  }
  const key = resolvePoolKey(m.apiKeyRef);
  const buf = await readFile(audioPath);
  const fd = new FormData();
  fd.append("model", m.id);
  fd.append(
    "file",
    new Blob([buf], { type: "audio/wav" }),
    audioPath.split("/").pop() ?? audioPath.split("\\").pop() ?? "audio.wav",
  );
  const res = await fetch(`${m.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key ?? ""}` },
    body: fd,
    signal,
  });
  const text = await res.text().catch(() => "");
  if (res.status !== 200) throw new Error(`HTTP ${res.status} ${text.slice(0, 150)}`);
  const j = JSON.parse(text) as { text?: string };
  return { text: j.text ?? text, model: m.id };
}

/** ASR：音频文件 → 文本（按优先级依次尝试，全失败可刷新重试）。 */
async function transcribeAudio(
  ctx: ExtensionContext,
  audioPath: string,
  signal?: AbortSignal,
): Promise<{ text: string; model: string }> {
  const attempt = async (pool: EPPoolState): Promise<{ text: string; model: string }> => {
    const errors: string[] = [];
    for (const m of candidatesOf(pool)) {
      try {
        return await transcribeOnce(m, audioPath, signal ?? AbortSignal.timeout(120_000));
      } catch (err) {
        errors.push(`${m.id}: ${errMsg(err)}`);
      }
    }
    throw new Error(errors.length ? errors.join("；") : "ASR 池为空");
  };
  const pool = await ensureFreshPool("asr", ctx);
  if (pool.models.length === 0) throw new Error("ASR 池为空，请先运行 /asr-discover");
  try {
    return await attempt(pool);
  } catch (firstErr) {
    if (!pool.config.refreshOnAllFailed) throw firstErr;
    try {
      return await attempt(await refreshKind("asr", ctx));
    } catch {
      throw firstErr;
    }
  }
}

// ---------------------------------------------------------------------------
/** 重排：query + 文档列表 → 按相关性降序的结果（按优先级依次尝试，全失败可刷新重试）。 */
async function rerankText(
  ctx: ExtensionContext,
  query: string,
  documents: string[],
  signal?: AbortSignal,
): Promise<{ model: string; results: Array<{ index: number; score: number; text: string }> }> {
  const attempt = async (pool: EPPoolState): Promise<{ model: string; results: Array<{ index: number; score: number; text: string }> }> => {
    const errors: string[] = [];
    for (const m of candidatesOf(pool)) {
      try {
        const key = resolvePoolKey(m.apiKeyRef);
        const r = await sendEndpointRequest(
          m.baseUrl, key ?? "", "rerank", m.id,
          { model: m.id, query, documents },
          signal ?? AbortSignal.timeout(60_000),
        );
        if (r.status !== 200) throw new Error(`HTTP ${r.status} ${r.text.slice(0, 150)}`);
        const j = JSON.parse(r.text) as {
          results?: Array<{ index?: number; relevance_score?: number; document?: { text?: string } }>;
        };
        const results = (j.results ?? [])
          .map((x) => ({
            index: typeof x.index === "number" ? x.index : -1,
            score: typeof x.relevance_score === "number" ? x.relevance_score : 0,
            text: x.document?.text ?? documents[x.index ?? -1] ?? "",
          }))
          .sort((a, b) => b.score - a.score);
        if (results.length === 0) throw new Error("响应中没有重排结果");
        return { model: m.id, results };
      } catch (err) {
        errors.push(`${m.id}: ${errMsg(err)}`);
      }
    }
    throw new Error(errors.length ? errors.join("；") : "重排池为空");
  };
  const pool = await ensureFreshPool("rerank", ctx);
  if (pool.models.length === 0) throw new Error("重排池为空，请先运行 /rerank-discover");
  try {
    return await attempt(pool);
  } catch (firstErr) {
    if (!pool.config.refreshOnAllFailed) throw firstErr;
    try {
      return await attempt(await refreshKind("rerank", ctx));
    } catch {
      throw firstErr;
    }
  }
}

// 命令与工具注册
// ---------------------------------------------------------------------------

function registerKindCommands(pi: ExtensionAPI, kind: PoolKind): void {
  const spec = KIND_SPECS[kind];
  const prefix = kind;

  pi.registerCommand(`${prefix}-pool`, {
    description: `查看${spec.label}池（按优先级排序）。可选参数：all`,
    handler: async (args, ctx) => {
      const pool = await loadPool(kind);
      if (pool.models.length === 0) {
        ctx.ui.notify(`${spec.label}池为空，请先运行 /${prefix}-discover`, "warning");
        return;
      }
      const list = pool.models
        .slice()
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
        .filter((m) => args.trim() !== "all" || true);
      const lines = [
        `${spec.label}池：${list.length} 个模型，更新于 ${pool.updatedAt ? new Date(pool.updatedAt).toLocaleString() : "从未"}`,
        `用法：/${prefix}-discover 发现新模型 · /${prefix}-priority 设置优先级`,
        ``,
        ...list.map(
          (m, i) =>
            `${String(i + 1).padStart(3)}. [${String(m.priority).padStart(3)}] ${m.provider}/${m.id}` +
            `${m.userSet ? "  [自定义优先级]" : ""}`,
        ),
      ];
      if (ctx.mode === "tui") {
        await ctx.ui.editor(`${spec.label}池`, lines.join("\n"));
      } else {
        ctx.ui.notify(lines.slice(0, 2).join(" | "), "info");
      }
    },
  });

  pi.registerCommand(`${prefix}-discover`, {
    description: `从用户配置的模型服务商发现${spec.label}模型（关键词候选 + 端点实测验证）`,
    handler: async (_args, ctx) => {
      ctx.ui.notify(`正在从用户服务商发现${spec.label}模型…`, "info");
      try {
        const n = await discoverKind(ctx, kind);
        ctx.ui.notify(
          n > 0
            ? `${spec.label}池：新增 ${n} 个模型（端点验证通过）`
            : `${spec.label}池：没有发现新的可用模型`,
          n > 0 ? "info" : "warning",
        );
      } catch (err) {
        ctx.ui.notify(`发现失败：${errMsg(err)}`, "error");
      }
    },
  });

  pi.registerCommand(`${prefix}-refresh`, {
    description: `强制刷新${spec.label}池（重新发现并验证模型，含 OpenRouter 免费模型）`,
    handler: async (_args, ctx) => {
      ctx.ui.notify(`正在刷新${spec.label}池…`, "info");
      try {
        await refreshKind(kind, ctx);
        const pool = await loadPool(kind);
        ctx.ui.notify(
          `${spec.label}池已刷新：在线 ${pool.models.length} 个模型`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`刷新失败：${errMsg(err)}`, "error");
      }
    },
  });

  pi.registerCommand(`${prefix}-priority`, {
    description: `设置${spec.label}池模型优先级。用法：/${prefix}-priority [数字] [关键字]`,
    handler: async (args, ctx) => {
      const pool = await loadPool(kind);
      if (pool.models.length === 0) {
        ctx.ui.notify(`${spec.label}池为空`, "warning");
        return;
      }
      const trimmed = (args || "").trim();
      let priority: number | undefined;
      let keyword = "";
      const m = trimmed.match(/^(\d{1,5})\s+(.+)$/);
      if (m) {
        priority = parseInt(m[1], 10);
        keyword = m[2].toLowerCase();
      } else if (/^\d{1,5}$/.test(trimmed)) {
        priority = parseInt(trimmed, 10);
      } else {
        keyword = trimmed.toLowerCase();
      }
      const matches = keyword
        ? pool.models.filter((mm) => mm.id.toLowerCase().includes(keyword))
        : pool.models;
      if (matches.length === 0) {
        ctx.ui.notify(`没有找到匹配“${keyword}”的模型`, "warning");
        return;
      }
      let target: EPPoolModel | undefined;
      if (matches.length === 1) {
        target = matches[0];
      } else {
        const picked = await ctx.ui.select(
          `选择模型（${matches.length} 个匹配）：`,
          matches.map((mm) => `[${mm.priority}] ${mm.id}`),
        );
        target = matches.find((mm) => `[${mm.priority}] ${mm.id}` === picked);
      }
      if (!target) return;
      if (priority === undefined) {
        const input = await ctx.ui.input("优先级（数字越小越优先）", String(target.priority));
        if (input === undefined || input.trim() === "") return;
        priority = parseInt(input.trim(), 10);
        if (Number.isNaN(priority)) {
          ctx.ui.notify("优先级必须是数字", "warning");
          return;
        }
      }
      pool.models = pool.models.map((mm) =>
        mm.id === target!.id ? { ...mm, priority, userSet: true } : mm,
      );
      await savePool(kind, pool);
      ctx.ui.notify(`已设置 ${target!.id} 的优先级为 ${priority}`, "info");
    },
  });
}

export function initEndpointPools(pi: ExtensionAPI): void {
  for (const kind of ["embed", "tts", "asr", "rerank"] as PoolKind[]) {
    registerKindCommands(pi, kind);
  }

  // ---- 自动发现调度：池为空或过期（TTL）且已配置对应 key 时，后台自动刷新 ----
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "print") return;
    void (async () => {
      for (const kind of ["embed", "tts", "asr", "rerank"] as PoolKind[]) {
        try {
          const pool = await loadPool(kind);
          if (pool.models.length > 0 && isFresh(pool)) continue;
          if (pool.models.length > 0 && !pool.config.refreshOnStartup) continue;
          const hasKey =
            kind === "embed"
              ? !!(getEnvValue("OPENROUTER_API_KEY") ||
                  getEnvValue("CLOUDFLARE_API_KEY") ||
                  getEnvValue("NVIDIA_API_KEY"))
              : kind === "tts" || kind === "asr"
                ? !!(getXiaomiKey() || getEnvValue("OPENROUTER_API_KEY"))
                : !!getEnvValue("OPENROUTER_API_KEY"); // rerank
          if (!hasKey) continue;
          await refreshKind(kind, ctx);
        } catch {
          // 静默：发现失败不影响启动
        }
      }
    })();
  });

  // ---- ASR 自动拦截：用户消息里的音频文件路径 → 自动转录（像图片自动描述一样） ----
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || ctx.mode === "print") return { action: "continue" };
    const text = event.text ?? "";
    if (!text.trim()) return { action: "continue" };
    const audioPool = await loadPool("asr");
    if (audioPool.models.length === 0) return { action: "continue" };
    // 匹配常见音频文件路径（含 Windows/Unix 路径与中文文件名）
    const m = text.match(/[\w:/.\\\-\u4e00-\u9fff]+?\.(?:wav|mp3|m4a|flac|ogg|aac|opus)\b/i);
    if (!m) return { action: "continue" };
    const audioPath = m[0].trim();
    try {
      await import("node:fs/promises").then((f) => f.access(audioPath));
    } catch {
      return { action: "continue" }; // 文件不存在：不拦截
    }
    ctx.ui.notify("[wanchuan] 检测到音频文件，自动转录…", "info");
    try {
      const r = await transcribeAudio(ctx, audioPath);
      const newText =
        text +
        "\n\n> 🎙️ 音频 " +
        audioPath +
        " 已自动转录（" +
        r.model +
        "）：\n" +
        r.text;
      return { action: "transform", text: newText };
    } catch (err) {
      ctx.ui.notify("[wanchuan] 自动转录失败（可手动 /asr 重试）：" + errMsg(err), "warning");
      return { action: "continue" };
    }
  });

  // ---- 工具 ----
  pi.registerTool({
    name: "embed_text",
    label: "Embed Text",
    description:
      "通过嵌入池把文本转为向量（返回维度与前几维）。嵌入池需先 /embed-discover 发现可用模型。可用于相似度/检索场景。",
      promptSnippet: "文本转向量（相似度/检索）",
      promptGuidelines: ["当用户询问文本相似度、语义比较、向量表示、聚类、检索等场景时，使用 embed_text 工具计算向量。"],
    parameters: Type.Object({
      text: Type.String({ description: "要嵌入的文本" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const r = await embedText(ctx, params.text, signal);
      return {
        content: [
          {
            type: "text",
            text: `模型：${r.model}\n维度：${r.dim}\n前 8 维：${JSON.stringify(r.vector)}`,
          },
        ],
        details: { model: r.model, dim: r.dim },
      };
    },
  });

  pi.registerTool({
    name: "text_to_speech",
    label: "Text to Speech",
    description: "通过 TTS 池把文本合成为语音文件（mp3，保存到 Downloads）。需先 /tts-discover。",
    promptSnippet: "朗读/读出文本，生成语音文件",
    promptGuidelines: ["当用户要求朗读、读出、语音播放某段文本或回复时，使用 text_to_speech 工具合成语音文件并告知保存路径。"],
    parameters: Type.Object({
      text: Type.String({ description: "要朗读的文本" }),
      outputPath: Type.Optional(Type.String({ description: "保存路径（默认 Downloads）" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const r = await synthesizeSpeech(ctx, params.text, signal);
      let finalPath = r.path;
      if (params.outputPath) {
        const target = isAbsolute(params.outputPath)
          ? params.outputPath
          : join(ctx.cwd, params.outputPath);
        await mkdir(join(target, ".."), { recursive: true }).catch(() => {});
        await writeFile(target, Buffer.from(await readFile(r.path)));
        finalPath = target;
      }
      return {
        content: [{ type: "text", text: `语音已保存：${finalPath}（模型：${r.model}）` }],
        details: { path: finalPath, model: r.model },
      };
    },
  });

  pi.registerTool({
    name: "transcribe_audio",
    label: "Transcribe Audio",
    description: "通过 ASR 池把音频文件转为文本。需先 /asr-discover。",
    promptSnippet: "转写/听写音频文件",
    promptGuidelines: ["当用户提供音频文件路径并要求转写内容时，使用 transcribe_audio 工具（用户消息中的音频路径通常已被自动转录，仅当自动转录失败或用户明确要求时使用本工具）。"],
    parameters: Type.Object({
      audioPath: Type.String({ description: "音频文件路径（wav/mp3 等）" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const resolvedPath = isAbsolute(params.audioPath)
        ? params.audioPath
        : join(ctx.cwd, params.audioPath);
      const r = await transcribeAudio(ctx, resolvedPath, signal);
      return {
        content: [{ type: "text", text: `转录结果（${r.model}）：\n${r.text}` }],
        details: { model: r.model },
      };
    },
  });

  pi.registerTool({
    name: "rerank_text",
    label: "Rerank Text",
    description: "通过重排池把文档列表按与查询的相关性排序（返回索引/分数/文本）。重排池需先 /rerank-discover。",
    promptSnippet: "文档重排（相关性排序）",
    promptGuidelines: ["当用户要求对搜索候选、检索结果、文档片段按与查询的相关性排序时，使用 rerank_text 工具。"],
    parameters: Type.Object({
      query: Type.String({ description: "查询文本" }),
      documents: Type.Array(Type.String(), { description: "待排序的文档/文本列表" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const r = await rerankText(ctx, params.query, params.documents, signal);
      return {
        content: [
          {
            type: "text",
            text:
              `模型：${r.model}\n按相关性排序（${r.results.length} 条）：\n` +
              r.results.map((x, i) => `${i + 1}. [${x.score.toFixed(4)}] ${x.text}`).join("\n"),
          },
        ],
        details: { model: r.model, results: r.results },
      };
    },
  });

  // ---- 便捷命令 ----
  pi.registerCommand("embed", {
    description: "文本 → 向量（嵌入池）。用法：/embed <文本>",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("用法：/embed <文本>", "warning");
        return;
      }
      try {
        const r = await embedText(ctx, args.trim());
        ctx.ui.notify(`嵌入（${r.model}）：维度 ${r.dim}，前 8 维 ${JSON.stringify(r.vector)}`, "info");
      } catch (err) {
        ctx.ui.notify(`嵌入失败：${errMsg(err)}`, "error");
      }
    },
  });

  pi.registerCommand("tts", {
    description: "文本 → 语音文件（TTS 池）。用法：/tts <文本>",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("用法：/tts <文本>", "warning");
        return;
      }
      ctx.ui.notify("正在合成语音…", "info");
      try {
        const r = await synthesizeSpeech(ctx, args.trim());
        ctx.ui.notify(`✅ 语音已保存：${r.path}（${r.model}）`, "info");
      } catch (err) {
        ctx.ui.notify(`合成失败：${errMsg(err)}`, "error");
      }
    },
  });

  pi.registerCommand("asr", {
    description: "音频 → 文本（ASR 池）。用法：/asr <音频文件路径>",
    handler: async (args, ctx) => {
      const path = args.trim();
      if (!path) {
        ctx.ui.notify("用法：/asr <音频文件路径>", "warning");
        return;
      }
      ctx.ui.notify("正在转录…", "info");
      try {
        const r = await transcribeAudio(ctx, path);
        ctx.ui.notify(`转录结果（${r.model}）：${r.text.slice(0, 200)}`, "info");
      } catch (err) {
        ctx.ui.notify(`转录失败：${errMsg(err)}`, "error");
      }
    },
  });

  pi.registerCommand("rerank", {
    description: "文档重排（重排池）。用法：/rerank <查询> | <文档1> | <文档2> …",
    handler: async (args, ctx) => {
      const parts = args
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length < 2) {
        ctx.ui.notify("用法：/rerank <查询> | <文档1> | <文档2> …", "warning");
        return;
      }
      const query = parts[0];
      const documents = parts.slice(1);
      ctx.ui.notify("正在重排…", "info");
      try {
        const r = await rerankText(ctx, query, documents);
        const top = r.results
          .slice(0, 5)
          .map((x, i) => `${i + 1}.${x.text.slice(0, 24)}(${x.score.toFixed(3)})`)
          .join("  ");
        ctx.ui.notify(`重排结果（${r.model}）：${top}`, "info");
      } catch (err) {
        ctx.ui.notify(`重排失败：${errMsg(err)}`, "error");
      }
    },
  });
}
