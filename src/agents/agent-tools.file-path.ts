import path from "node:path";
import { URL } from "node:url";
import { hasEncodedFileUrlSeparator, trySafeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { isWindowsDrivePath } from "@openclaw/fs-safe/archive";
import { resolveSandboxPathMapping } from "./path-policy.js";
import { normalizeFileReferencePrefix } from "./sandbox-paths.js";

export function resolveContainerPathCandidate(filePath: string): string | null {
  let candidate = normalizeFileReferencePrefix(filePath);
  if (/^file:\/\//i.test(candidate)) {
    const localFilePath = trySafeFileURLToPath(candidate);
    if (localFilePath) {
      candidate = localFilePath;
    } else {
      // Windows rejects posix-style file:///workspace/... in fileURLToPath; map via URL pathname
      // when it clearly refers to the container workdir (same idea as sandbox-paths).
      let parsed: URL;
      try {
        parsed = new URL(candidate);
      } catch {
        return filePath;
      }
      if (parsed.protocol !== "file:") {
        return filePath;
      }
      const host = parsed.hostname.trim().toLowerCase();
      if (host && host !== "localhost") {
        return filePath;
      }
      if (hasEncodedFileUrlSeparator(parsed.pathname)) {
        return filePath;
      }
      let normalizedPathname: string;
      try {
        normalizedPathname = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
      } catch {
        return filePath;
      }
      candidate = normalizedPathname;
    }
  }
  return candidate;
}

export function mapContainerPathToWorkspaceRoot(params: {
  filePath: string;
  root: string;
  containerWorkdir?: string;
}): string {
  const candidate = resolveContainerPathCandidate(params.filePath);
  const mapped =
    params.containerWorkdir && candidate !== null
      ? resolveSandboxPathMapping(
          [{ hostRoot: params.root, containerRoot: params.containerWorkdir }],
          candidate,
        )
      : null;
  return mapped?.hostPath ?? candidate ?? params.filePath;
}

/** Resolve a model-supplied file path against the host workspace root. */
export function resolveToolPathAgainstWorkspaceRoot(params: {
  filePath: string;
  root: string;
  containerWorkdir?: string;
}): string {
  const mapped = mapContainerPathToWorkspaceRoot(params);
  const candidate = normalizeFileReferencePrefix(mapped);
  if (isWindowsDrivePath(candidate)) {
    return path.win32.normalize(candidate);
  }
  if (path.isAbsolute(candidate)) {
    return path.resolve(candidate);
  }
  return path.resolve(params.root, candidate || ".");
}
