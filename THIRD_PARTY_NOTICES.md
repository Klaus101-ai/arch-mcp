# Third-Party Notices — arch-mcp

В этот пакет входят следующие сторонние компоненты.

## @cdktf/hcl2json 0.21.0 (T4b)

- Лицензия: **MPL-2.0** (поле `license` в `package.json`, SPDX-пометки `// SPDX-License-Identifier: MPL-2.0` в `lib/*.js`, 2026-11-04)
- Copyright (c) HashiCorp, Inc. (заголовок исходников `lib/bridge.js`/`index.js`)
- Использование: разбор Terraform HCL в адаптере `terraform`; **ленивый dynamic import только при `ARCH_MCP_TERRAFORM=1`**, объявлен external в `esbuild.mjs` — MPL-код **не входит** в основной бандл `dist/*.mjs`, поставляется как declared dependency из `node_modules`. CLI Terraform не вызывается (BUSL).
- Источник: `node_modules/@cdktf/hcl2json/package.json` после `npm install`; текст лицензии MPL-2.0: <https://mozilla.org/MPL/2.0/>.

```text
Mozilla Public License Version 2.0
----------------------------------

1. Definitions
--------------

The Mozilla Public License Version 2.0 (the "License") governs your use of the
Covered Software.

"This License" refers to this document.

"Licensed Material" means the Covered Software or any portion thereof.

Full text: <https://mozilla.org/MPL/2.0/> (в пакете @cdktf/hcl2json файл
LICENSE не поставляется — источник: SPDX-пометки в исходниках).
```

## @modelcontextprotocol/sdk 1.32.2

- Лицензия: MIT
- Copyright (c) 2024 Anthropic, PBC
- Использование: MCP-протокол и stdio-транспорт; **бандлится** в `dist/server.mjs` (esbuild), в `node_modules` пакета не поставляется (devDependency).
- Источник: `node_modules/@modelcontextprotocol/sdk/LICENSE` после `npm install`.

```text
MIT License

Copyright (c) 2024 Anthropic, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## dependency-cruiser 18.7.0

- Лицензия: MIT (проверено в `toolchain/node_modules/dependency-cruiser/LICENSE` и `package.json` поле `license: MIT`, 2026-11-01)
- Copyright (c) 2016-2026 Sander Verweij
- Использование: анализ графа зависимостей; устанавливается **только в локальный toolchain** пакета командой `npm run bootstrap` (`npm install --prefix toolchain.tmp-<pid> dependency-cruiser@18.7.0`), глобально не ставится, в бандл не входит.
- Источник: `toolchain/node_modules/dependency-cruiser/LICENSE`.

```text
The MIT License (MIT)

Copyright (c) 2016-2026 Sander Verweij

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime-зависимости пакета — полный аудит (T5, 2026-11-04)

Все 15 записей `dependencies` из `package.json`; источник каждой строки —
`package.json` + `node_modules/<name>/package.json` (поля `license` и
`repository` после `npm install`). Поставка: всё, кроме двух external,
**бандлится** esbuild в `dist/*.mjs` (`external: ["node:*",
"@asyncapi/parser", "@cdktf/hcl2json"]`, `esbuild.mjs:15`); два external
поставляются как declared dependencies и резолвятся из `node_modules` в
рантайме. Секции по эпохам (T2b/T3/T4a/T4b) ниже не дублируются — свод
один.

| Пакет | Версия | SPDX | Источник (репозиторий) | Назначение |
| --- | --- | --- | --- | --- |
| `@apidevtools/swagger-parser` | 13.1.0 | MIT | github.com/APIDevTools/swagger-parser | адаптер `api`: разбор Swagger 2.0 / OpenAPI 3.0 (`src/adapters/api/swagger.ts`), бандлится |
| `@asyncapi/parser` | 3.6.6 | Apache-2.0 | github.com/asyncapi/parser-js | адаптер `api`: разбор AsyncAPI (`src/adapters/api/asyncapi.ts`); **external** — UMD-цепочка spectral/jsonc-parser не бандлится в ESM |
| `@bufbuild/protobuf` | 2.16.0 | Apache-2.0 AND BSD-3-Clause | github.com/bufbuild/protobuf-es | SCIP-индекс: `fromBinary(IndexSchema)` в `src/core/adapters/tree-sitter/scip.ts` и `toBinary` в тестах (`tests/scip-indexer.test.mjs`), бандлится; с 2026-11-07 — **прямая** зависимость с pin `2.16.0` (`npm install --save-exact`) |
| `@cdktf/hcl2json` | 0.21.0 | **MPL-2.0** | github.com/hashicorp/terraform-cdk (`packages/@cdktf/hcl2json`) | адаптер `terraform`: разбор HCL; **external**, ленивый dynamic import под `ARCH_MCP_TERRAFORM=1` — полный notice с текстом лицензии в разделе выше |
| `@readme/openapi-parser` | 10.0.0 | MIT | github.com/readmeio/oas (`packages/parser`) | адаптер `api`: валидация OpenAPI 3.x (`src/adapters/api/openapi.ts`), бандлится |
| `@scip-code/scip` | 0.10.0 | Apache-2.0 | github.com/scip-code/scip | адаптер `scip`: чтение `index.scip` (`IndexSchema`, `SymbolRole`), бандлится |
| `@vscode/tree-sitter-wasm` | 0.3.1 | MIT | github.com/Microsoft/vscode-tree-sitter-wasm | поставщик 11 из 13 wasm-грамматик каталога `grammars/` (копирование при подготовке, см. раздел Грамматики); кодом сервера не импортируется |
| `dockerfile-ast` | 0.7.1 | MIT | github.com/rcjsuen/dockerfile-ast | адаптер `infra/dockerfile` (`src/adapters/infra/dockerfile.ts`), бандлится |
| `graphql` | 17.0.2 | MIT | github.com/graphql/graphql-js | адаптер `api`: разбор GraphQL SDL (`src/adapters/api/graphql.ts`), бандлится |
| `node-sql-parser` | 5.4.0 | Apache-2.0 | github.com/taozhi8833998/node-sql-parser | адаптер `sql`: DML-парсер и `tableList` (`src/adapters/sql/index.ts`), бандлится |
| `protobufjs` | 8.8.1 | BSD-3-Clause | github.com/protobufjs/protobuf.js | адаптер `api`: разбор `.proto` без генерации кода (`src/adapters/api/proto.ts`), бандлится |
| `remark` | 15.0.1 | MIT | github.com/remarkjs/remark | адаптер `docs`: разбор Markdown (`src/adapters/docs/index.ts`), бандлится |
| `smol-toml` | 1.9.1 | BSD-3-Clause | github.com/squirrelchat/smol-toml | адаптер `manifests`: чтение TOML-манифестов (`pyproject.toml` и др.), бандлится |
| `web-tree-sitter` | 0.27.1 | MIT | github.com/tree-sitter/tree-sitter (`lib/binding_web`) | рантайм WASM-парсера tree-sitter (`src/core/adapters/tree-sitter/init.ts`), бандлится; ядро tree-sitter — MIT |
| `yaml` | 2.9.1 | ISC | github.com/eemeli/yaml | адаптеры `k8s` и `ci`: разбор YAML (`src/adapters/infra/k8s.ts`, `ci.ts`), бандлится |

Тексты лицензий: `node_modules/<name>/LICENSE` либо `license`-поле
`node_modules/<name>/package.json` (у части пакетов LICENSE в tarball не
входит — тогда источником считается SPDX-пометка в `package.json`).

## devDependencies (T5: полнота сверки)

| Пакет | Версия | SPDX | Назначение |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | MCP-протокол/stdio — **бандлится** в `dist/server.mjs`, раздел выше с текстом лицензии |
| `@repomix/tree-sitter-wasms` | 0.1.17 | Unlicense (пакет); грамматика `tree-sitter-c` — MIT | источник `grammars/tree-sitter-c.wasm` (`out/tree-sitter-c.wasm`), только сборка каталога грамматик |
| `@unit-mesh/treesitter-artifacts` | 1.7.7 | MIT | источник `grammars/tree-sitter-kotlin.wasm` (`wasm/tree-sitter-kotlin.wasm`), только сборка каталога грамматик |
| `esbuild` | 0.25.12 | MIT | сборка `dist/*`, не поставляется с пакетом |
| `typescript` | 5.9.3 | Apache-2.0 | типизация/`tsc --noEmit`, не поставляется |
| `@types/node` | 22.20.5 | MIT | типы Node, не поставляется |
| `dependency-cruiser` | 18.7.0 | MIT | toolchain, отдельный раздел выше |

`@bufbuild/protobuf` 2.16.0 (`Apache-2.0 AND BSD-3-Clause`) — с 2026-11-07
**прямая** зависимость `package.json` с pin `2.16.0` (ранее — транзитивная у
`@scip-code/scip`, `package-lock.json`) — используется в
`src/core/adapters/tree-sitter/scip.ts` и входит в бандл.

## Грамматики tree-sitter (каталог `grammars/`, 13 wasm)

Провенанс каждого файла сверен по SHA256 с пакетом-источником 2026-11-04
(`grammars/SHA256SUMS`): 11 файлов из `@vscode/tree-sitter-wasm@0.3.1`
(MIT, Microsoft; собирает грамматики из официальных репозиториев),
`tree-sitter-c.wasm` — из `@repomix/tree-sitter-wasms@0.1.17`
(Unlicense как пакет, сама грамматика tree-sitter/c — MIT),
`tree-sitter-kotlin.wasm` — из `@unit-mesh/treesitter-artifacts@1.7.7`
(MIT). SPDX всех 13 бинарей — MIT (грамматики); тексты и репозитории —
`grammars/LICENSE`.

| Файл | Источник | SPDX |
| --- | --- | --- |
| `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`, `tree-sitter-javascript.wasm`, `tree-sitter-python.wasm`, `tree-sitter-go.wasm`, `tree-sitter-rust.wasm`, `tree-sitter-java.wasm`, `tree-sitter-csharp.wasm` (в пакете `tree-sitter-c-sharp.wasm`), `tree-sitter-php.wasm`, `tree-sitter-ruby.wasm`, `tree-sitter-cpp.wasm` | `@vscode/tree-sitter-wasm@0.3.1` (`wasm/`) | MIT |
| `tree-sitter-c.wasm` | `@repomix/tree-sitter-wasms@0.1.17` (`out/`) | грамматика MIT, пакет-источник Unlicense |
| `tree-sitter-kotlin.wasm` | `@unit-mesh/treesitter-artifacts@1.7.7` (`wasm/`) | MIT |

`web-tree-sitter@0.27.1` (MIT) и ядро tree-sitter (MIT) остаются в
`node_modules` и в каталог `grammars/` не копируются.

## sqlglot 30.29.0 (режим sqlglot, 2026-11-05)

- Лицензия: **MIT** (поле `License-Expression: MIT` в `sqlglot-30.29.0.dist-info/METADATA`, текст лицензии в `dist-info/licenses/LICENSE`)
- Copyright (c) 2026 Toby Mao (из `dist-info/licenses/LICENSE`)
- Использование: разбор PostgreSQL SQL в python-мосту `python/sqlglot_bridge.py` (ТЗ arch-mcp-sqlglot-20261105); вызывается только под `ARCH_MCP_SQLGLOT=1` + `ARCH_MCP_ALLOW_EXEC=1` командой `python <мост> <запрос> <корень>`, **в бандл `dist/*.mjs` не входит** — ставится в системный Python (`pip install sqlglot==30.29.0`), сеть в рантайме не используется.
- Источник: `pip show sqlglot` / <https://pypi.org/project/sqlglot/>. Сам `python/sqlglot_bridge.py` — собственный код под MIT (как у пакета).

```text
MIT License

Copyright (c) 2026 Toby Mao

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Проверка GPL/AGPL (T5, 2026-11-04)

Рекурсивное сканирование поля `license` всех установленных пакетов
(`node_modules`, 335 package.json): GPL/AGPL/LGPL и небесплатные лицензии
**не найдены**. Единственный copyleft в dependencies — MPL-2.0
(`@cdktf/hcl2json`, раздел и полный notice выше). Термины (BUSL) в
зависимостях нет; CLI Terraform не вызывается.

Прочие пакеты из `devDependencies` (esbuild, typescript, @types/node) и их транзитивные зависимости участвуют только в сборке и не поставляются с пакетом (свод — раздел devDependencies).
