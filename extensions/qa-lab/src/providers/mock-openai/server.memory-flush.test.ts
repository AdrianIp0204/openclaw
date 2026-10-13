import { describe, expect, it } from "vitest";
import {
  createMockServerTestHarness,
  expectNonStreamingResponsesJson,
  expectOpenAiNonStreamingResponsesJson,
  getJson,
  makeToolOutputWithCallId,
  makeUserInput,
  outputText,
  outputToolArgsFromItem,
  outputToolCall,
  outputToolCallId,
  postResponses,
  requireArray,
  requireRecord,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const WRITE_TOOL = { type: "function", name: "write" } as const;

describe("qa mock openai memory flush fallback", () => {
  it("drives one accepted memory-flush append through a 503 and terminal server error into a rejected fallback append", async () => {
    const server = await startMockServer();
    const dailyPath = "memory/2026-08-20.md";
    const prompt = [
      "MEMORY-FLUSH-CUMULATIVE-FALLBACK-QA",
      "OpenClaw assembled context for this turn:",
      "Current user request:",
      `Pre-compaction memory flush. Store durable memories only in ${dailyPath}.`,
    ].join("\n");

    const primaryPlanPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [WRITE_TOOL],
      input: [makeUserInput(prompt)],
    });
    const primaryCall = outputToolCall(primaryPlanPayload, "write");
    const primaryCallId = outputToolCallId(primaryCall, "missing-primary-call-id");
    expect(outputToolArgsFromItem(primaryCall)).toEqual({
      path: dailyPath,
      content: "P".repeat(500),
    });

    const primaryContinuation = {
      model: "gpt-5.6-luna",
      tools: [WRITE_TOOL],
      input: [
        makeUserInput(prompt),
        primaryCall,
        makeToolOutputWithCallId(primaryCallId, `Appended content to ${dailyPath}.`),
      ],
    };
    const primaryFailure = await postResponses(server, { stream: false, ...primaryContinuation });
    expect(primaryFailure.status).toBe(503);
    const primaryRetryFailure = await postResponses(server, {
      stream: false,
      ...primaryContinuation,
    });
    expect(primaryRetryFailure.status).toBe(400);

    const fallbackPlanPayload = await expectNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna-alt",
      tools: [WRITE_TOOL],
      input: [makeUserInput(prompt)],
    });
    const fallbackCall = outputToolCall(fallbackPlanPayload, "write");
    const fallbackCallId = outputToolCallId(fallbackCall, "missing-fallback-call-id");
    expect(outputToolArgsFromItem(fallbackCall)).toEqual({
      path: dailyPath,
      content: "F".repeat(301),
    });

    const rejection =
      "Memory flush append rejected: content across this memory-flush run is too large (801 chars; max 800). Write 1-3 short pointer lines only.";
    const fallbackContinuation = await expectNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna-alt",
      tools: [WRITE_TOOL],
      input: [
        makeUserInput(prompt),
        fallbackCall,
        makeToolOutputWithCallId(fallbackCallId, rejection),
      ],
    });
    expect(outputText(fallbackContinuation)).toBe("NO_REPLY");

    const requests = requireArray(
      await getJson(server, "/debug/requests"),
      "memory-flush requests",
    ).map((request) => requireRecord(request, "memory-flush request"));
    expect(requests).toHaveLength(5);
    expect(requests[0]).toMatchObject({
      model: "gpt-5.6-luna",
      outcome: "success",
      plannedToolName: "write",
      plannedToolArgs: { path: dailyPath, content: "P".repeat(500) },
    });
    expect(requests[1]).toMatchObject({
      model: "gpt-5.6-luna",
      outcome: "error",
      failureStatus: 503,
      toolOutputCallId: primaryCallId,
    });
    expect(requests[2]).toMatchObject({
      model: "gpt-5.6-luna",
      outcome: "error",
      failureStatus: 400,
      toolOutputCallId: primaryCallId,
    });
    expect(requests[3]).toMatchObject({
      model: "gpt-5.6-luna-alt",
      outcome: "success",
      plannedToolName: "write",
      plannedToolArgs: { path: dailyPath, content: "F".repeat(301) },
    });
    expect(requests[4]).toMatchObject({
      model: "gpt-5.6-luna-alt",
      outcome: "success",
      toolOutputCallId: fallbackCallId,
      toolOutput: rejection,
    });
    expect(requests[4]).not.toHaveProperty("toolOutputStructuredError");
  });
});
