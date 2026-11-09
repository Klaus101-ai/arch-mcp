<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/gitshow/banner-dark.svg">
  <img src="assets/gitshow/banner-light.svg" alt="arch-mcp: карта архитектуры репозитория с файлами, импортами, таблицами SQL и API-контрактами и зона влияния одной правки" width="100%">
</picture>

# arch-mcp

Карта архитектуры репозитория — файлы, импорты, SQL, API — и что сломает ваша правка.

[English](README.md) | [Русский](README.ru.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)

![Вывод arch-mcp status в терминале: адаптеры, размер графа, бюджет ответа](assets/gitshow/demo.png)

`arch-mcp` — MCP-сервер поверх stdio. Он собирает workspace в граф из файлов, модулей, символов, таблиц базы, API-контрактов, контейнерных и CI-файлов, а затем отвечает на вопросы по этому графу: что зависит от файла, какие тесты заденет правка, чем отличаются два снимка.

## Возможности

**Показывает, что сломает правка.** `impact` возвращает транзитивных зависимых изменённых файлов, `affected_tests` сужает список до тестовых файлов (`src/index.ts:90-119`).

**Один граф на все стеки.** 22 адаптера читают JavaScript/TypeScript, Python, ещё девять языков через wasm-грамматики, SQL, API-контракты, манифесты, Dockerfile, Kubernetes, CI YAML, Markdown и SCIP-индексы (`src/core/adapters/registry.ts:67-89`).

**Ответ сам сообщает о своём покрытии.** Каждый конверт несёт `index.coverage` и `index.kinds`, поэтому пропущенное ребро не спутать с незапущенным адаптером (`src/core/envelope.ts:59`, `src/core/envelope.ts:162-173`).

**Репозиторий остаётся нетронутым.** Сервер только читает: кэш лежит в `%LOCALAPPDATA%\arch-mcp\cache\<sha1(repo)>`, обратной записи нет (`src/cache.ts:8-11`).

**Ответ укладывается в заданный бюджет.** `max_bytes` по умолчанию 65536, жёсткий потолок 1048576; обрезанный ответ всегда несёт `truncated: true` и `hint` (`src/config.ts:35-40`).

## Что он видит

Каждый узел адресуется как `kind:path#symbol` в repo-relative POSIX-форме (`src/core/adapters/types.ts:2`).

### Узлы (11)

| Вид | Что это |
| --- | --- |
| `file` | Исходный файл или манифест на диске |
| `module` | Импортируемый модуль, по одному на исходный файл в конвейере tree-sitter |
| `package` | Зависимость: запись манифеста, образ контейнера или CI-экшен |
| `symbol` | Объявление функции, класса или типа, найденное tree-sitter или SCIP |
| `table` | Таблица SQL |
| `view` | Представление SQL |
| `api` | Одна API-операция из контракта OpenAPI, Swagger, proto, GraphQL или AsyncAPI |
| `config` | Объект конфигурации: CI-файл, конфиг Kubernetes, на который ссылается `envFrom` |
| `doc` | Документ Markdown |
| `service` | Разворачиваемая единица: API-сервис, нагрузка Kubernetes, ресурс Terraform |
| `container` | Dockerfile или собранный им образ |

Источник: `src/core/adapters/types.ts:5-16`.

### Связи (10)

| Связь | Человеческими словами | Эмитится сейчас |
| --- | --- | --- |
| `imports` | Файл A использует файл B | да (`src/core/adapters/registry.ts:102-114`) |
| `calls` | Функция A вызывает функцию B | да (`src/core/adapters/registry.ts:115`) |
| `reads` | SQL: таблица или представление читается; при включённом sqlglot ребро несёт ещё и колонки | да (`src/core/adapters/registry.ts:118`) |
| `writes` | SQL: таблица или представление пишется, с колонками при sqlglot | да (`src/core/adapters/registry.ts:119`) |
| `references` | API-операция, инфраструктурный файл, документ или зависимость пакета ссылается на объект | да (`src/core/adapters/registry.ts:120`) |
| `deploys` | Нагрузка Kubernetes разворачивает образ | да (`src/core/adapters/registry.ts:122`) |
| `extends` | Наследование класса или интерфейса | нет |
| `implements` | Реализация интерфейса | нет |
| `configures` | Настройка другого объекта | нет |
| `tests` | Тест покрывает цель | нет |

Последние четыре связи объявлены в системе типов, но пока их не эмитит ни один адаптер. Блок `index.kinds` честно показывает их как `not_emitted` с пустым списком эмиттеров (`src/core/adapters/registry.ts:116-117`, `src/core/adapters/registry.ts:121`, `src/core/adapters/registry.ts:123`).

## Покрытие, которому можно верить

Сервер не заявляет полноту картины, которую не может подтвердить.

- Каждый конверт несёт `index.coverage` с `files_seen`, `parsed` и `unsupported`, а также `index.kinds` со статусом каждого вида связей (`src/core/envelope.ts:59`, `src/core/envelope.ts:171-173`).
- Пустой граф отдаётся как `index.state = "partial"`, а не как ошибка (`src/core/envelope.ts:162-171`).
- Файлы, которые парсер не осилил, перечисляются по именам в `coverage.unsupported`, а упавший адаптер переводит свой вид связей в `unsupported` вместо `no_matches` (`src/core/envelope.ts:130-154`).
- Вид без эмиттеров вовсе показывается как `not_emitted` (`src/core/envelope.ts:130-132`).

Поддержанные слои: JavaScript/TypeScript, Python, девять языков через wasm-грамматики tree-sitter (C, C++, C#, Go, Java, Kotlin, PHP, Ruby, Rust), SQL (DML и PostgreSQL DDL), API-контракты (OpenAPI, Swagger, proto, GraphQL, AsyncAPI), Dockerfile, Kubernetes, CI YAML, Terraform под флагом, Markdown и SCIP-индексы.

Инварианты покрыты тестами `tests/envelope.test.mjs` и `tests/kinds.test.mjs`; всего в `tests/` 35 файлов и 241 тест.

## Быстрый старт

```powershell
npm install
npm run build
npm run bootstrap
npm test
```

`npm install` ставит runtime- и dev-зависимости. `npm run build` пишет `dist/server.mjs`, `dist/cli.mjs` и `dist/lib.mjs` через esbuild. `npm run bootstrap` ставит закреплённый toolchain (dependency-cruiser 18.7.0) в `./toolchain` и идемпотентен. `npm test` прогоняет набор тестов node (`package.json:14`, `package.json:16`, `package.json:17`).

## Подключение MCP-клиента

Сервер говорит по stdio через `dist/server.mjs`. Запись в конфиге opencode v2 выглядит так:

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

Путь замените на свой (`src/index.ts:137-141`).

## Инструменты

| Инструмент | Аргументы | Что отдаёт |
| --- | --- | --- |
| `arch_status` | `workspace?`, `max_bytes?` | Стеки, данные git, покрытие индекса, адаптеры |
| `arch_snapshot` | `workspace?`, `scope?`, `max_bytes?` | Граф и `snapshot_id`; `scope` — `summary` или `full` |
| `search` | `workspace?`, `query`, `kind?`, `max_bytes?` | Узлы графа по подстроке без учёта регистра |
| `focus` | `workspace?`, `node`, `limit?`, `max_bytes?`, `include_type_only?` | Входящие и исходящие рёбра одного узла; `limit` по умолчанию 50, максимум 200 |
| `reaches` | `workspace?`, `target`, `max_depth?`, `max_bytes?`, `include_type_only?` | Обратная достижимость: кто зависит от цели; `max_depth` по умолчанию 10 |
| `impact` | `workspace?`, `changed[]`, `depth?`, `max_bytes?`, `include_type_only?` | Транзитивные зависимые изменённых файлов |
| `affected_tests` | `workspace?`, `changed[]`, `max_bytes?`, `include_type_only?` | Тестовые файлы, зависящие от правки; пустой результат несёт `reason` и проверенные входы |
| `arch_diff` | `workspace?`, `from`, `to`, `max_bytes?` | Добавленные и удалённые узлы и рёбра между двумя ref |

Источник: `src/index.ts:14-135`.

## Конверт ответа

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

Ошибки приходят как `{"ok": false, "error": {"code", "message", "hint", "candidates"}}` с одним из кодов `WORKSPACE_NOT_FOUND`, `NODE_NOT_FOUND`, `AMBIGUOUS_NODE`, `INVALID_ARGUMENT`, `ADAPTER_UNAVAILABLE`, `INDEX_BUILDING`, `BUDGET_EXCEEDED`, `SNAPSHOT_NOT_FOUND`, `EXTERNAL_TOOL_FAILED` (`src/core/errors.ts:2-11`, `src/core/errors.ts:27`).

Пустой граф даёт `index.state = "partial"` (`src/core/envelope.ts:162-171`). Ответ сверх бюджета несёт `truncated: true` и подсказку поднять `max_bytes` (`src/tools/get_graph.ts:40-59`).

### index.kinds

`index.kinds` всегда содержит десять записей в порядке `EdgeKind`. У записи есть `kind`, `status`, `edges`, `confidence`, `confidence_min` и `emitters` (`src/core/envelope.ts:30`, `src/core/envelope.ts:100-127`). `status` принимает значения:

- `emitted`: рёбра есть;
- `no_matches`: рёбер нет, и все эмиттеры вида отработали;
- `unsupported`: рёбер нет, и хотя бы один эмиттер упал;
- `not_emitted`: у вида в реестре нет эмиттеров вовсе (`src/core/envelope.ts:130-154`).

Инвариант `sum(kinds.edges) == graph.edges.length` проверяет `tests/kinds.test.mjs`.

Правило десяти записей нарушает только `index.state = "building"`: холодный `arch_status` отвечает сразу с пустыми `kinds`, `adapters` и `missing`, нулевым покрытием и `data.graph = null`, а индекс строится в фоне (`src/core/envelope.ts:182-197`, `src/tools/get_graph.ts:429-443`).

## Поиск workspace

`workspace` необязателен. Каталог `.git` на любом уровне выше рабочего каталога выигрывает и возвращается сразу. Иначе сервер идёт вверх до ближайшего манифеста (`package.json`, `pyproject.toml`, `requirements.txt`, `settings.gradle*`, `build.gradle*`) либо до каталога минимум с тремя исходными файлами. Файлы Markdown, JSON и YAML корнем не делают. Нет корня — `WORKSPACE_NOT_FOUND` (`src/core/workspace.ts:7-12`, `src/core/workspace.ts:105-112`, `src/core/workspace.ts:152-163`).

Контейнер без собственного корня разворачивается в дочерние корни: конверт несёт `roots[]` и `root_used`. `ARCH_MCP_ALLOWED_ROOTS` превращает поиск в allowlist, а путь вне списка отвечает `WORKSPACE_NOT_FOUND` (`src/core/workspace.ts:179-190`, `src/core/workspace.ts:228-244`).

## Адаптеры

Все 22 адаптера встроены и регистрируются при загрузке модуля, поэтому `index.adapters` отражает реестр во время работы (`src/core/adapters/registry.ts:60-89`). Адаптер без подходящих файлов отдаёт `absent` и не попадает в `index.adapters` и `missing[]` (`src/core/envelope.ts:115-117`). Битая грамматика или несовпадение ABI уходят в `missing[]` со `state: partial`, а ядро продолжает отвечать (`src/core/envelope.ts:150-173`).

| Адаптер | Форматы | Precision | Что даёт |
| --- | --- | --- | --- |
| `scip` | SCIP `index.scip` | semantic | Узлы `symbol` и рёбра `references` по готовому индексу; путь из `ARCH_MCP_SCIP_DIR` либо `<root>/.arch/scip/index.scip` |
| `git` | git-репозиторий | manifest | Метаданные HEAD и status; рёбер не даёт |
| `depcruiser` | JavaScript/TypeScript | syntax | Рёбра импортов, включая type-only |
| `api` | OpenAPI/Swagger, AsyncAPI, GraphQL SDL, `.proto` | syntax | Узлы `service` для контрактов и рёбра `references` |
| `ci` | CI YAML | syntax | Узлы `config:<file>`, рёбра `uses:` к `package:<action>` |
| `dockerfile` | Dockerfile | syntax | Узлы `container:<file>` и `package:<image>` |
| `docs` | Markdown | syntax | Узлы `doc`, заголовки в `meta.headings`, локальные ссылки как `references` |
| `k8s` | Kubernetes YAML | syntax | `service:<Kind>/<name>`, `deploys` к образу, `envFrom` к `config` |
| `manifests` | Манифесты TOML/JSON | manifest | Узлы `file` и `package` со ссылками на зависимости |
| `sql` | SQL DML, PostgreSQL DDL | syntax | Узлы `table` и `view`, рёбра `reads`, `writes`, `references` |
| `terraform` | Terraform HCL | syntax | `service:<type>.<name>` и `references` по интерполяции; работает только с `ARCH_MCP_TERRAFORM=1` |
| `tree-sitter-c` | C | syntax | `module` и `imports` плюс приблизительные узлы `symbol` |
| `tree-sitter-cpp` | C++ | syntax | то же |
| `tree-sitter-csharp` | C# | syntax | то же |
| `tree-sitter-go` | Go | syntax | то же |
| `tree-sitter-java` | Java | syntax | то же |
| `tree-sitter-kotlin` | Kotlin | syntax | то же |
| `tree-sitter-php` | PHP | syntax | то же |
| `tree-sitter-python` | Python | syntax | Узлы `module`, `imports`, приблизительные `symbol` и `calls` |
| `tree-sitter-ruby` | Ruby | syntax | то же, что у универсальных языков |
| `tree-sitter-rust` | Rust | syntax | то же |
| `tree-sitter-tsjs` | JavaScript/TypeScript | syntax | Только узлы `symbol` и рёбра `calls`; `imports` принадлежат depcruiser |

Лицензии сторонних компонентов перечислены в `THIRD_PARTY_NOTICES.md`; провенанс грамматик — в `grammars/LICENSE`, хэши бинарей — в `grammars/SHA256SUMS`.

### Type-only зависимости

Рёбра, у которых `dependencyTypes` содержит `type-only`, получают `meta.type_only = true`. `focus`, `reaches`, `impact` и `affected_tests` не учитывают их без `include_type_only: true`. Для сбора нужен depcruiser с `options.parser = tsc`, иначе `import type` в граф не попадает вовсе (`src/adapters/depcruiser.ts:77-83`).

## Снимки и arch_diff

`arch_snapshot` считает `snapshot_id = SHA256(JSON графа + git HEAD + версии адаптеров)` и хранит снимок в кэше. `arch_diff` сравнивает два ref: `current`, git HEAD (hex-строка длиной 7–39 символов; неоднозначный префикс даёт `AMBIGUOUS_NODE` с кандидатами) либо `snapshot_id`. Нет снимка — `SNAPSHOT_NOT_FOUND`, битый ref — `INVALID_ARGUMENT`; произвольные git-ревизии вроде `HEAD~1` отложены до v1.1 (`src/core/snapshots.ts:11-12`, `src/core/snapshots.ts:136-139`, `src/core/snapshots.ts:171-175`).

## CLI

```text
node dist/cli.mjs <status|snapshot|search|focus|reaches|impact|affected-tests|diff> [--workspace <path>] [--json]
node dist/cli.mjs bootstrap
```

Опции: `--json`, `--scope`, `--query`, `--kind`, `--node`, `--target`, `--changed`, `--limit`, `--max-depth`, `--depth`, `--max-bytes`, `--include-type-only`, `--from`, `--to`. Коды выхода: 0 при успехе, 1 при ошибке контракта, 2 при ошибке использования (`src/cli.ts:8-26`, `src/cli.ts:155-187`). Без `ARCH_MCP_MAX_RESPONSE_BYTES` бюджет 65536, и `status` печатает строку `budget: 65536` (`src/cli.ts:135`).

## Настройка

| Переменная | По умолчанию | Смысл |
| --- | --- | --- |
| `ARCH_MCP_STACKS` | `all` | Фильтр стеков: `py`, `jvm`, `js` или `all` |
| `ARCH_MCP_TIMEOUT_MS` | `120000` | Таймаут любого внешнего процесса |
| `ARCH_MCP_MAX_RESPONSE_BYTES` | `65536` | Бюджет ответа, потолок `1048576`, выше — `BUDGET_EXCEEDED` |
| `ARCH_MCP_ALLOWED_ROOTS` | не задана | Allowlist workspace через `path.delimiter`; не задана — ограничений нет |
| `ARCH_MCP_CACHE_DIR` | `%LOCALAPPDATA%\arch-mcp\cache` | Override корня кэша графов и снимков |
| `ARCH_MCP_ALLOW_EXEC` | выкл | `1` разрешает опциональные внешние инструменты |
| `ARCH_MCP_AUTO_INSTALL` | выкл | Ставит toolchain автоматически, если его нет |
| `ARCH_MCP_GRAMMAR_DIR` | `<пакет>/grammars` | Override каталога wasm-грамматик |
| `ARCH_MCP_SCIP_DIR` | не задана | Каталог или файл `index.scip` для адаптера `scip` |
| `ARCH_MCP_SCIP_INDEXER` | не задана | Шаблон команды индексера с токенами `{root}` и `{out}`; нужен `ARCH_MCP_ALLOW_EXEC=1` |
| `ARCH_MCP_TERRAFORM` | выкл | `1` включает ленивый импорт `@cdktf/hcl2json` (MPL-2.0) |
| `ARCH_MCP_SQLGLOT` | выкл | `1` добавляет мост sqlglot: CTAS, materialized views, ALTER-FK и lineage колонок |
| `ARCH_MCP_PYTHON` | `python` | Интерпретатор для моста sqlglot |
| `ARCH_MCP_SQLGLOT_BRIDGE` | `<пакет>/python/sqlglot_bridge.py` | Override пути моста; содержимое файла входит в ключ кэша |

Большинство переменных читает `src/config.ts:42-70`; allowlist корней — `src/core/workspace.ts:179`.

## Чего нет в v1

- **Запуска вашего кода.** Ни тестов, ни сборок, ни скриптов репозитория: внешние процессы идут через один запускатель, доверенное ядро — это git read-only и depcruise (`src/core/exec.ts:5-12`).
- **Генерации SCIP-индекса по умолчанию.** Адаптер читает готовый индекс; внешний индексер запускается только с `ARCH_MCP_SCIP_INDEXER` и `ARCH_MCP_ALLOW_EXEC=1` (`src/config.ts:67-70`).
- **Записи в репозиторий.** Инструменты только читают workspace, кэш и снимки лежат вне его (`src/cache.ts:8-11`).
- **Диффа произвольных git-ревизий.** `arch_diff` покрывает `current`, `HEAD` и `snapshot_id` (`src/core/snapshots.ts:171-175`).
- **Управления Terraform CLI.** Адаптер разбирает HCL через `@cdktf/hcl2json`; вызовов `plan`, `validate` и `apply` нет (`src/adapters/infra/terraform.ts:2-3`, `src/adapters/infra/terraform.ts:78`).

## Заметки и ограничения

- **Ключ кэша.** Git HEAD, mtime изменённых файлов, версия toolchain, хэши конфигов, подпись адаптеров, `GRAPH_SCHEMA_VERSION` и версия пакета (`src/cache.ts:112-131`). Для не-git workspace ключ — sha256 по всем файлам, кроме `node_modules` и `.git`, поэтому правка без изменения mtime и размера кэш не инвалидирует (`src/cache.ts:185-196`).
- **Артефакты сборки попадают в граф.** Из подписи исключены только `node_modules` и `.git`, так что `.next/` и подобные каталоги индексируются (`src/cache.ts:185-190`).
- **Версии схемы.** `SCHEMA_VERSION = 6` меняется вместе с формой ответа, `GRAPH_SCHEMA_VERSION = "graph-9"` — только с формой графа или записи кэша (`src/core/envelope.ts:15-19`, `src/cache.ts:31`).
- **Single-flight.** Одинаковые одновременные вызовы делят один прогон (`src/tools/get_graph.ts:308-423`); попадание в кэш помечает команду в evidence суффиксом `(cached)` и ставит `provenance.cached` (`src/tools/get_graph.ts:361`, `src/provenance.ts:31`).
- **Неблокирующая сборка.** Конвейер tree-sitter уступает событийному циклу каждые восемь файлов, поэтому холодный `arch_status` отвечает за секунды, а граф строится в фоне (`src/core/adapters/tree-sitter/generic.ts:165`, `src/tools/get_graph.ts:442-443`).

## Лицензия

MIT (`LICENSE:1-3`). Сторонние компоненты и их лицензии перечислены в `THIRD_PARTY_NOTICES.md`.
