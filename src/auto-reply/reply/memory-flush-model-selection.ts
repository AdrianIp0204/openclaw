import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveModelFallbackOptions } from "./agent-runner-run-params.js";
import type { FollowupRun } from "./queue.js";

export function resolveMemoryFlushModelFallbackOptions(
  run: FollowupRun["run"],
  model?: string,
  configOverride: FollowupRun["run"]["config"] = run.config,
) {
  const options = resolveModelFallbackOptions(run, configOverride);
  const override = normalizeOptionalString(model);
  if (!override) {
    return options;
  }
  // A memory-flush maintenance model is an exact override: do not let a failed
  // local flush silently fall through to the paid active conversation fallback.
  const slashIdx = override.indexOf("/");
  if (slashIdx > 0) {
    const overrideProvider = override.slice(0, slashIdx).trim();
    const overrideModel = override.slice(slashIdx + 1).trim();
    if (overrideProvider && overrideModel) {
      return {
        ...options,
        provider: overrideProvider,
        model: overrideModel,
        requestedRouteResolution: "raw" as const,
        fallbacksOverride: [],
      };
    }
  }
  return {
    ...options,
    model: override,
    requestedRouteResolution: "raw" as const,
    fallbacksOverride: [],
  };
}
