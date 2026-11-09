import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StackFilter } from "../config.ts";

export interface StacksResult {
  repo: string;
  stacks: StackFilter[];
  detected: { js: string[]; py: string[]; jvm: string[] };
}

const MARKERS: Record<"js" | "py" | "jvm", string[]> = {
  js: ["package.json"],
  py: ["pyproject.toml", "requirements.txt"],
  jvm: ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"],
};

/** Распознавание стеков по файлам репозитория (только чтение). */
export function detectStacks(repo: string, filter: StackFilter): StacksResult {
  const detected: { js: string[]; py: string[]; jvm: string[] } = { js: [], py: [], jvm: [] };
  for (const stack of ["js", "py", "jvm"] as const) {
    for (const marker of MARKERS[stack]) {
      if (existsSync(join(repo, marker))) detected[stack].push(marker);
    }
  }
  const all: StackFilter[] = ["py", "jvm", "js"];
  const stacks = filter === "all" ? all : [filter];
  return {
    repo,
    stacks: stacks.filter((s) => (s === "all" ? true : detected[s].length > 0)),
    detected,
  };
}
