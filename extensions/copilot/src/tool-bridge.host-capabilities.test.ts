import { expectDefined } from "@openclaw/normalization-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import { createCopilotToolBridge as createCopilotToolBridgeImpl } from "./tool-bridge.js";
import { createCopilotToolBridge, makeInvocation } from "./tool-bridge.test-support.js";
import { makeTool } from "./tool-bridge.tool.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCopilotToolBridge host capabilities", () => {
  it("rejects a direct caller that omits the required host capability", async () => {
    await expect(
      createCopilotToolBridgeImpl({
        agentId: "agent-1",
        attemptParams: {} as never,
        modelId: "gpt-test",
        modelProvider: "github-copilot",
        sessionId: "session-1",
        spawnWorkspaceDir: undefined,
      }),
    ).rejects.toThrow("Copilot attempt tools require host-bound capabilities");
  });

  it("constructs production tools through the host seam without forwarding mutable state", async () => {
    const bindToolSurface = vi.fn((tools: AnyAgentTool[]) => tools);
    const receivedOptions: unknown[] = [];
    const createToolSurface = vi.fn((options: unknown) => {
      receivedOptions.push(options);
      return [makeTool({ name: "read" })];
    });
    const attemptParams = {
      config: { tools: { codeMode: false as const } },
      trigger: "memory" as const,
      memoryFlushWritePath: "memory/2026-03-24.md",
      hostCapabilities: {
        ...createCopilotTestHostCapabilities(),
        bindToolSurface,
        createToolSurface,
      },
    };
    Object.assign(attemptParams, {
      memoryFlushAppendBudget: { acceptedChars: -10_000, acceptedLines: -10_000 },
    });

    const bridge = await createCopilotToolBridgeImpl({
      agentId: "agent-1",
      attemptParams,
      modelId: "gpt-test",
      modelProvider: "github-copilot",
      sessionId: "session-1",
      spawnWorkspaceDir: undefined,
    });

    expect(createToolSurface).toHaveBeenCalledOnce();
    expect(receivedOptions[0]).toMatchObject({
      trigger: "memory",
      memoryFlushWritePath: "memory/2026-03-24.md",
    });
    expect(receivedOptions[0]).not.toHaveProperty("memoryFlushAppendBudget");
    expect(bindToolSurface).not.toHaveBeenCalled();
    expect(bridge.sourceTools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("binds every tool surface and retained source/SDK tools fail after capability closure", async () => {
    let active = true;
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const bindToolSurface = vi.fn((tools: AnyAgentTool[], _options?: Readonly<{ cwd?: string }>) =>
      tools.map((tool) => ({
        ...tool,
        execute: async (...args: Parameters<NonNullable<AnyAgentTool["execute"]>>) => {
          if (!active) {
            throw new Error("agent harness host capability is no longer active");
          }
          return await tool.execute?.(...args);
        },
      })),
    );
    const bridge = await createCopilotToolBridge({
      cwd: "/tmp/copilot-native-cwd",
      attemptParams: {
        hostCapabilities: createCopilotTestHostCapabilities(
          () => [makeTool({ execute })],
          bindToolSurface,
        ),
      },
      modelId: "gpt-test",
    });
    const source = expectDefined(bridge.sourceTools[0], "bound Copilot source tool");
    const sdk = expectDefined(bridge.promptToolPolicy.apply().tools[0], "bound Copilot SDK tool");
    const copiedSourceExecute = source.execute;
    const copiedSdkHandler = sdk.handler;
    active = false;

    await expect(copiedSourceExecute?.("call-1", {})).rejects.toThrow("no longer active");
    await expect(copiedSdkHandler?.({}, makeInvocation())).resolves.toMatchObject({
      resultType: "failure",
      textResultForLlm: expect.stringContaining("no longer active"),
    });
    expect(bindToolSurface).toHaveBeenCalledTimes(1);
    expect(bindToolSurface).toHaveBeenCalledWith(expect.any(Array), {
      cwd: "/tmp/copilot-native-cwd",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
