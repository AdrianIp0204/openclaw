import { afterEach } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import type { createAgentHarnessHostCapabilities } from "./host-capability.js";

export type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

export function useAdmittedHarnessAttempt() {
  const admissions: PreparedAgentRunAdmission[] = [];

  afterEach(() => {
    for (const admission of admissions.splice(0)) {
      admission.close();
    }
    resetAgentRunRegistryForTest();
  });

  return async function admittedAttempt(
    runId = "run-1",
    overrides: Omit<Partial<HostAttempt>, "admittedRunContext" | "runId"> = {},
  ): Promise<{ attempt: HostAttempt; admission: PreparedAgentRunAdmission }> {
    const admission = prepareAgentRunAdmission({
      cfg: {},
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
      },
      operationalRunInstance: createOperationalRunInstanceRef(runId),
    });
    admissions.push(admission);
    const admittedRunContext = await admission.admit("plugin-harness", `harness-${runId}`);
    return {
      admission,
      attempt: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId,
        cwd: "/attempt/worktree",
        workspaceDir: "/workspace",
        currentChannelId: "chat-1",
        messageChannel: "telegram",
        ...overrides,
        admittedRunContext,
      },
    };
  };
}
