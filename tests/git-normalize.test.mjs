import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeStatusLines, parseLastCommit } from "../dist/lib.mjs";

test("normalizeStatusLines: trim, без пустых строк, CRLF", () => {
  const raw = " M app/page.tsx\r\n?? new-file.md\r\n\r\n   \n";
  assert.deepEqual(normalizeStatusLines(raw), [" M app/page.tsx", "?? new-file.md"]);
});

test("normalizeStatusLines: пустой ввод → пустой массив", () => {
  assert.deepEqual(normalizeStatusLines(""), []);
});

test("parseLastCommit: %H%n%cI → {hash, committedAt}", () => {
  const raw = "686d6fd582af562602794fab40f48a86b3214d11\n2026-10-30T12:00:00+03:00\n";
  assert.deepEqual(parseLastCommit(raw), {
    hash: "686d6fd582af562602794fab40f48a86b3214d11",
    committedAt: "2026-10-30T12:00:00+03:00",
  });
});

test("parseLastCommit: мусор → null", () => {
  assert.equal(parseLastCommit("no-commit-here"), null);
  assert.equal(parseLastCommit(""), null);
});
