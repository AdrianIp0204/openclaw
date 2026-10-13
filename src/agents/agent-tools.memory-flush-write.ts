import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { withFileLock } from "../infra/file-lock.js";
import { resolveAbsolutePathForWrite, root as fsRoot, FsSafeError } from "../infra/fs-safe.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import type { OperationalRunInstanceRef } from "./admitted-run-context.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import { resolveToolPathAgainstWorkspaceRoot } from "./agent-tools.file-path.js";
import {
  REQUIRED_PARAM_GROUPS,
  assertRequiredParams,
  getToolParamsRecord,
  normalizeFileToolPathParamsFromKeys,
} from "./agent-tools.params.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  createMemoryFlushAppendEnforcement,
  resolveMemoryFlushAppendEnforcement,
} from "./embedded-agent-runner/run/memory-flush-budget.js";
import {
  DAILY_MEMORY_FLUSH_MAX_EXISTING_FILE_BYTES,
  isDailyMemoryPath,
  memoryFlushAppendRejected,
  prepareDailyMemoryFlushAppend,
} from "./memory-flush-append.js";
import type { MemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import { toRelativeWorkspacePath } from "./path-policy.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

const DAILY_MEMORY_FLUSH_LOCK_OPTIONS = {
  retries: { retries: 10, factor: 1, minTimeout: 10, maxTimeout: 100, randomize: true },
  stale: 30_000,
};

const dailyMemoryFlushProcessLocks = new KeyedAsyncQueue();

type MemoryFlushAppendOnlyWriteOptions = {
  root: string;
  relativePath: string;
  memoryWriteProvenance?: MemoryWriteProvenanceObserver;
  containerWorkdir?: string;
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
  operationalRunInstance?: OperationalRunInstanceRef;
};

async function readOptionalUtf8File(params: {
  root: string;
  relativePath: string;
  sandbox?: MemoryFlushAppendOnlyWriteOptions["sandbox"];
  signal?: AbortSignal;
}): Promise<string> {
  const dailyMemory = isDailyMemoryPath(params.relativePath);
  try {
    if (params.sandbox) {
      const stat = await params.sandbox.bridge.stat({
        filePath: params.relativePath,
        cwd: params.sandbox.root,
        signal: params.signal,
      });
      if (!stat) {
        return "";
      }
      if (dailyMemory && stat.size > DAILY_MEMORY_FLUSH_MAX_EXISTING_FILE_BYTES) {
        throw memoryFlushAppendRejected(
          `existing daily memory file exceeds ${DAILY_MEMORY_FLUSH_MAX_EXISTING_FILE_BYTES} bytes; compact it before appending more memory-flush content.`,
        );
      }
      const buffer = await params.sandbox.bridge.readFile({
        filePath: params.relativePath,
        cwd: params.sandbox.root,
        signal: params.signal,
        maxBytes: dailyMemory ? DAILY_MEMORY_FLUSH_MAX_EXISTING_FILE_BYTES : undefined,
      });
      return buffer.toString("utf-8");
    }
    if (!dailyMemory) {
      return await fs.readFile(path.resolve(params.root, params.relativePath), "utf-8");
    }
    const root = await fsRoot(params.root);
    const existing = await root.read(params.relativePath, {
      hardlinks: "reject",
      maxBytes: DAILY_MEMORY_FLUSH_MAX_EXISTING_FILE_BYTES,
      nonBlockingRead: true,
      symlinks: "reject",
    });
    return existing.buffer.toString("utf-8");
  } catch (error) {
    if (
      dailyMemory &&
      ((error instanceof FsSafeError && error.code === "too-large") ||
        (error instanceof RangeError && error.message.includes("exceeds")))
    ) {
      throw memoryFlushAppendRejected(
        `existing daily memory file exceeds ${DAILY_MEMORY_FLUSH_MAX_EXISTING_FILE_BYTES} bytes; compact it before appending more memory-flush content.`,
      );
    }
    if (
      hasErrnoCode(error, "ENOENT") ||
      (error instanceof FsSafeError && error.code === "not-found")
    ) {
      return "";
    }
    throw error;
  }
}

async function appendMemoryFlushContent(params: {
  root: string;
  relativePath: string;
  content: string;
  sandbox?: MemoryFlushAppendOnlyWriteOptions["sandbox"];
  signal?: AbortSignal;
  assertCurrent: () => void;
}) {
  if (!params.sandbox) {
    const root = await fsRoot(params.root);
    params.assertCurrent();
    await root.append(params.relativePath, params.content, {
      mkdir: true,
      prependNewlineIfNeeded: true,
      mutationSymlinks: isDailyMemoryPath(params.relativePath) ? "reject" : undefined,
      assertBeforeMutation: params.assertCurrent,
    });
    return;
  }

  const existing = await readOptionalUtf8File({
    root: params.root,
    relativePath: params.relativePath,
    sandbox: params.sandbox,
    signal: params.signal,
  });
  const separator =
    existing.length > 0 && !existing.endsWith("\n") && !params.content.startsWith("\n") ? "\n" : "";
  const next = `${existing}${separator}${params.content}`;
  const parent = path.posix.dirname(params.relativePath);
  params.assertCurrent();
  if (parent && parent !== ".") {
    await params.sandbox.bridge.mkdirp({
      filePath: parent,
      cwd: params.sandbox.root,
      signal: params.signal,
    });
  }
  params.assertCurrent();
  await params.sandbox.bridge.writeFile({
    filePath: params.relativePath,
    cwd: params.sandbox.root,
    data: next,
    mkdir: true,
    signal: params.signal,
  });
}

/** Restrict a write tool to appending memory-flush content to one path. */
export function wrapToolMemoryFlushAppendOnlyWrite(
  tool: AnyAgentTool,
  options: MemoryFlushAppendOnlyWriteOptions,
): AnyAgentTool {
  const allowedAbsolutePath = path.resolve(options.root, options.relativePath);
  const enforcement = options.operationalRunInstance
    ? resolveMemoryFlushAppendEnforcement(options.operationalRunInstance)
    : createMemoryFlushAppendEnforcement();
  if (!enforcement) {
    throw new Error("memory-flush append enforcement was not initialized for this admitted run");
  }
  return {
    ...tool,
    description: `${tool.description} During memory flush, this tool may only append to ${options.relativePath}.`,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const assertCurrent = captureAgentToolSourceExecutionGuard(signal);
      const record = getToolParamsRecord(args);
      const normalizedRecord = record
        ? await normalizeFileToolPathParamsFromKeys(
            record,
            ["path"],
            options.root,
            options.sandbox?.bridge,
          )
        : undefined;
      assertRequiredParams(normalizedRecord, REQUIRED_PARAM_GROUPS.write, tool.name);
      const filePath =
        typeof normalizedRecord?.path === "string" && normalizedRecord.path.trim()
          ? normalizedRecord.path
          : undefined;
      const content = typeof record?.content === "string" ? record.content : undefined;
      if (!filePath || content === undefined) {
        return tool.execute(toolCallId, args, signal, onUpdate);
      }

      const resolvedPath = resolveToolPathAgainstWorkspaceRoot({
        filePath,
        root: options.root,
        containerWorkdir: options.containerWorkdir,
      });
      if (filePath.startsWith("@") || resolvedPath !== allowedAbsolutePath) {
        throw new Error(
          `Memory flush writes are restricted to ${options.relativePath}; use that path only.`,
        );
      }

      const dailyMemory = isDailyMemoryPath(options.relativePath);
      const appendPreparedContent = async () => {
        assertCurrent();
        const contentBefore = await readOptionalUtf8File({
          root: options.root,
          relativePath: options.relativePath,
          sandbox: options.sandbox,
          signal,
        });
        const preparedAppend = dailyMemory
          ? prepareDailyMemoryFlushAppend({ content, existingContent: contentBefore })
          : undefined;
        const appendContent = preparedAppend?.content ?? content;
        const separator =
          contentBefore.length > 0 &&
          !contentBefore.endsWith("\n") &&
          !appendContent.startsWith("\n")
            ? "\n"
            : "";
        const commitWithProvenance = async () => {
          const commit = () =>
            appendMemoryFlushContent({
              root: options.root,
              relativePath: options.relativePath,
              content: appendContent,
              sandbox: options.sandbox,
              signal,
              assertCurrent,
            });
          const memoryWriteProvenance = options.memoryWriteProvenance;
          if (
            memoryWriteProvenance &&
            (await memoryWriteProvenance.classifies(allowedAbsolutePath))
          ) {
            await memoryWriteProvenance.write({
              absolutePath: allowedAbsolutePath,
              contentBefore,
              contentAfter: `${contentBefore}${separator}${appendContent}`,
              commit,
            });
          } else {
            await commit();
          }
          // This wrapper inherits the write tool's output schema, so report only
          // the authoritative `changed`; deriving `created` before append is racy.
          return {
            content: [
              { type: "text" as const, text: `Appended content to ${options.relativePath}.` },
            ],
            details: { changed: true },
          };
        };
        const result = preparedAppend
          ? await enforcement({
              appendChars: preparedAppend.appendChars,
              commit: commitWithProvenance,
            })
          : await commitWithProvenance();
        assertCurrent();
        return result;
      };

      if (!dailyMemory) {
        return await appendPreparedContent();
      }

      const canonicalRoot = await fs.realpath(options.root);
      const expectedLockTarget = path.join(canonicalRoot, options.relativePath);
      const resolvedLockTarget = await resolveAbsolutePathForWrite(expectedLockTarget, {
        symlinks: "reject",
      });
      const lockTarget = resolvedLockTarget.canonicalPath;
      if (lockTarget !== expectedLockTarget) {
        throw new FsSafeError("symlink", "path traverses a symlink");
      }
      toRelativeWorkspacePath(canonicalRoot, lockTarget);
      return await dailyMemoryFlushProcessLocks.enqueue(lockTarget, async () =>
        withFileLock(lockTarget, DAILY_MEMORY_FLUSH_LOCK_OPTIONS, appendPreparedContent),
      );
    },
  };
}
