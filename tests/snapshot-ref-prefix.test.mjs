import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArchMcpError, resolveSnapshotRef, saveSnapshot, snapshotId } from "../dist/lib.mjs";

// T1.1 (вердикт 4103, MINOR): resolveSnapshotRef рекламирует 7..64 hex,
// но heads.json хранит полные HEAD — короткая ссылка обязана разрешаться
// по уникальному префиксу, неоднозначность — AMBIGUOUS_NODE с кандидатами.

const WS = "E:/test/prefix-repo";
const ADAPTERS = { depcruiser: "18.7.0", package: "0.1.0", schema: "graph-4" };

const HEAD_A = `686d6fd${"a".repeat(33)}`; // 40 hex, префикс 7 — уникален
const HEAD_B = `1111111${"b".repeat(33)}`; // общий префикс 1111111
const HEAD_C = `1111111${"c".repeat(33)}`;

function graph() {
  return { nodes: ["a.ts"], edges: [] };
}

function makeSnap(head) {
  return {
    snapshot_id: snapshotId({ graph: graph(), gitHead: head, adapters: ADAPTERS }),
    workspace: WS,
    git_head: head,
    ts: "2026-11-02T00:00:00.000Z",
    graph: graph(),
    adapters: ADAPTERS,
  };
}

function makeCtx(root) {
  return {
    cacheRoot: root,
    workspace: WS,
    buildCurrent: async () => makeSnap(HEAD_A),
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "archmcp-prefix-"));
  saveSnapshot(root, makeSnap(HEAD_A));
  saveSnapshot(root, makeSnap(HEAD_B));
  saveSnapshot(root, makeSnap(HEAD_C));
  return root;
}

test("resolveSnapshotRef: 7-hex префикс уникального HEAD резолвится в полный HEAD", async () => {
  const root = setup();
  try {
    const { side, snapshot } = await resolveSnapshotRef("686d6fd", makeCtx(root));
    assert.equal(side.ref, "686d6fd");
    assert.equal(snapshot.git_head, HEAD_A);
    assert.equal(side.git_head, HEAD_A);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSnapshotRef: полный HEAD и префикс 7..39 дают один снимок", async () => {
  const root = setup();
  try {
    const ctx = makeCtx(root);
    const byFull = await resolveSnapshotRef(HEAD_A, ctx);
    const byPrefix = await resolveSnapshotRef(HEAD_A.slice(0, 12), ctx);
    assert.equal(byFull.snapshot.snapshot_id, byPrefix.snapshot.snapshot_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSnapshotRef: неоднозначный префикс → AMBIGUOUS_NODE с кандидатами", async () => {
  const root = setup();
  try {
    await assert.rejects(
      () => resolveSnapshotRef("1111111", makeCtx(root)),
      (err) =>
        err instanceof ArchMcpError &&
        err.code === "AMBIGUOUS_NODE" &&
        Array.isArray(err.candidates) &&
        err.candidates.length === 2 &&
        err.candidates.includes(HEAD_B) &&
        err.candidates.includes(HEAD_C),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSnapshotRef: отсутствующий префикс → SNAPSHOT_NOT_FOUND", async () => {
  const root = setup();
  try {
    await assert.rejects(
      () => resolveSnapshotRef("0000000", makeCtx(root)),
      (err) => err instanceof ArchMcpError && err.code === "SNAPSHOT_NOT_FOUND",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSnapshotRef: 64-hex по-прежнему читается по snapshot_id", async () => {
  const root = setup();
  try {
    const snap = makeSnap(HEAD_A);
    const { snapshot } = await resolveSnapshotRef(snap.snapshot_id, makeCtx(root));
    assert.equal(snapshot.snapshot_id, snap.snapshot_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
