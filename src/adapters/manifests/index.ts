// T3: адаптер манифестов (ТЗ рев.3 §7; решение R10).
//
// Сканирует манифесты зависимостей: package.json (deps/devDeps), pnpm-workspace.yaml,
// pyproject.toml / requirements*.txt / poetry.lock / uv.lock, build.gradle(.kts) /
// pom.xml, Cargo.toml, go.mod, *.csproj, composer.json, Gemfile.lock →
// package-узлы `package:<имя>` (имя + версия в meta.version) и references-рёбра
// от узла проекта (file-узел манифеста) к зависимостям.
// Версия — как в источнике; для pip-спецификаций (`name==1.2`) оператор-разделитель
// отбрасывается (это разделитель имени и версии, а не часть версии).
// T3.1: extras (`rich[d]==13.6.1`) разбираются в meta.extras=["d"], версия сохраняется.
// T3.2: pyproject.toml читается как TOML через smol-toml (BSD-3-Clause), а не регуляркой:
// массив `]` внутри `rich[d]` больше не обрывает разбор (вердикт 6230).
// R12: module/imports не порождаются — legacy-счётчики не меняются.
// Ноль подходящих файлов → status "absent"; неразобранный манифест → coverage.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { packageVersion } from "../../cache.ts";
import type { AdapterOutcome, DetailedAdapter } from "../../core/adapters/runner.ts";
import { listSourceFiles, sortDelta } from "../../core/adapters/tree-sitter/init.ts";
import type { Capability, GraphDelta, GraphEdge, GraphNode, ScanContext } from "../../core/adapters/types.ts";

export const MANIFESTS_ADAPTER_ID = "manifests";

const MANIFEST_EXTS = new Set([
  ".json", ".yaml", ".yml", ".toml", ".txt", ".xml", ".gradle", ".kts", ".mod", ".lock", ".csproj",
]);
const EXACT_NAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "Cargo.toml",
  "go.mod",
  "composer.json",
  "Gemfile.lock",
]);
const REQUIREMENTS_RE = /^requirements[^/]*\.txt$/i;
const CSPROJ_RE = /\.csproj$/i;

function isManifest(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return EXACT_NAMES.has(base) || REQUIREMENTS_RE.test(base) || CSPROJ_RE.test(base);
}

interface Dep {
  name: string;
  version: string;
  /** PEP 508 extras из `name[extra1,extra2]<оп>версия`; нет — поле отсутствует. */
  extras?: string[];
}
interface FileDeps {
  deps: Dep[];
  ok: boolean;
}

/** pip-спецификация `name[extras]<оператор>версия` → имя (1), extras (2) и версия (3). */
const PIP_SPEC_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*\[([^\]]*)\])?\s*(?:==|!=|~=|>=|<=|>|<)\s*(.+)$/;

/** Строка extras `d,perf` → массив; пустая/отсутствующая → undefined. */
function parseExtras(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  return list.length > 0 ? list : undefined;
}

/** Спецификация (groups PIP_SPEC_RE) → Dep; без имени/версии — null. */
function pipDep(m: RegExpExecArray): Dep | null {
  const version = m[3].trim();
  if (version === "") return null;
  const extras = parseExtras(m[2]);
  return extras ? { name: m[1], version, extras } : { name: m[1], version };
}

function requirementsDeps(text: string): Dep[] {
  const deps: Dep[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("-")) continue;
    const m = PIP_SPEC_RE.exec(line);
    if (!m) continue; // без версии (bare requirement) — узел без версии не создаём
    const dep = pipDep(m);
    if (dep) deps.push(dep);
  }
  return deps;
}

function jsonPackageDeps(data: Record<string, unknown>, sections: string[], filter: (name: string) => boolean): Dep[] {
  const deps: Dep[] = [];
  for (const section of sections) {
    const table = data[section];
    if (table === undefined || table === null || typeof table !== "object" || Array.isArray(table)) continue;
    for (const [name, version] of Object.entries(table as Record<string, unknown>)) {
      if (!filter(name)) continue;
      if (typeof version !== "string" || version.trim() === "") continue;
      deps.push({ name, version: version.trim() });
    }
  }
  return deps;
}

/** TOML-таблица (plain object) или null. */
function asTable(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * pyproject.toml через smol-toml (ТЗ рев.3 §7, вердикт 6230 MAJOR).
 * `[project].dependencies` — массив PEP 508-строк (`rich[d]==13.6.1`, `requests>=2`);
 * `[tool.poetry.dependencies]` — объект, значение либо строка версии,
 * либо таблица `{version, extras, optional}`. Некорректные записи пропускаются,
 * битый TOML → ok:false (coverage, без исключения).
 */
function pyprojectDeps(text: string): FileDeps {
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch {
    return { deps: [], ok: false }; // битый TOML — в coverage, без исключения
  }
  const deps: Dep[] = [];

  const projectDeps = asTable(doc.project)?.dependencies;
  if (Array.isArray(projectDeps)) {
    for (const item of projectDeps) {
      if (typeof item !== "string") continue;
      const spec = PIP_SPEC_RE.exec(item.trim());
      if (!spec) continue; // не PEP 508-строка — пропуск записи
      const dep = pipDep(spec);
      if (dep) deps.push(dep);
    }
  }

  const poetryDeps = asTable(asTable(doc.tool)?.poetry)?.dependencies;
  const poetry = asTable(poetryDeps);
  if (poetry) {
    for (const [name, value] of Object.entries(poetry)) {
      if (typeof value === "string") {
        const version = value.trim();
        if (version !== "") deps.push({ name, version });
        continue;
      }
      const spec = asTable(value);
      if (!spec) continue; // не строка и не таблица — пропуск записи
      const version = typeof spec.version === "string" ? spec.version.trim() : "";
      if (version === "") continue; // path/git/workspace без версии — пропуск
      const extras = Array.isArray(spec.extras)
        ? spec.extras
            .filter((e): e is string => typeof e === "string")
            .map((e) => e.trim())
            .filter((e) => e !== "")
        : [];
      deps.push(extras.length > 0 ? { name, version, extras } : { name, version });
    }
  }

  return { deps, ok: true };
}

/** poetry.lock / uv.lock: блоки [[package]] с name/version. */
function lockDeps(text: string): FileDeps {
  const deps: Dep[] = [];
  let inPackage = false;
  let name = "";
  let version = "";
  const flush = (): void => {
    if (inPackage && name !== "" && version !== "") deps.push({ name, version });
    name = "";
    version = "";
  };
  for (const raw of text.split(/\r?\n/)) {
    if (/^\[\[package\]\]/.test(raw)) {
      flush();
      inPackage = true;
      continue;
    }
    if (/^\[/.test(raw)) {
      flush();
      inPackage = false;
      continue;
    }
    if (!inPackage) continue;
    const n = /^name\s*=\s*"([^"]+)"/.exec(raw);
    if (n && name === "") name = n[1];
    const v = /^version\s*=\s*"([^"]+)"/.exec(raw);
    if (v && version === "") version = v[1];
  }
  flush();
  return { deps, ok: true };
}

function cargoDeps(text: string): FileDeps {
  const deps: Dep[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    const tableForm = /^(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(section);
    if (tableForm) {
      const v = /^version\s*=\s*"([^"]+)"/.exec(line);
      if (v) deps.push({ name: tableForm[1], version: v[1] });
      continue;
    }
    if (!/^(?:dev-|build-)?dependencies$/.test(section)) continue;
    const m = /^"?([\w-]+)"?\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim();
    let version = "";
    if (value.startsWith('"')) version = value.slice(1, value.indexOf('"', 1));
    else if (value.startsWith("{")) {
      const v = /version\s*=\s*"([^"]+)"/.exec(value);
      if (v) version = v[1]; // path/git/workspace-зависимости без версии пропускаются
    }
    if (version !== "") deps.push({ name: m[1], version });
  }
  return { deps, ok: true };
}

function goDeps(text: string): FileDeps {
  const deps: Dep[] = [];
  let inRequire = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    if (/^require\s*\($/.test(line)) {
      inRequire = true;
      continue;
    }
    if (inRequire) {
      if (line === ")") {
        inRequire = false;
        continue;
      }
      const m = /^(\S+)\s+(\S+)/.exec(line);
      if (m) deps.push({ name: m[1], version: m[2] });
      continue;
    }
    const single = /^require\s+(\S+)\s+(\S+)/.exec(line);
    if (single) deps.push({ name: single[1], version: single[2] });
  }
  return { deps, ok: true };
}

const GRADLE_KEYWORDS =
  /\b(?:implementation|api|compile|compileOnly|runtimeOnly|testImplementation|testCompile|testRuntimeOnly|annotationProcessor|classpath|kapt|ksp|developmentOnly)\s*\(?\s*['"]([^'"]+)['"]/g;

function gradleDeps(text: string): Dep[] {
  const deps: Dep[] = [];
  for (const m of text.matchAll(GRADLE_KEYWORDS)) {
    const parts = m[1].split(":");
    if (parts.length < 3) continue; // без версии (g:a или версионный каталог) — пропуск
    deps.push({ name: `${parts[0]}:${parts[1]}`, version: parts[2] });
  }
  return deps;
}

function pomDeps(text: string): Dep[] {
  const deps: Dep[] = [];
  for (const block of text.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? []) {
    const g = /<groupId>\s*([^<]+?)\s*<\/groupId>/.exec(block);
    const a = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(block);
    const v = /<version>\s*([^<]+?)\s*<\/version>/.exec(block);
    if (g && a && v) deps.push({ name: `${g[1]}:${a[1]}`, version: v[1] });
  }
  return deps;
}

function csprojDeps(text: string): Dep[] {
  const deps: Dep[] = [];
  for (const tag of text.match(/<PackageReference\b[\s\S]*?(?:\/>|<\/PackageReference>)/g) ?? []) {
    const inc = /Include="([^"]+)"/.exec(tag);
    const ver = /Version="([^"]+)"/.exec(tag) ?? /<Version>\s*([^<]+?)\s*<\/Version>/.exec(tag);
    if (inc && ver) deps.push({ name: inc[1], version: ver[1] });
  }
  return deps;
}

function gemfileDeps(text: string): Dep[] {
  const deps: Dep[] = [];
  let inGem = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^GEM\b/.test(raw)) {
      inGem = true;
      continue;
    }
    if (/^[A-Z]/.test(raw)) inGem = false; // PLATFORMS / DEPENDENCIES / PATHS ...
    if (!inGem) continue;
    const m = /^ {4}([\w.\-]+) \((\d[^)]*)\)$/.exec(raw);
    if (m) deps.push({ name: m[1], version: m[2] });
  }
  return deps;
}

function parseManifest(text: string, base: string): FileDeps {
  try {
    if (base === "package.json" || base === "composer.json") {
      const data = JSON.parse(text) as Record<string, unknown>;
      if (base === "package.json") {
        return { deps: jsonPackageDeps(data, ["dependencies", "devDependencies"], () => true), ok: true };
      }
      // composer: platform-требования (php, ext-*) — не пакеты, без "/" пропускаются.
      return { deps: jsonPackageDeps(data, ["require", "require-dev"], (n) => n.includes("/")), ok: true };
    }
    if (REQUIREMENTS_RE.test(base)) return { deps: requirementsDeps(text), ok: true };
    if (base === "pyproject.toml") return pyprojectDeps(text);
    if (base === "poetry.lock" || base === "uv.lock") return lockDeps(text);
    if (base === "Cargo.toml") return cargoDeps(text);
    if (base === "go.mod") return goDeps(text);
    if (base === "build.gradle" || base === "build.gradle.kts") return { deps: gradleDeps(text), ok: true };
    if (base === "pom.xml") return { deps: pomDeps(text), ok: true };
    if (CSPROJ_RE.test(base)) return { deps: csprojDeps(text), ok: true };
    if (base === "Gemfile.lock") return { deps: gemfileDeps(text), ok: true };
    if (base === "pnpm-workspace.yaml") return { deps: [], ok: true }; // workspace-пути, не зависимости
  } catch {
    return { deps: [], ok: false }; // битый JSON/TOML — в coverage, без исключения
  }
  return { deps: [], ok: false };
}

async function buildDelta(root: string, files: string[]): Promise<GraphDelta> {
  const fileNodes: GraphNode[] = [];
  const packages = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const unsupported: string[] = [];

  for (const rel of files) {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    let text: string | null = null;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      text = null;
    }
    const parsed = text === null ? ({ deps: [], ok: false } as FileDeps) : parseManifest(text, base);
    if (!parsed.ok) unsupported.push(rel);
    fileNodes.push({ id: rel, kind: "file", path: rel, name: base, source: MANIFESTS_ADAPTER_ID });
    for (const dep of parsed.deps) {
      const id = `package:${dep.name}`;
      if (!packages.has(id)) {
        packages.set(id, {
          id,
          kind: "package",
          path: rel,
          name: dep.name,
          source: MANIFESTS_ADAPTER_ID,
          meta: dep.extras === undefined ? { version: dep.version } : { version: dep.version, extras: dep.extras },
        });
      }
      const key = `references|${rel}|${id}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({
        source: rel,
        target: id,
        kind: "references",
        file: rel,
        confidence: "syntax",
        meta: { dependencyTypes: ["references"] },
      });
    }
  }

  const sorted = sortDelta([...fileNodes, ...packages.values()], edges);
  return {
    nodes: sorted.nodes,
    edges: sorted.edges,
    coverage: {
      files_seen: files.length,
      parsed: files.length - unsupported.length,
      unsupported: [...unsupported].sort(),
    },
  };
}

async function outcome(ctx: ScanContext): Promise<AdapterOutcome> {
  const files = listSourceFiles(ctx.root, MANIFEST_EXTS).filter(isManifest);
  if (files.length === 0) return { status: "absent", deltas: [] };
  return { status: "ok", deltas: [await buildDelta(ctx.root, files)] };
}

/** T3: адаптер манифестов — package-узлы и references-рёбра (ТЗ рев.3 §7). */
export const manifestsAdapter: DetailedAdapter = {
  id: MANIFESTS_ADAPTER_ID,
  get version(): string {
    return packageVersion() ?? "0.0.0";
  },
  license: "MIT",
  precision: "manifest",
  priority: 50,
  detect(ctx: ScanContext): Promise<Capability[]> {
    const files = listSourceFiles(ctx.root, MANIFEST_EXTS).filter(isManifest);
    return Promise.resolve(
      files.length > 0 ? [{ id: MANIFESTS_ADAPTER_ID, confidence: "manifest", detail: `${files.length} files` }] : [],
    );
  },
  async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
    const run = await outcome(ctx);
    if (run.status === "ok") yield* run.deltas;
  },
  outcome,
};
