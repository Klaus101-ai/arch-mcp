<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/gitshow/banner-dark.svg">
  <img src="assets/gitshow/banner-light.svg" alt="arch-mcp: a repository architecture map with files, imports, SQL tables and API contracts, and the blast radius of one change" width="100%">
</picture>

# arch-mcp

Maps your repo's architecture — files, imports, SQL, APIs — and shows what a change breaks.

[English](README.md) | [Russian](README.ru.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)

![arch-mcp status output in a terminal: adapters, graph size, response budget](assets/gitshow/demo.png)

`arch-mcp` is an MCP server over stdio. It indexes a workspace into a graph of files, modules, symbols, database tables, API contracts, container and CI files, then answers questions about that graph: what depends on this file, which tests a change touches, what two snapshots differ by.

## Features

**Find what a change breaks.** `impact` returns the transitive dependents of the files you changed, `affected_tests` narrows that to test files (`src/index.ts:90-119`).

**One graph across stacks.** 22 adapters read JavaScript/TypeScript, Python, nine more languages through wasm grammars, SQL, API contracts, manifests, Dockerfile, Kubernetes, CI YAML, Markdown and SCIP indexes (`src/core/adapters/registry.ts:67-89`).

**Answers state their own coverage.** Every response carries `index.coverage` and `index.kinds`, so you can tell a missing edge from a missing adapter (`src/core/envelope.ts:59`, `src/core/envelope.ts:162-173`).

**Your repository stays untouched.** The server only reads: the cache lives in `%LOCALAPPDATA%\arch-mcp\cache\<sha1(repo)>` and nothing is written back (`src/cache.ts:8-11`).

**Responses respect a byte budget.** `max_bytes` defaults to 65536 with a hard cap of 1048576; a truncated answer always carries `truncated: true` and a `hint` (`src/config.ts:35-40`).

## What it sees

Every node is addressed as `kind:path#symbol` in repo-relative POSIX form (`src/core/adapters/types.ts:2`).

### Nodes (11)

| Kind | What it is |
| --- | --- |
| `file` | A source file or manifest on disk |
| `module` | An importable module, one per source file in the tree-sitter pipeline |
| `package` | A dependency: a manifest entry, a container image, or a CI action |
| `symbol` | A function, class or type declaration found by tree-sitter or SCIP |
| `table` | A SQL table |
| `view` | A SQL view |
| `api` | One API operation from an OpenAPI, Swagger, proto, GraphQL or AsyncAPI contract |
| `config` | A configuration object: a CI file, a Kubernetes config referenced by `envFrom` |
| `doc` | A Markdown document |
| `service` | A deployable unit: an API service, a Kubernetes workload, a Terraform resource |
| `container` | A Dockerfile or the image it builds |

Source: `src/core/adapters/types.ts:5-16`.

### Edges (10)

| Edge | In plain words | Emitted today |
| --- | --- | --- |
| `imports` | File A uses file B | yes (`src/core/adapters/registry.ts:102-114`) |
| `calls` | Function A calls function B | yes (`src/core/adapters/registry.ts:115`) |
| `reads` | SQL: a table or view is read; with sqlglot on, the edge also carries columns | yes (`src/core/adapters/registry.ts:118`) |
| `writes` | SQL: a table or view is written, with columns under sqlglot | yes (`src/core/adapters/registry.ts:119`) |
| `references` | An API operation, an infrastructure file, a document, or a package dependency points at an object | yes (`src/core/adapters/registry.ts:120`) |
| `deploys` | A Kubernetes workload deploys an image | yes (`src/core/adapters/registry.ts:122`) |
| `extends` | Class or interface inheritance | no |
| `implements` | Interface implementation | no |
| `configures` | Configuration of another object | no |
| `tests` | A test covers a target | no |

The last four edges are declared in the type system, but no adapter emits them yet. The `index.kinds` block reports them honestly as `not_emitted` with an empty emitter list (`src/core/adapters/registry.ts:116-117`, `src/core/adapters/registry.ts:121`, `src/core/adapters/registry.ts:123`).

## Coverage you can trust

The server never claims a complete picture it cannot back up.

- Each response carries `index.coverage` with `files_seen`, `parsed` and `unsupported`, plus `index.kinds` with the status of every edge kind (`src/core/envelope.ts:59`, `src/core/envelope.ts:171-173`).
- An empty graph is reported as `index.state = "partial"`, not as an error (`src/core/envelope.ts:162-171`).
- Files a parser could not handle are listed by name in `coverage.unsupported`, and an adapter that failed turns the matching edge kind into `unsupported` instead of `no_matches` (`src/core/envelope.ts:130-154`).
- A kind with no emitters at all shows up as `not_emitted` (`src/core/envelope.ts:130-132`).

Supported layers: JavaScript/TypeScript, Python, nine languages through wasm tree-sitter grammars (C, C++, C#, Go, Java, Kotlin, PHP, Ruby, Rust), SQL (DML plus PostgreSQL DDL), API contracts (OpenAPI, Swagger, proto, GraphQL, AsyncAPI), Dockerfile, Kubernetes, CI YAML, Terraform behind a flag, Markdown, and SCIP indexes.

The invariants are covered by `tests/envelope.test.mjs` and `tests/kinds.test.mjs`; the suite has 35 files and 241 tests in `tests/`.

## Quick start

```powershell
npm install
npm run build
npm run bootstrap
npm test
```

`npm install` pulls runtime and dev dependencies. `npm run build` writes `dist/server.mjs`, `dist/cli.mjs` and `dist/lib.mjs` with esbuild. `npm run bootstrap` installs the pinned toolchain (dependency-cruiser 18.7.0) into `./toolchain` and is idempotent. `npm test` runs the node test suite (`package.json:14`, `package.json:16`, `package.json:17`).

## Connect your MCP client

The server speaks stdio through `dist/server.mjs`. An opencode v2 config entry looks like this:

```json
{
  "mcp": {
    "servers": {
      "arch-mcp": {
        "type": "local",
        "command": ["node", "E:/1_Products/arch-mcp/dist/server.mjs"]
      }
    }
  }
}
```

Replace the path with your own checkout. The MCP layer is thin: the tools are registered in `src/index.ts:137-141` and executed through `src/server_core.ts`.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `arch_status` | `workspace?`, `max_bytes?` | Stacks, git info, index coverage, adapters |
| `arch_snapshot` | `workspace?`, `scope?`, `max_bytes?` | Graph plus `snapshot_id`; `scope` is `summary` or `full` |
| `search` | `workspace?`, `query`, `kind?`, `max_bytes?` | Graph nodes matching a case-insensitive substring |
| `focus` | `workspace?`, `node`, `limit?`, `max_bytes?`, `include_type_only?` | Incoming and outgoing edges of one node, `limit` defaults to 50, max 200 |
| `reaches` | `workspace?`, `target`, `max_depth?`, `max_bytes?`, `include_type_only?` | Reverse reachability: who depends on the target, `max_depth` defaults to 10 |
| `impact` | `workspace?`, `changed[]`, `depth?`, `max_bytes?`, `include_type_only?` | Transitive dependents of changed files |
| `affected_tests` | `workspace?`, `changed[]`, `max_bytes?`, `include_type_only?` | Test files depending on the change; an empty result carries a `reason` and the checked inputs |
| `arch_diff` | `workspace?`, `from`, `to`, `max_bytes?` | Added and removed nodes and edges between two refs |

Source: `src/index.ts:14-135`.

## Response envelope

```json
{
  "ok": true,
  "workspace": "E:/work/my-service",
  "root_used": "E:/work/my-service",
  "roots": ["E:/work/my-service"],
  "schema_version": 6,
  "index": {
    "state": "ready",
    "progress": { "percent": 100, "complete": true },
    "coverage": { "files_seen": 226, "parsed": 226, "unsupported": [] },
    "adapters": [{ "name": "git", "status": "ok", "version": null }],
    "missing": []
  },
  "data": {},
  "truncated": false,
  "_meta": { "provenance": { "command": "arch_status", "cwd": "E:/work/my-service", "ts": "…", "cached": false, "exit_code": 0 } }
}
```

Failures come back as `{"ok": false, "error": {"code", "message", "hint", "candidates"}}` with one of the codes `WORKSPACE_NOT_FOUND`, `NODE_NOT_FOUND`, `AMBIGUOUS_NODE`, `INVALID_ARGUMENT`, `ADAPTER_UNAVAILABLE`, `INDEX_BUILDING`, `BUDGET_EXCEEDED`, `SNAPSHOT_NOT_FOUND`, `EXTERNAL_TOOL_FAILED` (`src/core/errors.ts:2-11`, `src/core/errors.ts:27`).

An empty graph gives `index.state = "partial"` (`src/core/envelope.ts:162-171`). An answer over the byte budget carries `truncated: true` and a hint that says to raise `max_bytes` (`src/tools/get_graph.ts:40-59`).

### index.kinds

`index.kinds` always holds ten entries in `EdgeKind` order. Each entry has `kind`, `status`, `edges`, `confidence`, `confidence_min` and `emitters` (`src/core/envelope.ts:30`, `src/core/envelope.ts:100-127`). `status` is one of:

- `emitted`: edges exist;
- `no_matches`: no edges, and every emitter for that kind ran;
- `unsupported`: no edges, and at least one emitter failed;
- `not_emitted`: the kind has no emitters in the registry at all (`src/core/envelope.ts:130-154`).

The invariant `sum(kinds.edges) == graph.edges.length` is checked by `tests/kinds.test.mjs`.

Only `index.state = "building"` breaks the rule of ten entries: a cold `arch_status` answers immediately with empty `kinds`, `adapters` and `missing`, zero coverage and `data.graph = null`, while the index builds in the background (`src/core/envelope.ts:182-197`, `src/tools/get_graph.ts:429-443`).

## Workspace discovery

`workspace` is optional. A `.git` directory anywhere above the working directory wins and is returned at once. Otherwise the server walks up to the nearest manifest (`package.json`, `pyproject.toml`, `requirements.txt`, `settings.gradle*`, `build.gradle*`) or to a directory with at least three source files. Markdown, JSON and YAML files do not make a root. No root means `WORKSPACE_NOT_FOUND` (`src/core/workspace.ts:7-12`, `src/core/workspace.ts:105-112`, `src/core/workspace.ts:152-163`).

A container without its own root resolves into child roots: the envelope reports `roots[]` and `root_used`. `ARCH_MCP_ALLOWED_ROOTS` turns discovery into an allowlist, and a path outside it answers `WORKSPACE_NOT_FOUND` (`src/core/workspace.ts:179-190`, `src/core/workspace.ts:228-244`).

## Adapters

All 22 adapters are built in and register at module load, so `index.adapters` reflects the registry at runtime (`src/core/adapters/registry.ts:60-89`). An adapter with no matching files reports `absent` and stays out of `index.adapters` and `missing[]` (`src/core/envelope.ts:115-117`). A broken grammar or ABI mismatch lands in `missing[]` with `state: partial` while the core keeps answering (`src/core/envelope.ts:150-173`).

| Adapter | Formats | Precision | What it adds |
| --- | --- | --- | --- |
| `scip` | SCIP `index.scip` | semantic | `symbol` nodes and `references` edges from a ready index; path from `ARCH_MCP_SCIP_DIR` or `<root>/.arch/scip/index.scip` |
| `git` | git repository | manifest | HEAD and status metadata; no edges |
| `depcruiser` | JavaScript/TypeScript | syntax | import edges, type-only ones included |
| `api` | OpenAPI/Swagger, AsyncAPI, GraphQL SDL, `.proto` | syntax | `service` nodes for contracts and `references` edges |
| `ci` | CI YAML | syntax | `config:<file>` nodes, `uses:` to `package:<action>` references |
| `dockerfile` | Dockerfile | syntax | `container:<file>` and `package:<image>` nodes |
| `docs` | Markdown | syntax | `doc` nodes, headings in `meta.headings`, local links as `references` |
| `k8s` | Kubernetes YAML | syntax | `service:<Kind>/<name>`, `deploys` to an image, `envFrom` to `config` |
| `manifests` | TOML/JSON manifests | manifest | `file` and `package` nodes with `references` to dependencies |
| `sql` | SQL DML, PostgreSQL DDL | syntax | `table` and `view` nodes, `reads`, `writes`, `references` edges |
| `terraform` | Terraform HCL | syntax | `service:<type>.<name>` and `references` by interpolation; runs only with `ARCH_MCP_TERRAFORM=1` |
| `tree-sitter-c` | C | syntax | `module` and `imports` plus approximate `symbol` nodes |
| `tree-sitter-cpp` | C++ | syntax | same |
| `tree-sitter-csharp` | C# | syntax | same |
| `tree-sitter-go` | Go | syntax | same |
| `tree-sitter-java` | Java | syntax | same |
| `tree-sitter-kotlin` | Kotlin | syntax | same |
| `tree-sitter-php` | PHP | syntax | same |
| `tree-sitter-python` | Python | syntax | `module` nodes, `imports`, approximate `symbol` and `calls` |
| `tree-sitter-ruby` | Ruby | syntax | same as the generic languages |
| `tree-sitter-rust` | Rust | syntax | same |
| `tree-sitter-tsjs` | JavaScript/TypeScript | syntax | `symbol` nodes and `calls` edges only; `imports` belong to depcruiser |

Third-party licenses per dependency are listed in `THIRD_PARTY_NOTICES.md`; `grammars/LICENSE` holds the grammar provenance and `grammars/SHA256SUMS` the binary hashes.

### Type-only dependencies

Edges whose `dependencyTypes` contain `type-only` get `meta.type_only = true`. `focus`, `reaches`, `impact` and `affected_tests` exclude them unless you pass `include_type_only: true`. Collecting them needs depcruiser with `options.parser = tsc`, otherwise `import type` statements never reach the graph (`src/adapters/depcruiser.ts:77-83`).

## Snapshots and arch_diff

`arch_snapshot` computes `snapshot_id = SHA256(graph JSON + git HEAD + adapter versions)` and stores the snapshot in the cache. `arch_diff` compares two refs: `current`, git HEAD (a hex string of 7 to 39 characters, an ambiguous prefix yields `AMBIGUOUS_NODE` with candidates), or a `snapshot_id`. A missing snapshot yields `SNAPSHOT_NOT_FOUND`, a malformed ref yields `INVALID_ARGUMENT`; arbitrary git revisions such as `HEAD~1` are v1.1 (`src/core/snapshots.ts:11-12`, `src/core/snapshots.ts:136-139`, `src/core/snapshots.ts:171-175`).

## CLI

```text
node dist/cli.mjs <status|snapshot|search|focus|reaches|impact|affected-tests|diff> [--workspace <path>] [--json]
node dist/cli.mjs bootstrap
```

Options include `--json`, `--scope`, `--query`, `--kind`, `--node`, `--target`, `--changed`, `--limit`, `--max-depth`, `--depth`, `--max-bytes`, `--include-type-only`, `--from` and `--to`. Exit codes: 0 on success, 1 on a contract error, 2 on a usage error (`src/cli.ts:8-26`, `src/cli.ts:155-187`). Without `ARCH_MCP_MAX_RESPONSE_BYTES` the budget is 65536, and `status` prints the line `budget: 65536` (`src/cli.ts:135`).

Sample call arguments:

```json
{ "name": "impact", "arguments": { "workspace": "E:\\work\\my-service", "changed": ["server/src/limits.ts"], "depth": 3 } }
{ "name": "affected_tests", "arguments": { "workspace": "E:\\work\\my-service", "changed": ["server/src/limits.ts"] } }
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCH_MCP_STACKS` | `all` | Stack filter: `py`, `jvm`, `js` or `all` |
| `ARCH_MCP_TIMEOUT_MS` | `120000` | Timeout for every external process |
| `ARCH_MCP_MAX_RESPONSE_BYTES` | `65536` | Response budget, cap `1048576`, above it `BUDGET_EXCEEDED` |
| `ARCH_MCP_ALLOWED_ROOTS` | not set | Workspace allowlist separated by `path.delimiter`; unset means no restriction |
| `ARCH_MCP_CACHE_DIR` | `%LOCALAPPDATA%\arch-mcp\cache` | Cache root override for graphs and snapshots |
| `ARCH_MCP_ALLOW_EXEC` | off | `1` enables optional external tools |
| `ARCH_MCP_AUTO_INSTALL` | off | Installs the toolchain automatically when missing |
| `ARCH_MCP_GRAMMAR_DIR` | `<package>/grammars` | wasm grammar directory override |
| `ARCH_MCP_SCIP_DIR` | not set | Directory or `index.scip` file for the `scip` adapter |
| `ARCH_MCP_SCIP_INDEXER` | not set | Indexer command template with `{root}` and `{out}` tokens; needs `ARCH_MCP_ALLOW_EXEC=1` |
| `ARCH_MCP_TERRAFORM` | off | `1` enables the lazy MPL-2.0 `@cdktf/hcl2json` import |
| `ARCH_MCP_SQLGLOT` | off | `1` adds the sqlglot bridge for CTAS, materialized views, ALTER-FK and column lineage |
| `ARCH_MCP_PYTHON` | `python` | Interpreter for the sqlglot bridge |
| `ARCH_MCP_SQLGLOT_BRIDGE` | `<package>/python/sqlglot_bridge.py` | Bridge path override; the file content joins the cache key |

Most variables are read in `src/config.ts:42-70`; the root allowlist is read in `src/core/workspace.ts:179`.

## What v1 does not do

- **Run your code.** No tests, builds or scripts from the repository; external processes go through one runner, and the trusted core uses git read-only and depcruise (`src/core/exec.ts:5-12`).
- **Generate a SCIP index by default.** The adapter reads a ready index; an external indexer runs only with `ARCH_MCP_SCIP_INDEXER` and `ARCH_MCP_ALLOW_EXEC=1` (`src/config.ts:67-70`).
- **Write into the repository.** Tools only read the workspace; the cache and snapshots stay outside it (`src/cache.ts:8-11`).
- **Diff arbitrary git revisions.** `arch_diff` covers `current`, `HEAD` and `snapshot_id` (`src/core/snapshots.ts:171-175`).
- **Drive the Terraform CLI.** The adapter parses HCL through `@cdktf/hcl2json`; no `plan`, `validate` or `apply` call is made (`src/adapters/infra/terraform.ts:2-3`, `src/adapters/infra/terraform.ts:78`).

## Notes and limits

- **Cache key.** Git HEAD, mtimes of changed files, toolchain version, config hashes, the adapter signature, `GRAPH_SCHEMA_VERSION` and the package version (`src/cache.ts:112-131`). A non-git workspace is keyed by a sha256 signature over all files except `node_modules` and `.git`, so an edit that keeps mtime and size does not invalidate the cache (`src/cache.ts:185-196`).
- **Build artifacts reach the graph.** Only `node_modules` and `.git` are excluded from that signature, so `.next/` and friends are indexed (`src/cache.ts:185-190`).
- **Schema versions.** `SCHEMA_VERSION = 6` moves with the response shape, `GRAPH_SCHEMA_VERSION = "graph-9"` only with the graph or cache entry shape (`src/core/envelope.ts:15-19`, `src/cache.ts:31`).
- **Single flight.** Identical concurrent calls share one run (`src/tools/get_graph.ts:308-423`); a cache hit marks the evidence command with a `(cached)` suffix and sets `provenance.cached` (`src/tools/get_graph.ts:361`, `src/provenance.ts:31`).
- **Non-blocking build.** The tree-sitter pipeline yields to the event loop every eight files, so a cold `arch_status` answers within seconds and the graph builds in the background (`src/core/adapters/tree-sitter/generic.ts:165`, `src/tools/get_graph.ts:442-443`).

## License

MIT (`LICENSE:1-3`). Third-party components and their licenses are listed in `THIRD_PARTY_NOTICES.md`.
