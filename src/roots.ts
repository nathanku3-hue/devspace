import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function translateWslPath(path: string): string {
  if (process.platform !== "win32") {
    return path;
  }
  const wslMatch = path.match(/^\/mnt\/([a-zA-Z])(\/|$)(.*)/);
  if (wslMatch) {
    const drive = wslMatch[1].toUpperCase();
    const rest = wslMatch[3].replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }
  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  let resolvedPath = resolve(translateWslPath(expandHomePath(path)));
  let resolvedRoot = resolve(translateWslPath(expandHomePath(root)));

  if (process.platform === "win32") {
    resolvedPath = resolvedPath.toLowerCase();
    resolvedRoot = resolvedRoot.toLowerCase();
  }

  const relationship = relative(resolvedRoot, resolvedPath);

  return (
    relationship === "" ||
    (!isAbsolute(relationship) &&
      !relationship.startsWith("..") &&
      relationship !== ".." &&
      !relationship.includes(`..${sep}`))
  );
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(translateWslPath(expandHomePath(path)));
  if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  const translatedInputPath = translateWslPath(inputPath);
  const absolutePath = resolve(cwd, translatedInputPath);
  return assertAllowedPath(absolutePath, allowedRoots);
}
