// T1.2a: реестр адаптеров (контракт ТЗ рев.3 §6). Тестовый адаптер — заглушка внутри теста.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as lib from "../dist/lib.mjs";

const { registerAdapter, listAdapters, builtinAdapters, loadAdapterStatus } = lib;

const stub = (id, priority, version = "1.0.0") => ({
  id,
  version,
  license: "MIT",
  precision: "syntax",
  priority,
  detect: async () => [],
  scan: async function* () {},
});

test("регистрация: повторная регистрация того же id обновляет запись (идемпотентно)", () => {
  registerAdapter(stub("reg-a", 1, "1.0.0"));
  registerAdapter(stub("reg-a", 2, "2.0.0"));
  const hits = listAdapters().filter((a) => a.id === "reg-a");
  assert.equal(hits.length, 1, "запись одна, не дублируется");
  assert.equal(hits[0].priority, 2, "запись обновлена");
  assert.equal(hits[0].version, "2.0.0", "запись обновлена");
});

test("порядок listAdapters: priority по убыванию, затем id лексикографически", () => {
  registerAdapter(stub("ord-low", 1));
  registerAdapter(stub("ord-z", 5));
  registerAdapter(stub("ord-a", 5));
  registerAdapter(stub("ord-high", 9));
  const ids = listAdapters().map((a) => a.id);
  const filtered = ids.filter((id) => id.startsWith("ord-"));
  assert.deepEqual(filtered, ["ord-high", "ord-a", "ord-z", "ord-low"]);
});

test("builtinAdapters: git, depcruiser и два tree-sitter, порядок priority↓ затем id (T1.2b/T2a)", () => {
  const ids = builtinAdapters().map((a) => a.id);
  assert.deepEqual(
    ids,
    ["scip", "git", "depcruiser", "api", "ci", "dockerfile", "docs", "k8s", "manifests", "sql", "terraform", "tree-sitter-c", "tree-sitter-cpp", "tree-sitter-csharp", "tree-sitter-go", "tree-sitter-java", "tree-sitter-kotlin", "tree-sitter-php", "tree-sitter-python", "tree-sitter-ruby", "tree-sitter-rust", "tree-sitter-tsjs"],
    `состав/порядок builtin: ${ids}`,
  );
  const byId = Object.fromEntries(builtinAdapters().map((a) => [a.id, a]));
  assert.ok(byId.git.priority > byId.depcruiser.priority, "git приоритетнее depcruiser → index.adapters git первым");
  for (const a of builtinAdapters()) {
    assert.equal(typeof a.detect, "function", `${a.id}: detect`);
    assert.equal(typeof a.scan, "function", `${a.id}: scan`);
    assert.ok(a.version.length > 0, `${a.id}: version`);
  }
});

test("loadAdapterStatus: name/status/version по записям реестра", () => {
  registerAdapter(stub("stat-a", 3, "3.1.4"));
  const entry = loadAdapterStatus().find((e) => e.name === "stat-a");
  assert.ok(entry, "адаптер виден в loadAdapterStatus");
  assert.equal(typeof entry.status, "string");
  assert.ok(entry.status.length > 0, "status — непустая строка");
  assert.equal(entry.version, "3.1.4");
});
