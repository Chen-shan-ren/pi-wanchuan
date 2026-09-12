/**
 * scnet-schedule.ts — 国超算 高峰/低峰 动态上下文窗口（pi-wanchuan 万川扩展模块）
 *
 * 国超算(scnet/scnet2)后端是负载均衡、各节点上下文上限不一致：
 * - 白天高峰人多 → 超大上下文容易 500 / 超时
 * - 晚上人少     → 能撑住更大的上下文
 *
 * 本模块按本地时间动态调整 scnet2 的 contextWindow（通过 pi.registerProvider
 * 运行时覆盖 models.json 里的模型定义，无需重启）。每 60 秒检查一次，
 * 仅在窗口切换时重新注册。可用 /scnet-window 查看当前生效值。
 *
 * 时间窗口与窗口大小在下方「可调参数」区修改。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ==================== 可调参数 ====================
// 高峰时段：本地小时在 [PEAK_START, PEAK_END) 内视为高峰（含起始、不含结束）
const PEAK_START = 9;    // 09:00 起为高峰（白天）
const PEAK_END = 19;     // 19:00 起为低峰（晚上 7 点高峰结束）
const PEAK_CONTEXT_WINDOW = 1048576;    // 高峰（白天）：应需求设为 1M（原 240K 是为规避高峰 500 的保守值）
const OFFPEAK_CONTEXT_WINDOW = 1048576; // 低峰（夜晚）：1024K 上下文，夜间负载低可用，需实际验证

// 是否同时应用到 scnet（国超算1）。默认 false：只影响 scnet2
const ALSO_APPLY_TO_SCNET = false;

// scnet2 / scnet 在 models.json 里的模型 id 列表
const SCNET_MODEL_IDS = ["DeepSeek-V4-Flash-0731", "DeepSeek-V4-Pro-0813", "Kimi-K3", "Qwen3.8-Max", "GLM-5.3"];

// 定时检查间隔（毫秒）
const CHECK_INTERVAL_MS = 60_000;
// ==================================================

const TARGET_PROVIDERS: string[] = ALSO_APPLY_TO_SCNET ? ["scnet2", "scnet"] : ["scnet2"];

let lastWindow = -1;
let firstRun = true;

function windowForTime(d: Date): number {
  const h = d.getHours();
  return h >= PEAK_START && h < PEAK_END ? PEAK_CONTEXT_WINDOW : OFFPEAK_CONTEXT_WINDOW;
}

function buildScnetModels(windowSize: number) {
  return SCNET_MODEL_IDS.map((id) => ({
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    // 动态 registerProvider 会替换模型对象；必须保留完整 cost 结构，
    // 否则 pi 的费用计算读取 cost.tiers 时会触发 undefined.tiers。
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [],
    },
    contextWindow: windowSize,
    maxTokens: 65536,
    thinkingLevelMap: {
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
  }));
}

function apply(pi: ExtensionAPI): void {
  const w = windowForTime(new Date());
  if (w === lastWindow) return; // 窗口没变，无需重复注册
  for (const p of TARGET_PROVIDERS) {
    try {
      pi.registerProvider(p, { api: "openai-completions", models: buildScnetModels(w) });
    } catch (e) {
      console.error(`[scnet-schedule] 注册 provider "${p}" 失败:`, e);
    }
  }
  if (firstRun) {
    firstRun = false;
    console.log(`[scnet-schedule] 启动：本地 ${new Date().getHours()} 点 → ${TARGET_PROVIDERS.join("+")} contextWindow=${w}`);
  } else {
    console.log(`[scnet-schedule] 窗口切换：contextWindow ${lastWindow} -> ${w}`);
  }
  lastWindow = w;
}

export function initScnetSchedule(pi: ExtensionAPI): void {
  try {
    apply(pi);
    setInterval(() => {
      try {
        apply(pi);
      } catch (e) {
        console.error("[scnet-schedule] 定时检查出错:", e);
      }
    }, CHECK_INTERVAL_MS);

    pi.registerCommand("scnet-window", {
      description: "查看国超算当前生效的上下文窗口（高峰/低峰）",
      handler: async (_args, ctx) => {
        const w = windowForTime(new Date());
        const period = w === PEAK_CONTEXT_WINDOW ? "高峰（白天）" : "低峰（夜晚）";
        ctx.ui.notify(
          `[scnet-schedule] ${period} → contextWindow=${w}（${TARGET_PROVIDERS.join("+")}）`,
          "info"
        );
      },
    });
  } catch (e) {
    // 初始化失败不影响 pi-wanchuan 其它模块
    console.error("[scnet-schedule] 初始化失败（已跳过）:", e);
  }
}
