/**
 * pi-free-models — 免费优先的 OpenRouter 模型扩展（合并自 openrouter-free + vision-pool）
 *
 * 两个功能共享同一份 OpenRouter 模型目录（内存/文件缓存），整个扩展
 * 启动只拉取一次网络：
 *
 * 1. Provider 注册（or-free.ts）：/model 选择器中 openrouter 提供商只显示免费模型，
 *    `/openrouter-free` 手动刷新 / `list` 查看。
 * 2. 视觉模型池（vision-pool.ts）：文本模型自动看图——上传图片时自动调用
 *    视觉池中优先级最高的多模态模型描述，`/mm-*` 命令管理池。
 *
 * 安装：整个 pi-free-models/ 目录放到 ~/.pi/agent/extensions/ 下，重启 pi。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initFreeProvider } from "./or-free.ts";
import { initVisionPool } from "./vision-pool.ts";
import { initProviderFilter } from "./filter-providers.ts";
import { initImageGen } from "./image-gen.ts";
import { initEndpointPools } from "./endpoint-pool.ts";
import { initScnetSchedule } from "./scnet-schedule.ts";

export default async function (pi: ExtensionAPI) {
  // 先等待 provider 注册（启动时拉取/缓存一次），再初始化各池
  await initFreeProvider(pi);
  // 筛选内置 provider 的模型（nvidia/cloudflare-workers-ai/zai 只留旗舰）
  initProviderFilter(pi);
  initVisionPool(pi);
  initImageGen(pi);
  initEndpointPools(pi);
  initScnetSchedule(pi);
}
