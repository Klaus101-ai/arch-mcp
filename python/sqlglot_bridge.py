#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""arch-mcp — sqlglot-мост (ТЗ arch-mcp-sqlglot-20261105).

Разбирает PostgreSQL SQL пакетом sqlglot (MIT) и печатает один JSON:
узлы table/view (CTAS, matview, заглушки неизвестных концов) и рёбра
reads/writes/references. Сеть не используется; битый SQL попадает в
errors соответствующего файла, адаптер при этом не падает.

Вызов:  python sqlglot_bridge.py <request.json> <workspace-root>
Запрос: {"bridge": 1, "dialect": "postgres", "files": [{"path": "<repo-relative>"}]}
Ответ:  {"ok": bool, "version": str, "version_mismatch": bool,
         "files": [{"path", "nodes", "edges", "errors"}], "errors": []}

Лицензия обёртки: MIT (как у sqlglot).
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

import sqlglot
from sqlglot import exp

DEFAULT_SCHEMA = "public"
EXPECTED_VERSION = "30.29.0"
MAX_DEPTH = 8


def _ident_name(node: Any) -> str:
    if isinstance(node, exp.Identifier):
        return node.name
    if isinstance(node, exp.TableAlias):
        th = node.args.get("this")
        return th.name if isinstance(th, exp.Identifier) else ""
    return ""


def table_parts(t: exp.Table) -> tuple[str | None, str]:
    this = t.args.get("this")
    db = t.args.get("db")
    name = this.name if isinstance(this, exp.Identifier) else str(this)
    schema = db.name if isinstance(db, exp.Identifier) else None
    return schema, name


def table_id(t: exp.Table) -> str:
    schema, name = table_parts(t)
    return f"{schema or DEFAULT_SCHEMA}.{name}"


def alias_of(node: exp.Expression) -> str:
    return _ident_name(node.args.get("alias"))


def cte_name(cte: exp.CTE) -> str:
    return alias_of(cte)


def collect_ctes(node: exp.Expression) -> tuple[set[str], dict[str, exp.Select]]:
    """Имена всех CTE узла + тело первого SELECT на каждое имя (вложенные — тоже)."""
    names: set[str] = set()
    bodies: dict[str, exp.Select] = {}
    for cte in node.find_all(exp.CTE):
        name = cte_name(cte)
        if not name:
            continue
        key = name.lower()
        names.add(key)
        if key in bodies:
            continue
        # Тело CTE в sqlglot лежит в args["this"] (Select), не в expression.
        body = cte.args.get("this")
        if not isinstance(body, exp.Select):
            body = cte.expression
        if isinstance(body, exp.Select):
            bodies[key] = body
    return names, bodies


def source_tables(node: exp.Expression, ctes: set[str]) -> list[exp.Table]:
    """Цели FROM/JOIN на любом уровне вложенности; CTE-имена — не источники."""
    out: list[exp.Table] = []
    seen: set[str] = set()
    for t in node.find_all(exp.Table):
        schema, name = table_parts(t)
        if schema is None and name.lower() in ctes:
            continue
        qid = f"{schema or DEFAULT_SCHEMA}.{name}"
        if qid in seen:
            continue
        seen.add(qid)
        out.append(t)
    return out


def scope_of(sel: exp.Select, ctes: set[str]) -> dict[str, Any]:
    """Скоуп SELECT: таблицы по ключу (алиас|имя), CTE-цели, число подзапросов."""
    items: list[exp.Expression] = []
    fr = sel.args.get("from_")
    if fr is not None and fr.this is not None:
        items.append(fr.this)
    for j in sel.args.get("joins") or []:
        if getattr(j, "this", None) is not None:
            items.append(j.this)
    tables: list[tuple[str, str]] = []
    cte_keys: list[str] = []
    subs = 0
    for it in items:
        if isinstance(it, exp.Table):
            schema, name = table_parts(it)
            if schema is None and name.lower() in ctes:
                cte_keys.append(name.lower())
            else:
                tables.append(((alias_of(it) or name).lower(), f"{schema or DEFAULT_SCHEMA}.{name}"))
        elif isinstance(it, exp.Subquery):
            subs += 1
    return {"tables": tables, "ctes": cte_keys, "subs": subs}


def projection_map(sel: exp.Select) -> dict[str, exp.Expression]:
    out: dict[str, exp.Expression] = {}
    for p in sel.expressions:
        if isinstance(p, exp.Alias):
            nm = _ident_name(p.args.get("alias"))
            if nm:
                out[nm.lower()] = p.this
        elif isinstance(p, exp.Column):
            out[p.name.lower()] = p
    return out


def resolve_cte(name: str, cname: str, ctes: set[str], bodies: dict[str, exp.Select], depth: int) -> list[tuple[str, str]]:
    body = bodies.get(name)
    if body is None or depth > MAX_DEPTH:
        return []
    expr = projection_map(body).get(cname.lower())
    if expr is None:
        return []
    if isinstance(expr, exp.Column):
        return resolve_column(expr, body, ctes, bodies, depth + 1)
    cols = list(expr.find_all(exp.Column))
    if len(cols) != 1:
        return []
    return resolve_column(cols[0], body, ctes, bodies, depth + 1)


def resolve_column(
    col: exp.Column,
    sel: exp.Select,
    ctes: set[str],
    bodies: dict[str, exp.Select],
    depth: int = 0,
) -> list[tuple[str, str]]:
    """Колонка → [(квалифицированная таблица-источник, колонка)]; [] — не разрешается."""
    if depth > MAX_DEPTH:
        return []
    q = ""
    ta = col.args.get("table")
    if isinstance(ta, exp.Identifier):
        q = ta.name
    elif isinstance(ta, str):
        q = ta
    cname = col.name
    scope = scope_of(sel, ctes)
    if q:
        ql = q.lower()
        for key, qid in scope["tables"]:
            if key == ql:
                return [(qid, cname)]
        if ql in scope["ctes"]:
            return resolve_cte(ql, cname, ctes, bodies, depth + 1)
        return []
    total = len(scope["tables"]) + len(scope["ctes"]) + scope["subs"]
    if total == 1:
        if scope["tables"]:
            return [(scope["tables"][0][1], cname)]
        if scope["ctes"]:
            return resolve_cte(scope["ctes"][0], cname, ctes, bodies, depth + 1)
        return []
    if len(scope["tables"]) == 1 and not scope["ctes"] and scope["subs"] == 0:
        return [(scope["tables"][0][1], cname)]
    return []


def lineage_pairs(sel: exp.Select, ctes: set[str], bodies: dict[str, exp.Select], target_qid: str) -> list[dict[str, str]]:
    """Пары lineage выходных колонок: {"from": "<schema>.<таблица>.<колонка>", "to": "<цель>.<колонка>"}."""
    pairs: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for p in sel.expressions:
        if isinstance(p, exp.Alias):
            out_name = _ident_name(p.args.get("alias"))
            expr: exp.Expression = p.this
        elif isinstance(p, exp.Column):
            out_name = p.name
            expr = p
        else:
            continue
        if not out_name:
            continue
        cols = [expr] if isinstance(expr, exp.Column) else list(expr.find_all(exp.Column))
        for c in cols:
            for src_qid, src_col in resolve_column(c, sel, ctes, bodies, 0):
                key = (f"{src_qid}.{src_col}", f"{target_qid}.{out_name}")
                if key in seen:
                    continue
                seen.add(key)
                pairs.append({"from": key[0], "to": key[1]})
    return pairs


def output_columns(sel: exp.Select) -> list[str]:
    names: list[str] = []
    for p in sel.expressions:
        if isinstance(p, exp.Alias):
            nm = _ident_name(p.args.get("alias"))
        elif isinstance(p, exp.Column):
            nm = p.name
        else:
            continue
        if nm:
            names.append(nm)
    return names


def ref_target(ref: exp.Reference) -> str | None:
    inner = ref.this
    if isinstance(inner, exp.Schema):
        inner = inner.this
    if isinstance(inner, exp.Table):
        return "table:" + table_id(inner)
    return None


def schema_fk_targets(schema: exp.Schema) -> list[str]:
    """FK-цели внутри CREATE TABLE: колоночные REFERENCES и табличные FOREIGN KEY."""
    out: list[str] = []
    for d in schema.expressions:
        if isinstance(d, exp.ColumnDef):
            for c in d.args.get("constraints") or []:
                if isinstance(c, exp.ColumnConstraint) and isinstance(c.args.get("kind"), exp.Reference):
                    tid = ref_target(c.args["kind"])
                    if tid:
                        out.append(tid)
        elif isinstance(d, exp.Constraint):
            for sub in d.expressions or []:
                if isinstance(sub, exp.ForeignKey):
                    ref = sub.args.get("reference")
                    if isinstance(ref, exp.Reference):
                        tid = ref_target(ref)
                        if tid:
                            out.append(tid)
    return out


def alter_fk_edges(stmt: exp.Alter) -> list[tuple[str, str, dict[str, Any]]]:
    """ALTER ... ADD CONSTRAINT ... FOREIGN KEY → рёбра references c via=alter."""
    child = stmt.this
    if not isinstance(child, exp.Table):
        return []
    child_id = "table:" + table_id(child)
    out: list[tuple[str, str, dict[str, Any]]] = []
    for act in stmt.args.get("actions") or []:
        if not isinstance(act, exp.AddConstraint):
            continue
        for item in act.expressions or []:
            if not isinstance(item, exp.Constraint):
                continue
            for sub in item.expressions or []:
                if isinstance(sub, exp.ForeignKey):
                    ref = sub.args.get("reference")
                    if isinstance(ref, exp.Reference):
                        tid = ref_target(ref)
                        if tid:
                            out.append((child_id, tid, {"fk": True, "via": "alter"}))
    return out


def analyze(rel: str, text: str) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    errors: list[str] = []
    declared: set[str] = set()
    stubbed: set[str] = set()

    def add_node(nid: str, kind: str, meta: dict[str, Any] | None = None) -> None:
        if nid in declared:
            return
        declared.add(nid)
        node: dict[str, Any] = {"id": nid, "kind": kind}
        if meta:
            node["meta"] = dict(meta)
        nodes.append(node)

    def add_edge(src: str, tgt: str, kind: str, meta: dict[str, Any] | None = None) -> None:
        edge: dict[str, Any] = {"source": src, "target": tgt, "kind": kind}
        if meta:
            edge["meta"] = dict(meta)
        edges.append(edge)

    def stub(nid: str) -> None:
        if nid in declared or nid in stubbed:
            return
        stubbed.add(nid)
        nodes.append({"id": nid, "kind": "table", "meta": {"stub": True}})

    def emit_reads(src_id: str, sel: exp.Select, ctes: set[str], bodies: dict[str, exp.Select], target_qid: str) -> None:
        pairs = lineage_pairs(sel, ctes, bodies, target_qid)
        for t in source_tables(sel, ctes):
            sqid = table_id(t)
            mine = [p for p in pairs if p["from"].startswith(sqid + ".")]
            add_edge(src_id, "table:" + sqid, "reads", {"columns": mine} if mine else None)

    def handle_create(stmt: exp.Create) -> None:
        kind = str(stmt.args.get("kind") or "").upper()
        if kind == "TABLE" and isinstance(stmt.this, exp.Schema):
            schema = stmt.this
            target = schema.this
            if not isinstance(target, exp.Table):
                return
            sch, _ = table_parts(target)
            cols = [
                name
                for d in schema.expressions
                if isinstance(d, exp.ColumnDef)
                for name in [_ident_name(d.args.get("this"))]
                if name
            ]
            nid = "table:" + table_id(target)
            add_node(nid, "table", {"schema": sch or DEFAULT_SCHEMA, "columns": cols})
            for parent in schema_fk_targets(schema):
                add_edge(nid, parent, "references", {"fk": True})
            return
        if kind == "TABLE" and isinstance(stmt.this, exp.Table) and isinstance(stmt.expression, exp.Select):
            # CTAS: CREATE TABLE <имя> AS <SELECT>
            target = stmt.this
            sel = stmt.expression
            qid = table_id(target)
            nid = "table:" + qid
            ctes, bodies = collect_ctes(sel)
            sch, _ = table_parts(target)
            meta: dict[str, Any] = {"ctas": True, "schema": sch or DEFAULT_SCHEMA}
            cols = output_columns(sel)
            if cols:
                meta["columns"] = cols
            add_node(nid, "table", meta)
            add_edge(rel, nid, "writes")
            emit_reads(nid, sel, ctes, bodies, qid)
            return
        if kind == "VIEW" and isinstance(stmt.this, exp.Table) and isinstance(stmt.expression, exp.Select):
            target = stmt.this
            sel = stmt.expression
            qid = table_id(target)
            nid = "view:" + qid
            ctes, bodies = collect_ctes(sel)
            sch, _ = table_parts(target)
            meta = {"schema": sch or DEFAULT_SCHEMA}
            props = stmt.args.get("properties")
            if props is not None and any(isinstance(p, exp.MaterializedProperty) for p in props.expressions or []):
                meta["materialized"] = True
            add_node(nid, "view", meta)
            emit_reads(nid, sel, ctes, bodies, qid)

    def handle_insert(stmt: exp.Insert) -> None:
        target = stmt.this
        # INSERT INTO t (a,b) SELECT … — цель при колоночном списке exp.Schema,
        # таблица лежит в target.this (ТЗ arch-mcp-sqlglot-20261105, дельта рев.8).
        if isinstance(target, exp.Schema):
            target = target.this
        if isinstance(target, exp.Table):
            # необъявленная таблица — узел-заглушка появится в общем проходе stub()
            add_edge(rel, "table:" + table_id(target), "writes")
        ctes, bodies = collect_ctes(stmt)
        trees: list[exp.Expression] = []
        if stmt.expression is not None:
            trees.append(stmt.expression)
        with_ = stmt.args.get("with_")
        if with_ is not None:
            trees.append(with_)
        seen: set[str] = set()
        src_ids: list[str] = []
        for tree in trees:
            for t in source_tables(tree, ctes):
                sqid = table_id(t)
                if sqid in seen:
                    continue
                seen.add(sqid)
                src_ids.append(sqid)
        for sqid in src_ids:
            # INSERT — файл-источник без колонок lineage (ТЗ)
            add_edge(rel, "table:" + sqid, "reads")

    def handle(stmt: exp.Expression) -> None:
        if isinstance(stmt, exp.Create):
            handle_create(stmt)
        elif isinstance(stmt, exp.Insert):
            handle_insert(stmt)
        elif isinstance(stmt, exp.Alter):
            for child_id, parent_id, meta in alter_fk_edges(stmt):
                add_edge(child_id, parent_id, "references", meta)
        elif isinstance(stmt, (exp.Update, exp.Delete)):
            t = stmt.this
            if isinstance(t, exp.Table):
                add_edge(rel, "table:" + table_id(t), "writes")

    try:
        statements = sqlglot.parse(text, read="postgres")
    except Exception as exc:  # битый SQL → errors файла, узлов/рёбер нет
        return {"path": rel, "nodes": [], "edges": [], "errors": [str(exc)[:500]]}

    for stmt in statements:
        if stmt is None:
            continue
        try:
            handle(stmt)
        except Exception as exc:  # не должны падать, но файл целиком не теряем
            errors.append(str(exc)[:500])

    # Неизвестные концы рёбер — узлы-заглушки (реальные узлы не перетираются).
    for e in list(edges):
        for end in (e["source"], e["target"]):
            if end.startswith("table:") or end.startswith("view:"):
                stub(end)

    return {"path": rel, "nodes": nodes, "edges": edges, "errors": errors}


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        sys.stdout.write(json.dumps({"ok": False, "errors": ["usage: sqlglot_bridge.py <request.json> <root>"]}))
        return 1
    req_path, root = argv[1], argv[2]
    try:
        with open(req_path, encoding="utf8") as fh:
            req = json.load(fh)
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "errors": [f"request read failed: {exc}"]}))
        return 1
    entries = req.get("files") or []
    out_files: list[dict[str, Any]] = []
    for entry in entries:
        rel = str(entry.get("path", "")) if isinstance(entry, dict) else str(entry)
        if not rel:
            out_files.append({"path": "", "nodes": [], "edges": [], "errors": ["empty path"]})
            continue
        full = os.path.join(root, rel.replace("/", os.sep))
        try:
            with open(full, encoding="utf8", errors="replace") as fh:
                text = fh.read()
        except Exception as exc:
            out_files.append({"path": rel, "nodes": [], "edges": [], "errors": [str(exc)[:500]]})
            continue
        out_files.append(analyze(rel, text))
    version = str(getattr(sqlglot, "__version__", "") or "")
    payload = {
        "ok": True,
        "version": version,
        "version_mismatch": version != EXPECTED_VERSION,
        "files": out_files,
        "errors": [],
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
