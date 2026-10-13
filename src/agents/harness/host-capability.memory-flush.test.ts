import "./host-capability.test-mocks.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { initializeMemoryFlushAppendBudget } from "../embedded-agent-runner/run/memory-flush-budget.js";
import { useAdmittedHarnessAttempt } from "./host-capability.admission.test-support.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

const admittedAttempt = useAdmittedHarnessAttempt();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("agent harness host capability memory flush", () => {
  it("shares host-owned memory-flush accounting across external harness tool surfaces", async () => {
    const workspaceDir = tempDirs.make("openclaw-host-memory-flush-");
    const relativePath = "memory/2026-03-24.md";
    const { attempt } = await admittedAttempt("run-memory-flush", {
      cwd: workspaceDir,
      workspaceDir,
      trigger: "memory",
      memoryFlushWritePath: relativePath,
    });
    initializeMemoryFlushAppendBudget(attempt.admittedRunContext.operationalRunInstance);
    const createWrite = (pluginId: string) => {
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId });
      const options = { workspaceDir, trigger: "memory", memoryFlushWritePath: relativePath };
      Object.assign(options, {
        memoryFlushAppendBudget: { acceptedChars: -10_000, acceptedLines: -10_000 },
      });
      const write = host.capabilities
        .createToolSurface?.(options)
        .find((tool) => tool.name === "write");
      if (!write) {
        throw new Error(`expected ${pluginId} host-created write tool`);
      }
      return write.execute;
    };

    await createWrite("codex")("primary", {
      path: relativePath,
      content: "x".repeat(500),
    });
    await expect(
      createWrite("copilot")("fallback", {
        path: relativePath,
        content: "y".repeat(301),
      }),
    ).rejects.toThrow(/across this memory-flush run.*801.*max 800/);
    await expect(
      createWrite("third-party-harness")("third-party", {
        path: relativePath,
        content: "z".repeat(301),
      }),
    ).rejects.toThrow(/across this memory-flush run.*801.*max 800/);
    expect(fs.readFileSync(path.join(workspaceDir, relativePath), "utf8")).toBe("x".repeat(500));
  });
});
