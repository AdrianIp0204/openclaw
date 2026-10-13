import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";

const {
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  hoisted,
} = await import("./dynamic-tool-build.test-support.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let tempDir: string;

describe("Codex app-server memory flush tool build", () => {
  beforeEach(() => {
    hoisted.loadNodeExecAvailability.mockResolvedValue({
      cacheKey: "eligible",
      isAvailable: () => true,
    });
    hoisted.normalizeAgentRuntimeTools.mockClear();
    hoisted.resolveWebSearchToolPolicy.mockClear();
    tempDir = tempDirs.make("openclaw-codex-memory-flush-tools-");
  });

  afterEach(async () => {
    await cleanupDynamicToolBuildFixture(tempDir, []);
  });

  it("limits Codex memory flush runs to managed read and write tools", async () => {
    const factoryOptions: unknown[] = [];

    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    setCodexTestToolFactory(params, (options) => {
      factoryOptions.push(options);
      return [
        createRuntimeDynamicTool("read"),
        createRuntimeDynamicTool("write"),
        createRuntimeDynamicTool("exec"),
        createRuntimeDynamicTool("process"),
        createRuntimeDynamicTool("apply_patch"),
        createRuntimeDynamicTool("message"),
        createRuntimeDynamicTool("web_search"),
      ];
    });
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.trigger = "memory";
    params.memoryFlushWritePath = "memory/2026-05-22.md";
    const sandbox = { enabled: true, backendId: "docker" } as never;
    let persistentWebSearchAllowed = false;
    let webSearchAllowed = true;

    const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, sandbox);
    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox,
      nativeToolSurfaceEnabled,
      onPersistentWebSearchPolicyResolved: (allowed) => {
        persistentWebSearchAllowed = allowed;
      },
      onWebSearchPolicyResolved: (allowed) => {
        webSearchAllowed = allowed;
      },
    });

    expect(nativeToolSurfaceEnabled).toBe(false);
    expect(factoryOptions).toHaveLength(1);
    expect(factoryOptions[0]).toMatchObject({
      trigger: "memory",
      memoryFlushWritePath: "memory/2026-05-22.md",
    });
    expect(factoryOptions[0]).not.toHaveProperty("memoryFlushAppendBudget");
    expect(tools.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(persistentWebSearchAllowed).toBe(true);
    expect(webSearchAllowed).toBe(false);
  });

  it("keeps persistent search disabled during a memory flush when config disables it", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    setCodexTestToolFactory(params, () => [
      createRuntimeDynamicTool("read"),
      createRuntimeDynamicTool("write"),
      createRuntimeDynamicTool("web_search"),
    ]);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.trigger = "memory";
    params.memoryFlushWritePath = "memory/2026-05-22.md";
    params.config = { tools: { web: { search: { enabled: false } } } };
    let persistentWebSearchAllowed = true;

    await buildDynamicToolsForTest(params, workspaceDir, {
      onPersistentWebSearchPolicyResolved: (allowed) => {
        persistentWebSearchAllowed = allowed;
      },
    });

    expect(persistentWebSearchAllowed).toBe(false);
  });
});
