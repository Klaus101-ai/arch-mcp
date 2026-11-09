// P01 (ТЗ рев.6): блок index.kinds конверта. Кейсы тест-плана 1-3 и 7.
// RED до реализации: kinds/карта эмиттеров в dist/lib.mjs ещё нет.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import * as lib from "../dist/lib.mjs";

const ROOT = resolve("E:\\1_Products\\arch-mcp");
// Порядок EdgeKind (src/core/adapters/types.ts:16-26) — дублируется здесь
// намеренно: тест проверяет порядок независимо от реализации.
const EDGE_ORDER = [
  "imports",
  "calls",
  "extends",
  "implements",
  "reads",
  "writes",
  "references",
  "configures",
  "deploys",
  "tests",
];
const PREC_RANK = { manifest: 0, syntax: 1, semantic: 2 };

const CACHE = mkdtempSync(join(tmpdir(), "arch-mcp-kindscache-"));
const ENV = { ...process.env, ARCH_MCP_CACHE_DIR: CACHE };
const opts = (cwd) => ({ env: ENV, cwd });

/** Прогрев (ТЗ v3, п.A): холодный arch_status отдаёт building — поллинг до готовности. */
async function warmArchStatus(args, o) {
  for (let i = 0; i < 900; i++) {
    const ctx = await lib.runTool("arch_status", args, o);
    if (ctx.payload.index.state !== "building") return ctx;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("index building не завершился за 90 с");
}

function fixture(name, files) {
  const dir = mkdtempSync(join(tmpdir(), `arch-mcp-kinds-${name}-`));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, "utf8");
  }
  return dir;
}

// Фикстура 1: TS-проект — depcruiser даёт imports, manifests даёт references.
const FX_TS = fixture("ts", {
  "package.json": JSON.stringify({ name: "kinds-ts", version: "1.0.0", type: "module" }),
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": 'import { a } from "./a.ts";\nexport const b = a;\n',
});
// Фикстура 2: package.json с зависимостями + TS — references эмитит manifests.
const FX_MIXED = fixture("mixed", {
  "package.json": JSON.stringify({
    name: "kinds-mixed",
    version: "1.0.0",
    dependencies: { lodash: "^4.17.21" },
  }),
  "src/index.ts": "export const x = 1;\n",
});

// Источники адаптеров для кейса 7b: каждый эмиттер карты должен реально
// эмитить свой вид — литерал kind в файле адаптера.
const SRC = {
  depcruiser: "src/core/adapters/depcruiser-adapter.ts",
  "tree-sitter-python": "src/core/adapters/tree-sitter/python.ts",
  "tree-sitter-tsjs": "src/core/adapters/tree-sitter/tsjs.ts",
  "tree-sitter-c": "src/core/adapters/tree-sitter/generic.ts",
  "tree-sitter-cpp": "src/core/adapters/tree-sitter/generic.ts",
  "tree-sitter-csharp": "src/core/adapters/tree-sitter/generic.ts",
  "tree-sitter-go": "src/core/adapters/tree-sitter/generic.ts",
  "tree-sitter-java": "src/core/adapters/tree-sitter/generic.ts",
  "tree-sitter-kotlin": "src/core/adapters/tree-sitter/generic.ts",
  "tree-sitter-php": "src/core/adapters/tree-sitter/generic.ts",
  "tree-sitter-ruby": "src/core/adapters/tree-sitter/generic.ts",
  "tree-sitter-rust": "src/core/adapters/tree-sitter/generic.ts",
  sql: "src/adapters/sql/index.ts",
  api: "src/adapters/api/shared.ts",
  manifests: "src/adapters/manifests/index.ts",
  docs: "src/adapters/docs/index.ts",
  ci: "src/adapters/infra/ci.ts",
  terraform: "src/adapters/infra/terraform.ts",
  k8s: "src/adapters/infra/k8s.ts",
  dockerfile: "src/adapters/infra/dockerfile.ts",
  scip: "src/core/adapters/tree-sitter/scip.ts",
};

test.after(() => {
  for (const dir of [CACHE, FX_TS, FX_MIXED]) rmSync(dir, { recursive: true, force: true });
});

test("кейс 1: kinds на TS-фикстуре — 10 элементов, порядок EdgeKind, imports=emitted", async () => {
  const ctx = await warmArchStatus({ workspace: FX_TS }, opts(FX_TS));
  const kinds = ctx.payload.index.kinds;
  assert.ok(Array.isArray(kinds), "index.kinds отсутствует");
  assert.equal(kinds.length, 10, `длина kinds = ${kinds.length}`);
  assert.deepEqual(
    kinds.map((k) => k.kind),
    EDGE_ORDER,
    "порядок kinds не совпадает с порядком EdgeKind",
  );
  const imports = kinds.find((k) => k.kind === "imports");
  assert.equal(imports.status, "emitted", `imports.status = ${imports.status}`);
  assert.ok(imports.edges > 0, "imports.edges = 0 при TS-импортах");
  for (const k of kinds) {
    assert.ok(Number.isInteger(k.edges) && k.edges >= 0, `${k.kind}: edges не целое ≥0: ${k.edges}`);
    assert.ok(Array.isArray(k.confidence), `${k.kind}: confidence не массив`);
    assert.ok(Array.isArray(k.emitters), `${k.kind}: emitters не массив`);
    assert.ok("confidence_min" in k, `${k.kind}: нет confidence_min`);
    assert.ok("status" in k, `${k.kind}: нет status`);
    assert.ok(
      ["emitted", "no_matches", "not_emitted", "unsupported"].includes(k.status),
      `${k.kind}: неизвестный статус ${k.status}`,
    );
  }
});

test("кейс 2: смешанный references — package.json + TS: manifest и syntax, min=manifest", async () => {
  const ctx = await warmArchStatus({ workspace: FX_MIXED }, opts(FX_MIXED));
  const kinds = ctx.payload.index.kinds;
  assert.equal(kinds.length, 10, `длина kinds = ${kinds.length}`);
  const ref = kinds.find((k) => k.kind === "references");
  assert.equal(ref.status, "emitted", `references.status = ${ref.status} (ожидался emitted от manifests)`);
  assert.ok(ref.edges > 0, "references.edges = 0");
  assert.ok(ref.confidence.includes("manifest"), `нет manifest в confidence: ${JSON.stringify(ref.confidence)}`);
  assert.ok(ref.confidence.includes("syntax"), `нет syntax в confidence: ${JSON.stringify(ref.confidence)}`);
  assert.equal(ref.confidence_min, "manifest", `confidence_min = ${ref.confidence_min}`);
  // confidence: отсортированный массив уникальных precision (manifest < syntax < semantic)
  assert.deepEqual(
    ref.confidence,
    [...ref.confidence].sort((a, b) => PREC_RANK[a] - PREC_RANK[b]),
    "confidence не отсортирован по manifest < syntax < semantic",
  );
  assert.equal(new Set(ref.confidence).size, ref.confidence.length, "в confidence есть дубли");
  assert.ok(ref.emitters.includes("manifests"), `emitters без manifests: ${JSON.stringify(ref.emitters)}`);
});

test("кейс 3: пустые виды — not_emitted, emitters=[], confidence=[]", async () => {
  const ctx = await warmArchStatus({ workspace: FX_TS }, opts(FX_TS));
  const kinds = ctx.payload.index.kinds;
  for (const kind of ["extends", "implements", "configures", "tests"]) {
    const k = kinds.find((x) => x.kind === kind);
    assert.ok(k, `вида ${kind} нет в kinds`);
    assert.equal(k.status, "not_emitted", `${kind}: status = ${k.status}`);
    assert.deepEqual(k.emitters, [], `${kind}: emitters не пусты`);
    assert.deepEqual(k.confidence, [], `${kind}: confidence не пуст`);
    assert.equal(k.edges, 0, `${kind}: edges = ${k.edges}`);
    assert.equal(k.confidence_min, null, `${kind}: confidence_min = ${k.confidence_min}`);
  }
});

test("кейс 4: sum(kinds.edges) == graph.edges.length", async () => {
  const ctx = await lib.runTool(
    "arch_snapshot",
    { workspace: FX_TS, scope: "full", max_bytes: 1_048_576 },
    opts(FX_TS),
  );
  const env = ctx.payload;
  assert.equal(env.ok, true);
  const sum = env.index.kinds.reduce((n, k) => n + k.edges, 0);
  assert.equal(sum, env.data.graph.edges.length, `sum(kinds.edges)=${sum} != graph.edges=${env.data.graph.edges.length}`);
  assert.ok(sum > 0, "на TS-фикстуре рёбра должны быть");
});

test("кейс 5: бюджет 4096 — конверт целиком ≤ max_bytes, все 10 видов на месте", async () => {
  const size = (env) => Buffer.byteLength(JSON.stringify(env), "utf8");

  const st = await warmArchStatus({ workspace: ROOT, max_bytes: 4096 }, opts(ROOT));
  assert.ok(size(st.payload) <= 4096, `arch_status: конверт ${size(st.payload)} > 4096`);
  assert.equal(st.payload.index.kinds.length, 10, "arch_status: не все виды в конверте");

  const fo = await lib.runTool("focus", { workspace: ROOT, node: "src/config.ts", max_bytes: 4096 }, opts(ROOT));
  assert.ok(size(fo.payload) <= 4096, `focus: конверт ${size(fo.payload)} > 4096`);
  assert.equal(fo.payload.index.kinds.length, 10, "focus: не все виды в конверте");

  // scope=full: graph-секция репозитория заведомо больше 4096 → обрезка обязательна.
  const sn = await lib.runTool(
    "arch_snapshot",
    { workspace: ROOT, scope: "full", max_bytes: 4096 },
    opts(ROOT),
  );
  assert.equal(sn.payload.truncated, true, `arch_snapshot@4096: truncated=${sn.payload.truncated}`);
  assert.ok(size(sn.payload) <= 4096, `arch_snapshot: конверт ${size(sn.payload)} > 4096`);
  assert.equal(sn.payload.index.kinds.length, 10, "arch_snapshot: не все виды в конверте");
  assert.match(String(sn.payload.data.graph.hint ?? sn.payload.hint ?? ""), /ARCH_MCP_MAX_RESPONSE_BYTES|max_bytes/);
});

test("кейс 7: самопроверка карты — merged ⊆ карта, каждый эмиттер реально эмитит свой вид", async () => {
  // 7-предусловие: карта существует, все 10 видов, порядок = EdgeKind.
  assert.ok(lib.KIND_EMITTERS, "KIND_EMITTERS не экспортирован из dist/lib.mjs");
  assert.deepEqual(Object.keys(lib.KIND_EMITTERS), EDGE_ORDER, "карта не в порядке EdgeKind");

  const cfg = lib.loadConfig(ENV);
  const full = await lib.loadFullGraph(FX_TS, cfg);
  assert.ok(Array.isArray(full.kindStats), "FullGraph.kindStats отсутствует");

  // 7a: каждый kind из merged.edges есть в карте; сумма сходится с графом.
  assert.ok(full.kindStats.length > 0, "kindStats пусты на TS-фикстуре");
  for (const s of full.kindStats) {
    assert.ok(Object.hasOwn(lib.KIND_EMITTERS, s.kind), `вид ${s.kind} из merged.edges не в карте`);
    assert.ok(s.edges > 0, `${s.kind}: нулевой счётчик в kindStats`);
  }
  const sum = full.kindStats.reduce((n, s) => n + s.edges, 0);
  assert.equal(sum, full.graph.edges.length, `sum(kindStats) = ${sum} != graph.edges = ${full.graph.edges.length}`);

  // 7b: каждый эмиттер карты зарегистрирован и реально эмитит свой вид —
  // в источнике адаптера есть литерал kind: "<вид>".
  const registered = new Set(lib.listAdapters().map((a) => a.id));
  for (const [kind, emitters] of Object.entries(lib.KIND_EMITTERS)) {
    assert.ok(Array.isArray(emitters), `${kind}: эмиттеры не массив`);
    for (const emitter of emitters) {
      assert.ok(registered.has(emitter), `${emitter} не зарегистрирован в реестре`);
      const file = SRC[emitter];
      assert.ok(file, `нет файла источника для эмиттера ${emitter}`);
      const text = readFileSync(join(ROOT, file), "utf8");
      assert.ok(
        text.includes(`kind: "${kind}"`),
        `${emitter} не эмитит ${kind}: литерала kind: "${kind}" нет в ${file}`,
      );
    }
  }
});
