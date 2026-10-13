import { vi } from "vitest";

vi.mock("../agent-tools.before-tool-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-tools.before-tool-call.js")>()),
  rewrapToolWithBeforeToolCallHook: vi.fn((tool) => tool),
  runBeforeToolCallHook: vi.fn(async ({ params }) => ({ blocked: false, params })),
}));
vi.mock("../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
