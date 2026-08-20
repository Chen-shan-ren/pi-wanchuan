/**
 * vision-pool.ts — 视觉模型池（Vision Pool）扩展
 *
 * 解决的问题：
 *   当当前模型是纯文本模型时，用户上传的图片无法被模型看到。本扩展会在
 *   用户消息进入 LLM 之前自动拦截：检测到图片 + 当前模型不支持图片输入时，
 *   自动调用"视觉模型池"中优先级最高的多模态模型（走 OpenRouter API）
 *   识别图片，并把识别出的文字描述注入消息（原始图片从消息中移除）。
 *   文本模型看到的是描述文字，完全无需用户或模型手动干预。
 *
 * 视觉模型池：
 *   1. OpenRouter 公开接口 https://openrouter.ai/api/v1/models 中支持图片输入
 *      （input_modalities 含 image）的免费多模态模型（includePaid=false 时只保留免费），
 *      缓存到 ~/.pi/agent/vision-pool.json。OpenRouter 的 free 模型会不定期上架/
 *      下架，因此池需要周期性刷新（见“刷新策略”）。
 *   2. pi 模型注册表中你自己配置的多模态模型（如 models.json 里自定义的
 *      xiaomi-clean/mimo-v2.5、sensenova-6.x 等，includeRegistryModels=true 时自动纳入），
 *      调用时直接走 pi 自身的模型调用层（鉴权/协议自动处理）。
 *
 * 刷新策略（混合式）：
 *   1. 懒刷新 + TTL：池过期（默认 24h）后，第一次真正需要视觉能力时先刷新再用；
 *   2. 启动后台刷新：pi 启动时若池已过期，在后台异步刷新（不阻塞启动，离线也能用旧池）；
 *   3. 手动刷新：/mm-refresh 随时强制刷新；
 *   4. 失败触发：池中所有候选模型都调用失败（例如免费模型被下架）时，
 *      自动强制刷新一次并用新池重试。
 *   之所以不全在启动时刷新：启动刷新会引入网络依赖、拖慢启动，且模型上架
 *   下架是按天级别的变化；之所以不全在用时刷新：首次使用会慢，且过期池中
 *   的模型可能已失效。混合策略兼顾新鲜度与启动速度。
 *
 * 优先级：
 *   数字越小越优先（1 = 最高）。默认：免费模型按上下文长度降序排 1..N，
 *   付费模型排 10000+，即"免费优先"；用户手动设置过的优先级（userSet）
 *   在每次刷新时保留。下架的模型不会删除，而是标记 offline（⚠），
 *   不再参与调用，恢复上架后自动解除标记。
 *
 * 命令：
 *   /mm-pool [free|paid|all|offline]  查看模型池（按优先级排序）
 *   /mm-refresh                       强制从 OpenRouter 刷新模型池
 *   /mm-priority [数字] [关键字]      设置模型优先级（无参数时交互选择）
 *   /mm-status                        当前模型与模型池状态
 *   /mm-config                        查看扩展配置
 *
 * 工具（LLM 可调用）：
 *   describe_image   显式描述一张图片（本地路径 / data URL / 裸 base64）
 *   mm_pool_info     查询视觉池信息（数量、优先级、免费/付费等）
 *
 * 配置（~/.pi/agent/vision-pool.json 的 config 字段，改后 /reload 生效）：
 *   ttlHours            池过期时间（小时），默认 24
 *   refreshOnStartup    启动时后台异步刷新，默认 true
 *   refreshOnAllFailed  全部候选失败时强制刷新重试，默认 true
 *   freeFirst           免费模型默认排前面，默认 true
 *   includePaid         池中是否包含付费模型，默认 true
 *   maxModels           池容量上限，默认 200
 *   includeRegistryModels  自动把 pi 中已配置鉴权的多模态模型（如自定义的
 *                      mimo-v2.5）纳入池，默认 true
 *   describeMaxTokens   识别输出的最大 token，默认 2048
 *   forceDescribe       即使当前模型支持图片也强制走视觉池，默认 false
 *   openrouterBaseUrl   OpenRouter API 地址，默认 https://openrouter.ai/api/v1
 *   describePrompt      发给视觉模型的识别提示词
 *
 * 依赖：
 *   OpenRouter API key —— 自动复用 pi 中 openrouter provider 的凭据
 *   （/login openrouter 或 OPENROUTER_API_KEY 环境变量），无需额外配置。
 *   拉取模型列表本身是公开接口，不需要 key。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join, isAbsolute } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { getOpenRouterCatalog, isFreeModel, type RawORModel } from "./or-free.ts";
import { getEnvValue, resolveApiKey } from "./shared.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface ImageContentLike {
  type: "image";
  data: string;
  mimeType: string;
}

interface PoolModel {
  id: string;
  name: string;
  contextLength: number;
  free: boolean;
  priority: number; // 1 = 最高
  userSet?: boolean; // 优先级是否由用户手动设置（刷新时保留）
  offline?: boolean; // 已从 OpenRouter 下架
  source?: "openrouter" | "registry" | "discovered"; // 来源：OpenRouter / 注册表 / AI 自动发现
  provider?: string; // registry/discovered 条目的 provider id（如 xiaomi-clean）
  baseUrl?: string; // discovered：服务商 baseUrl
  apiKeyRef?: string; // discovered：服务商 apiKey 的环境变量引用（如 $MODELSCOPE_API_TOKEN）
  reasoning?: boolean; // discovered：LLM 判定的推理能力
  pricing?: { prompt?: string; completion?: string };
}

/** pi 注册表中支持图片输入且已配置鉴权的模型（用户自定义/已登录的多模态模型）。 */
interface RegistryModelInfo {
  provider: string;
  id: string;
  name: string;
  contextLength: number;
}

interface PoolConfig {
  ttlHours: number;
  refreshOnStartup: boolean;
  refreshOnAllFailed: boolean;
  freeFirst: boolean;
  includePaid: boolean;
  maxModels: number;
  describeMaxTokens: number;
  forceDescribe: boolean;
  openrouterBaseUrl: string;
  describePrompt: string;
  /** AI 自动发现（默认关闭）：读取用户配置的服务商并调用其 /models 接口，
   *  用用户的模型分析出多模态模型并实测验证后加入池 */
  autoDiscover: boolean;
  /** 用于分析的模型："provider/model" 或空（空=用当前激活模型） */
  discoverModel: string;
  /** 只纳入 LLM 判定为免费的新模型 */
  discoverFreeOnly: boolean;
}

interface PoolState {
  updatedAt: number;
  models: PoolModel[];
  config: PoolConfig;
}

// ---------------------------------------------------------------------------
// 常量与默认配置
// ---------------------------------------------------------------------------

const POOL_FILE = join(getAgentDir(), "vision-pool.json");
const DESCRIBE_TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // base64 上限（约 15MB 原始数据）

const DEFAULT_CONFIG: PoolConfig = {
  ttlHours: 24,
  refreshOnStartup: true,
  refreshOnAllFailed: true,
  freeFirst: true,
  includePaid: false,
  includeRegistryModels: true,
  maxModels: 200,
  describeMaxTokens: 2048,
  forceDescribe: false,
  openrouterBaseUrl: "https://openrouter.ai/api/v1",
  autoDiscover: false,
  discoverModel: "",
  // LLM 对“免费”判断不可靠（服务商不标注），默认收录所有多模态模型，
  // 免费标记只影响优先级排序；设为 true 可严格只收 LLM 判定为免费的
  discoverFreeOnly: false,
  describePrompt:
    "你是图片识别代理。请用中文详细描述用户提供的图片内容：包括可见的文字（原样转录）、界面/布局、图表数据、颜色、物体与场景等所有重要细节。若有多张图片，请按图片顺序逐张描述，并分别标注“图片 1”、“图片 2”。只输出描述本身，不要输出任何解释或前言。",
};

// ---------------------------------------------------------------------------
// 池文件读写
// ---------------------------------------------------------------------------

async function loadPool(): Promise<PoolState> {
  try {
    const raw = await readFile(POOL_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<PoolState>;
    if (parsed && Array.isArray(parsed.models)) {
      return {
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
        models: parsed.models.filter((m) => m && typeof m.id === "string"),
        config: { ...DEFAULT_CONFIG, ...(parsed.config ?? {}) },
      };
    }
  } catch {
    // 首次运行或文件损坏：返回空池
  }
  return { updatedAt: 0, models: [], config: { ...DEFAULT_CONFIG } };
}

async function savePool(pool: PoolState): Promise<void> {
  try {
    await mkdir(join(getAgentDir()), { recursive: true });
    await writeFile(POOL_FILE, JSON.stringify(pool, null, 2), "utf8");
  } catch (err) {
    throw new Error(`无法写入池文件 ${POOL_FILE}: ${errMsg(err)}`);
  }
}

function isFresh(pool: PoolState): boolean {
  return (
    pool.models.length > 0 &&
    Date.now() - pool.updatedAt < pool.config.ttlHours * 3_600_000
  );
}

function sortModels(models: PoolModel[]): PoolModel[] {
  return [...models].sort(
    (a, b) =>
      Number(!!a.offline) - Number(!!b.offline) ||
      a.priority - b.priority ||
      a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// 从 OpenRouter 拉取并构建池
// ---------------------------------------------------------------------------

/** 获取 OpenRouter 模型目录：复用 or-free 模块的共享缓存（整个扩展启动只拉取一次网络）。 */
async function fetchOpenRouterModels(force: boolean): Promise<RawORModel[]> {
  return getOpenRouterCatalog(force);
}

/**
 * 用最新数据重建池：
 * - 在线模型：保留旧优先级（用户设置过的永久保留，默认值重新计算）
 * - 下架模型：不删除，标记 offline（恢复上架后自动解除）
 */
function buildPool(
  current: PoolState,
  raw: RawORModel[],
  config: PoolConfig,
): { pool: PoolState; added: string[]; removed: string[]; restored: string[] } {
  const prevById = new Map(current.models.map((m) => [m.id, m]));
  const rawIds = new Set(raw.map((r) => r.id)); // 用于区分“被配置排除”与“真下架”
  const free: PoolModel[] = [];
  const paid: PoolModel[] = [];

  for (const r of raw) {
    const modalities = (r.architecture?.input_modalities ?? []).map((s) =>
      String(s).toLowerCase(),
    );
    if (!modalities.includes("image")) continue; // 只保留多模态（图片输入）模型
    const freeModel = isFreeModel(r);
    if (!freeModel && !config.includePaid) continue;
    const prev = prevById.get(r.id);
    const model: PoolModel = {
      id: r.id,
      name: r.name ?? r.id,
      contextLength: r.context_length ?? 0,
      free: freeModel,
      priority: prev?.priority ?? (freeModel ? 0 : 10000), // 临时值，下面重排
      userSet: prev?.userSet,
      offline: false,
      pricing: r.pricing,
    };
    (freeModel ? free : paid).push(model);
  }

  // 默认优先级：freeFirst=true 时免费模型排 1..N（上下文长度降序）、付费排 10000+i；
  // freeFirst=false 时全部按上下文长度统一排 1..N。用户设置过的优先级不受影响。
  const byCtx = (a: PoolModel, b: PoolModel) =>
    b.contextLength - a.contextLength || a.id.localeCompare(b.id);
  if (config.freeFirst) {
    free.sort(byCtx);
    paid.sort(byCtx);
    free.forEach((m, i) => {
      if (!m.userSet) m.priority = i + 1;
    });
    paid.forEach((m, i) => {
      if (!m.userSet) m.priority = 10000 + i + 1;
    });
  } else {
    const allNew = [...free, ...paid].sort(byCtx);
    allNew.forEach((m, i) => {
      if (!m.userSet) m.priority = i + 1;
    });
  }

  // 下架的旧模型：保留并标记 offline。被配置排除的（如 includePaid=false 时的付费模型）
  // 不属于下架，直接从池中移除，不算 ⚠下架；注册表条目由 mergeRegistryIntoPool 管理。
  const offlineModels: PoolModel[] = [];
  for (const prev of current.models) {
    if (prev.source === "registry") continue;
    if (!free.some((m) => m.id === prev.id) && !paid.some((m) => m.id === prev.id)) {
      if (rawIds.has(prev.id)) continue; // 仍在 OpenRouter 上，只是被配置排除
      offlineModels.push({ ...prev, offline: true });
    }
  }

  let all = sortModels([...free, ...paid, ...offlineModels]);

  // 容量上限：优先保留用户设置过优先级的模型
  if (config.maxModels > 0 && all.length > config.maxModels) {
    const keep: PoolModel[] = all.filter((m) => m.userSet);
    for (const m of all) {
      if (keep.length >= config.maxModels) break;
      if (!keep.includes(m)) keep.push(m);
    }
    all = keep;
  }

  // 统计差异（在截断之后统计，避免把被容量上限排除的模型误报为“新增”）
  const added: string[] = [];
  const removed: string[] = [];
  const restored: string[] = [];
  for (const m of all) {
    const prev = prevById.get(m.id);
    if (!m.offline) {
      if (!prev) added.push(m.id);
      else if (prev.offline) restored.push(m.id);
    } else if (prev && !prev.offline) {
      removed.push(m.id);
    }
  }

  return { pool: { ...current, updatedAt: Date.now(), models: all }, added, removed, restored };
}

let refreshing: Promise<PoolState> | null = null;

/** 刷新池（并发合并：同一时刻只发一个请求）。force=true 时忽略 TTL。 */
function refreshPool(force: boolean, ctx: ExtensionContext): Promise<PoolState> {
  if (!force && refreshing) return refreshing;
  const task = doRefresh(force, ctx).finally(() => {
    refreshing = null;
  });
  refreshing = task;
  return task;
}

async function doRefresh(force: boolean, ctx: ExtensionContext): Promise<PoolState> {
  const current = await loadPool();
  if (!force && isFresh(current)) return current;
  const raw = await fetchOpenRouterModels(force);
  const { pool, added, removed, restored } = buildPool(current, raw, current.config);
  const merged = await mergeRegistryIntoPool(pool, ctx);
  await savePool(merged.pool);
  // 注意：TUI 模式下 console.log 会直接污染终端屏幕（/resume 重载扩展或后台刷新时
  // 会再次打印到屏幕上，直到下次重绘才消失），因此这里静默处理。
  return merged.pool;
}

/** 获取可用池：新鲜直接返回，否则懒刷新（失败时退回旧池）。每次都会同步注册表条目。 */
async function ensureFreshPool(ctx: ExtensionContext): Promise<PoolState> {
  const pool = await loadPool();
  const merged = await mergeRegistryIntoPool(pool, ctx);
  if (merged.changed) await savePool(merged.pool);
  if (isFresh(merged.pool)) return merged.pool;
  try {
    return await refreshPool(false, ctx);
  } catch {
    return merged.pool; // 刷新失败不阻塞使用旧池
  }
}

// ---------------------------------------------------------------------------
// 注册表（自定义模型）同步
// ---------------------------------------------------------------------------

/** 从 pi 模型注册表找出支持图片输入、已配置鉴权的模型（OpenRouter 除外，它由 REST 路径覆盖）。 */
function getRegistryMultimodalModels(ctx: ExtensionContext): RegistryModelInfo[] {
  try {
    const registry = ctx.modelRegistry;
    return registry
      .getAll()
      .filter((m) => m.provider !== "openrouter")
      .filter((m) => m.input.includes("image"))
      .filter((m) => {
        try {
          return registry.hasConfiguredAuth(m);
        } catch {
          return false;
        }
      })
      .map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        contextLength: m.contextWindow,
      }));
  } catch {
    return [];
  }
}

/**
 * 把注册表中的多模态模型同步进池：新增条目（默认优先级 100+i，排在免费 OpenRouter
 * 模型之后）、保留用户设置的优先级、移除已不在注册表中的条目。
 */
async function mergeRegistryIntoPool(
  pool: PoolState,
  ctx: ExtensionContext,
): Promise<{ pool: PoolState; changed: boolean }> {
  if (!pool.config.includeRegistryModels) return { pool, changed: false };
  const registry = getRegistryMultimodalModels(ctx);
  const oldRegistry = pool.models.filter((m) => m.source === "registry");
  const oldByKey = new Map(oldRegistry.map((m) => [`${m.provider}/${m.id}`, m]));

  const sorted = [...registry].sort(
    (a, b) => b.contextLength - a.contextLength || a.id.localeCompare(b.id),
  );
  const synced: PoolModel[] = [];
  let changed = oldRegistry.length !== sorted.length;
  for (const r of sorted) {
    const key = `${r.provider}/${r.id}`;
    const prev = oldByKey.get(key);
    // 去重：池中已有同 id 的可用来源（discovered）时，不再重复加入 registry 条目
    if (!prev && pool.models.some((m) => m.id === r.id && !m.offline)) continue;
    if (prev) {
      if (prev.name !== r.name || prev.contextLength !== r.contextLength) changed = true;
      synced.push({ ...prev, name: r.name, contextLength: r.contextLength, offline: false });
    } else {
      changed = true;
      synced.push({
        id: r.id,
        name: r.name,
        contextLength: r.contextLength,
        free: false,
        priority: 100 + synced.length,
        source: "registry",
        provider: r.provider,
      });
    }
  }
  const keptOthers = pool.models.filter((m) => m.source !== "registry");
  return { pool: { ...pool, models: sortModels([...keptOthers, ...synced]) }, changed };
}

// ---------------------------------------------------------------------------
// AI 自动发现（读取用户服务商 + LLM 分析 + 实测验证）
// ---------------------------------------------------------------------------

/** 拉取服务商的模型列表（OpenAI 兼容 /models 端点）。失败返回 null。 */
async function fetchProviderModelList(
  baseUrl: string,
  apiKey: string,
): Promise<{ id: string }[] | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { id?: string }[] };
    const list = Array.isArray(j?.data) ? j.data.filter((m) => typeof m.id === "string") : [];
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

/** 从 LLM 输出中提取 JSON 数组（容忍 markdown 代码块/前后文字）。 */
function extractJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface DiscoveredModelInfo {
  id: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  free: boolean;
}

/**
 * 调用用户的模型分析服务商模型列表，找出多模态模型并生成配置。
 * 用 ctx.modelRegistry.complete 走 pi 自身调用层（鉴权/协议自动处理）。
 */
async function analyzeWithLLM(
  ctx: ExtensionContext,
  config: PoolConfig,
  providerName: string,
  baseUrl: string,
  modelIds: string[],
): Promise<DiscoveredModelInfo[]> {
  let model = ctx.model;
  if (config.discoverModel) {
    const slash = config.discoverModel.indexOf("/");
    if (slash > 0) {
      model =
        ctx.modelRegistry.find(config.discoverModel.slice(0, slash), config.discoverModel.slice(slash + 1)) ??
        model;
    }
  }
  if (!model) return [];

  const prompt =
    "你是模型清单分析器。下面是模型服务商\"" +
    providerName +
    "\"（" +
    baseUrl +
    "）返回的模型列表 JSON：\n" +
    JSON.stringify(modelIds) +
    "\n\n请从列表中找出【支持图片输入（多模态）】的模型，输出 JSON 数组，每个元素：" +
    '{"id":"与列表完全一致的id","reasoning":true/false,"contextWindow":整数,"maxTokens":整数,"free":true/false}\n' +
    "规则：\n" +
    "1. 只输出 JSON 数组本身，禁止任何其他文字/解释/markdown 代码块\n" +
    "2. id 必须与列表中的完全一致，不能编造\n" +
    "3. contextWindow/maxTokens 不确定时填 131072/16384，不要编造离谱数值\n" +
    "4. free 仅当你确定该模型在服务商处免费时为 true，否则 false\n" +
    "5. 判断多模态：id 含 vl/vision/omni/4v/4o 等视觉理解标识，或你确知的视觉理解模型\n" +
    "6. 排除图像生成/编辑/视频生成类模型（如 id 含 image-edit/generation/video 或已知是生成模型的）——它们不能理解图片\n" +
    "7. 若没有多模态模型，输出 []";

  try {
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: prompt }],
      timestamp: Date.now(),
    };
    const result = await ctx.modelRegistry.complete(model, { messages: [message] } as never, {
      maxTokens: 4000,
      signal: AbortSignal.timeout(120_000),
    });
    const text = (result.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n");
    const arr = extractJsonArray(text);
    if (!arr) return [];
    const known = new Set(modelIds);
    const out: DiscoveredModelInfo[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.id !== "string" || !known.has(o.id)) continue; // 杜绝编造 id
      out.push({
        id: o.id,
        reasoning: o.reasoning === true,
        contextWindow: typeof o.contextWindow === "number" ? o.contextWindow : 131072,
        maxTokens: typeof o.maxTokens === "number" ? o.maxTokens : 16384,
        free: o.free === true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** 实测验证：发一个带图片的最小请求（1x1 PNG + max_tokens=1）。
 *  只有真正支持图片输入（多模态理解）的模型才会返回 200——
 *  图像生成/编辑模型不接受 image_url 输入，会被 4xx 剔除。 */
async function verifyDiscovered(
  baseUrl: string,
  apiKey: string,
  modelId: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                },
              },
            ],
          },
        ],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * AI 自动发现主流程：读用户配置的 provider → 拉 /models → LLM 分析多模态 →
 * 实测验证 → 合并进池。incremental=true 时只处理池中不存在的模型。
 */
async function runDiscovery(ctx: ExtensionContext, incremental: boolean): Promise<number> {
  const pool = await loadPool();
  if (!pool.config.autoDiscover) {
    ctx.ui.notify("AI 自动发现未开启（vision-pool.json 配置 autoDiscover: true 后启用）", "warning");
    return 0;
  }
  // 读取用户配置的 provider（同步读 models.json）
  let providerDefs: Record<string, { name?: string; baseUrl?: string; apiKey?: string }> = {};
  try {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(join(getAgentDir(), "models.json"), "utf8");
    const cfg = JSON.parse(raw) as { providers?: typeof providerDefs };
    providerDefs = cfg.providers ?? {};
  } catch {
    ctx.ui.notify("读取 models.json 失败，无法自动发现", "warning");
    return 0;
  }

  let discovered = 0;
  for (const [id, def] of Object.entries(providerDefs)) {
    if (id === "openrouter") continue; // OpenRouter 已有专门逻辑
    if (!def?.baseUrl) continue;
    const apiKey = resolveApiKey(def.apiKey);
    if (!apiKey) continue; // 无 key 无法拉列表

    ctx.ui.notify(`[vision-pool] 正在分析 ${def.name ?? id} 的多模态模型…`, "info");
    const list = await fetchProviderModelList(def.baseUrl, apiKey);
    if (!list || list.length === 0) continue;
    const knownIds = new Set(pool.models.map((m) => m.id));
    const candidates = incremental
      ? list.filter((m) => !knownIds.has(m.id)).map((m) => m.id)
      : list.map((m) => m.id);
    if (candidates.length === 0) continue;

    const analyzed = await analyzeWithLLM(ctx, pool.config, def.name ?? id, def.baseUrl, candidates);
    for (const info of analyzed) {
      if (pool.config.discoverFreeOnly && !info.free) continue; // 严格模式：只收免费的
      // 实测验证（防 LLM 幻觉：id 错/参数错/实际不可用）
      const ok = await verifyDiscovered(def.baseUrl, apiKey, info.id);
      if (!ok) continue;
      // 去重：池中已有同 id 的可用条目（registry/discovered）则不重复添加
      const existingAny = pool.models.find((m) => m.id === info.id && !m.offline);
      if (existingAny) {
        if (existingAny.source === "discovered") {
          existingAny.name = existingAny.name || info.id;
          existingAny.contextLength = info.contextWindow;
          existingAny.free = info.free;
          existingAny.reasoning = info.reasoning;
        }
        // registry 已有：保留 registry 条目（走 pi 调用层更优），跳过
        continue;
      }
      // 新条目：free → 免费层末尾；非 free → 1000+ 区间
      const freeMax = Math.max(
        0,
        ...pool.models.filter((m) => m.free && m.source !== "discovered").map((m) => m.priority),
      );
      const paidMax = Math.max(
        999,
        ...pool.models.filter((m) => !m.free).map((m) => m.priority),
      );
      pool.models.push({
        id: info.id,
        name: info.id,
        contextLength: info.contextWindow,
        free: info.free,
        priority: info.free ? freeMax + 1 : paidMax + 1,
        source: "discovered",
        provider: id,
        baseUrl: def.baseUrl,
        apiKeyRef: typeof def.apiKey === "string" && def.apiKey.startsWith("$") ? def.apiKey : undefined,
        reasoning: info.reasoning,
      });
      discovered++;
    }
  }
  if (discovered > 0) {
    await savePool({ ...pool, models: sortModels(pool.models) });
    ctx.ui.notify(`[vision-pool] AI 自动发现：新增 ${discovered} 个多模态模型`, "info");
  } else {
    ctx.ui.notify("[vision-pool] AI 自动发现完成：没有新的多模态模型", "info");
  }
  return discovered;
}

// ---------------------------------------------------------------------------
// 调用视觉模型
// ---------------------------------------------------------------------------

async function getOpenRouterApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  try {
    const key = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
    if (key) return key;
  } catch {
    // 走环境变量兜底
  }
  return process.env.OPENROUTER_API_KEY;
}

async function callOpenRouter(
  config: PoolConfig,
  apiKey: string,
  modelId: string,
  images: ImageContentLike[],
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const content: unknown[] = [{ type: "text", text: prompt }];
  for (const img of images) {
    if (!img.data) continue;
    if (img.data.length > MAX_IMAGE_BYTES * 1.34) {
      throw new Error("图片过大（base64 超过 20MB）");
    }
    content.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType || "image/png"};base64,${img.data}` },
    });
  }
  if (content.length <= 1) throw new Error("没有可用的图片数据");

  const res = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-title": "pi vision-pool",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content }],
      max_tokens: config.describeMaxTokens,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body.slice(0, 160)}`);
  }
  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const out = payload?.choices?.[0]?.message?.content;
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    return out
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  throw new Error("模型返回了空响应");
}

/**
 * 通过 pi 的模型调用层调用注册表中的模型（自动处理鉴权/协议，如 xiaomi-clean/mimo-v2.5）。
 */
async function callRegistryModel(
  ctx: ExtensionContext,
  entry: PoolModel,
  images: ImageContentLike[],
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const model = ctx.modelRegistry.find(entry.provider!, entry.id);
  if (!model) throw new Error(`模型 ${entry.provider}/${entry.id} 未在注册表中`);
  const config = (await loadPool()).config;
  const content: unknown[] = [{ type: "text", text: prompt }];
  for (const img of images) {
    if (!img.data) continue;
    content.push({ type: "image", data: img.data, mimeType: img.mimeType || "image/png" });
  }
  const message = { role: "user" as const, content, timestamp: Date.now() };
  const result = await ctx.modelRegistry.complete(model, { messages: [message] } as never, {
    signal,
    maxTokens: config.describeMaxTokens,
  });
  if (result.errorMessage) throw new Error(result.errorMessage);
  const text = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n")
    .trim();
  if (!text) throw new Error("模型返回了空响应");
  return text;
}

/** 调用 AI 自动发现的模型（用户服务商的 OpenAI 兼容端点，通用 REST）。 */
async function callDiscoveredModel(
  entry: PoolModel,
  images: ImageContentLike[],
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  if (!entry.baseUrl) throw new Error("discovered 模型缺少 baseUrl");
  const apiKeyRef = entry.apiKeyRef ?? "";
  const apiKey = apiKeyRef.startsWith("$") ? getEnvValue(apiKeyRef.slice(1)) : undefined;
  if (!apiKey) throw new Error(`无法解析 ${entry.provider} 的 API key（${apiKeyRef}）`);
  const config = (await loadPool()).config;
  const content: unknown[] = [{ type: "text", text: prompt }];
  for (const img of images) {
    if (!img.data) continue;
    if (img.data.length > MAX_IMAGE_BYTES * 1.34) throw new Error("图片过大（base64 超过 20MB）");
    content.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType || "image/png"};base64,${img.data}` },
    });
  }
  const res = await fetch(`${entry.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: entry.id,
      messages: [{ role: "user", content }],
      max_tokens: config.describeMaxTokens,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body.slice(0, 160)}`);
  }
  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const out = payload?.choices?.[0]?.message?.content;
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    return out
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  throw new Error("模型返回了空响应");
}

/**
 * 按优先级依次调用池中模型（OpenRouter REST 与注册表模型混排），直到成功。
 * 全部失败时：若配置允许，强制刷新池（处理免费模型被下架的情况）后重试一次。
 */
async function describeImages(
  ctx: ExtensionContext,
  images: ImageContentLike[],
  promptOverride?: string,
  signal?: AbortSignal,
): Promise<{ text: string; modelId: string }> {
  const pool = await ensureFreshPool(ctx);
  const config = pool.config;
  // OpenRouter key 按需获取：只有真正轮到 OpenRouter 模型时才会检查，
  // 池中全是 registry/discovered 模型时无需 openrouter key。
  let orKeyCache: string | undefined | null;
  const getOrKey = async (): Promise<string | undefined> => {
    if (orKeyCache === null) return undefined;
    if (orKeyCache === undefined) orKeyCache = (await getOpenRouterApiKey(ctx)) ?? null;
    return orKeyCache ?? undefined;
  };
  const prompt = promptOverride ?? config.describePrompt;
  const timeout = signal ?? AbortSignal.timeout(DESCRIBE_TIMEOUT_MS);
  const tried = new Set<string>();
  const errors: string[] = [];

  const attempt = async (candidates: PoolModel[]) => {
    for (const m of candidates) {
      if (m.offline || tried.has(m.id)) continue;
      tried.add(m.id);
      try {
        let text: string;
        if (m.source === "registry") {
          text = await callRegistryModel(ctx, m, images, prompt, timeout);
          // 伪多模态检测：registry 模型声明支持图片但可能实际无法处理（如 sensenova）
          if (!appearsToUnderstandImage(text)) {
            throw new Error("伪多模态：模型未真正理解图片内容（回复中缺少图片描述）");
          }
        } else if (m.source === "discovered") {
          text = await callDiscoveredModel(m, images, prompt, timeout);
          if (!appearsToUnderstandImage(text)) {
            throw new Error("伪多模态：模型未真正理解图片内容（回复中缺少图片描述）");
          }
        } else {
          const key = await getOrKey();
          if (!key) {
            throw new Error(
              "未找到 OpenRouter API key（/login openrouter 或 OPENROUTER_API_KEY）——" +
                "若要使用该模型请先配置 key，或用 /mm-priority 把已有自定义模型排更前",
            );
          }
          text = await callOpenRouter(config, key, m.id, images, prompt, timeout);
        }
        const modelId =
          m.source === "registry" || m.source === "discovered" ? `${m.provider}/${m.id}` : m.id;
        return { text, modelId };
      } catch (err) {
        errors.push(
          `${m.source === "registry" || m.source === "discovered" ? `${m.provider}/${m.id}` : m.id}: ${errMsg(err)}`,
        );
      }
    }
    return undefined;
  };

  let result = await attempt(pool.models);
  if (!result && config.refreshOnAllFailed) {
    try {
      const fresh = await refreshPool(true, ctx);
      result = await attempt(fresh.models);
    } catch (err) {
      errors.push(`刷新池失败: ${errMsg(err)}`);
    }
  }
  if (!result) throw new Error(`视觉池所有模型均调用失败：${errors.join("；")}`);
  return result;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 伪多模态检测：模型声明支持图片但实际上无法理解图片时，返回的文本中
// 会包含明显的"无法查看/处理图片"类措辞，而不会描述图片实际内容。
// 通过检测这类措辞 + 缺少图片特征词，判断模型是否真正理解了图片。
// ---------------------------------------------------------------------------

/** 模型未真正处理图片时的常见回复模式 */
const CANNOT_SEE_IMAGE_PATTERNS: RegExp[] = [
  /无法查看图片/i,
  /无法处理图片/i,
  /无法识别图片/i,
  /没有看到.*图片/i,
  /没有.*图片/i,
  /未提供.*图片/i,
  /无法访问.*图片/i,
  /无法读取.*图片/i,
  /没有.*图片.*内容/i,
  /没有上传图片/i,
  /没有.*附带.*图片/i,
  /无法分析图片/i,
  /看不到.*图片/i,
  /不能.*图片/i,
  /无法直接查看/i,
  /没有收到.*图片/i,
  /对话中.*没有.*图片/i,
  /没有.*图像/i,
  /不能查看图片/i,
  /not\s+able\s+to\s+(see|view|process|analyze|access)/i,
  /cannot\s+(see|view|process|analyze|access)\s+(the\s+)?image/i,
  /no\s+(image|picture)\s+(was|has\s+been|has)/i,
  /I\s+cannot\s+(see|view|process|analyze|access)/i,
];

/** 图片描述中应包含的特征词（用于确认模型真正处理了图片） */
const IMAGE_CONTENT_HINTS: RegExp[] = [
  /颜色/i,
  /色彩/i,
  /红色|蓝色|绿色|黑色|白色|黄色|紫色|粉色|棕色/i,
  /头发|长发|短发/i,
  /眼睛|眼/i,
  /脸|面部/i,
  /衣服|服装|裙|衬衫|外套/i,
  /背景/i,
  /场景/i,
  /人物/i,
  /男性|女性/i,
  /男|女/i,
  /物体/i,
  /文字/i,
  /布局/i,
  /形状/i,
  /photo|image|picture/i,
  /color|background/i,
];

/**
 * 判断模型回复是否真正理解了图片。
 * 返回 false 表示模型没有看到/理解图片（伪多模态），应该跳过。
 */
function appearsToUnderstandImage(text: string): boolean {
  const cleaned = text.trim();
  if (cleaned.length < 20) return false;
  const hasCannotSeePattern = CANNOT_SEE_IMAGE_PATTERNS.some((p) => p.test(cleaned));
  const hasImageContent = IMAGE_CONTENT_HINTS.some((p) => p.test(cleaned));
  // 有明确"看不到图片"措辞 + 没有图片特征词 → 未真正理解图片
  if (hasCannotSeePattern && !hasImageContent) return false;
  return true;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmtContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function extToMime(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    case "svg": return "image/svg+xml";
    default: return undefined;
  }
}

/** 合并 abort signal：任一触发即中止；无 signal 时返回静默信号。 */
function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => !!s);
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0];
  const anyFn = (AbortSignal as unknown as { any?: (sigs: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn(present);
  const ctrl = new AbortController();
  for (const s of present) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

// ---------------------------------------------------------------------------
// 扩展主体
// ---------------------------------------------------------------------------

export function initVisionPool(pi: ExtensionAPI) {
  // ---- 自动拦截：文本模型 + 图片 → 视觉池描述 ----
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const images = event.images;
    if (!images || images.length === 0) return { action: "continue" };

    const model = ctx.model;
    const multimodal = !!model && model.input.includes("image");
    const config = (await loadPool()).config;
    if (multimodal && !config.forceDescribe) return { action: "continue" };

    const modelLabel = model ? `${model.provider}/${model.id}` : "(未知模型)";
    ctx.ui.notify(
      `[vision-pool] 当前模型 ${modelLabel} 不支持图片输入，自动调用视觉池描述 ${images.length} 张图片…`,
      "info",
    );

    const signal = combineSignals(ctx.signal, AbortSignal.timeout(DESCRIBE_TIMEOUT_MS));
    try {
      const result = await describeImages(ctx, images, undefined, signal);
      const parts: string[] = [];
      if (event.text.trim()) parts.push(event.text.trim());
      parts.push("");
      parts.push(
        "> 📷 用户上传的图片已自动交给视觉模型池识别（当前模型不支持图片输入，原图已移除，替换为以下描述）：",
      );
      parts.push("");
      parts.push(`**图片描述**（由 \`${result.modelId}\` 识别）：`);
      parts.push(result.text);
      return { action: "transform", text: parts.join("\n"), images: [] };
    } catch (err) {
      ctx.ui.notify(
        `[vision-pool] 自动描述失败，原图照常透传（若当前模型不支持图片将报错）：${errMsg(err)}`,
        "warning",
      );
      return { action: "continue" };
    }
  });

  // ---- 启动后台刷新（不阻塞启动） ----
  pi.on("session_start", async (_event, ctx) => {
    const pool = await loadPool();
    if (pool.config.autoDiscover && ctx.mode === "tui") {
      // 首次运行：池里还没有 discovered 条目时，做一次全量 AI 自动发现
      const hasDiscovered = pool.models.some((m) => m.source === "discovered");
      if (!hasDiscovered) {
        void runDiscovery(ctx, false).catch(() => {});
      }
    }
    if (!pool.config.refreshOnStartup || isFresh(pool)) return;
    refreshPool(false, ctx)
      .then((fresh) => {
        const online = fresh.models.filter((m) => !m.offline);
        const offline = fresh.models.length - online.length;
        ctx.ui.notify(
          `[vision-pool] 模型池已更新：${online.length} 个多模态模型` +
            (offline > 0 ? `（${offline} 个已下架）` : ""),
          "info",
        );
      })
      .catch((err) =>
        ctx.ui.notify(`[vision-pool] 后台刷新失败（用到时会按需重试）：${errMsg(err)}`, "warning"),
      );
  });

  // ---- 命令：/mm-pool ----
  pi.registerCommand("mm-pool", {
    description: "查看视觉模型池（按优先级排序）。可选参数：free / paid / all / offline",
    handler: async (args, ctx) => {
      const filter = (args || "").trim().toLowerCase();
      const pool = await ensureFreshPool(ctx);
      if (pool.models.length === 0) {
        ctx.ui.notify("视觉池为空，请先运行 /mm-refresh", "warning");
        return;
      }
      const online = pool.models.filter((m) => !m.offline);
      const registryCount = online.filter((m) => m.source === "registry").length;
      const discoveredCount = online.filter((m) => m.source === "discovered").length;
      const list = sortModels(pool.models).filter((m) => {
        if (filter === "free") return !m.offline && m.free;
        if (filter === "paid") return !m.offline && !m.free && m.source !== "registry";
        if (filter === "offline") return m.offline;
        if (filter === "all") return true;
        return !m.offline; // 默认只看在线
      });
      const lines = [
        `视觉模型池：在线 ${online.length} 个（免费 ${online.filter((m) => m.free).length}，` +
          `自定义 ${registryCount}，发现 ${discoveredCount}），下架 ${pool.models.length - online.length} 个，` +
          `更新于 ${pool.updatedAt ? new Date(pool.updatedAt).toLocaleString() : "从未"}`,
        `设置优先级：/mm-priority [数字] [关键字]（数字越小越优先；默认免费模型在前）`,
        ``,
        ...list.map(
          (m, i) =>
            `${String(i + 1).padStart(3)}. [${String(m.priority).padStart(5)}] ` +
            `${m.offline ? "⚠下架" : m.source === "registry" ? "自定义" : m.source === "discovered" ? "发现" : m.free ? "FREE" : "paid"} ` +
            `${m.source === "registry" || m.source === "discovered" ? `${m.provider}/${m.id}` : m.id}  ` +
            `ctx=${fmtContext(m.contextLength)}${m.userSet ? "  [自定义优先级]" : ""}`,
        ),
      ];
      if (ctx.mode === "tui") {
        await ctx.ui.editor("视觉模型池", lines.join("\n"));
        ctx.ui.notify(
          `视觉池：在线 ${online.length} 个（免费 ${online.filter((m) => m.free).length}），已打开列表`,
          "info",
        );
      } else {
        ctx.ui.notify(lines.slice(0, 2).join(" | "), "info");
      }
    },
  });

  // ---- 命令：/mm-refresh ----
  pi.registerCommand("mm-refresh", {
    description: "强制从 OpenRouter 刷新视觉模型池（免费模型可能不定期上架/下架）",
    handler: async (_args, ctx) => {
      ctx.ui.notify("正在从 OpenRouter 刷新视觉模型池…", "info");
      try {
        const prev = await loadPool();
        const beforeOnline = new Set(prev.models.filter((m) => !m.offline).map((m) => m.id));
        const pool = await refreshPool(true, ctx);
        const online = pool.models.filter((m) => !m.offline);
        const added = online.filter((m) => !beforeOnline.has(m.id));
        const nowOffline = pool.models.filter((m) => m.offline);
        const delisted = nowOffline.filter((m) => beforeOnline.has(m.id));
        const restored = nowOffline.filter((m) => !beforeOnline.has(m.id)).length;
        ctx.ui.notify(
          `视觉池已刷新：在线 ${online.length} 个多模态模型` +
            `（免费 ${online.filter((m) => m.free).length}），新增 ${added.length}，` +
            `本次下架 ${delisted.length} 个${restored > 0 ? `，恢复 ${restored} 个` : ""}`,
          "info",
        );
        // autoDiscover 开启时：刷新后增量发现服务商的新多模态模型
        if ((await loadPool()).config.autoDiscover) {
          await runDiscovery(ctx, true);
        }
      } catch (err) {
        ctx.ui.notify(`刷新失败：${errMsg(err)}`, "error");
      }
    },
  });

  // ---- 命令：/mm-discover ----
  pi.registerCommand("mm-discover", {
    description: "AI 自动发现：读取用户配置的模型服务商，分析并验证多模态模型后加入池",
    handler: async (args, ctx) => {
      const incremental = args.trim() !== "full";
      await runDiscovery(ctx, incremental);
    },
  });

  // ---- 命令：/mm-priority ----
  pi.registerCommand("mm-priority", {
    description: "设置视觉池模型优先级（数字越小越优先）。用法：/mm-priority [数字] [模型关键字]",
    handler: async (args, ctx) => {
      const pool = await ensureFreshPool(ctx);
      const online = pool.models.filter((m) => !m.offline);
      if (online.length === 0) {
        ctx.ui.notify("视觉池为空，请先运行 /mm-refresh", "warning");
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
        ? online.filter(
            (mm) =>
              mm.id.toLowerCase().includes(keyword) ||
              (mm.source === "registry" &&
                `${mm.provider}/${mm.id}`.toLowerCase().includes(keyword)) ||
              (mm.name ?? "").toLowerCase().includes(keyword),
          )
        : online;
      if (matches.length === 0) {
        ctx.ui.notify(`没有找到匹配“${keyword}”的模型`, "warning");
        return;
      }

      let target: PoolModel | undefined;
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
      await savePool(pool);
      ctx.ui.notify(`已设置 ${target!.id} 的优先级为 ${priority}`, "info");
    },
  });

  // ---- 命令：/mm-status ----
  pi.registerCommand("mm-status", {
    description: "查看当前模型与视觉池状态",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      const pool = await ensureFreshPool(ctx);
      const online = pool.models.filter((m) => !m.offline);
      const key = await getOpenRouterApiKey(ctx);
      const registryCount = online.filter((m) => m.source === "registry").length;
      const lines = [
        `当前模型：${model ? `${model.provider}/${model.id}` : "(未设置)"}`,
        `支持图片输入：${model ? (model.input.includes("image") ? "是 ✅" : "否 ❌（上传图片时将自动走视觉池）") : "未知"}`,
        `视觉池：在线 ${online.length} 个多模态模型（免费 ${online.filter((m) => m.free).length}，自定义 ${registryCount}），下架 ${pool.models.length - online.length} 个`,
        `上次更新：${pool.updatedAt ? new Date(pool.updatedAt).toLocaleString() : "从未"}（${isFresh(pool) ? "新鲜" : "已过期，将按需刷新"}）`,
        `OpenRouter API key：${key ? "已配置 ✅" : "未配置 ❌（运行 /login openrouter 或设置 OPENROUTER_API_KEY）"}`,
        `自动描述开关：${pool.config.forceDescribe ? "始终强制走视觉池" : "仅文本模型上传图片时触发"}`,
        `注册表多模态模型：${registryCount > 0 ? `已纳入 ${registryCount} 个（如 xiaomi-clean/mimo-v2.5）` : "无（在 models.json 或 /login 配置后自动纳入）"}`,
      ];
      if (ctx.mode === "tui") await ctx.ui.editor("vision-pool 状态", lines.join("\n"));
      else ctx.ui.notify(lines.join(" | "), "info");
    },
  });

  // ---- 命令：/mm-config ----
  pi.registerCommand("mm-config", {
    description: "查看 vision-pool 配置（修改：编辑 vision-pool.json 的 config 后 /reload）",
    handler: async (_args, ctx) => {
      const config = (await loadPool()).config;
      const text = `vision-pool 配置（修改：编辑 ${POOL_FILE} 的 config 字段后 /reload）\n\n${JSON.stringify(config, null, 2)}`;
      if (ctx.mode === "tui") await ctx.ui.editor("vision-pool 配置", text);
      else ctx.ui.notify("vision-pool 配置已打印（TUI 模式下打开编辑器）", "info");
    },
  });

  // ---- 工具：describe_image ----
  pi.registerTool({
    name: "describe_image",
    label: "Describe Image",
    description:
      "通过视觉模型池描述一张图片的内容。image 参数可以是本地图片路径、data:image/...;base64,xxx 数据 URL 或裸 base64 字符串；prompt 可自定义描述要求。注意：用户上传图片时若当前模型不支持图片，系统会自动描述，无需调用本工具。",
    parameters: Type.Object({
      image: Type.String({ description: "本地图片路径 / data URL / 裸 base64" }),
      prompt: Type.Optional(Type.String({ description: "自定义描述指令" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let img: ImageContentLike;
      if (params.image.startsWith("data:image/")) {
        const m = params.image.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);
        if (!m) throw new Error("无法解析 data URL");
        img = { type: "image", mimeType: m[1], data: m[2] };
      } else if (params.image.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(params.image)) {
        img = { type: "image", mimeType: "image/png", data: params.image.replace(/\s/g, "") };
      } else {
        const path = isAbsolute(params.image) ? params.image : join(ctx.cwd, params.image);
        const buf = await readFile(path);
        img = {
          type: "image",
          mimeType: extToMime(params.image) ?? "image/png",
          data: buf.toString("base64"),
        };
      }
      onUpdate?.({ content: [{ type: "text", text: "正在通过视觉模型池识别图片…" }] });
      const config = (await loadPool()).config;
      const prompt = params.prompt
        ? `${config.describePrompt}\n\n用户自定义要求：${params.prompt}`
        : config.describePrompt;
      const result = await describeImages(ctx, [img], prompt, signal);
      return {
        content: [{ type: "text", text: `[由 ${result.modelId} 识别]\n${result.text}` }],
        details: { modelId: result.modelId },
      };
    },
  });

  // ---- 工具：mm_pool_info ----
  pi.registerTool({
    name: "mm_pool_info",
    label: "Vision Pool Info",
    description:
      "查看视觉模型池（支持图片输入的多模态模型）的信息：总数、免费数、更新时间和按优先级排序的模型列表。当用户询问有哪些多模态模型/视觉模型可用时使用。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ description: "返回前 N 个模型，默认 20" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const pool = await ensureFreshPool(ctx);
      const online = sortModels(pool.models).filter((m) => !m.offline);
      const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
      const top = online.slice(0, limit).map((m) => ({
        id: m.source === "registry" ? `${m.provider}/${m.id}` : m.id,
        priority: m.priority,
        free: m.free,
        source: m.source ?? "openrouter",
        contextLength: m.contextLength,
      }));
      const text = JSON.stringify(
        {
          count: online.length,
          free: online.filter((m) => m.free).length,
          custom: online.filter((m) => m.source === "registry").length,
          updatedAt: pool.updatedAt ? new Date(pool.updatedAt).toISOString() : null,
          top: top,
        },
        null,
        2,
      );
      return {
        content: [{ type: "text", text }],
        details: { count: online.length },
      };
    },
  });
}
