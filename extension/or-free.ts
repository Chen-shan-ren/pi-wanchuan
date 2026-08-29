/**
 * or-free.ts — OpenRouter 免费模型数据层 + provider 注册（pi-wanchuan 扩展模块）
 *
 * 职责：
 * 1. 数据层：拉取 OpenRouter 全量模型列表并缓存（内存 + 文件），供本扩展的
 *    provider 注册模块和视觉池模块共享，整个扩展启动只拉取一次网络。
 * 2. Provider 注册：把 pi 内置的 openrouter provider 替换为"仅免费模型"，
 *    /model 选择器中 openrouter 提供商只显示标有 free 的模型。
 *
 * 缓存：~/.pi/agent/openrouter-free.cache.json（存全量模型，含 fetchedAt）。
 * 免费列表变化频繁（每周甚至更勤），启动时若缓存过期（默认 6h）则重新拉取；
 * 失败时回退缓存，再失败则保留 pi 内置目录。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  getModelsPath,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const OR_API_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 6 * 3_600_000; // 缓存有效期 6 小时
const CACHE_FILE = join(getAgentDir(), "openrouter-free.cache.json");

/** OpenRouter /models 接口原始模型条目 */
export interface RawORModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number };
}

interface PiModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: { thinkingFormat: string; supportsReasoningEffort?: boolean };
}

/** 一个模型是否免费（OpenRouter 对 prompt/completion 均定价 0） */
export function isFreeModel(model: RawORModel): boolean {
  const pricing = model.pricing ?? {};
  return pricing.prompt === "0" && pricing.completion === "0";
}

function toPiModel(model: RawORModel): PiModelConfig {
  const params = model.supported_parameters ?? [];
  const reasoning = params.includes("reasoning");
  const inputModalities = model.architecture?.input_modalities ?? ["text"];
  const config: PiModelConfig = {
    id: model.id,
    name: model.name ?? model.id,
    reasoning,
    input: inputModalities.includes("image") ? ["text", "image"] : ["text"],
    contextWindow: model.context_length ?? 128000,
    maxTokens: model.top_provider?.max_completion_tokens ?? 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (reasoning) {
    config.compat = {
      // OpenRouter 通过嵌套 reasoning 对象归一化思考
      thinkingFormat: "openrouter",
      ...(params.includes("reasoning_effort") ? { supportsReasoningEffort: true } : {}),
    };
  }
  return config;
}

// ---------------------------------------------------------------------------
// 数据层：全量模型目录（内存缓存 + 文件缓存 + 网络拉取，防并发）
// ---------------------------------------------------------------------------

let memoryCatalog: RawORModel[] | undefined;
let memoryFetchedAt = 0;
/** 最后一次真正联网成功拉取目录的时间（用于判断启动时是否发生了网络刷新） */
let lastNetworkFetchAt = 0;
let refreshing: Promise<RawORModel[]> | undefined;

async function fetchCatalog(): Promise<RawORModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(OR_API_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { data?: RawORModel[] };
    const models = Array.isArray(data?.data) ? data.data : [];
    if (models.length === 0) throw new Error("response contained no models");
    return models;
  } finally {
    clearTimeout(timer);
  }
}

function readCacheFile(): { fetchedAt: number; models: RawORModel[] } | null {
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as {
      fetchedAt?: number;
      models?: RawORModel[];
    };
    if (Array.isArray(data.models) && data.models.length > 0 && typeof data.fetchedAt === "number") {
      return { fetchedAt: data.fetchedAt, models: data.models };
    }
  } catch {
    // 缓存损坏/旧格式：忽略
  }
  return null;
}

function writeCacheFile(models: RawORModel[]): void {
  try {
    mkdirSync(join(getAgentDir()), { recursive: true });
    writeFileSync(
      CACHE_FILE,
      JSON.stringify({ fetchedAt: Date.now(), models }, null, 2),
    );
  } catch {
    // 缓存尽力而为，失败不影响功能
  }
}

/**
 * 获取 OpenRouter 全量模型目录（含免费与付费）。
 * force=true 时强制网络拉取；否则优先内存缓存，其次文件缓存（6h 内），
 * 过期才拉网络。并发调用共享同一次拉取。失败时回退缓存。
 */
export async function getOpenRouterCatalog(force = false): Promise<RawORModel[]> {
  if (!force && memoryCatalog && Date.now() - memoryFetchedAt < CACHE_TTL_MS) {
    return memoryCatalog;
  }
  if (refreshing) {
    return refreshing;
  }
  const task = (async (): Promise<RawORModel[]> => {
    try {
      const fresh = await fetchCatalog();
      memoryCatalog = fresh;
      memoryFetchedAt = Date.now();
      lastNetworkFetchAt = Date.now();
      writeCacheFile(fresh);
      return fresh;
    } catch {
      const cached = memoryCatalog ?? readCacheFile()?.models;
      if (cached && cached.length > 0) return cached;
      throw new Error("无法获取 OpenRouter 模型列表且无缓存可用");
    }
  })();
  refreshing = task;
  try {
    return await task;
  } finally {
    refreshing = undefined;
  }
}

// ---------------------------------------------------------------------------
// Provider 注册（/model 中 openrouter 只显示免费模型）
// ---------------------------------------------------------------------------

/** models.json 中用户自定义的 openrouter 模型（按 id 覆盖免费列表） */
function readCustomOpenRouterModels(): Record<string, unknown>[] {
  try {
    const data = JSON.parse(readFileSync(getModelsPath(), "utf8")) as {
      providers?: { openrouter?: { models?: Record<string, unknown>[] } };
    };
    return Array.isArray(data?.providers?.openrouter?.models)
      ? data.providers.openrouter.models
      : [];
  } catch {
    return [];
  }
}

function mergeModels(free: PiModelConfig[], custom: Record<string, unknown>[]): PiModelConfig[] {
  const byId = new Map<string, PiModelConfig>(free.map((m) => [m.id, m]));
  for (const definition of custom) {
    if (typeof definition.id !== "string" || !definition.id) continue;
    byId.set(definition.id, { ...byId.get(definition.id), ...definition } as PiModelConfig);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function providerConfig(models: PiModelConfig[]) {
  return {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    models,
  };
}

export async function initFreeProvider(pi: ExtensionAPI): Promise<void> {
  // ---- 启动：等待目录就绪（缓存命中时无网络）并注册免费 provider ----
  // 注意：TUI 模式下 console.* 会污染终端屏幕（扩展重载时重新打印），一律静默。
  let startupFetchedNetwork = false;
  let startupFreeCount = 0;
  try {
    const prevFetch = lastNetworkFetchAt;
    const catalog = await getOpenRouterCatalog();
    startupFetchedNetwork = lastNetworkFetchAt > prevFetch; // 本次启动真正联网拉取
    const free = catalog.filter(isFreeModel).map(toPiModel);
    if (free.length > 0) {
      pi.registerProvider("openrouter", providerConfig(mergeModels(free, readCustomOpenRouterModels())));
      startupFreeCount = free.length;
    }
  } catch {
    // 失败：保留 pi 内置的 openrouter 目录
  }

  // ---- 启动提示：目录真正联网刷新后，会话开始时补一条通知（与 vision-pool 一致） ----
  if (startupFetchedNetwork && startupFreeCount > 0) {
    let notified = false;
    pi.on("session_start", (_event, ctx) => {
      if (notified || ctx.mode === "print") return;
      notified = true;
      ctx.ui.notify(
        `[openrouter-free] 免费模型目录已更新：${startupFreeCount} 个免费模型`,
        "info",
      );
    });
  }

  // ---- 手动刷新命令 ----
  pi.registerCommand("openrouter-free", {
    description: "刷新 OpenRouter 免费模型并重新注册 openrouter provider",
    handler: async (args, ctx) => {
      const wantsList = args.trim().toLowerCase() === "list";
      if (wantsList) {
        const cached = memoryCatalog ?? readCacheFile()?.models ?? [];
        const free = cached.filter(isFreeModel).map(toPiModel);
        if (free.length === 0) {
          ctx.ui.notify("暂无免费模型数据，请先运行 /openrouter-free", "warning");
          return;
        }
        const picked = await ctx.ui.select(
          `OpenRouter 免费模型（${free.length}）：`,
          free.map((m) => m.id),
        );
        if (picked) ctx.ui.notify(picked, "info");
        return;
      }
      try {
        const catalog = await getOpenRouterCatalog(true);
        const free = catalog.filter(isFreeModel).map(toPiModel);
        pi.registerProvider("openrouter", providerConfig(mergeModels(free, readCustomOpenRouterModels())));
        ctx.ui.notify(
          `OpenRouter 免费模型已刷新：${free.length} 个免费（+${mergeModels(free, readCustomOpenRouterModels()).length - free.length} 自定义）`,
          "info",
        );
      } catch (error) {
        const cached = readCacheFile()?.models ?? [];
        if (cached.length > 0) {
          const free = cached.filter(isFreeModel).map(toPiModel);
          pi.registerProvider("openrouter", providerConfig(mergeModels(free, readCustomOpenRouterModels())));
          ctx.ui.notify(`拉取失败，已恢复缓存列表（${free.length} 个免费模型）`, "warning");
        } else {
          ctx.ui.notify(
            `拉取失败：${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      }
    },
  });
}
