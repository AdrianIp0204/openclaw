import {
  QA_MEMORY_FLUSH_CUMULATIVE_FALLBACK_MARKER_RE,
  type MockScenarioState,
  type QaMockProviderFailure,
  type StreamEvent,
} from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";
import { buildScenarioToolCallEvents } from "./mock-openai-tool-routing.js";

const QA_MEMORY_FLUSH_CUMULATIVE_FALLBACK_PROMPT_RE = /Pre-compaction memory flush\./u;
const QA_MEMORY_FLUSH_DAILY_PATH_RE = /\bmemory\/\d{4}-\d{2}-\d{2}\.md\b/u;
const QA_MEMORY_FLUSH_PRIMARY_MODEL = "gpt-5.6-luna";
const QA_MEMORY_FLUSH_FALLBACK_MODEL = "gpt-5.6-luna-alt";

function isMemoryFlushCumulativeFallbackRequest(params: { allInputText: string; prompt: string }) {
  return (
    QA_MEMORY_FLUSH_CUMULATIVE_FALLBACK_MARKER_RE.test(params.allInputText) &&
    QA_MEMORY_FLUSH_CUMULATIVE_FALLBACK_PROMPT_RE.test(params.prompt)
  );
}

function isAcceptedMemoryFlushAppendResult(toolOutput: string) {
  return /^Appended content to memory\/\d{4}-\d{2}-\d{2}\.md\.$/u.test(toolOutput.trim());
}
export function buildMemoryFlushCumulativeFallbackEvents(params: {
  allInputText: string;
  prompt: string;
  model: string;
  hasCompletedToolOutput: boolean;
  toolDeclarationBody: Record<string, unknown>;
}): StreamEvent[] | undefined {
  if (!isMemoryFlushCumulativeFallbackRequest(params)) {
    return undefined;
  }
  if (params.hasCompletedToolOutput) {
    return buildAssistantEvents("NO_REPLY");
  }
  const dailyPath = params.allInputText.match(QA_MEMORY_FLUSH_DAILY_PATH_RE)?.[0];
  if (!dailyPath) {
    throw new Error("memory-flush cumulative fallback fixture missing canonical daily path");
  }
  if (params.model === QA_MEMORY_FLUSH_PRIMARY_MODEL) {
    return buildScenarioToolCallEvents(params.toolDeclarationBody, "write", {
      path: dailyPath,
      content: "P".repeat(500),
    });
  }
  if (params.model === QA_MEMORY_FLUSH_FALLBACK_MODEL) {
    return buildScenarioToolCallEvents(params.toolDeclarationBody, "write", {
      path: dailyPath,
      content: "F".repeat(301),
    });
  }
  return undefined;
}

export function resolveMemoryFlushCumulativeFallbackFailure(
  params: { allInputText: string; prompt: string; model: string; toolOutput: string },
  scenarioState: Pick<MockScenarioState, "memoryFlushPrimary503Served">,
): QaMockProviderFailure | undefined {
  if (
    params.model !== QA_MEMORY_FLUSH_PRIMARY_MODEL ||
    !isMemoryFlushCumulativeFallbackRequest(params) ||
    !isAcceptedMemoryFlushAppendResult(params.toolOutput)
  ) {
    return undefined;
  }
  const failure = scenarioState.memoryFlushPrimary503Served
    ? {
        status: 400,
        type: "server_error",
        message: "Injected terminal server error",
      }
    : {
        status: 503,
        type: "server_error",
        message: "Service Unavailable",
      };
  // Codex retries 5xx responses internally. The first response records the requested
  // 503, then a non-retryable response exposes the server error to OpenClaw's fallback.
  scenarioState.memoryFlushPrimary503Served = true;
  return failure;
}
