import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeDepcruiser, runDepcruiser } from "../dist/lib.mjs";

// Регрессия ТЗ рев.3, п.6: depcruiser должен отдавать type-only рёбра.
// Ловушка: дефолтный путь (--no-config) транспилирует TS→JS и выбрасывает
// `import type` до парсера — a.ts -> b.ts не появляется вовсе (репро 2026-11-02).
// Лечение: --config с options.parser=tsc (файл генерируется в кэше).
test("runDepcruiser: import type → ребро с meta.type_only=true (parser tsc)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "arch-mcp-typeonly-"));
  try {
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "typerepro", version: "1.0.0", type: "module" }), "utf8");
    writeFileSync(join(repo, "a.ts"), "import type { B } from './b.ts';\nexport const x: B = 1;\n", "utf8");
    writeFileSync(join(repo, "b.ts"), "export type B = number;\n", "utf8");
    writeFileSync(join(repo, "c.ts"), "import { b } from './b.ts';\nexport const y = b;\n", "utf8");

    const res = await runDepcruiser(repo, 60_000, 65_536);
    assert.equal(res.status, "ok", `stderr: ${res.evidence.stderr}`);
    assert.ok(res.command.includes("--config"), `нет --config в команде: ${res.command}`);

    const { edges } = normalizeDepcruiser(res.data);
    const typeOnly = edges.filter((e) => e.meta.type_only === true);
    assert.equal(typeOnly.length, 1, `type-only рёбер не 1: ${JSON.stringify(edges)}`);
    assert.equal(typeOnly[0].source, "a.ts");
    assert.equal(typeOnly[0].target, "b.ts");
    assert.match(typeOnly[0].type, /type-only/);

    const valueEdge = edges.find((e) => e.source === "c.ts" && e.target === "b.ts");
    assert.ok(valueEdge, "обычное ребро c.ts -> b.ts потеряно");
    assert.equal(valueEdge.meta.type_only, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
