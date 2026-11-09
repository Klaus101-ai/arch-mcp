import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootstrap, listTmpDirs, sweepInterrupted } from "../dist/lib.mjs";

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "arch-mcp-boot-"));
  return { root, toolchain: join(root, "toolchain"), marker: join(root, ".bootstrap-in-progress") };
}

test("прерванный bootstrap: tmp-каталоги, маркер и toolchain без lock убираются", () => {
  const { root, toolchain, marker } = makeRoot();
  try {
    mkdirSync(join(root, "toolchain.tmp-999"), { recursive: true });
    writeFileSync(join(root, "toolchain.tmp-999", "partial.json"), "{}", "utf8");
    mkdirSync(join(toolchain, "node_modules"), { recursive: true }); // битое состояние: без lock
    writeFileSync(marker, "2026-11-01T00:00:00Z", "utf8");

    sweepInterrupted(root, toolchain, marker);

    assert.equal(listTmpDirs(root).length, 0, "tmp не убран");
    assert.equal(existsSync(marker), false, "маркер не убран");
    assert.equal(existsSync(toolchain), false, "toolchain без lock должен быть удалён");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("прерванный bootstrap: toolchain с lock сохраняется, маркер снимается", () => {
  const { root, toolchain, marker } = makeRoot();
  try {
    mkdirSync(join(toolchain, "node_modules", "dependency-cruiser"), { recursive: true });
    writeFileSync(join(toolchain, "toolchain.lock.json"), JSON.stringify({ version: "18.7.0" }), "utf8");
    writeFileSync(marker, "2026-11-01T00:00:00Z", "utf8");
    mkdirSync(join(root, "toolchain.tmp-111"), { recursive: true });

    sweepInterrupted(root, toolchain, marker);

    assert.equal(existsSync(join(toolchain, "toolchain.lock.json")), true, "lock не должен теряться");
    assert.equal(existsSync(marker), false, "маркер должен сняться");
    assert.equal(listTmpDirs(root).length, 0, "tmp должен убираться");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap идемпотентен: с lock и пакетом → return 0 без npm (сеть не нужна)", async () => {
  const { root, toolchain } = makeRoot();
  try {
    mkdirSync(join(toolchain, "node_modules", "dependency-cruiser"), { recursive: true });
    writeFileSync(
      join(toolchain, "toolchain.lock.json"),
      JSON.stringify({ package: "dependency-cruiser", version: "18.7.0" }),
      "utf8",
    );
    const code = await bootstrap(root);
    assert.equal(code, 0);
    assert.equal(listTmpDirs(root).length, 0, "tmp появляться не должен");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
