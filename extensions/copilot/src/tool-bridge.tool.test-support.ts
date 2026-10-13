import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { vi } from "vitest";

type FakeTool = AnyAgentTool & {
  execute: ReturnType<typeof vi.fn>;
  prepareArguments?: ReturnType<typeof vi.fn>;
};

export function makeTool(
  overrides: Partial<FakeTool> = {},
  result: { content?: unknown; details: unknown } = {
    content: [{ text: "done", type: "text" }],
    details: null,
  },
): FakeTool {
  return {
    description: "A fake tool",
    execute: vi.fn(async () => result),
    label: "Fake Tool",
    name: "tool-a",
    parameters: {
      properties: { value: { type: "string" } },
      type: "object",
    } as never,
    ...overrides,
  } as unknown as FakeTool;
}
