import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOperationalRunInstanceRef } from "./admitted-run-context.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { initializeMemoryFlushAppendBudget } from "./embedded-agent-runner/run/memory-flush-budget.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { requireTool, requireToolExecute } from "./test-helpers/agent-tools-tool-lookup.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetGlobalHookRunner();
});

describe("createOpenClawCodingTools memory flush", () => {
  it("records restricted memory flush writes without an active memory provider", async () => {
    const workspaceDir = tempDirs.make("openclaw-memory-workspace-");
    const taskCwd = tempDirs.make("openclaw-memory-cwd-");
    const memoryRelativePath = "memory/2026-03-24.md";
    const workspaceMemoryFile = path.join(workspaceDir, memoryRelativePath);
    const taskMemoryFile = path.join(taskCwd, memoryRelativePath);

    await fs.mkdir(path.dirname(workspaceMemoryFile), { recursive: true });
    await fs.writeFile(workspaceMemoryFile, "seed", "utf8");

    const tools = createOpenClawCodingTools({
      workspaceDir,
      cwd: taskCwd,
      config: { plugins: { slots: { memory: "none" } } },
      trigger: "memory",
      memoryFlushWritePath: memoryRelativePath,
      senderIsOwner: false,
    });
    const writeExecute = requireToolExecute(requireTool(tools, "write"));

    await writeExecute("tool-memory-flush-workspace", {
      path: memoryRelativePath,
      content: "new durable note",
    });

    await expect(fs.readFile(workspaceMemoryFile, "utf8")).resolves.toBe("seed\nnew durable note");
    await expect(fs.stat(taskMemoryFile)).rejects.toThrow();
    await expect(
      readMemoryArtifactProvenance({ workspaceDir, relativePath: memoryRelativePath }),
    ).resolves.toMatchObject({ originClass: "untrusted" });
  });

  it("keeps line limits per payload while sharing one host-owned character budget", async () => {
    const workspaceDir = tempDirs.make("openclaw-memory-budget-");
    const memoryRelativePath = "memory/2026-03-24.md";
    const operationalRunInstance = createOperationalRunInstanceRef("memory-flush-run");
    const primaryPayload = `${"x".repeat(249)}\n${"x".repeat(250)}`;
    const fallbackPayload = `${"y".repeat(150)}\n${"y".repeat(150)}`;
    initializeMemoryFlushAppendBudget(operationalRunInstance);
    const createAttemptWrite = (owner = operationalRunInstance) => {
      const options = {
        workspaceDir,
        trigger: "memory",
        memoryFlushWritePath: memoryRelativePath,
        operationalRunInstance: owner,
      };
      Object.assign(options, {
        memoryFlushAppendBudget: { acceptedChars: -10_000, acceptedLines: -10_000 },
      });
      return requireToolExecute(requireTool(createOpenClawCodingTools(options), "write"));
    };

    await createAttemptWrite()("tool-memory-flush-primary", {
      path: memoryRelativePath,
      content: primaryPayload,
    });
    const acceptedBytes = await fs.readFile(path.join(workspaceDir, memoryRelativePath));
    const acceptedHash = crypto.createHash("sha256").update(acceptedBytes).digest("hex");
    expect(acceptedBytes.byteLength).toBe(500);
    await expect(
      createAttemptWrite()("tool-memory-flush-fallback", {
        path: memoryRelativePath,
        content: fallbackPayload,
      }),
    ).rejects.toThrow(/across this memory-flush run.*801.*max 800/);
    const rejectedBytes = await fs.readFile(path.join(workspaceDir, memoryRelativePath));
    expect(rejectedBytes.byteLength).toBe(500);
    expect(crypto.createHash("sha256").update(rejectedBytes).digest("hex")).toBe(acceptedHash);

    const freshRun = createOperationalRunInstanceRef("memory-flush-run-fresh");
    initializeMemoryFlushAppendBudget(freshRun);
    await createAttemptWrite(freshRun)("tool-memory-flush-fresh", {
      path: memoryRelativePath,
      content: "z".repeat(301),
    });
    await expect(fs.readFile(path.join(workspaceDir, memoryRelativePath), "utf8")).resolves.toBe(
      `${primaryPayload}\n${"z".repeat(301)}`,
    );
  });

  it("passes the existing-file ceiling into sandbox memory-flush reads", async () => {
    const workspaceDir = tempDirs.make("openclaw-memory-read-limit-");
    const memoryRelativePath = "memory/2026-03-24.md";
    const bridge = createHostSandboxFsBridge(workspaceDir);
    const readFile = vi.spyOn(bridge, "readFile");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, memoryRelativePath), "seed", "utf8");
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir,
      containerWorkdir: workspaceDir,
      fsBridge: bridge,
    });
    const write = requireToolExecute(
      requireTool(
        createOpenClawCodingTools({
          workspaceDir,
          sandbox,
          trigger: "memory",
          memoryFlushWritePath: memoryRelativePath,
        }),
        "write",
      ),
    );
    await write("tool-memory-flush-sandbox-limit", {
      path: memoryRelativePath,
      content: "bounded note",
    });
    expect(readFile).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 16 * 1024 * 1024 }));
  });
});
