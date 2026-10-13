import type {
  MockCompactionSummaryFaultMode,
  MockOpenAiRequestKind,
} from "./mock-openai-contracts.js";

export const QA_COMPACTION_RETRY_PROMPT_RE = /compaction retry mutating tool check/i;
export const QA_COMPACTION_RETRY_OVERFLOW_THRESHOLD_BYTES = 256 * 1024;
export const QA_COMPACTION_OUTPUT_RECOVERY_OVERFLOW_THRESHOLD_BYTES = 96 * 1024;
export const QA_COMPACTION_RETRY_DURABLE_MARKER = "QA-COMPACTION-DURABLE-MARKER";
export const QA_COMPACTION_RETRY_BULKY_MARKER = "QA-COMPACTION-BULKY-HISTORICAL-MARKER";
export const QA_COMPACTION_RETRY_HISTORICAL_PHRASE = "post-marker historical user block";
const QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE =
  /\bQA-COMPACTION-EMPTY-OUTPUT-ONCE-[A-Za-z0-9_-]+\b/u;
const QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE =
  /\bQA-COMPACTION-REASONING-ONLY-OUTPUT-ONCE-[A-Za-z0-9_-]+\b/u;
const QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-EMPTY-RECOVERED-SUMMARY";
const QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-REASONING-RECOVERED-SUMMARY";
export const QA_COMPACTION_RETRY_SUMMARY = `## Decisions
- Continue the compaction retry from durable context without replaying a completed mutation.

## Open TODOs
- Write compaction-retry-summary.txt exactly once.
- Return the final replay-safety marker.

## Constraints/Rules
- Preserve ${QA_COMPACTION_RETRY_DURABLE_MARKER}.
- Write exactly: Replay safety: unsafe after write.

## Pending user asks
- Create compaction-retry-summary.txt, then reply exactly: Protocol note: replay unsafe after write.

## Exact identifiers
- ${QA_COMPACTION_RETRY_DURABLE_MARKER}
- compaction-retry-summary.txt`;
export const QA_COMPACTION_RETRY_HISTORICAL_SUMMARY = `## Decisions
- Preserve the latest ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} context through staged compaction.

## Open TODOs
- Continue summarizing the ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} sequence.

## Constraints/Rules
- Keep historical content distinct from live task state.
- Do not invent durable context absent from the summarized history.

## Pending user asks
- Retain the ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} details.

## Exact identifiers
- None captured.`;
const QA_GENERIC_COMPACTION_SUMMARY = `## Decisions
- Continue from the summary without restarting completed work.

## Open TODOs
- Continue the active task.

## Constraints/Rules
- Keep current requirements and identifiers.

## Pending user asks
- Continue the active task from the retained context.

## Exact identifiers
- None captured.`;
const QA_COMPACTION_OUTPUT_RECOVERY_SUMMARY = `## Decisions
- Retry the typed compaction-summary fault at the compaction owner.

## Open TODOs
- Continue the active task after compaction.

## Constraints/Rules
- Preserve the historical recovery user block and current continuation.

## Pending user asks
- Retain the historical recovery user block context.

## Exact identifiers`;

export function resolveCompactionRecoverySummary(allInputText: string) {
  const faultMarker =
    QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.exec(allInputText)?.[0] ??
    QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.exec(allInputText)?.[0];
  const recoveryMarker = faultMarker?.startsWith("QA-COMPACTION-EMPTY-")
    ? QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER
    : faultMarker
      ? QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER
      : undefined;
  return recoveryMarker && faultMarker
    ? `${QA_COMPACTION_OUTPUT_RECOVERY_SUMMARY}\n- ${recoveryMarker}\n- ${faultMarker}`
    : QA_GENERIC_COMPACTION_SUMMARY;
}

export function hasCompactionOutputRecoveryMarker(allInputText: string) {
  return (
    QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.test(allInputText) ||
    QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.test(allInputText)
  );
}

export function resolveCompactionSummaryFaultMode(params: {
  allInputText: string;
  requestKind: MockOpenAiRequestKind;
  servedFaultMarkers: Set<string>;
}): MockCompactionSummaryFaultMode {
  if (params.requestKind !== "compaction-summary") {
    return "none";
  }
  const emptyMarker = QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.exec(params.allInputText)?.[0];
  const reasoningMarker = QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.exec(
    params.allInputText,
  )?.[0];
  const selected = emptyMarker
    ? {
        key: emptyMarker,
        mode: "empty-output-once" as const,
      }
    : reasoningMarker
      ? {
          key: reasoningMarker,
          mode: "reasoning-only-output-once" as const,
        }
      : undefined;
  if (!selected?.key || params.servedFaultMarkers.has(selected.key)) {
    return "none";
  }
  params.servedFaultMarkers.add(selected.key);
  return selected.mode;
}
