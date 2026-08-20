/**
 * image-gen.ts — 图像生成池（pi-wanchuan 万川扩展模块）
 *
 * 图像生成池由两类来源组成：
 *   1. OpenRouter 目录：自动筛选"图像生成模型"（architecture.output_modalities 含 image），
 *      按优先级调用生成图片并保存到本地。
 *   2. 用户服务商模型（/img-add）：把 models.json 中已配置鉴权的服务商图像生成模型
 *      （如 agnes-image-2.1-flash、sensenova-u1-fast）加入池，直接调其
 *      /images/generations 端点（OpenAI 兼容格式），不再被 OpenRouter 绑定。
 *      刷新 OpenRouter 目录时用户条目自动保留。
 *
 * 命令：
 *   /img-pool [free|all|offline]   查看图像生成池
 *   /img-refresh                   强制刷新池
 *   /img-add [provider] [modelId]  把用户服务商的图像生成模型加入池（端点验证）
 *   /img-remove [关键字]           从池中移除模型
 *   /img-priority [n] [关键字]     设置优先级
 *   /img-generate <提示词>         生成图片并保存
 *
 * 工具：
 *   generate_image                 生成图片（LLM 可调用）
 *
 * 注意：OpenRouter 当前没有免费的图像生成模型（池内均为付费模型，调用按量计费）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join, isAbsolute } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getOpenRouterCatalog, isFreeModel, type RawORModel } from "./or-free.ts";
import { getEnvValue, resolveApiKey, readUserProviders } from "./shared.ts";

interface ImgPoolModel {
  id: string;
  name: string;
  free: boolean;
  priority: number;
  userSet?: boolean;
  offline?: boolean;
  /** 用户服务商条目：models.json 中的 provider id（缺省 = openrouter 目录条目） */
  provider?: string;
  baseUrl?: string;
  apiKeyRef?: string;
}

interface ImgPoolConfig {
  ttlHours: number;
  size: string; // 生成尺寸：1024x1024 / 512x512 等
  outputDir: string; // 输出目录（空=自动选择）
  maxModels: number;
}

interface ImgPoolState {
  updatedAt: number;
  models: ImgPoolModel[];
  config: ImgPoolConfig;
}

const IMG_POOL_FILE = join(getAgentDir(), "image-pool.json");
const DEFAULT_IMG_CONFIG: ImgPoolConfig = {
  ttlHours: 24,
  size: "1024x1024",
  outputDir: "",
  maxModels: 50,
};

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadImgPool(): Promise<ImgPoolState> {
  try {
    const raw = await readFile(IMG_POOL_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<ImgPoolState>;
    if (parsed && Array.isArray(parsed.models)) {
      return {
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
        models: parsed.models.filter((m) => m && typeof m.id === "string"),
        config: { ...DEFAULT_IMG_CONFIG, ...(parsed.config ?? {}) },
      };
    }
  } catch {
    // 首次运行
  }
  return { updatedAt: 0, models: [], config: { ...DEFAULT_IMG_CONFIG } };
}

async function saveImgPool(pool: ImgPoolState): Promise<void> {
  try {
    await mkdir(join(getAgentDir()), { recursive: true });
    await writeFile(IMG_POOL_FILE, JSON.stringify(pool, null, 2), "utf8");
  } catch (err) {
    throw new Error(`无法写入池文件 ${IMG_POOL_FILE}: ${errMsg(err)}`);
  }
}

function imgPoolFresh(pool: ImgPoolState): boolean {
  return pool.models.length > 0 && Date.now() - pool.updatedAt < pool.config.ttlHours * 3_600_000;
}

function sortImgModels(models: ImgPoolModel[]): ImgPoolModel[] {
  return [...models].sort(
    (a, b) =>
      Number(!!a.offline) - Number(!!b.offline) || a.priority - b.priority || a.id.localeCompare(b.id),
  );
}

/** 从 OpenRouter 目录构建图像生成池（output 含 image，排除路由别名）。
 *  用户服务商条目（provider 非空且非 openrouter）原样保留，不参与目录刷新。 */
function buildImgPool(current: ImgPoolState, raw: RawORModel[]): ImgPoolState {
  const prevById = new Map(current.models.map((m) => [m.id, m]));
  const rawIds = new Set(raw.map((r) => r.id));
  // 用户服务商条目：保留（不被 OpenRouter 下架逻辑影响）
  const custom = current.models.filter((m) => m.provider && m.provider !== "openrouter");
  const models: ImgPoolModel[] = [];
  for (const r of raw) {
    const out = (r.architecture?.output_modalities ?? []).map((s) => String(s).toLowerCase());
    if (!out.includes("image")) continue;
    if (r.id.startsWith("openrouter/")) continue; // 路由别名（auto 等），非特定生成模型
    const free = isFreeModel(r);
    const prev = prevById.get(r.id);
    models.push({
      id: r.id,
      name: r.name ?? r.id,
      free,
      priority: prev?.priority ?? (free ? 1 + models.filter((m) => m.free).length : 1000 + models.filter((m) => !m.free).length),
      userSet: prev?.userSet,
      offline: false,
    });
  }
  // 下架保留（仅 OpenRouter 条目）
  const offlineModels: ImgPoolModel[] = [];
  for (const prev of current.models) {
    if (prev.provider && prev.provider !== "openrouter") continue; // 用户条目不标记下架
    if (!models.some((m) => m.id === prev.id)) {
      if (rawIds.has(prev.id)) continue; // 被排除（如路由别名）
      offlineModels.push({ ...prev, offline: true });
    }
  }
  let all = sortImgModels([...custom, ...models, ...offlineModels]);
  if (current.config.maxModels > 0 && all.length > current.config.maxModels) {
    const keep = all.filter((m) => m.userSet);
    for (const m of all) {
      if (keep.length >= current.config.maxModels) break;
      if (!keep.includes(m)) keep.push(m);
    }
    all = keep;
  }
  return { ...current, updatedAt: Date.now(), models: all };
}

let imgRefreshing: Promise<ImgPoolState> | null = null;

async function refreshImgPool(ctx: ExtensionContext, force: boolean): Promise<ImgPoolState> {
  if (!force && imgRefreshing) return imgRefreshing;
  const task = (async () => {
    const current = await loadImgPool();
    if (!force && imgPoolFresh(current)) return current;
    const raw = await getOpenRouterCatalog(force);
    const pool = buildImgPool(current, raw);
    await saveImgPool(pool);
    return pool;
  })();
  imgRefreshing = task;
  try {
    return await task;
  } finally {
    imgRefreshing = null;
  }
}

async function ensureImgPool(ctx: ExtensionContext): Promise<ImgPoolState> {
  const pool = await loadImgPool();
  if (imgPoolFresh(pool)) return pool;
  try {
    return await refreshImgPool(ctx, false);
  } catch {
    return pool;
  }
}

// ---------------------------------------------------------------------------
// 调用：OpenRouter / 用户服务商 两条路径
// ---------------------------------------------------------------------------

interface GenResult {
  b64?: string;
  url?: string;
}

/** 调用任意 OpenAI 兼容 /images/generations 端点。返回图片 base64 与扩展名。 */
async function callImageEndpoint(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  prompt: string,
  size: string,
  signal: AbortSignal,
): Promise<{ b64: string; ext: string }> {
  const res = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: modelId, prompt, n: 1, size }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body.slice(0, 150)}`);
  }
  const j = (await res.json()) as { data?: GenResult[] };
  const item = j?.data?.[0];
  if (!item) throw new Error("空响应");
  if (item.b64_json) return { b64: item.b64_json, ext: "png" };
  if (item.url) {
    const imgRes = await fetch(item.url, { signal });
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return {
      b64: buf.toString("base64"),
      ext: imgRes.headers.get("content-type")?.includes("jpeg") ? "jpg" : "png",
    };
  }
  throw new Error("响应中没有图片数据");
}

/** 生成图片：按优先级尝试池中模型（OpenRouter 与用户服务商混排），
 *  尺寸不被支持时自动回退（1024 → 512 → 256）。 */
async function generateImage(
  ctx: ExtensionContext,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ path: string; modelId: string }> {
  const pool = await ensureImgPool(ctx);
  const config = pool.config;
  const tried = new Set<string>();
  const errors: string[] = [];
  const timeout = signal ?? AbortSignal.timeout(180_000);

  // 可回退的尺寸序列（去重）
  const sizes = [...new Set([config.size, "1024x1024", "512x512", "256x256"])];

  const attempt = async (candidates: ImgPoolModel[]) => {
    for (const m of candidates) {
      if (m.offline || tried.has(m.id)) continue;
      tried.add(m.id);
      try {
        let apiKey: string | undefined;
        let baseUrl: string;
        if (m.provider && m.provider !== "openrouter") {
          // 用户服务商路径
          baseUrl = m.baseUrl ?? "";
          if (!baseUrl) throw new Error(`模型 ${m.id} 缺少 baseUrl`);
          apiKey = m.apiKeyRef ? getEnvValue(m.apiKeyRef.replace(/^\$/, "")) : undefined;
        } else {
          // OpenRouter 路径
          baseUrl = OPENROUTER_BASE;
          try {
            apiKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
          } catch {
            // 环境变量兜底
          }
          apiKey = apiKey ?? process.env.OPENROUTER_API_KEY;
        }
        if (!apiKey) {
          throw new Error(
            m.provider && m.provider !== "openrouter"
              ? `无法解析 ${m.provider} 的 API key（apiKeyRef: ${m.apiKeyRef ?? "未配置"}）`
              : "未找到 OpenRouter API key（/login openrouter 或 OPENROUTER_API_KEY）",
          );
        }
        // 逐尺寸尝试：尺寸不被支持的错误降级到更小尺寸
        let lastErr: Error | undefined;
        for (const size of sizes) {
          try {
            const { b64, ext } = await callImageEndpoint(
              baseUrl,
              apiKey,
              m.id,
              prompt,
              size,
              timeout,
            );
            const outDir =
              config.outputDir || join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "Downloads");
            await mkdir(outDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const file = join(outDir, `wanchuan-${stamp}.${ext}`);
            await writeFile(file, Buffer.from(b64, "base64"));
            return { path: file, modelId: m.id };
          } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
            const msg = lastErr.message;
            if (/size|resolution|dimension|1024|x1024|not support|unsupported/i.test(msg)) {
              continue; // 尺寸问题：换更小尺寸重试
            }
            break; // 其他错误：不换尺寸
          }
        }
        throw lastErr ?? new Error("生成失败");
      } catch (err) {
        errors.push(
          `${m.provider && m.provider !== "openrouter" ? `${m.provider}/${m.id}` : m.id}: ${errMsg(err)}`,
        );
      }
    }
    return undefined;
  };

  let result = await attempt(pool.models);
  if (!result && pool.config.ttlHours > 0) {
    try {
      const fresh = await refreshImgPool(ctx, true);
      result = await attempt(fresh.models);
    } catch (err) {
      errors.push(`刷新池失败: ${errMsg(err)}`);
    }
  }
  if (!result) throw new Error(`图像池所有模型均失败：${errors.join("；")}`);
  return result;
}

// ---------------------------------------------------------------------------
// /img-add：把用户服务商的图像生成模型加入池（端点验证）
// ---------------------------------------------------------------------------

/** 端点验证：发一个最小生成请求（256x256 + 简短 prompt），200 且有图即通过。
 *  注意：会真实生成一次极小图片（按量计费，费用极低）。 */
async function verifyImageModel(
  baseUrl: string,
  apiKey: string,
  modelId: string,
): Promise<boolean> {
  try {
    await callImageEndpoint(baseUrl, apiKey, modelId, "a simple red circle on a white background", "256x256", AbortSignal.timeout(60_000));
    return true;
  } catch {
    return false;
  }
}

/** 拉取服务商模型列表（OpenAI 兼容 /models 端点）。失败返回 null。 */
async function fetchProviderModelList(
  baseUrl: string,
  apiKey: string,
): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { id?: string }[] };
    const list = Array.isArray(j?.data) ? j.data.filter((m) => typeof m.id === "string").map((m) => m.id as string) : [];
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

export function initImageGen(pi: ExtensionAPI): void {
  // ---- 命令：/img-pool ----
  pi.registerCommand("img-pool", {
    description: "查看图像生成池（按优先级排序）。可选参数：free / all / offline",
    handler: async (args, ctx) => {
      const filter = (args || "").trim().toLowerCase();
      const pool = await ensureImgPool(ctx);
      if (pool.models.length === 0) {
        ctx.ui.notify("图像池为空，请先运行 /img-refresh", "warning");
        return;
      }
      const online = pool.models.filter((m) => !m.offline);
      const customCount = online.filter((m) => m.provider && m.provider !== "openrouter").length;
      const list = sortImgModels(pool.models).filter((m) => {
        if (filter === "free") return !m.offline && m.free;
        if (filter === "offline") return m.offline;
        if (filter === "all") return true;
        return !m.offline;
      });
      const lines = [
        `图像生成池：在线 ${online.length} 个（免费 ${online.filter((m) => m.free).length}，` +
          `自定义 ${customCount}），下架 ${pool.models.length - online.length} 个，` +
          `更新于 ${new Date(pool.updatedAt).toLocaleString()}`,
        `用法：/img-generate <提示词> · /img-add [provider] [modelId] · /img-priority [数字] [关键字]`,
        ``,
        ...list.map(
          (m, i) =>
            `${String(i + 1).padStart(3)}. [${String(m.priority).padStart(5)}] ` +
            `${m.offline ? "⚠下架" : m.free ? "FREE" : "paid"} ` +
            `${m.provider && m.provider !== "openrouter" ? `${m.provider}/${m.id}` : m.id}` +
            `${m.userSet ? "  [自定义优先级]" : ""}`,
        ),
      ];
      if (ctx.mode === "tui") {
        await ctx.ui.editor("图像生成池", lines.join("\n"));
        ctx.ui.notify(`图像池：在线 ${online.length} 个，已打开列表`, "info");
      } else {
        ctx.ui.notify(lines.slice(0, 2).join(" | "), "info");
      }
    },
  });

  // ---- 命令：/img-refresh ----
  pi.registerCommand("img-refresh", {
    description: "强制刷新图像生成池",
    handler: async (_args, ctx) => {
      try {
        const pool = await refreshImgPool(ctx, true);
        ctx.ui.notify(
          `图像池已刷新：在线 ${pool.models.filter((m) => !m.offline).length} 个图像生成模型` +
            `（免费 ${pool.models.filter((m) => m.free && !m.offline).length}）`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`刷新失败：${errMsg(err)}`, "error");
      }
    },
  });

  // ---- 命令：/img-add ----
  pi.registerCommand("img-add", {
    description: "把用户服务商（models.json 中配置的）图像生成模型加入池。用法：/img-add [provider] [modelId]",
    handler: async (args, ctx) => {
      const providers = readUserProviders();
      if (providers.length === 0) {
        ctx.ui.notify("没有找到已配置鉴权的用户服务商（请先在 models.json 配置 baseUrl + apiKey）", "warning");
        return;
      }
      const parts = (args || "").trim().split(/\s+/).filter(Boolean);
      let provider = parts[0];
      let modelId = parts[1];

      // 选择服务商
      if (!provider) {
        const picked = await ctx.ui.select(
          "选择服务商：",
          providers.map((p) => `${p.id}（${p.name}）`),
        );
        provider = picked?.split("（")[0];
        if (!provider) return;
      }
      const def = providers.find((p) => p.id === provider);
      if (!def) {
        ctx.ui.notify(`服务商 ${provider} 不在 models.json 中（或缺少 baseUrl/apiKey）`, "warning");
        return;
      }
      // 选择模型
      if (!modelId) {
        const list = await fetchProviderModelList(def.baseUrl, def.apiKey);
        if (!list || list.length === 0) {
          ctx.ui.notify(`无法获取 ${def.name} 的模型列表`, "warning");
          return;
        }
        const picked = await ctx.ui.select(
          `选择 ${def.name} 的图像生成模型：`,
          list,
        );
        modelId = picked;
        if (!modelId) return;
      }
      const pool = await loadImgPool();
      if (pool.models.some((m) => m.id === modelId && !m.offline)) {
        ctx.ui.notify(`模型 ${modelId} 已在图像池中`, "info");
        return;
      }
      ctx.ui.notify(`正在验证 ${def.name}/${modelId}（会生成一张 256x256 极小测试图，按量计费）…`, "info");
      const ok = await verifyImageModel(def.baseUrl, def.apiKey, modelId);
      if (!ok) {
        ctx.ui.notify(`验证失败：${def.name}/${modelId} 不是可用的图像生成模型（或端点不兼容）`, "error");
        return;
      }
      const maxP = Math.max(0, ...pool.models.map((m) => m.priority));
      pool.models.push({
        id: modelId,
        name: `${def.name} ${modelId}`,
        free: false,
        priority: maxP + 1,
        provider: def.id,
        baseUrl: def.baseUrl,
        apiKeyRef: def.apiKeyRef,
      });
      pool.updatedAt = Date.now();
      await saveImgPool(pool);
      ctx.ui.notify(`✅ 已加入图像池：${def.name}/${modelId}（当前优先级 ${maxP + 1}）`, "info");
    },
  });

  // ---- 命令：/img-remove ----
  pi.registerCommand("img-remove", {
    description: "从图像池移除模型。用法：/img-remove [关键字]",
    handler: async (args, ctx) => {
      const pool = await loadImgPool();
      const online = pool.models.filter((m) => !m.offline);
      if (online.length === 0) {
        ctx.ui.notify("图像池为空", "warning");
        return;
      }
      const keyword = (args || "").trim().toLowerCase();
      const matches = keyword
        ? online.filter((mm) => mm.id.toLowerCase().includes(keyword) || mm.name.toLowerCase().includes(keyword))
        : online;
      if (matches.length === 0) {
        ctx.ui.notify(`没有找到匹配“${keyword}”的模型`, "warning");
        return;
      }
      let target: ImgPoolModel | undefined;
      if (matches.length === 1) {
        target = matches[0];
      } else {
        const picked = await ctx.ui.select(
          `选择要移除的模型（${matches.length} 个匹配）：`,
          matches.map((mm) => `[${mm.priority}] ${mm.id}`),
        );
        target = matches.find((mm) => `[${mm.priority}] ${mm.id}` === picked);
      }
      if (!target) return;
      pool.models = pool.models.filter((mm) => mm.id !== target!.id);
      await saveImgPool(pool);
      ctx.ui.notify(`已移除 ${target.id}`, "info");
    },
  });

  // ---- 命令：/img-priority ----
  pi.registerCommand("img-priority", {
    description: "设置图像池模型优先级（数字越小越优先）。用法：/img-priority [数字] [关键字]",
    handler: async (args, ctx) => {
      const pool = await loadImgPool();
      const online = pool.models.filter((m) => !m.offline);
      if (online.length === 0) {
        ctx.ui.notify("图像池为空，请先运行 /img-refresh", "warning");
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
        ? online.filter((mm) => mm.id.toLowerCase().includes(keyword) || mm.name.toLowerCase().includes(keyword))
        : online;
      if (matches.length === 0) {
        ctx.ui.notify(`没有找到匹配“${keyword}”的模型`, "warning");
        return;
      }
      let target: ImgPoolModel | undefined;
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
      await saveImgPool(pool);
      ctx.ui.notify(`已设置 ${target!.id} 的优先级为 ${priority}`, "info");
    },
  });

  // ---- 命令：/img-generate ----
  pi.registerCommand("img-generate", {
    description: "生成图片并保存到本地。用法：/img-generate <提示词>",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("用法：/img-generate <提示词>", "warning");
        return;
      }
      ctx.ui.notify(`正在生成图片（${prompt.slice(0, 40)}…）`, "info");
      try {
        const result = await generateImage(ctx, prompt);
        ctx.ui.notify(`✅ 图片已保存：${result.path}（由 ${result.modelId} 生成）`, "info");
      } catch (err) {
        ctx.ui.notify(`生成失败：${errMsg(err)}`, "error");
      }
    },
  });

  // ---- 工具：generate_image ----
  pi.registerTool({
    name: "generate_image",
    label: "Generate Image",
    description:
      "通过图像生成池生成一张图片并保存到本地。prompt 为图片描述；outputPath 可选（默认 Downloads 目录）。返回保存路径。注意：图像生成模型需要付费额度。",
    promptSnippet: "生成图片（AI 绘图）",
    promptGuidelines: ["当用户要求画图、生成图片、绘图、制作插画/海报/logo 等图像生成需求时，使用 generate_image 工具（提示词要详细：主体、风格、构图、细节）。生成会消耗付费额度。"],
    parameters: Type.Object({
      prompt: Type.String({ description: "图片内容描述" }),
      outputPath: Type.Optional(Type.String({ description: "保存路径（默认 Downloads）" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = (await loadImgPool()).config;
      const result = await generateImage(ctx, params.prompt, signal);
      let finalPath = result.path;
      if (params.outputPath) {
        const target = isAbsolute(params.outputPath)
          ? params.outputPath
          : join(ctx.cwd, params.outputPath);
        await mkdir(join(target, ".."), { recursive: true }).catch(() => {});
        await writeFile(target, Buffer.from(await readFile(result.path)));
        finalPath = target;
      }
      return {
        content: [
          {
            type: "text",
            text: `图片已生成并保存：${finalPath}\n生成模型：${result.modelId}\n提示词：${params.prompt}`,
          },
        ],
        details: { path: finalPath, modelId: result.modelId },
      };
    },
  });
}