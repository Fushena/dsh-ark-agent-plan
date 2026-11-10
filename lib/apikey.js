import { assertUsableApiKey, LlmError } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

/**
 * 凭据解析：DSH 凭据服务 → 环境变量。每次调用重新解析（改 Key 不用重启）。
 * 候选名按顺序尝试：配置首选 + Agent Plan 常见别名。
 */
export async function resolveApiKey(ctx, candidates, pluginName) {
  const service = ctx.get?.("credentials");
  for (const ref of candidates) {
    const hit = service ? await service.resolve(credentialRef(ref)) : undefined;
    const raw = hit?.value ?? process.env[ref];
    if (typeof raw === "string" && raw.trim() !== "") {
      return assertUsableApiKey(raw, pluginName, ref);
    }
  }
  throw new LlmError(
    `${pluginName}: 缺少 API Key（已尝试 ${candidates.join(" / ")}）。请在 Settings → Models 中为该 provider 配置凭据，或导出同名环境变量。`,
    "MISSING_CREDENTIAL",
  );
}

/** 软解析：拿不到 Key 返回 undefined，不抛错（目录刷新/探测等后台任务用）。 */
export async function tryResolveApiKey(ctx, candidates, pluginName) {
  try {
    return await resolveApiKey(ctx, candidates, pluginName);
  } catch {
    return undefined;
  }
}
