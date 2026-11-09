// T4b: инфраструктура и документация (ТЗ рев.3 §7, решения R19-R23).
// Тест-план TDD (5 случаев + битые файлы + absent + регистрация):
// (1) Dockerfile → container:<file> и package:<image> базового образа, ребро references;
// (2) K8s YAML (Deployment+Service) → service:<Kind>/<name>, deploys к образу,
//     envFrom → references к config:<name>;
// (3) CI YAML (.github/workflows) → config:<file>, uses → references к package:<action>;
// (4) Terraform HCL при ARCH_MCP_TERRAFORM=1 → service:<type>.<name> и references
//     по ${...}-интерполяции; без флага — адаптер absent (R22, MPL-модуль лениво);
// (5) Markdown → doc:<relative path>, заголовки в meta.headings, локальные ссылки
//     → references; битый файл каждого формата → coverage.unsupported без исключения.
// R21: module/imports не порождаются; ноль файлов → absent.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as lib from "../dist/lib.mjs";

const dockerfile = lib.dockerfileAdapter;
const k8s = lib.k8sAdapter;
const ci = lib.ciAdapter;
const terraform = lib.terraformAdapter;
const docs = lib.docsAdapter;

function scanCtx(root) {
  return {
    root,
    roots: [root],
    gitHead: null,
    files: [],
    capabilities: [{ id: "scan", confidence: "syntax" }],
    cacheDir: "",
    timeoutMs: 60_000,
    maxBytes: 1_048_576,
  };
}

async function scan(adapter, root) {
  return lib.runAdapter(adapter, scanCtx(root));
}

function tmpRepo(prefix) {
  return mkdtempSync(join(tmpdir(), `arch-mcp-${prefix}-`));
}

function write(root, rel, src) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, src, "utf8");
}

const DOCKERFILE_SRC = [
  "FROM node:20-alpine AS build",
  "WORKDIR /app",
  "COPY package*.json ./",
  "RUN npm ci",
  "FROM node:20-alpine",
  "COPY --from=build /app /app",
  "",
].join("\n");

const K8S_SRC = [
  "apiVersion: apps/v1",
  "kind: Deployment",
  "metadata:",
  "  name: web",
  "spec:",
  "  template:",
  "    spec:",
  "      containers:",
  "        - name: web",
  "          image: nginx:1.25",
  "      envFrom:",
  "        - configMapRef:",
  "            name: app-config",
  "---",
  "apiVersion: v1",
  "kind: Service",
  "metadata:",
  "  name: web",
  "spec:",
  "  ports:",
  "    - port: 80",
  "",
].join("\n");

const CI_SRC = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: npm test",
  "",
].join("\n");

const TF_SRC = [
  'resource "aws_instance" "web" {',
  '  ami       = "ami-123"',
  '  subnet_id = "${aws_subnet.main.id}"',
  "}",
  "",
  'resource "aws_subnet" "main" {',
  '  cidr_block = "10.0.0.0/24"',
  "}",
  "",
].join("\n");

const README_SRC = [
  "# Project Title",
  "",
  "Intro with a [local guide](docs/guide.md) and an [external site](https://example.com/docs).",
  "",
  "## Setup",
  "",
  "Run the tests.",
  "",
].join("\n");

const GUIDE_SRC = ["# Guide", "", "Back to [home](../README.md).", ""].join("\n");

test("T4b-регистрация: 5 адаптеров в builtinAdapters(), priority 50, precision syntax, SPDX", () => {
  assert.ok(dockerfile && k8s && ci && terraform && docs, "нет экспортов адаптеров T4b в dist/lib.mjs");
  const ids = lib.builtinAdapters().map((a) => a.id);
  for (const id of ["dockerfile", "k8s", "ci", "terraform", "docs"]) {
    assert.ok(ids.includes(id), `нет ${id} в builtinAdapters: ${ids}`);
  }
  const byId = Object.fromEntries(lib.builtinAdapters().map((a) => [a.id, a]));
  assert.equal(byId.dockerfile.priority, 50, "dockerfile: priority 50");
  assert.equal(byId.k8s.priority, 50, "k8s: priority 50");
  assert.equal(byId.ci.priority, 50, "ci: priority 50");
  assert.equal(byId.terraform.priority, 50, "terraform: priority 50");
  assert.equal(byId.docs.priority, 50, "docs: priority 50");
  assert.equal(byId.dockerfile.license, "MIT", "dockerfile: SPDX dockerfile-ast");
  assert.equal(byId.k8s.license, "ISC", "k8s: SPDX yaml");
  assert.equal(byId.ci.license, "ISC", "ci: SPDX yaml");
  assert.equal(byId.terraform.license, "MPL-2.0", "terraform: SPDX hcl2json (R22, notice обязателен)");
  assert.equal(byId.docs.license, "MIT", "docs: SPDX remark");
  for (const id of ["dockerfile", "k8s", "ci", "terraform", "docs"]) {
    assert.equal(byId[id].precision, "syntax", `${id}: precision syntax`);
    assert.ok(typeof byId[id].version === "string" && byId[id].version.length > 0, `${id}: version`);
    assert.equal(typeof byId[id].detect, "function", `${id}: detect`);
    assert.equal(typeof byId[id].scan, "function", `${id}: scan`);
    assert.equal(typeof byId[id].outcome, "function", `${id}: outcome`);
  }
  // Порядок в группе priority 50: api < ci < dockerfile < docs < k8s < manifests < sql < terraform < tree-sitter-*.
  const order = ["api", "ci", "dockerfile", "docs", "k8s", "manifests", "sql", "terraform", "tree-sitter-c"];
  const idx = order.map((id) => ids.indexOf(id));
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i - 1] >= 0 && idx[i - 1] < idx[i], `порядок builtin нарушен на ${order[i]}: ${ids}`);
  }
});

test("T4b-1: Dockerfile → container-узел и package-узел базового образа, ребро references", async () => {
  const dir = tmpRepo("t4b-dockerfile");
  try {
    write(dir, "Dockerfile", DOCKERFILE_SRC);
    const run = await scan(dockerfile, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    assert.ok(delta, "дельта не вернулась");

    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const container = byId.get("container:Dockerfile");
    assert.ok(container, `нет container-узла: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(container.kind, "container");
    assert.equal(container.path, "Dockerfile");

    const image = byId.get("package:node:20-alpine");
    assert.ok(image, `нет package-узла образа: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(image.kind, "package");
    assert.equal(image.path, "Dockerfile");

    const edge = delta.edges.find(
      (e) => e.source === "container:Dockerfile" && e.target === "package:node:20-alpine",
    );
    assert.ok(edge, `нет ребра container→package: ${JSON.stringify(delta.edges)}`);
    assert.equal(edge.kind, "references");
    assert.equal(edge.confidence, "syntax");
    assert.equal(edge.file, "Dockerfile");

    // Многостадийность: второй FROM с тем же образом не дублирует узлы/рёбра.
    assert.equal(delta.nodes.filter((n) => n.id === "package:node:20-alpine").length, 1, "дубль package-узла");
    assert.equal(
      delta.edges.filter((e) => e.source === "container:Dockerfile" && e.target === "package:node:20-alpine").length,
      1,
      "дубль ребра",
    );

    assert.deepEqual(delta.coverage.unsupported, [], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.files_seen, 1);
    assert.equal(delta.coverage.parsed, 1);
    assert.deepEqual(delta.nodes.filter((n) => n.kind === "module"), [], "R21: module-узлов нет");
    assert.deepEqual(delta.edges.filter((e) => e.kind === "imports"), [], "R21: imports-рёбер нет");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4b-1b: битый Dockerfile (нет FROM) → unsupported, узлов 0, без исключения", async () => {
  const dir = tmpRepo("t4b-dockerfile-broken");
  try {
    write(dir, "Dockerfile", "this is not a dockerfile\n");
    const run = await scan(dockerfile, dir);
    assert.equal(run.status, "ok", `адаптер не должен падать, status=${run.status}`);
    const delta = run.deltas[0];
    assert.deepEqual(delta.coverage.unsupported, ["Dockerfile"], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.parsed, 0);
    assert.deepEqual(delta.nodes, []);
    assert.deepEqual(delta.edges, []);
    const reason = run.evidence?.unsupported_reasons?.["Dockerfile"];
    assert.ok(typeof reason === "string" && reason.length > 0, `нет причины unsupported: ${JSON.stringify(run.evidence)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4b-2: K8s YAML → service-узлы Kind/Name, deploys к образу, envFrom → references", async () => {
  const dir = tmpRepo("t4b-k8s");
  try {
    write(dir, "k8s.yaml", K8S_SRC);
    const run = await scan(k8s, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];

    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const dep = byId.get("service:Deployment/web");
    assert.ok(dep, `нет service:Deployment/web: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(dep.kind, "service");
    assert.equal(dep.path, "k8s.yaml");
    const svc = byId.get("service:Service/web");
    assert.ok(svc, `нет service:Service/web: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(svc.kind, "service");

    const image = byId.get("package:nginx:1.25");
    assert.ok(image, `нет package-узла образа: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(image.kind, "package");

    const deploys = delta.edges.find(
      (e) => e.source === "service:Deployment/web" && e.target === "package:nginx:1.25",
    );
    assert.ok(deploys, `нет ребра deploys: ${JSON.stringify(delta.edges)}`);
    assert.equal(deploys.kind, "deploys");
    assert.equal(deploys.confidence, "syntax");
    assert.equal(deploys.file, "k8s.yaml");

    // R20: envFrom configMapRef → config-узел и references-ребро.
    const cfg = byId.get("config:app-config");
    assert.ok(cfg, `нет config-узла app-config: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(cfg.kind, "config");
    const refs = delta.edges.find(
      (e) => e.source === "service:Deployment/web" && e.target === "config:app-config",
    );
    assert.ok(refs, `нет ребра references к конфигу: ${JSON.stringify(delta.edges)}`);
    assert.equal(refs.kind, "references");
    assert.equal(refs.confidence, "syntax");

    assert.deepEqual(delta.coverage.unsupported, [], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.files_seen, 1);
    assert.equal(delta.coverage.parsed, 1);
    assert.deepEqual(delta.nodes.filter((n) => n.kind === "module"), [], "R21: module нет");
    assert.deepEqual(delta.edges.filter((e) => e.kind === "imports"), [], "R21: imports нет");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4b-2b: битый K8s YAML → unsupported, узлов 0, без исключения", async () => {
  const dir = tmpRepo("t4b-k8s-broken");
  try {
    write(dir, "k8s-broken.yaml", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: [broken\n");
    const run = await scan(k8s, dir);
    assert.equal(run.status, "ok", `адаптер не должен падать, status=${run.status}`);
    const delta = run.deltas[0];
    assert.deepEqual(delta.coverage.unsupported, ["k8s-broken.yaml"], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.parsed, 0);
    assert.deepEqual(delta.nodes, []);
    assert.deepEqual(delta.edges, []);
    const reason = run.evidence?.unsupported_reasons?.["k8s-broken.yaml"];
    assert.ok(typeof reason === "string" && reason.length > 0, "нет причины unsupported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4b-3: CI YAML (.github/workflows) → config-узел, uses → references к package", async () => {
  const dir = tmpRepo("t4b-ci");
  try {
    write(dir, join(".github", "workflows", "ci.yml"), CI_SRC);
    const run = await scan(ci, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];

    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const cfg = byId.get("config:.github/workflows/ci.yml");
    assert.ok(cfg, `нет config-узла: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(cfg.kind, "config");
    assert.equal(cfg.path, ".github/workflows/ci.yml");

    const action = byId.get("package:actions/checkout");
    assert.ok(action, `нет package-узла действия: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(action.kind, "package");

    const edge = delta.edges.find(
      (e) => e.source === "config:.github/workflows/ci.yml" && e.target === "package:actions/checkout",
    );
    assert.ok(edge, `нет ребра references: ${JSON.stringify(delta.edges)}`);
    assert.equal(edge.kind, "references");
    assert.equal(edge.confidence, "syntax");
    assert.equal(edge.file, ".github/workflows/ci.yml");

    assert.deepEqual(delta.coverage.unsupported, [], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.files_seen, 1);
    assert.equal(delta.coverage.parsed, 1);
    assert.deepEqual(delta.nodes.filter((n) => n.kind === "module"), [], "R21: module нет");
    assert.deepEqual(delta.edges.filter((e) => e.kind === "imports"), [], "R21: imports нет");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4b-3b: битый CI YAML → unsupported, узлов 0, без исключения", async () => {
  const dir = tmpRepo("t4b-ci-broken");
  try {
    write(dir, join(".github", "workflows", "broken.yml"), "jobs: [unclosed\n  build: x\n");
    const run = await scan(ci, dir);
    assert.equal(run.status, "ok", `адаптер не должен падать, status=${run.status}`);
    const delta = run.deltas[0];
    assert.deepEqual(delta.coverage.unsupported, [".github/workflows/broken.yml"], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.parsed, 0);
    assert.deepEqual(delta.nodes, []);
    assert.deepEqual(delta.edges, []);
    const reason = run.evidence?.unsupported_reasons?.[".github/workflows/broken.yml"];
    assert.ok(typeof reason === "string" && reason.length > 0, "нет причины unsupported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4b-4: без ARCH_MCP_TERRAFORM=1 при .tf-файлах — адаптер absent (R22)", async () => {
  const saved = process.env.ARCH_MCP_TERRAFORM;
  delete process.env.ARCH_MCP_TERRAFORM;
  const dir = tmpRepo("t4b-tf-off");
  try {
    write(dir, "main.tf", TF_SRC);
    const run = await scan(terraform, dir);
    assert.equal(run.status, "absent", `без флага должен быть absent, status=${run.status}`);
    assert.deepEqual(run.deltas, []);
    const caps = await terraform.detect(scanCtx(dir));
    assert.deepEqual(caps, [], "detect без флага не даёт capability");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.ARCH_MCP_TERRAFORM;
    else process.env.ARCH_MCP_TERRAFORM = saved;
  }
});

test("T4b-4b: с ARCH_MCP_TERRAFORM=1 → service-узлы ресурсов и references по интерполяции", async () => {
  const saved = process.env.ARCH_MCP_TERRAFORM;
  process.env.ARCH_MCP_TERRAFORM = "1";
  const dir = tmpRepo("t4b-tf-on");
  try {
    write(dir, "main.tf", TF_SRC);
    const run = await scan(terraform, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];

    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const inst = byId.get("service:aws_instance.web");
    assert.ok(inst, `нет service:aws_instance.web: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(inst.kind, "service");
    assert.equal(inst.path, "main.tf");
    const subnet = byId.get("service:aws_subnet.main");
    assert.ok(subnet, `нет service:aws_subnet.main: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(subnet.kind, "service");

    const edge = delta.edges.find(
      (e) => e.source === "service:aws_instance.web" && e.target === "service:aws_subnet.main",
    );
    assert.ok(edge, `нет ребра references по ${"${...}"}: ${JSON.stringify(delta.edges)}`);
    assert.equal(edge.kind, "references");
    assert.equal(edge.confidence, "syntax");
    assert.equal(edge.file, "main.tf");

    assert.deepEqual(delta.coverage.unsupported, [], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.files_seen, 1);
    assert.equal(delta.coverage.parsed, 1);
    assert.deepEqual(delta.nodes.filter((n) => n.kind === "module"), [], "R21: module нет");
    assert.deepEqual(delta.edges.filter((e) => e.kind === "imports"), [], "R21: imports нет");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.ARCH_MCP_TERRAFORM;
    else process.env.ARCH_MCP_TERRAFORM = saved;
  }
});

test("T4b-4c: с флагом битый HCL → unsupported, узлов 0, без исключения", async () => {
  const saved = process.env.ARCH_MCP_TERRAFORM;
  process.env.ARCH_MCP_TERRAFORM = "1";
  const dir = tmpRepo("t4b-tf-broken");
  try {
    write(dir, "broken.tf", 'resource "aws_instance" {\n');
    const run = await scan(terraform, dir);
    assert.equal(run.status, "ok", `адаптер не должен падать, status=${run.status}`);
    const delta = run.deltas[0];
    assert.deepEqual(delta.coverage.unsupported, ["broken.tf"], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.parsed, 0);
    assert.deepEqual(delta.nodes, []);
    assert.deepEqual(delta.edges, []);
    const reason = run.evidence?.unsupported_reasons?.["broken.tf"];
    assert.ok(typeof reason === "string" && reason.length > 0, "нет причины unsupported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.ARCH_MCP_TERRAFORM;
    else process.env.ARCH_MCP_TERRAFORM = saved;
  }
});

test("T4b-5: Markdown → doc-узел, заголовки в meta.headings, локальные ссылки → references", async () => {
  const dir = tmpRepo("t4b-docs");
  try {
    write(dir, "README.md", README_SRC);
    write(dir, join("docs", "guide.md"), GUIDE_SRC);
    const run = await scan(docs, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];

    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const readme = byId.get("doc:README.md");
    assert.ok(readme, `нет doc:README.md: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(readme.kind, "doc");
    assert.equal(readme.path, "README.md");
    const headings = readme.meta?.headings;
    assert.ok(Array.isArray(headings), `meta.headings не массив: ${JSON.stringify(readme.meta)}`);
    assert.ok(headings.includes("Project Title"), `нет H1: ${JSON.stringify(headings)}`);
    assert.ok(headings.includes("Setup"), `нет H2: ${JSON.stringify(headings)}`);

    const guide = byId.get("doc:docs/guide.md");
    assert.ok(guide, `нет doc:docs/guide.md: ${JSON.stringify([...byId.keys()])}`);

    const edge = delta.edges.find(
      (e) => e.source === "doc:README.md" && e.target === "doc:docs/guide.md",
    );
    assert.ok(edge, `нет ребра references README→guide: ${JSON.stringify(delta.edges)}`);
    assert.equal(edge.kind, "references");
    assert.equal(edge.confidence, "syntax");
    assert.equal(edge.file, "README.md");

    // Обратная локальная ссылка из guide → README.
    const back = delta.edges.find((e) => e.source === "doc:docs/guide.md" && e.target === "doc:README.md");
    assert.ok(back, `нет обратного ребра guide→README: ${JSON.stringify(delta.edges)}`);

    // R23: внешняя ссылка не резолвится — узла/ребра к example.com нет.
    assert.deepEqual(delta.edges.filter((e) => e.target.includes("example.com")), [], "внешняя ссылка не даёт рёбер");
    assert.deepEqual(delta.nodes.filter((n) => n.id.includes("example.com")), [], "внешняя ссылка не даёт узлов");

    assert.deepEqual(delta.coverage.unsupported, [], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.files_seen, 2);
    assert.equal(delta.coverage.parsed, 2);
    assert.deepEqual(delta.nodes.filter((n) => n.kind === "module"), [], "R21: module нет");
    assert.deepEqual(delta.edges.filter((e) => e.kind === "imports"), [], "R21: imports нет");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4b-5b: битый Markdown (NUL/бинарь) → unsupported, узлов 0, без исключения", async () => {
  const dir = tmpRepo("t4b-docs-broken");
  try {
    write(dir, "broken.md", "text with \u0000 null byte\n");
    const run = await scan(docs, dir);
    assert.equal(run.status, "ok", `адаптер не должен падать, status=${run.status}`);
    const delta = run.deltas[0];
    assert.deepEqual(delta.coverage.unsupported, ["broken.md"], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.parsed, 0);
    assert.deepEqual(delta.nodes, []);
    assert.deepEqual(delta.edges, []);
    const reason = run.evidence?.unsupported_reasons?.["broken.md"];
    assert.ok(typeof reason === "string" && reason.length > 0, "нет причины unsupported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// T5-фикс [MINOR] 6325: .tf с resource без второй метки (hcl2json отдаёт массив
// вместо объекта имён) сейчас даёт parsed=1, unsupported=[], nodes=0 — молчаливый
// пропуск. Тест-план TDD (3 случая): (1) без второй метки с телом → unsupported,
// узлов 0; (2) корректная метка → узел есть; (3) битый .tf → unsupported.
test("T5-1: .tf с resource без второй метки и с телом → unsupported, узлов 0, без исключения", async () => {
  const saved = process.env.ARCH_MCP_TERRAFORM;
  process.env.ARCH_MCP_TERRAFORM = "1";
  const dir = tmpRepo("t5-tf-one-label");
  try {
    write(dir, "one-label.tf", 'resource "aws_instance" {\n  ami = "ami-123"\n}\n');
    const run = await scan(terraform, dir);
    assert.equal(run.status, "ok", `адаптер не должен падать, status=${run.status}`);
    const delta = run.deltas[0];
    assert.ok(delta, "дельта не вернулась");
    assert.deepEqual(
      delta.coverage.unsupported,
      ["one-label.tf"],
      `coverage: ${JSON.stringify(delta.coverage)}`,
    );
    assert.equal(delta.coverage.parsed, 0, "файл без второй метки не должен считаться parsed");
    assert.deepEqual(delta.nodes, [], `узлов должно быть 0: ${JSON.stringify(delta.nodes)}`);
    assert.deepEqual(delta.edges, [], "рёбер не должно быть");
    const reason = run.evidence?.unsupported_reasons?.["one-label.tf"];
    assert.ok(
      typeof reason === "string" && reason.length > 0,
      `нет причины unsupported: ${JSON.stringify(run.evidence)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.ARCH_MCP_TERRAFORM;
    else process.env.ARCH_MCP_TERRAFORM = saved;
  }
});

test("T5-2: .tf с корректной второй меткой → узел service:<type>.<name> есть", async () => {
  const saved = process.env.ARCH_MCP_TERRAFORM;
  process.env.ARCH_MCP_TERRAFORM = "1";
  const dir = tmpRepo("t5-tf-two-label");
  try {
    write(dir, "two-label.tf", 'resource "aws_instance" "web" {\n  ami = "ami-123"\n}\n');
    const run = await scan(terraform, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    assert.ok(delta, "дельта не вернулась");
    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const node = byId.get("service:aws_instance.web");
    assert.ok(node, `нет узла при корректной метке: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(node.kind, "service");
    assert.equal(node.path, "two-label.tf");
    assert.deepEqual(delta.coverage.unsupported, [], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.parsed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.ARCH_MCP_TERRAFORM;
    else process.env.ARCH_MCP_TERRAFORM = saved;
  }
});

test("T5-3: битый .tf (незакрытый блок) → unsupported, узлов 0, без исключения", async () => {
  const saved = process.env.ARCH_MCP_TERRAFORM;
  process.env.ARCH_MCP_TERRAFORM = "1";
  const dir = tmpRepo("t5-tf-broken");
  try {
    write(dir, "broken.tf", 'resource "aws_instance" "web" {\n  ami = "ami-123"\n');
    const run = await scan(terraform, dir);
    assert.equal(run.status, "ok", `адаптер не должен падать, status=${run.status}`);
    const delta = run.deltas[0];
    assert.deepEqual(delta.coverage.unsupported, ["broken.tf"], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.parsed, 0);
    assert.deepEqual(delta.nodes, []);
    assert.deepEqual(delta.edges, []);
    const reason = run.evidence?.unsupported_reasons?.["broken.tf"];
    assert.ok(typeof reason === "string" && reason.length > 0, "нет причины unsupported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.ARCH_MCP_TERRAFORM;
    else process.env.ARCH_MCP_TERRAFORM = saved;
  }
});

test("T4b-6: ноль файлов каждого формата → absent (не в index.adapters/missing[])", async () => {
  const dir = tmpRepo("t4b-absent");
  try {
    write(dir, "readme.txt", "нет ни одного формата T4b\n");
    for (const [name, adapter] of [
      ["dockerfile", dockerfile],
      ["k8s", k8s],
      ["ci", ci],
      ["terraform", terraform],
      ["docs", docs],
    ]) {
      const run = await scan(adapter, dir);
      assert.equal(run.status, "absent", `${name}: status=${run.status}`);
      assert.deepEqual(run.deltas, [], `${name}: дельты пусты`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
