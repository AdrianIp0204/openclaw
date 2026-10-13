import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  createAdmittedRunOperatorAuthority,
  getAdmittedRunDelegatedAuthority,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { resolveMemoryFlushAppendEnforcement } from "../../agents/embedded-agent-runner/run/memory-flush-budget.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { registerMemoryCapability } from "../../plugins/memory-state.test-fixtures.js";
import type { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import {
  createFlushSessionEntry,
  createModifiedMemoryFlushPlan,
  loadMainSessionEntry,
  modelRoutingProvenance,
  type EmbeddedAgentParams,
  type ModelFallbackParams,
} from "./agent-runner-memory.test-support.js";
import { createTestFollowupRun, writeTestSessionStore } from "./agent-runner.test-fixtures.js";

type MemoryFlushFallbackFixture = {
  getRootDir: () => string;
  runDefaultMemoryFlush: (
    sessionEntry: SessionEntry,
    overrides?: Partial<Parameters<typeof runMemoryFlushIfNeeded>[0]>,
  ) => ReturnType<typeof runMemoryFlushIfNeeded>;
  runEmbeddedAgentMock: Mock;
  runEmbeddedAgentEntryMock: Mock;
  runWithModelFallbackMock: Mock;
  incrementCompactionCountMock: Mock;
  refreshQueuedFollowupSessionMock: Mock;
};

// Retain the runner suite's hoisted mocks, session state, and per-case cleanup.
export function registerMemoryFlushFallbackTests({
  getRootDir,
  runDefaultMemoryFlush,
  runEmbeddedAgentMock,
  runEmbeddedAgentEntryMock,
  runWithModelFallbackMock,
  incrementCompactionCountMock,
  refreshQueuedFollowupSessionMock,
}: MemoryFlushFallbackFixture) {
  it("reuses its private buffer, admission, and append budget across a model fallback", async () => {
    const storePath = path.join(getRootDir(), "sessions.json");
    const sessionKey = "main";
    const sessionEntry = createFlushSessionEntry({ lifecycleRevision: "memory-generation" });
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);
    const primaryError = new Error("primary failed after private compaction");
    let memorySession: SessionManager | undefined;
    let admission: PreparedAgentRunAdmission | undefined;
    let admittedContext: AdmittedRunContext | undefined;
    let appendEnforcement: ReturnType<typeof resolveMemoryFlushAppendEnforcement>;
    const releaseOperatorAuthority = vi.fn();
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.write"],
      assertCurrent: vi.fn(),
      retain: () => releaseOperatorAuthority,
    });
    runEmbeddedAgentMock
      .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        admission = params.preparedRunAdmission;
        memorySession = params.sessionManager;
        if (!admission || !memorySession) {
          throw new Error("Missing private memory runtime");
        }
        appendEnforcement = resolveMemoryFlushAppendEnforcement(admission.operationalRunInstance);
        if (!appendEnforcement) {
          throw new Error("Missing host-owned memory append enforcement");
        }
        expect(params).not.toHaveProperty("memoryFlushAppendBudget");
        await appendEnforcement({ appendChars: 500, commit: async () => undefined });
        expect(memorySession.getSessionTarget()).toBeUndefined();
        admittedContext = await admission.admit("embedded");
        expect(getAdmittedRunDelegatedAuthority(admittedContext)).toBeDefined();
        expect(readAdmittedRunOperatorAuthority(admittedContext)).toMatchObject({
          profileId: "guest",
          scopes: ["operator.write"],
        });
        const retained = memorySession.appendMessage(makeUserMessage("Private retained work", 1));
        memorySession.appendCompaction("Private summary", retained, 120);
        throw primaryError;
      })
      .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        if (!memorySession || !admission || !admittedContext || !appendEnforcement) {
          throw new Error("Missing first memory attempt");
        }
        expect(params.sessionManager).toBe(memorySession);
        expect(params.preparedRunAdmission).toBe(admission);
        expect(resolveMemoryFlushAppendEnforcement(admission.operationalRunInstance)).toBe(
          appendEnforcement,
        );
        expect(params).not.toHaveProperty("memoryFlushAppendBudget");
        await expect(
          appendEnforcement({ appendChars: 301, commit: async () => undefined }),
        ).rejects.toThrow(/across this memory-flush run.*801.*max 800/);
        expect(await admission.admit("embedded")).toBe(admittedContext);
        expect(getAdmittedRunDelegatedAuthority(admittedContext)).toBeDefined();
        expect(memorySession.getBranch().at(-1)).toMatchObject({
          type: "compaction",
          summary: "Private summary",
        });
        expect(loadMainSessionEntry(storePath).compactionCount).toBe(1);
        return { payloads: [], meta: {} };
      });
    runWithModelFallbackMock.mockImplementationOnce(async (params: ModelFallbackParams) => {
      await expect(
        params.run("anthropic", "claude", {
          modelRoutingProvenance: modelRoutingProvenance("anthropic", "claude"),
        }),
      ).rejects.toBe(primaryError);
      return {
        result: await params.run("anthropic", "fallback", {
          modelRoutingProvenance: modelRoutingProvenance("anthropic", "claude", "fallback"),
        }),
        provider: "anthropic",
        model: "fallback",
        attempts: [],
      };
    });
    const result = await runDefaultMemoryFlush(sessionEntry, {
      followupRun: {
        ...createTestFollowupRun({
          thinkingCatalog: [
            { provider: "anthropic", id: "claude", input: ["text"] },
            { provider: "anthropic", id: "fallback", input: ["text"] },
          ],
        }),
        operatorAuthority,
      },
      sessionStore,
      sessionKey,
      storePath,
    });
    expect(result.outcome).toBe("completed");
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedAgentEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: { kind: "memory-flush-maintenance" } }),
    );
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSessionMock).not.toHaveBeenCalled();
    expect(loadMainSessionEntry(storePath)).toMatchObject({
      sessionId: "session",
      lifecycleRevision: "memory-generation",
      compactionCount: 1,
      memoryFlush: { kind: "succeeded", compactionCount: 1 },
    });
    if (!admittedContext) {
      throw new Error("Memory attempt was not admitted");
    }
    expect(getAdmittedRunDelegatedAuthority(admittedContext)).toBeUndefined();
    expect(releaseOperatorAuthority).toHaveBeenCalledOnce();
  });

  it("keeps non-daily plugin memory flushes out of guarded result fallback", async () => {
    registerMemoryCapability("memory-core", {
      flushPlanResolver: () => createModifiedMemoryFlushPlan({ relativePath: "memory/sidecar.md" }),
    });
    const sessionEntry = createFlushSessionEntry();
    const storePath = path.join(getRootDir(), "sessions.json");
    await writeTestSessionStore(storePath, "main", sessionEntry);

    const result = await runDefaultMemoryFlush(sessionEntry, { storePath });

    expect(result.outcome).toBe("completed");
    expect(runEmbeddedAgentEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: { kind: "maintenance" } }),
    );
  });
}
