# arch-mcp

MCP-сервер (stdio) архитектурного снимка workspace. Восемь инструментов (контракт рев.3):

- `arch_status(workspace?, max_bytes?)` — status: detected stacks, git info, graph index coverage and adapters;
- `arch_snapshot(workspace?, scope?, max_bytes?)` — architectural snapshot with `snapshot_id` (`scope`: `summary` | `full`);
- `search(workspace?, query, kind?, max_bytes?)` — case-insensitive substring search over graph nodes (`kind`: `file` | `dir` | `test` | `all` | `module` | `package` | `symbol` | `table` | `view` | `api` | `config` | `doc` | `service` | `container`);
- `focus(workspace?, node, limit?, max_bytes?, include_type_only?)` — incoming and outgoing edges of one node with types; sqlglot lineage edges additionally carry `columns` (`{from,to}` pairs), which are stripped from `get_graph`/`arch_snapshot` (`limit`: default 50, max 200);
- `reaches(workspace?, target, max_depth?, max_bytes?, include_type_only?)` — reverse reachability: who depends on target (`max_depth`: default 10, integers ≥ 1);
- `impact(workspace?, changed[], depth?, max_bytes?, include_type_only?)` — transitive dependents of changed files within `depth` (default 10);
- `affected_tests(workspace?, changed[], max_bytes?, include_type_only?)` — test files (`*.test.*`, `*.spec.*`, `__tests__/`, `test_*.py`) transitively depending on `changed[]`; empty result carries `reason` plus the checked inputs; `dist/`, `build/`, `.next/`, `out/`, `coverage/` are excluded;
- `arch_diff(workspace?, from, to, max_bytes?)` — diff of two snapshots (`current` | git HEAD | `snapshot_id`): added/removed nodes and edges.

Все инструменты **только читают** workspace.

## Переходные алиасы (до v1.1)

- `stacks` → часть `arch_status`: тот же конверт, `data` содержит только блок `stacks`;
- `get_graph` → `arch_snapshot.graph`: `scope=full`, `data` — graph-секция снимка (`nodes`, `edges`, `edge_count`, `snapshot_id`);
- аргумент `repo` = `workspace`; если заданы оба — побеждает `workspace`;
- аргумент `maxDepth` = `max_depth`; если заданы оба — побеждает `max_depth`.

Удаление алиасов — v1.1.

## Конверт ответа (рев.3)

Успех:

```json
{
  "ok": true,
  "workspace": "E:/1_siteteam/asi-agent1",
  "root_used": "E:/1_siteteam/asi-agent1",
  "roots": ["E:/1_siteteam/asi-agent1"],
  "schema_version": 6,
  "index": {
    "state": "ready",
    "progress": { "percent": 100, "complete": true },
    "coverage": { "files_seen": 226, "parsed": 226, "unsupported": [] },
    "adapters": [{ "name": "git", "status": "ok", "version": null }, { "name": "depcruiser", "status": "ok", "version": "18.7.0" }],
    "missing": []
  },
  "data": {},
  "truncated": false,
  "_meta": { "provenance": { "command": "…", "cwd": "…", "git_head": "…", "ts": "…", "cached": false, "exit_code": 0 } }
}
```

Блок `index` дополнительно несёт `kinds` — все 10 видов рёбер со статусами
(см. раздел index.kinds).

Ошибка: `{"ok": false, "error": {"code", "message", "hint", "candidates"}}` с кодами
`WORKSPACE_NOT_FOUND`, `NODE_NOT_FOUND`, `AMBIGUOUS_NODE`, `INVALID_ARGUMENT`,
`ADAPTER_UNAVAILABLE`, `INDEX_BUILDING`, `BUDGET_EXCEEDED`, `SNAPSHOT_NOT_FOUND`,
`EXTERNAL_TOOL_FAILED`.

Пустой граф — `index.state = "partial"`, а не ошибка. При обрезке по бюджету ответ
всегда несёт `truncated: true` и `hint`.

`index.state = "building"` (ТЗ v3, п.A): `arch_status` **не ждёт** построение — на
холодном кэше он немедленно отвечает конвертом с `state: "building"`,
`progress.percent` 0..100 (0 — прогон только что стартовал), пустыми
`adapters`/`kinds`/`missing`, нулевой `coverage`, `data.graph = null`,
`data.toolchain.status = "building"`, `data.hint`, `cached: false` (и
`_meta.provenance.cached: false`). Построение идёт в фоне: повторный
`arch_status` отдаёт `ready`/`partial` и `cached: true`. Это единственное
состояние, при котором пустые `kinds`/`adapters`/`missing` и нулевая coverage
легальны; вне `building` инвариант «ровно 10 видов» сохраняется. Остальные
инструменты строгие: `focus`/`search`/`reaches`/`impact`/`affected_tests`/
`arch_snapshot`/`stacks` ждут идущий прогон (single-flight) и отвечают
готовым результатом; второй прогон при этом не стартует.

## index.kinds (блок конверта)

`index.kinds` — всегда ровно 10 элементов в порядке `EdgeKind`: `imports`,
`calls`, `extends`, `implements`, `reads`, `writes`, `references`,
`configures`, `deploys`, `tests`. Единственное исключение — состояние
`index.state = "building"` (см. раздел Конверт ответа): там `kinds = []`,
`adapters = []`, `missing = []` и нулевая `coverage`. Поля элемента:

| поле | смысл |
| --- | --- |
| `kind` | вид рёбра |
| `status` | `emitted` \| `no_matches` \| `not_emitted` \| `unsupported` |
| `edges` | число рёбер вида в merged-графе, целое ≥ 0 |
| `confidence` | отсортированный массив уникальных precision эмиттеров вида (порядок `manifest` < `syntax` < `semantic`) |
| `confidence_min` | наименее сильная precision из `confidence`; `null` при пустом массиве |
| `emitters` | адаптеры-эмиттеры вида — состав зависит от статуса (ниже) |

Семантика статусов:

- **`emitted`** — `edges > 0`; `emitters` — только адаптеры, чьи рёбра реально
  попали в merged;
- **`no_matches`** — `edges = 0` и все эмиттеры вида отработали
  (`ok`/`absent`/`unavailable`/`cached`); `emitters` — полный перечень
  эмиттеров вида из карты;
- **`unsupported`** — `edges = 0` и хотя бы один эмиттер в
  `error`/`timeout`/`not_available`; `emitters` — полный перечень из карты;
- **`not_emitted`** — у вида нет эмиттеров в карте (`extends`, `implements`,
  `configures`, `tests`); `emitters = []`, `confidence = []`. **Известная дыра,
  не ошибка**: виды объявлены в типах, но их сейчас никто не эмитит, и блок
  честно сообщает об этом.

Карта эмиттеров — `KIND_EMITTERS` в `src/core/adapters/registry.ts` (сверена с
кодом адаптеров): `imports` — depcruiser + tree-sitter-{python, c, cpp, csharp,
go, java, kotlin, php, ruby, rust}; `calls` — tree-sitter-{tsjs, python};
`reads`/`writes` — sql; `references` — sql, api, manifests, docs, ci,
terraform, k8s, dockerfile, scip; `deploys` — k8s; `extends`/`implements`/
`configures`/`tests` — пусто.

Инвариант: `sum(kinds.edges) == graph.edges.length` — каждое ребро графа
учтено ровно один раз по своему виду (проверяется `tests/kinds.test.mjs`).

## Workspace

`workspace` необязателен: корень от cwd ищется по приоритету. `.git` на любом
уровне вверх от cwd сильнее и возвращается немедленно; если его нет —
fallback-каскад из ближайшего к cwd каталога с манифестом
(`package.json`, `pyproject.toml`, `requirements.txt`, `settings.gradle*`, `build.gradle*`)
либо с не меньше чем тремя файлами с исходными расширениями (`.sql`, `.py`, `.ts`,
`.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.kt`, `.kts`, `.java`, `.go`, `.rs`, `.rb`,
`.php`, `.cs`, `.c`, `.cpp`, `.h`, `.hpp`, `.tf`, `.proto`, `.graphql`, `.gql`;
сравнение без учёта регистра): из манифеста и третьего признака побеждает
ближайший к cwd. `.md`, `.json`, `.yaml`/`.yml` корнем не делают; порог 3, ложные
корни допустимы (осознанное решение, ТЗ рев.2 п.1). Корня нет →
`WORKSPACE_NOT_FOUND`. Container без собственного корня разрешается в дочерние корни: конверт несёт
`roots[]` и `root_used`. Allowlist — `ARCH_MCP_ALLOWED_ROOTS` (записи через
`path.delimiter`, на Windows `;`): **не задан** → ограничений нет; **задан** →
путь вне списка запрещён → `WORKSPACE_NOT_FOUND`. Авто-корень cwd при этом
разрешён, если `discoverRootFrom(cwd)` находит корень (`.git` вверх либо
fallback-каталог с манифестом/тремя файлами) — разрешение авто-корня не
зависит от содержимого списка. Игнор при поиске корней: `.gitignore` container плюс
`node_modules`, `.venv`, `target`, `dist`, `build`, `.next`, `out`, `coverage`.

## Type-only зависимости

Рёбра depcruiser с `dependencyTypes`, содержащим `type-only`, получают
`meta.type_only = true`. `focus`, `reaches`, `impact` и `affected_tests` принимают
`include_type_only` (дефолт `false`): по умолчанию type-only рёбра исключены из
обхода, при `true` — включаются. Сами рёбра добираются запуском depcruiser с
`options.parser = tsc` (конфиг генерируется в кэш-каталоге): дефолтный путь
транспилирует TS→JS и выбрасывает `import type` ещё до парсера — без этого
`import type`-зависимости в граф не попадают вовсе.

## Адаптеры

Реестр — `src/core/adapters/registry.ts`; порядок списка — `priority` по
убыванию, затем id лексикографически (`listAdapters()`); всего 22 адаптера:

| id | Язык/формат | precision | priority | SPDX | Что даёт |
| --- | --- | --- | --- | --- | --- |
| `scip` | SCIP-индекс `index.scip` | semantic | 200 | Apache-2.0 (+ прямая зависимость `@bufbuild/protobuf@2.16.0`: Apache-2.0 AND BSD-3-Clause) | `symbol`-узлы и `references`-рёбра по готовому индексу; путь — `ARCH_MCP_SCIP_DIR` либо `<root>/.arch/scip/index.scip`; эталона нет и задан `ARCH_MCP_SCIP_INDEXER` (см. Переменные окружения) → индексер запускается на каждом фактическом прогоне в эфемерный `<кэш>/scip/run-<pid>-<n>/index.scip`, читается и удаляется |
| `git` | git-репозиторий | manifest | 150 | MIT | только метаданные (HEAD, строки `git status`); граф не даёт — дельта пустая, рёбра в граф не вносятся |
| `depcruiser` | JS/TS | syntax | 100 | MIT (toolchain `dependency-cruiser@18.7.0`) | рёбра JS/TS-импортов, включая type-only (см. раздел Type-only) |
| `api` | OpenAPI/Swagger, AsyncAPI, GraphQL SDL, `.proto` | syntax | 50 | Apache-2.0 AND BSD-3-Clause AND MIT | `service`-узлы контрактов и `references`-рёбра между ними и наружу |
| `ci` | CI YAML (`.github/workflows` и др.) | syntax | 50 | ISC | `config:<file>`, `uses:` → `references` к `package:<action>` |
| `dockerfile` | Dockerfile | syntax | 50 | MIT | `container:<file>` и `package:<image>` базового образа, ребро `references` |
| `docs` | Markdown | syntax | 50 | MIT | `doc:<path>`, заголовки в `meta.headings`, локальные ссылки → `references` (внешние не резолвятся, R23) |
| `k8s` | Kubernetes YAML | syntax | 50 | ISC | `service:<Kind>/<name>`, `deploys` к образу, `envFrom` → `references` к `config:<name>` |
| `manifests` | манифесты: TOML/JSON (`pyproject.toml`, `package.json` и др.) | manifest | 50 | MIT | `file`/`package`-узлы манифестов и `references` к зависимостям |
| `sql` | SQL: DML (`node-sql-parser`) + PostgreSQL-DDL (свой лексер) | syntax | 50 | Apache-2.0 (код DDL-лексера пакета — MIT) | `table`/`view`-узлы, рёбра `reads`/`writes`/`references` |
| `terraform` | Terraform HCL (`.tf`) | syntax | 50 | **MPL-2.0** (`@cdktf/hcl2json`) | `service:<type>.<name>` и `references` по `${...}`-интерполяции; только при `ARCH_MCP_TERRAFORM=1` (R22, без флага — `absent`), битый HCL и ресурс без второй метки → `unsupported` с причиной |
| `tree-sitter-c` | C | syntax | 50 | MIT | `module`/`imports` + `symbol` best-effort, wasm-грамматика из `grammars/` |
| `tree-sitter-cpp` | C++ | syntax | 50 | MIT | то же |
| `tree-sitter-csharp` | C# | syntax | 50 | MIT | то же |
| `tree-sitter-go` | Go | syntax | 50 | MIT | то же |
| `tree-sitter-java` | Java | syntax | 50 | MIT | то же |
| `tree-sitter-kotlin` | Kotlin | syntax | 50 | MIT | то же |
| `tree-sitter-php` | PHP | syntax | 50 | MIT | то же |
| `tree-sitter-python` | Python | syntax | 50 | MIT | `module`-узлы (id = repo-relative путь) + `imports`-рёбра (`confidence: syntax`) + `symbol`/`calls` best-effort |
| `tree-sitter-ruby` | Ruby | syntax | 50 | MIT | то же |
| `tree-sitter-rust` | Rust | syntax | 50 | MIT | то же |
| `tree-sitter-tsjs` | JavaScript/TypeScript | syntax | 50 | MIT | только `symbol`-узлы и `calls`-рёбра — `module`/`imports` у JS/TS принадлежат depcruiser (R6), дубли исключены |

Все адаптеры встроены и регистрируются при загрузке модуля, поэтому
`index.adapters` конверта отдаёт их динамически из реестра. Адаптер с нулём
подходящих файлов возвращает статус `absent` и в `index.adapters`/`missing[]`
не попадает; битая грамматика/несовпадение ABI — `not_available` в `missing[]`
и `state: partial`, ядро продолжает отвечать. Кэш-подпись и `snapshot_id`
учитывают состав и версии адаптеров (`adapterSignature`); по правилу R25 это
**не** требует бампа `GRAPH_SCHEMA_VERSION` — см. раздел Заметки и
ограничения.

**SPDX (T2b, пайплайн WASM tree-sitter):** `web-tree-sitter@0.27.1` — MIT;
`@vscode/tree-sitter-wasm@0.3.1` (поставщик wasm-бинарей) — MIT;
`@repomix/tree-sitter-wasms@0.1.17` (wasm C) — Unlicense как пакет, сама
грамматика `tree-sitter-c` — MIT; `@unit-mesh/treesitter-artifacts@1.7.7`
(wasm Kotlin) — MIT; `@scip-code/scip@0.10.0` + `@bufbuild/protobuf` (SCIP
адаптер) — Apache-2.0 AND BSD-3-Clause. Языковые грамматики
`tree-sitter-{typescript,tsx,javascript,python,go,rust,java,kotlin,csharp,php,ruby,c,cpp}`
— MIT. Тексты и провенанс — `grammars/LICENSE`,
хэши бинарей — `grammars/SHA256SUMS`; каталог `grammars/` копируется из
`node_modules/@vscode/tree-sitter-wasm/wasm/` (+ `@unit-mesh` для Kotlin и
`@repomix` для C). Грамматики каталога `grammars/` — только MIT,
GPL/AGPL/Terms не используются (решение лида R7); Apache-2.0/BSD затрагивает
только SCIP-зависимости.

**SPDX (T3, SQL и манифесты):** `node-sql-parser@5.4.0` (DML и `tableList`
адаптера `sql`) — Apache-2.0; `smol-toml@1.9.1` (чтение `pyproject.toml`
адаптера `manifests`, Т3.2) — BSD-3-Clause; собственный PostgreSQL-DDL-лексер
адаптера `sql` и адаптер `manifests` — код пакета (MIT). GPL/AGPL/Terms
в зависимостях T3 нет.

**SPDX (T4a, API-адаптер):** `@readme/openapi-parser@10.0.0` (валидация
OpenAPI 3.x) — MIT; `@apidevtools/swagger-parser@13.1.0` (Swagger 2.0/3.0) —
MIT; `protobufjs@8.8.1` (разбор `.proto` без генерации кода) — BSD-3-Clause;
`graphql@17.0.2` (разбор SDL) — MIT; `@asyncapi/parser@3.6.6` — Apache-2.0;
код адаптера `api` (`src/adapters/api/`) — код пакета (MIT). Сборка: цепочка
`@asyncapi/parser` (spectral/jsonc-parser) не бандлится в ESM (external в
`esbuild.mjs`), остальное бандлится. GPL/AGPL/Terms в зависимостях T4a нет.

**SPDX (T4b, инфраструктура и документация):** `yaml@2.9.1` (разбор K8s/CI
YAML) — ISC; `dockerfile-ast@0.7.1` (разбор Dockerfile) — MIT;
`remark@15.0.1` (разбор Markdown) — MIT; `@cdktf/hcl2json@0.21.0`
(разбор HCL, адаптер `terraform`) — **MPL-2.0**: только ленивый dynamic
import под `ARCH_MCP_TERRAFORM=1`, external в `esbuild.mjs`, в основной
бандл не линкуется, notice — в `THIRD_PARTY_NOTICES.md`; код адаптеров
`dockerfile`/`k8s`/`ci`/`terraform` (`src/adapters/infra/`) и `docs`
(`src/adapters/docs/`) — код пакета (MIT). GPL/AGPL в зависимостях T4b нет.

## Снимки и arch_diff

`arch_snapshot` (и алиас `get_graph`) считает `snapshot_id = SHA256(JSON графа +
git HEAD + версии адаптеров)` и сохраняет снимок в кэш
(`<cacheRoot>/snapshots/<sha1(workspace)>/<snapshot_id>.json` + маппинг HEAD → id).
`arch_diff` сравнивает два ref: `current` (свежий снимок), git HEAD (hex —
полный либо уникальный префикс 7..39 hex; неоднозначный префикс →
`AMBIGUOUS_NODE` с кандидатами) или `snapshot_id` (64 hex); снимка нет →
`SNAPSHOT_NOT_FOUND`; произвольные git-ревизии (`HEAD~1`, ветки) — v1.1;
неверный формат ref → `INVALID_ARGUMENT`.
Кэш графа работает и для git, и для не-git workspace: при git HEAD ключ —
прежний (HEAD + mtime изменённых файлов), без git HEAD — подпись по всем
файлам workspace (раздел Заметки), поэтому правки видны и в не-git каталоге.

## Установка

```powershell
Set-Location E:\1_Products\arch-mcp
npm install        # runtime- и dev-зависимости; SDK бандлится, external: @asyncapi/parser, @cdktf/hcl2json
npm run build      # dist/server.mjs, dist/cli.mjs, dist/lib.mjs (esbuild, node>=22)
npm run bootstrap  # атомарная установка toolchain: dependency-cruiser@18.7.0 в ./toolchain
npm test           # node --test, юнит-тесты на фикстуре реального прогона
```

`npm run bootstrap` идемпотентен: повторный запуск находит `toolchain/toolchain.lock.json` и ничего не меняет. Прерванный bootstrap убирает `toolchain.tmp-*`, маркер `.bootstrap-in-progress` и toolchain без lock при следующем запуске. Маркер на месте → вызовы отвечают `INDEX_BUILDING`. Сетевые операции — только `npm install` и `npm run bootstrap`; сервер в рантайме сеть не использует.

## Подключение к opencode (v2-конфиг)

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

## CLI

```text
node dist/cli.mjs <status|snapshot|search|focus|reaches|impact|affected-tests|diff> [--workspace <path>] [--json]
node dist/cli.mjs bootstrap
```

Опции: `--json` (полный конверт), `--scope`, `--query`, `--kind` (`file` | `dir` | `test` | `all` | `module` | `package` | `symbol` | `table` | `view` | `api` | `config` | `doc` | `service` | `container`; default `file`), `--node`,
`--target`, `--changed` (через запятую, повторяемый), `--limit`, `--max-depth`,
`--depth`, `--max-bytes`, `--include-type-only`, `--from`, `--to`.
Коды выхода: 0 — ок, 1 — ошибка контракта (конверт на stdout при `--json`,
`error <CODE>` на stderr без него), 2 — usage. Без `ARCH_MCP_MAX_RESPONSE_BYTES`
в окружении бюджет — 65536; `status` без `--json` печатает строку `budget: 65536`.

## Примеры вызовов

```json
{ "name": "arch_status",     "arguments": { "workspace": "E:\\1_siteteam\\asi-agent1" } }
{ "name": "arch_snapshot",   "arguments": { "workspace": "E:\\1_siteteam\\asi-agent1", "scope": "full" } }
{ "name": "search",          "arguments": { "workspace": "E:\\1_siteteam\\asi-agent1", "query": "limits" } }
{ "name": "focus",           "arguments": { "workspace": "E:\\1_siteteam\\asi-agent1", "node": "server/src/limits.ts", "include_type_only": true } }
{ "name": "reaches",         "arguments": { "workspace": "E:\\1_siteteam\\asi-agent1", "target": "server/src/limits.ts", "max_depth": 10 } }
{ "name": "impact",          "arguments": { "workspace": "E:\\1_siteteam\\asi-agent1", "changed": ["server/src/limits.ts"], "depth": 3 } }
{ "name": "affected_tests",  "arguments": { "workspace": "E:\\1_siteteam\\asi-agent1", "changed": ["server/src/limits.ts"] } }
{ "name": "arch_diff",       "arguments": { "workspace": "E:\\1_siteteam\\asi-agent1", "from": "current", "to": "0123456789abcdef0123456789abcdef01234567" } }
```

## Переменные окружения

| Переменная | По умолчанию | Смысл |
| --- | --- | --- |
| `ARCH_MCP_STACKS` | `all` | фильтр стеков: `py` \| `jvm` \| `js` \| `all` |
| `ARCH_MCP_TIMEOUT_MS` | `120000` | таймаут всех exec (git, depcruise, мост sqlglot и будущие Docker/SCIP/protoc/kubeconform/helm), мс; по истечении kill дерева по PID и `EXTERNAL_TOOL_FAILED` c `timeout_ms` |
| `ARCH_MCP_MAX_RESPONSE_BYTES` | `65536` | бюджет JSON-ответа; потолок `1048576` (явный `max_bytes` выше — `BUDGET_EXCEEDED`); при обрезке — `truncated` + `hint` |
| `ARCH_MCP_ALLOWED_ROOTS` | не задан | не задан → ограничений нет; задан → allowlist workspace-путей через `path.delimiter` (на Windows `;`), путь вне списка — `WORKSPACE_NOT_FOUND`; авто-корень cwd разрешён, если `discoverRootFrom(cwd)` находит корень |
| `ARCH_MCP_CACHE_DIR` | `%LOCALAPPDATA%\arch-mcp\cache` | override корня кэша (граф + снимки `arch_diff`) |
| `ARCH_MCP_ALLOW_EXEC` | off | `1` — разрешает опциональные внешние инструменты; доверенное ядро (git read-only + depcruise) работает без флага |
| `ARCH_MCP_AUTO_INSTALL` | off | автоустановка toolchain при отсутствии (по умолчанию выключена) |
| `ARCH_MCP_GRAMMAR_DIR` | `<корень пакета>/grammars` | override каталога wasm-грамматик tree-sitter (тесты подкладывают битый файл во временную копию; см. раздел Адаптеры) |
| `ARCH_MCP_SCIP_DIR` | не задан | каталог либо файл `index.scip` для адаптера `scip`; без переменной читается `<root>/.arch/scip/index.scip`. Новая семантика (ТЗ scip-indexer): при заданном `ARCH_MCP_SCIP_INDEXER` отсутствие эталона ⇒ запуск индексера и чтение run-индекса `<кэш>/scip/run-<pid>-<n>/index.scip`; эталон есть ⇒ запуска нет, читается эталон |
| `ARCH_MCP_SCIP_INDEXER` | не задан | шаблон команды SCIP-индексера (без shell: пробелы и двойные кавычки; `{root}` — корень workspace, `{out}` — эфемерный run-каталог, подстановка в любом токене). Пример: `node C:\tools\scip-index.js {root} {out}`. Требует `ARCH_MCP_ALLOW_EXEC=1`, иначе режим выключен (`scip` при отсутствии эталона — `absent`); первый токен `.cmd`/`.bat` → `not_available` («.cmd/.bat unsupported»), незакрытая кавычка → `not_available` («unterminated quote»), пустой шаблон → `not_available` («empty command»); таймаут — `ARCH_MCP_TIMEOUT_MS`; причина отказа — `index.adapters[].reason` |
| `ARCH_MCP_TERRAFORM` | off | `1` — включает адаптер `terraform`: ленивый dynamic import `@cdktf/hcl2json` (MPL-2.0) происходит только под флагом; без флага — `absent` (R22), CLI Terraform не вызывается |
| `ARCH_MCP_SQLGLOT` | off | `1` — режим sqlglot: DDL/DML дополнительно разбирает python-мост `python/sqlglot_bridge.py` (sqlglot 30.29.0, MIT): CTAS/matview/ALTER-FK и lineage-колонки в meta рёбер; требует `ARCH_MCP_ALLOW_EXEC=1`, иначе режим выключен; мост/Python недоступны → статус `sql` = `not_available`, граф строится прежним лексером |
| `ARCH_MCP_PYTHON` | `python` | интерпретатор для моста sqlglot (путь к python) |
| `ARCH_MCP_SQLGLOT_BRIDGE` | `<корень пакета>/python/sqlglot_bridge.py` | override пути к мосту sqlglot; содержимое эффективного файла моста входит в ключ кэша (правка моста → другой ключ) |

## Что не входит в v1

- **Runtime-исполнение кода проекта** — сервер не запускает тесты, сборки и скрипты репозитория (только собственные вызовы git/depcruiser);
- **Генерация SCIP-индекса по умолчанию** — адаптер `scip` читает готовый индекс (эталон `<root>/.arch/scip/index.scip` либо `ARCH_MCP_SCIP_DIR`); внешний индексер запускается только при заданном `ARCH_MCP_SCIP_INDEXER` и `ARCH_MCP_ALLOW_EXEC=1` — без шаблона `scip` `absent` и спавнов нет;
- **Сеть в рантайме** — сетевые операции только `npm install` и `npm run bootstrap`; сам сервер ответы по сети не ходит;
- **Запись в репозиторий** — все инструменты только читают workspace, кэш и снимки пишутся вне репозитория;
- **Diff произвольных git-ревизий** — `arch_diff` сравнивает `current` / `HEAD` / `snapshot_id`; `HEAD~1`, ветки и другие ревизии — v1.1;
- **Terraform CLI** — адаптер `terraform` только парсит HCL (`@cdktf/hcl2json`); `plan`/`validate`/apply не вызываются (CLI — BUSL).

## Заметки и ограничения

- Команда depcruiser: `<toolchain>/node_modules/dependency-cruiser/bin/dependency-cruiser.mjs --output-type json --config <кэш>/depcruise.config.json --exclude node_modules .` с cwd=workspace. `--config` подставляет `options.parser = tsc` (type-only рёбра, см. раздел Type-only); конфиг лежит в кэш-каталоге и не трогает репозиторий, чужие конфиги проекта игнорируются. Флаг `--exclude node_modules` добавлен по факту прогона 2026-11-01: без него на репозитории с `node_modules` в дереве (asi-agent1) depcruiser уходит в OOM (exit 134, ~198 с, heap 4 ГБ). Путь репозитория передаётся в posix-вида (`E:/...`): depcruiser резолвит аргументы через fast-glob, который не принимает backslash-пути.
- Кэш: корень — `ARCH_MCP_CACHE_DIR` либо `%LOCALAPPDATA%\arch-mcp\cache\<sha1(repo)>\`, ключ — git HEAD + mtime изменённых файлов + версия toolchain + хэши конфигов (`configHashes`, включая `scipIndexer`/`scipIndexerMode` — шаблон и режим SCIP-индексера) + режим парсера depcruiser (`parser`: `tsc-config` при `--config <кэш>/depcruise.config.json`, `no-config` при фолбэке `--no-config`) + подпись состава адаптеров `adapterSignature` (см. раздел Адаптеры) + `GRAPH_SCHEMA_VERSION` + `version` из `package.json`. Режим парсера детерминирован: его выбирает один и тот же код (`depcruiseConfigPlan`) и в ключе, и в прогоне, поэтому запись одного режима не отдаётся по ключу другого. Для не-git workspace (git HEAD = null) вместо HEAD/mtimes в ключ входит **подпись файлов**: sha256 по отсортированным строкам `<path>\t<mtimeMs>\t<size>` всех файлов под workspace, исключая **только** `node_modules` и `.git` на любой глубине (зеркало охвата depcruiser: `--exclude node_modules`, см. выше и п. «В граф попадают артефакты сборки»); `.next/`, `dist/`, `build/`, `out/`, `coverage/` в подпись входят. Гарантия инвалидации: правка, добавление или удаление любого файла вне этих двух каталогов меняет mtime/size → другой ключ → кэш-промах. **Оговорка mtime/size:** подпись детерминирована по mtime и размеру, поэтому правка, не меняющая ни mtime, ни размер (те же байты с восстановленным mtime), кэш не инвалидирует; git-канал работает по прежней семантике HEAD + mtimes из `git status`. Репозиторий не меняется.
- **Правило бампа `schema_version` и `GRAPH_SCHEMA_VERSION` (R25):** `SCHEMA_VERSION` (`src/core/envelope.ts`) поднимается на единицу при любом изменении формы ответа (конверт, `data`, ошибки). `GRAPH_SCHEMA_VERSION` (`src/cache.ts`) поднимается на единицу **только** при изменении формы графа (структура узлов/рёбер, нормализация путей) либо структуры кэш-записи (`GraphCacheEntry`) — иначе старые записи кэша считаются совместимыми. Изменение состава или версий адаптеров (`src/adapters/*`) бампа **не требует**: состав и версии входят в подпись `adapterSignature`, которая лежит в ключе кэша, поэтому изменение адаптеров само по себе инвалидирует старые записи и бампа не требует (решение лида R25). Бампы независимы: изменение конверта не требует бампа `GRAPH_SCHEMA_VERSION`, а изменение графа или кэша — бампа `SCHEMA_VERSION`. Актуальные значения: `SCHEMA_VERSION = 6` — в `src/core/envelope.ts`, `GRAPH_SCHEMA_VERSION = "graph-9"` — в `src/cache.ts`. `SCHEMA 6` (2026-11-07, scip-indexer): в `index.adapters[]` добавлено поле `reason` (причина не-ok статуса, ≤200 символов; несёт `IndexAdapter`/`IndexInput.adapterStatuses`/`GraphCacheEntry.adapterStatuses`, маппит `server_core.indexFrom` — живой прогон и кэш-хит), бамп по изменению формы ответа, `GRAPH_SCHEMA_VERSION` не менялся; `graph-9` (2026-11-07, scip-indexer): в `GraphCacheEntry.adapterStatuses` добавлено поле `reason` — структура кэш-записи изменилась, бамп по правилу R25, `SCHEMA_VERSION` не менялся; `SCHEMA 5` (2026-11-06, robustness): `index.state` получил легальное состояние `building` — `arch_status` не ждёт построение и отдаёт немедленный building-конверт (пустые `kinds`/`adapters`/`missing`, `data.graph = null`, `data.hint`), бамп по изменению формы ответа (`index`), `GRAPH_SCHEMA_VERSION` не менялся; `graph-8` (2026-11-06, robustness): в `GraphCacheEntry` добавлены `adapterStatuses` (статусы прогона — источник `index.adapters` при кэш-хите) и `degraded{reason,ts}` (кэш деградаций core на `DEGRADED_TTL_MS`), условие записи «только все ok/absent» отменено — бамп по изменению структуры кэш-записи (R25), `SCHEMA_VERSION` не менялся; `SCHEMA 4` (2026-11-06, дельта рев.8): в `focus` добавлен необязательный `columns` (lineage-пары `{from,to}` sqlglot-рёбер) в `incoming`/`outgoing`, публичный `get_graph`/`arch_snapshot` и сохранённый снимок колонки снимают через `stripColumnMeta` — бамп по изменению формы ответа (`data`), правки через врата 8806, `GRAPH_SCHEMA_VERSION` не менялся; `graph-7` (2026-11-05, sqlglot): режим `ARCH_MCP_SQLGLOT=1` добавляет в граф мету `ctas`/`materialized`/`columns`/`stub`/`via=alter` и sqlglot-рёбра, в ключ кэша добавлены `sqlglotMode`/`sqlglotPython`/`sqlglotBridge` (хэш содержимого файла моста) — бамп сделан по изменению формы графа и состава configHashes. `graph-6` (2026-11-03, T2a): в реестр добавлены адаптеры `tree-sitter-python`/`tree-sitter-tsjs` (пайплайн WASM tree-sitter) — бамп сделан по изменению формы графа (новые виды узлов/рёбер `symbol`/`calls`/`module`), кэш дополнительно перестраивается по новой подписи. `graph-5` (2026-11-03, T1.2b): кэш-запись хранит слияние дельт адаптеров (`merged` с `meta.adapters`/`contributors`) вместо raw-ответа depcruiser, в ключ добавлена подпись состава адаптеров `adapterSignature`. Бамп версии `package.json` происходит автоматически и уже меняет ключ кэша.
- В граф попадают артефакты сборки вроде `.next/` (исключается только `node_modules`).
- **Неблокируемость (ТЗ рев.2, п.1):** построение графа уступает ход event loop: кооперативные паузы `setImmediate` каждые 8 файлов в циклах чтение+парс tree-sitter (`generic.ts`, `tsjs.ts`, `python.ts`), пауза перед каждым адаптером (sync-обход файлов `listSourceFiles` блокирует ход не дольше одного обхода), а также перед `mergeDeltas` и `enforceBudget`; подпись не-git workspace считается на async fs. Потолки времени: вызов с несуществующим workspace отвечает `WORKSPACE_NOT_FOUND` ≤1 с при workspace до 1000 файлов и ≤3 с сверх, даже если идёт построение; первый прогон построения на workspace в 1000 файлов — ≤120 с (фактически ~5 с, замер в `tests/concurrency.test.mjs`).
- **Building-гарантия (ТЗ v3, п.A):** `arch_status` никогда не ждёт построение: холодный вызов отвечает `state: "building"` ≤3 с (фактически — время инспекции git/подписи файлов), прогон стартует в фоне (fire-and-forget: ошибка прогона не всплывает, она ложится в `lastError` держателя), повторный вызов отдаёт `ready`/`partial` с `cached: true`. Строгие инструменты ждут тот же промис (single-flight) — второй прогон не стартует; `stacks`/`arch_snapshot`/`get_graph` поведение не меняли.
- **Кэш деградаций (ТЗ v3, п.B):** запись пишется при фактическом прогоне в любом исходе, кроме кэш-off (не-git каталог без подписи) — прежнее условие «только все `ok`/`absent`» отменено. Деградация core — `depcruiser` со статусом ≠ `ok`/`absent` (`timeout`/`error`/`not_available`; сбой git — **не** деградация) — кэшируется с `degraded: {reason, ts}` и отдаётся из кэша, пока `(now − ts) ≤ DEGRADED_TTL_MS = 15 мин`; после TTL запись считается промахом и идёт пересбор. Семантика ключа точно такая: транзитная деградация при неизменном ключе живёт до TTL; изменения в ключе (HEAD и mtime из `git status` либо подпись файлов, `toolchainVersion`, `configHashes`, `adapterSignature`) дают другой ключ и обнуляют запись; `ARCH_MCP_ALLOW_EXEC` в ключ не входит — запись при смене флага не вытесняется.
- **Цель кэш-hit ≤2 с (ТЗ v3, п.D):** на git-workspace кэш-хит делает ровно один `inspectGit` на вызов (двойной вызов `server_core`/`get_graph` убран) и только git-спавны (`rev-parse`, `status`, `log` — счётчики `inspectGitStats`/`spawnStats` в `src/adapters/git.ts` и `src/core/exec.ts`, реэкспорт `dist/lib.mjs`); медиана 5 прогонов ≤2 с — замер канарейки `E:\1_Products\arch-mcp` и `E:\1_BITeam\svs-trans\warehouse` в отчёте writer. **Известное ограничение:** для не-git каталога каждый вызов заново обходит `collectWorkspaceSignature` (все файлы, кроме `node_modules`/`.git`) — на больших каталогах без git кэш-hit дорогой; обход не менялся.
- **Single-flight (ТЗ рев.2, п.2):** одновременные одинаковые вызовы на один workspace и один ключ кэша выполняются одним прогоном — второй вызов ждёт тот же результат, адапторы второй раз не запускаются. Наблюдаемость: счётчик прогонов адаптера в `tests/concurrency.test.mjs`; в живом вызове — evidence/provenance конверта (при отдаче из кэша команда несёт суффикс `(cached)`). Держатель прогонов (`RUNS` в `src/tools/get_graph.ts`) несёт `promise`/`done`/`total`/`lastError`: по нему `arch_status` отдаёт `progress.percent` в состоянии `building`, а ключ снимается в `finally` промиса — и fire-and-forget-прогон не оставляет держатель (ТЗ v3, п.A).
- **Legacy-счётчики (R6b):** `graph.modules` и `graph.edge_count` в `arch_status`/`arch_snapshot` считают только `module`-узлы и `imports`-рёбра; новые виды `symbol`/`calls` (пайплайн tree-sitter) в эти числа не входят. `calls`-рёбра соединяют только `symbol`-узлы, модуль-пути в них не входят — `focus`/`reaches`/`impact`/`affected_tests` по JS/TS-графу depcruiser не меняются.

Лицензия: MIT. Сторонние компоненты — в `THIRD_PARTY_NOTICES.md`.
