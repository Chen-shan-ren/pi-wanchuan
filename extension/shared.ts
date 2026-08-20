/**
 * shared.ts — pi-wanchuan 万川扩展共享工具
 *
 * 集中三处（endpoint-pool / image-gen / vision-pool）重复的环境变量读取、
 * apiKey 解析、用户服务商读取逻辑，避免改一处漏两处。
 *
 * 内存缓存说明：getEnvValue 优先读 process.env（进程内不变），回退 Windows
 * 注册表（reg query，setx 后必须新进程才生效）——两者在进程内都稳定，
 * 因此缓存结果安全；/login 写 auth.json 不影响本模块（getXiaomiKey 不缓存）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const envCache = new Map<string, string | undefined>();

/** 读取环境变量：优先进程环境，回退 Windows 注册表（setx 后未重启也能读到）。
 *  结果内存缓存（进程内稳定）。 */
export function getEnvValue(name: string): string | undefined {
  if (envCache.has(name)) return envCache.get(name);
  const v = process.env[name];
  if (v) {
    envCache.set(name, v);
    return v;
  }
  try {
    const out = execSync(`reg query "HKCU\\Environment" /v ${name}`, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    const m = out.match(/REG_SZ\s+(\S.*)/);
    if (m) {
      const val = m[1].trim();
      envCache.set(name, val);
      return val;
    }
  } catch {
    // 注册表无此键：回退 undefined
  }
  envCache.set(name, undefined);
  return undefined;
}

/** 解析 apiKey 配置值：支持 `$ENV` 引用与明文。 */
export function resolveApiKey(config: unknown): string | undefined {
  if (typeof config !== "string" || !config) return undefined;
  const m = config.match(/^\$(.+)$/);
  return m ? getEnvValue(m[1]) : config;
}

export interface UserProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 原 apiKey 配置为 $ENV 引用时保存引用（如 $MODELSCOPE_API_TOKEN），否则 undefined */
  apiKeyRef?: string;
}

/** 读 models.json 中已配置鉴权的用户服务商（有 baseUrl 且能解析出 key，排除 openrouter）。 */
export function readUserProviders(): UserProvider[] {
  const out: UserProvider[] = [];
  try {
    const cfg = JSON.parse(readFileSync(join(getAgentDir(), "models.json"), "utf8")) as {
      providers?: Record<string, { name?: string; baseUrl?: string; apiKey?: string }>;
    };
    for (const [id, def] of Object.entries(cfg.providers ?? {})) {
      if (id === "openrouter") continue;
      if (!def?.baseUrl) continue;
      const apiKey = resolveApiKey(def.apiKey);
      if (!apiKey) continue;
      out.push({
        id,
        name: def.name ?? id,
        baseUrl: def.baseUrl.endsWith("/") ? def.baseUrl.slice(0, -1) : def.baseUrl,
        apiKey,
        apiKeyRef: typeof def.apiKey === "string" && def.apiKey.startsWith("$") ? def.apiKey : undefined,
      });
    }
  } catch {
    // 无 models.json
  }
  return out;
}