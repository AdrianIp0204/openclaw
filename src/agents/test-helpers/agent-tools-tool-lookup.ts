import type { createOpenClawCodingTools } from "../agent-tools.js";

type OpenClawCodingTool = ReturnType<typeof createOpenClawCodingTools>[number];

export function requireTool(tools: OpenClawCodingTool[], name: string): OpenClawCodingTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`expected ${name} tool`);
  }
  return tool;
}

export function requireToolExecute(
  tool: OpenClawCodingTool,
): NonNullable<OpenClawCodingTool["execute"]> {
  if (!tool.execute) {
    throw new Error(`expected ${tool.name} tool execute`);
  }
  return tool.execute;
}
