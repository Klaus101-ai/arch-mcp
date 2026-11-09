import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  ArchMcpError,
  DEFAULT_IGNORE,
  discoverRootFrom,
  isArchMcpError,
  isRootDir,
  resolveWorkspace,
} from "../dist/lib.mjs";

const CWD_E_ROOT = "E:\\"; // на E: нет package.json/.git до корня диска — детерминированный «нет корня»
const AUTO_ROOT = resolve("E:\\1_Products\\arch-mcp"); // известный авто-корень для allowlist-тестов

function makeRepo(parent, name) {
  const dir = join(parent, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return resolve(dir);
}

test("resolveWorkspace: запрошенный git-корень → workspace=roots=[root], root_used=root", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-ws-"));
  try {
    const repo = makeRepo(base, "repo");
    const r = resolveWorkspace(repo, { env: {}, cwd: CWD_E_ROOT });
    assert.equal(r.workspace, repo);
    assert.deepEqual(r.roots, [repo]);
    assert.equal(r.root_used, repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveWorkspace: несуществующий путь → ArchMcpError WORKSPACE_NOT_FOUND", () => {
  try {
    resolveWorkspace(join(tmpdir(), "arch-mcp-does-not-exist-xyz"), { env: {}, cwd: CWD_E_ROOT });
    assert.fail("ожидался WORKSPACE_NOT_FOUND");
  } catch (err) {
    assert.ok(isArchMcpError(err), `не ArchMcpError: ${err}`);
    assert.equal(err.code, "WORKSPACE_NOT_FOUND");
    assert.match(String(err.hint ?? ""), /ARCH_MCP_ALLOWED_ROOTS|discover|manifest|git/i);
  }
});

test("resolveWorkspace: пустой container без корней → WORKSPACE_NOT_FOUND", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-empty-"));
  try {
    resolveWorkspace(base, { env: {}, cwd: CWD_E_ROOT });
    assert.fail("ожидался WORKSPACE_NOT_FOUND");
  } catch (err) {
    assert.ok(isArchMcpError(err));
    assert.equal(err.code, "WORKSPACE_NOT_FOUND");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveWorkspace: мультикорень — container с двумя детьми-репо, root_used = дитя с cwd", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-multi-"));
  try {
    const a = makeRepo(base, "a");
    const b = makeRepo(base, "b");
    const r = resolveWorkspace(base, { env: {}, cwd: b });
    assert.deepEqual(r.roots, [a, b].sort(), "roots — оба дитяти, отсортированы");
    assert.equal(r.root_used, b, "root_used — дитя, содержащее cwd");
    assert.equal(r.workspace, resolve(base));
    // cwd вне container → детерминированный первый корень
    const r2 = resolveWorkspace(base, { env: {}, cwd: AUTO_ROOT });
    assert.equal(r2.root_used, a, "cwd вне container → первый отсортированный корень");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveWorkspace: ignore — node_modules с манифестом не считается корнем", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-ignore-"));
  try {
    mkdirSync(join(base, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(base, "node_modules", "pkg", "package.json"), "{}", "utf8");
    mkdirSync(join(base, "node_modules", "pkg", ".git"), { recursive: true });
    const real = makeRepo(base, "real");
    const r = resolveWorkspace(base, { env: {}, cwd: AUTO_ROOT });
    assert.deepEqual(r.roots, [real], "node_modules должен игнорироваться");
    assert.ok(DEFAULT_IGNORE.includes("node_modules"));
    assert.ok(DEFAULT_IGNORE.includes("dist"));
    assert.ok(DEFAULT_IGNORE.includes(".venv"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveWorkspace: .gitignore container исключает дитя-корень", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-gignore-"));
  try {
    writeFileSync(join(base, ".gitignore"), "# comment\nsub2\n*.log\n", "utf8");
    makeRepo(base, "sub2");
    const real = makeRepo(base, "sub1");
    const r = resolveWorkspace(base, { env: {}, cwd: AUTO_ROOT });
    assert.deepEqual(r.roots, [real], "sub2 из .gitignore должна быть исключена");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveWorkspace: манифест без git — каталог с pyproject.toml является корнем", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-manifest-"));
  try {
    const dir = join(base, "proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pyproject.toml"), "[project]\n", "utf8");
    const r = resolveWorkspace(dir, { env: {}, cwd: CWD_E_ROOT });
    assert.equal(r.root_used, resolve(dir));
    assert.ok(isRootDir(dir));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("allowlist: workspace вне ARCH_MCP_ALLOWED_ROOTS → WORKSPACE_NOT_FOUND", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-alw-"));
  try {
    const allowed = makeRepo(base, "allowed");
    const other = makeRepo(base, "other");
    const env = { ARCH_MCP_ALLOWED_ROOTS: allowed };
    const ok = resolveWorkspace(allowed, { env, cwd: AUTO_ROOT });
    assert.equal(ok.root_used, allowed, "workspace внутри allowlist проходит");
    try {
      resolveWorkspace(other, { env, cwd: AUTO_ROOT });
      assert.fail("ожидался WORKSPACE_NOT_FOUND");
    } catch (err) {
      assert.ok(isArchMcpError(err));
      assert.equal(err.code, "WORKSPACE_NOT_FOUND");
      assert.match(String(err.message), /allowlist/i);
      assert.match(String(err.hint ?? ""), /ARCH_MCP_ALLOWED_ROOTS/);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("allowlist: несколько корней через path.delimiter, несуществующая запись не падает", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-alw2-"));
  try {
    const a = makeRepo(base, "a");
    const b = makeRepo(base, "b");
    const missing = join(base, "missing-entry");
    const env = { ARCH_MCP_ALLOWED_ROOTS: [missing, a, b].join(";") };
    assert.equal(resolveWorkspace(b, { env, cwd: AUTO_ROOT }).root_used, b, "b в списке записей");
    assert.equal(resolveWorkspace(a, { env, cwd: AUTO_ROOT }).root_used, a, "a в списке записей");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("allowlist: авто-корень cwd разрешён и без записи в env", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-auto-"));
  try {
    const repo = makeRepo(base, "cwdrepo");
    const env = { ARCH_MCP_ALLOWED_ROOTS: join(base, "some-other-entry") };
    const r = resolveWorkspace(repo, { env, cwd: repo });
    assert.equal(r.root_used, repo, "cwd-корень разрешён как авто-корень");
    const d = resolveWorkspace(undefined, { env, cwd: repo });
    assert.equal(d.root_used, repo, "discovery с cwd разрешён");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("discoverRootFrom: git-корень выше cwd, ближайший манифест — fallback", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-disc-"));
  try {
    const repo = makeRepo(base, "repo");
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    assert.equal(discoverRootFrom(join(repo, "src", "deep")), repo, "git-корень от cwd");

    const proj = join(base, "proj");
    mkdirSync(join(proj, "sub"), { recursive: true });
    writeFileSync(join(proj, "pyproject.toml"), "[project]\n", "utf8");
    assert.equal(discoverRootFrom(join(proj, "sub")), resolve(proj), "ближайший манифест без git");

    assert.equal(discoverRootFrom(CWD_E_ROOT), null, "на E:\\ корня нет");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveWorkspace: cwd без корня и без workspace → WORKSPACE_NOT_FOUND", () => {
  try {
    resolveWorkspace(undefined, { env: {}, cwd: CWD_E_ROOT });
    assert.fail("ожидался WORKSPACE_NOT_FOUND");
  } catch (err) {
    assert.ok(isArchMcpError(err));
    assert.equal(err.code, "WORKSPACE_NOT_FOUND");
    assert.ok(err instanceof ArchMcpError);
  }
});

// --- ТЗ рев.2, тест-план: третий признак корня (≥3 файлов с исходными расширениями) ---

/** Файлы-фикстуры с исходными расширениями (порог 3, сравнение без учёта регистра). */
function writeSources(dir, names) {
  mkdirSync(dir, { recursive: true });
  for (const n of names) writeFileSync(join(dir, n), "-- source\n", "utf8");
}

test("третий признак: папка с 3 .sql — корень (isRootDir + resolveWorkspace)", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-sql3-"));
  try {
    const dir = join(base, "ddl");
    writeSources(dir, ["a.sql", "b.sql", "c.sql"]);
    assert.equal(isRootDir(dir), true, "3 файла .sql → каталог-корень");
    const r = resolveWorkspace(dir, { env: {}, cwd: CWD_E_ROOT });
    assert.equal(r.workspace, resolve(dir));
    assert.deepEqual(r.roots, [resolve(dir)]);
    assert.equal(r.root_used, resolve(dir));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("третий признак: 2 .sql + 1 .md — не корень (порог 3, .md корнем не делает)", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-sql2-"));
  try {
    const dir = join(base, "weak");
    writeSources(dir, ["a.sql", "b.sql"]);
    writeFileSync(join(dir, "notes.md"), "# notes\n", "utf8");
    assert.equal(isRootDir(dir), false, "2 исходных файла — ниже порога");
    try {
      resolveWorkspace(dir, { env: {}, cwd: CWD_E_ROOT });
      assert.fail("ожидался WORKSPACE_NOT_FOUND");
    } catch (err) {
      assert.ok(isArchMcpError(err), `не ArchMcpError: ${err}`);
      assert.equal(err.code, "WORKSPACE_NOT_FOUND");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("третий признак: расширение в верхнем регистре (.SQL) считается", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-sqlU-"));
  try {
    const dir = join(base, "upper");
    writeSources(dir, ["A.SQL", "b.sql", "C.Sql"]);
    assert.equal(isRootDir(dir), true, "сравнение расширения без учёта регистра");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("приоритет: .git на любом уровне сильнее третьего признака (cwd в подпапке с 3 .ts)", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-git3-"));
  try {
    const repo = makeRepo(base, "repo");
    const sub = join(repo, "src", "deep");
    writeSources(sub, ["a.ts", "b.ts", "c.ts"]);
    assert.equal(isRootDir(sub), true, "подпапка с 3 .ts сама по себе — кандидат-корень");
    assert.equal(discoverRootFrom(sub), resolve(repo), "git-корень возвращается немедленно, не подпапка");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("fallback: без git и манифеста корень — ближайшая к cwd папка с ≥3 .sql", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-sqlF-"));
  try {
    const dir = join(base, "sqlroot");
    writeSources(dir, ["a.sql", "b.sql", "c.sql"]);
    assert.equal(discoverRootFrom(dir), resolve(dir), "папка с 3 .sql без git и манифеста — корень");

    // Каскад fallback: манифест и третий признак побеждает ближайший к cwd.
    const inner = join(dir, "pkg");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "package.json"), "{}", "utf8");
    assert.equal(discoverRootFrom(inner), resolve(inner), "манифест ближе к cwd, чем 3 .sql выше");

    const inner2 = join(dir, "innerddl");
    writeSources(inner2, ["x.sql", "y.sql", "z.sql"]);
    assert.equal(discoverRootFrom(inner2), resolve(inner2), "третий признак: ближайший к cwd побеждает");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("контейнер: дитя-корень по третьему признаку в roots, root_used=ditя; allowlist-отказ прежний", () => {
  const base = mkdtempSync(join(tmpdir(), "arch-mcp-ctr3-"));
  try {
    const ddl = join(base, "ddl");
    writeSources(ddl, ["a.sql", "b.sql", "c.sql"]);
    const r = resolveWorkspace(base, { env: {}, cwd: ddl });
    assert.equal(r.workspace, resolve(base), "container — база разрешения");
    assert.deepEqual(r.roots, [resolve(ddl)], "ddl — единственный дочерний корень");
    assert.equal(r.root_used, resolve(ddl), "root_used — дитя, содержащее cwd");

    const env = { ARCH_MCP_ALLOWED_ROOTS: join(base, "outside-entry") };
    try {
      resolveWorkspace(base, { env, cwd: ddl });
      assert.fail("ожидался WORKSPACE_NOT_FOUND");
    } catch (err) {
      assert.ok(isArchMcpError(err), `не ArchMcpError: ${err}`);
      assert.equal(err.code, "WORKSPACE_NOT_FOUND");
      assert.match(String(err.message), /allowlist/i);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
