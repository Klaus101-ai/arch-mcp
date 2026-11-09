import { isAbsolute, relative, resolve } from "node:path";

/**
 * Нормализация путей для query-инструментов (focus/reaches/affected_tests).
 * Единая точка приведения входных путей и узлов графа к repo-relative POSIX.
 */

/** Каталоги-артефакты сборки: тесты внутри них не считаются тестовыми. */
export const EXCLUDED_TEST_DIRS = ["dist", "build", ".next", "out", "coverage"];

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Отрезает ./-сегменты и ведущие ../. */
export function stripDotSegments(p: string): string {
  const parts = toPosix(p)
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  let i = 0;
  while (i < parts.length && parts[i] === "..") i += 1;
  return parts.slice(i).join("/");
}

/** Путь repo от корня диска без буквы: E:\1_siteteam\asi-agent1 → 1_siteteam/asi-agent1. */
export function repoDriveRelative(repo: string): string {
  const posix = toPosix(resolve(repo));
  return posix.replace(/^[A-Za-z]:/, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function isOutsideRepo(rel: string): boolean {
  return rel === ".." || rel.startsWith("../");
}

/**
 * Нормализация узла графа (без ошибок): \→/, отрезка ./ и ведущих ../,
 * срез префикса repo от корня диска — так нормализуются узлы старого кэша
 * вида `../../1_siteteam/asi-agent1/server/src/limits.ts`; абсолютный узел
 * внутри repo приводится к repo-relative.
 */
export function normalizeNode(node: string, repo: string): string {
  const raw = toPosix(String(node ?? ""));
  if (/^[A-Za-z]:\//.test(raw)) {
    const rel = toPosix(relative(resolve(repo), resolve(raw)));
    if (!isOutsideRepo(rel)) return rel === "" ? "." : rel;
    return raw;
  }
  let s = stripDotSegments(raw);
  const prefix = repoDriveRelative(repo);
  if (prefix !== "" && s.toLowerCase().startsWith(prefix.toLowerCase() + "/")) {
    s = s.slice(prefix.length + 1);
  }
  return s;
}

export type RepoPathResult =
  | { status: "ok"; path: string }
  | { status: "invalid"; reason: string };

/**
 * Входной путь → repo-relative POSIX:
 * - абсолютный: resolve от repo; вне repo → invalid с причиной;
 * - относительный: resolve от repo; для путей старого кэша (ведущие ../,
 *   префикс repo от корня диска) — отрезка ./ и ведущих ../ + срез префикса repo.
 */
export function resolveInputPath(input: string, repo: string): RepoPathResult {
  const raw = toPosix(String(input ?? "")).trim();
  if (raw === "") return { status: "invalid", reason: "empty path" };
  if (/^[A-Za-z]:\//.test(raw) || isAbsolute(String(input ?? ""))) {
    const rel = toPosix(relative(resolve(repo), resolve(raw)));
    if (isOutsideRepo(rel) || rel === "") {
      return { status: "invalid", reason: `path outside repo: ${input}` };
    }
    return { status: "ok", path: rel };
  }
  const rel = toPosix(relative(resolve(repo), resolve(repo, raw)));
  if (!isOutsideRepo(rel)) return { status: "ok", path: rel === "" ? "." : rel };
  // Ведущие ../ уводят за пределы repo: допускаем только путь старого кэша
  // с префиксом repo от корня диска, иначе — invalid.
  const stripped = stripDotSegments(raw);
  const prefix = repoDriveRelative(repo);
  if (prefix !== "" && stripped.toLowerCase().startsWith(prefix.toLowerCase() + "/")) {
    return { status: "ok", path: stripped.slice(prefix.length + 1) };
  }
  return { status: "invalid", reason: `path outside repo: ${input}` };
}

export type NodeMatch =
  | { status: "ok"; node: string; path: string }
  | { status: "ambiguous"; matches: string[] }
  | { status: "invalid"; reason: string };

/**
 * Подбор узла графа по входному пути: точное совпадение нормализованного узла
 * либо суффикс (нормализованный узел заканчивается на `/<path>`).
 * Более одного совпадения → ambiguous со списком; ни одного либо путь вне
 * repo → invalid с причиной.
 */
export function matchNode(input: string, repo: string, nodes: readonly string[]): NodeMatch {
  const rel = resolveInputPath(input, repo);
  if (rel.status === "invalid") return { status: "invalid", reason: rel.reason };
  const target = rel.path;
  const matches: string[] = [];
  for (const node of nodes) {
    const norm = normalizeNode(node, repo);
    if (norm === target || norm.endsWith("/" + target)) matches.push(node);
  }
  if (matches.length === 0) {
    return { status: "invalid", reason: `no graph node matches "${input}" (resolved: ${target})` };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", matches: [...matches].sort() };
  }
  return { status: "ok", node: matches[0], path: normalizeNode(matches[0], repo) };
}

/**
 * Тестовый файл: путь под `*.test.*`, `*.spec.*`, `__tests__/`, `test_*.py`.
 * Каталоги dist/build/.next/out/coverage исключены из матчинга тестов.
 */
export function isTestFile(path: string): boolean {
  const p = toPosix(String(path ?? ""));
  const segs = p.split("/").filter((s) => s !== "");
  if (segs.length === 0) return false;
  const dirs = segs.slice(0, -1);
  if (dirs.some((d) => EXCLUDED_TEST_DIRS.includes(d))) return false;
  const base = segs[segs.length - 1];
  if (/\.test\.[^./]+$/.test(base)) return true;
  if (/\.spec\.[^./]+$/.test(base)) return true;
  if (segs.includes("__tests__")) return true;
  if (/^test_.+\.py$/.test(base)) return true;
  return false;
}
