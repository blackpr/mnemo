import { fileURLToPath } from "node:url";
import { loadModule, parseSync } from "libpg-query";
import type pg from "pg";
import { CROSS_BANK_STATEMENTS, SCOPED_TABLES, crossBankTagOf, type CrossBankStatement } from "../../src/platform/postgres/bank-isolation.js";

/**
 * Query guard: checks every SQL statement that application code runs during the test suite against the
 * bank-isolation rule in `src/platform/postgres/bank-isolation.ts`.
 *
 * `installQueryGuard` wraps one pool: `pool.query` and the `query` of every client the pool hands out (so
 * statements inside `withTransaction` are seen too). Each statement is parsed with libpg-query, the real
 * Postgres parser compiled to WASM, and every query block (each SELECT, UPDATE, DELETE, subquery, CTE, RETURNING
 * subquery, and the DO UPDATE of an upsert) is checked: a scoped table in its FROM, USING or target must have one of
 * its scope columns pinned by an equality in a top-level AND of the WHERE or of an inner join's ON, to a parameter
 * or constant, or to a column that is itself pinned (also from an enclosing query, for a correlated subquery). An
 * equality under OR or NOT pins nothing; an outer join's ON pins only its nullable side; a subquery is never a pin
 * value. An upsert's DO UPDATE must pin every scope column, and no UPDATE may assign a scope column. Statement
 * kinds and FROM items the guard does not interpret (TRUNCATE, MERGE, COPY, DROP TABLE, ...) fail on a scoped table;
 * DO blocks and function definitions, whose bodies are opaque strings, fail outright. A statement tagged `crossBank("<name>")` may leave the entry's tables
 * unpinned and is counted as allowlisted.
 *
 * Statements issued directly by test files (fixtures, assertions) are not application code and are not checked;
 * the call site decides. Migrations run before the guard is installed.
 */

type Node = Record<string, unknown>;

export interface GuardViolation {
  readonly sql: string;
  readonly problems: readonly string[];
  readonly callSite: string;
}

export interface GuardLog {
  /** Application statements checked (each execution counts). */
  checked: number;
  readonly distinct: Set<string>;
  /** Statements from test files, not checked. */
  testStatements: number;
  readonly tags: Map<string, number>;
  readonly violations: GuardViolation[];
}

export const guardLog: GuardLog = { checked: 0, distinct: new Set(), testStatements: 0, tags: new Map(), violations: [] };

/** What one statement amounts to: its tag, if any, and the problems found (empty when it is pinned). */
export interface StatementCheck {
  readonly tag: string | undefined;
  readonly problems: readonly string[];
}

let parserReady: Promise<void> | undefined;

/** libpg-query's WASM module must load once before `parseSync`; `installQueryGuard` awaits this. */
export function loadParser(): Promise<void> {
  parserReady ??= loadModule();
  return parserReady;
}

const cache = new Map<string, StatementCheck>();

export function checkStatement(sql: string): StatementCheck {
  const cached = cache.get(sql);
  if (cached) return cached;
  const tag = crossBankTagOf(sql);
  const unpinned = findUnpinned(sql);
  const problems: string[] = [];
  if (tag === undefined) problems.push(...unpinned.map((u) => u.message));
  else if (!Object.hasOwn(CROSS_BANK_STATEMENTS, tag)) problems.push(`tag "${tag}" is not in CROSS_BANK_STATEMENTS`);
  else if (statementCount(sql) > 1) problems.push(`tag "${tag}" is on a string of several statements; tag one statement at a time`);
  else {
    // A tag exempts only the tables its entry names; anything else in the statement is still checked.
    const allowed: readonly string[] = CROSS_BANK_STATEMENTS[tag as CrossBankStatement].tables;
    problems.push(...unpinned.filter((u) => !allowed.includes(u.table)).map((u) => `${u.message} (not among the tables of "${tag}")`));
    if (!unpinned.some((u) => allowed.includes(u.table))) problems.push(`tag "${tag}" marks a statement whose tables are already pinned to one bank; remove the tag and its allowlist entry`);
  }
  const result = { tag, problems };
  cache.set(sql, result);
  return result;
}

interface Unpinned {
  readonly table: string;
  readonly message: string;
}

/** One message per scoped table occurrence that no predicate pins. Exported for the guard's own tests. */
export function unpinnedTables(sql: string): string[] {
  return findUnpinned(sql).map((u) => u.message);
}

function statementCount(sql: string): number {
  try {
    return ((parseSync(sql) as { stmts?: unknown[] }).stmts ?? []).length;
  } catch {
    return 1;
  }
}

function findUnpinned(sql: string): Unpinned[] {
  let parsed: { stmts?: { stmt: Node }[] };
  try {
    parsed = parseSync(sql) as typeof parsed;
  } catch (e) {
    return [{ table: "?", message: `the statement could not be parsed (${e instanceof Error ? e.message : String(e)})` }];
  }
  const problems: Unpinned[] = [];
  for (const { stmt } of parsed.stmts ?? []) visitStatement(stmt, undefined, problems);
  return problems;
}

// ---------------------------------------------------------------------------------------------- AST walk

interface Relation {
  /** Unique per occurrence in the statement. */
  readonly key: string;
  readonly name: string; // schema.table, or the CTE / derived-table alias
  readonly alias: string;
  readonly scopeColumns: readonly string[];
}

interface Scope {
  readonly relations: readonly Relation[];
  readonly parent: Scope | undefined;
  /** Column keys ("<relation key>.<column>") pinned in this scope or an enclosing one. */
  readonly pinned: ReadonlySet<string>;
}

let relationCounter = 0;

/** Statement kinds that may name a scoped table without reading or changing its rows (the admin pin's DDL, session settings). */
const NO_ROWS = new Set(["AlterTableStmt", "IndexStmt", "LockStmt", "CreateStmt", "VariableSetStmt", "VariableShowStmt", "TransactionStmt"]);
/** Code the parser sees only as a string: whatever it does to a scoped table is invisible, so it is refused outright (migrations, which hold the triggers and functions, are not checked). */
const OPAQUE = new Set(["DoStmt", "CreateFunctionStmt"]);

function visitStatement(node: Node, parent: Scope | undefined, problems: Unpinned[]): void {
  const [type, body] = only(node);
  if (type === "SelectStmt") visitSelect(body, parent, problems);
  else if (type === "UpdateStmt" || type === "DeleteStmt") checkBlock(type, body, parent, problems);
  else if (type === "InsertStmt") visitInsert(body, parent, problems);
  else if (type === "ExplainStmt") visitStatement(body.query as Node, parent, problems);
  else if (OPAQUE.has(type)) problems.push({ table: "?", message: `a ${type} runs code the guard cannot see into` });
  else if (type === "DropStmt") {
    // DROP INDEX is the admin pin's; DROP TABLE of a scoped table is not something application code does.
    if (body.removeType !== "OBJECT_TABLE") return;
    for (const o of (body.objects as Node[] | undefined) ?? []) {
      const name = (((o.List as Node | undefined)?.items as Node[] | undefined) ?? []).map((i) => (i as { String?: { sval: string } }).String?.sval).join(".");
      if (name in SCOPED_TABLES) problems.push({ table: name, message: `${name} in a DropStmt is not something the guard can check` });
    }
  } else if (!NO_ROWS.has(type)) {
    // Default deny: TRUNCATE, MERGE, COPY, CREATE TABLE AS, DECLARE CURSOR and anything else the guard does not
    // understand fails on a scoped table, rather than passing unchecked.
    walk(body, (x) => {
      if (typeof x.relname === "string") {
        const r = relationOf(x);
        if (r.scopeColumns.length > 0) problems.push({ table: r.name, message: `${r.name} in a ${type} is not something the guard can check` });
      }
      return true;
    });
  }
}

function visitSelect(body: Node, parent: Scope | undefined, problems: Unpinned[]): void {
  if (body.op && body.op !== "SETOP_NONE") {
    visitWith(body, parent, problems);
    visitStatement({ SelectStmt: body.larg as Node }, parent, problems);
    visitStatement({ SelectStmt: body.rarg as Node }, parent, problems);
    // ORDER BY, LIMIT, OFFSET and FOR UPDATE of the whole set operation may hold subqueries too.
    findSubLinks([body.sortClause, body.limitCount, body.limitOffset, body.lockingClause], (sub) => visitStatement(sub, parent, problems));
    return;
  }
  checkBlock("SelectStmt", body, parent, problems);
}

function visitWith(body: Node, parent: Scope | undefined, problems: Unpinned[]): void {
  const withClause = body.withClause as Node | undefined;
  for (const cte of (withClause?.ctes as Node[] | undefined) ?? []) {
    const c = (cte as { CommonTableExpr: Node }).CommonTableExpr;
    visitStatement(c.ctequery as Node, parent, problems);
  }
}

function visitInsert(body: Node, parent: Scope | undefined, problems: Unpinned[]): void {
  visitWith(body, parent, problems);
  if (body.selectStmt) visitStatement(body.selectStmt as Node, parent, problems);
  const target = relationOf(body.relation as Node);
  // The inserted row's own columns are values the statement supplies.
  let scope: Scope = { relations: [target], parent, pinned: new Set(target.scopeColumns.map((c) => `${target.key}.${c}`)) };
  const conflict = body.onConflictClause as Node | undefined;
  if (conflict?.action === "ONCONFLICT_UPDATE") {
    // DO UPDATE changes the existing row that holds the conflicting key. Its key columns equal the new row's, so they
    // count as pinned; every other scope column must be pinned in DO UPDATE's WHERE (`t.bank_id = EXCLUDED.bank_id`):
    // the row that is overwritten must belong to the same bank, tenant and principal as the row being written.
    const infer = conflict.infer as Node | undefined;
    const inferred = ((infer?.indexElems as Node[] | undefined) ?? []).map((e) => (e as { IndexElem: { name?: string } }).IndexElem.name).filter((n): n is string => !!n);
    scope = checkConditions([target], parent, [{ expr: conflict.whereClause as Node | undefined }], inferred.map((c) => `${target.key}.${c}`), problems, { excludedIsValue: true, requireAll: true });
    refuseScopeAssignments(target, conflict.targetList, problems);
    findSubLinks([conflict.targetList, conflict.whereClause], (sub) => visitStatement(sub, scope, problems));
  }
  findSubLinks(body.returningList, (sub) => visitStatement(sub, scope, problems));
}

/** Moving a row to another bank (or tenant, or principal) is never a bank-scoped write: `SET bank_id = ...` is refused. */
function refuseScopeAssignments(target: Relation, targetList: unknown, problems: Unpinned[]): void {
  for (const t of (targetList as Node[] | undefined) ?? []) {
    const name = ((t as { ResTarget?: { name?: string } }).ResTarget?.name ?? "") as string;
    if (target.scopeColumns.includes(name)) problems.push({ table: target.name, message: `${target.name} has its scope column ${name} assigned; a row never moves to another bank` });
  }
}

interface Condition {
  readonly expr: Node | undefined;
  /**
   * Undefined for WHERE and an inner join's ON, which filter every relation of the block. For an outer join's ON, the
   * nullable side: that ON filters only those rows, so it can pin them but never the preserved side.
   */
  readonly nullable?: readonly Relation[];
}

function checkBlock(type: "SelectStmt" | "UpdateStmt" | "DeleteStmt", body: Node, parent: Scope | undefined, problems: Unpinned[]): void {
  visitWith(body, parent, problems);
  const relations: Relation[] = [];
  const conditions: Condition[] = [];
  const derived: Node[] = [];
  const collect = (item: Node): Relation[] => {
    const [kind, n] = only(item);
    if (kind === "RangeVar") {
      const r = relationOf(item);
      relations.push(r);
      return [r];
    }
    if (kind === "JoinExpr") {
      const left = collect(n.larg as Node);
      const right = collect(n.rarg as Node);
      const joinType = n.jointype as string;
      // USING and NATURAL joins are not interpreted: they pin nothing (qualify the columns in ON instead).
      if (n.quals) {
        const nullable = joinType === "JOIN_INNER" ? undefined : joinType === "JOIN_LEFT" ? right : joinType === "JOIN_RIGHT" ? left : [];
        conditions.push({ expr: n.quals as Node, ...(nullable ? { nullable } : {}) });
      }
      return [...left, ...right];
    }
    if (kind === "RangeTableSample") return collect(n.relation as Node);
    if (kind === "RangeSubselect" || kind === "RangeFunction") {
      if (kind === "RangeSubselect") derived.push(n.subquery as Node);
      const r = { key: `r${relationCounter++}`, name: aliasOf(n), alias: aliasOf(n), scopeColumns: [] };
      relations.push(r);
      return [r];
    }
    // Any other FROM item (XMLTABLE, JSON_TABLE, ...): a scoped table inside it is refused rather than skipped.
    walk(item, (x) => {
      if (typeof x.relname === "string") {
        const r = relationOf(x);
        if (r.scopeColumns.length > 0) problems.push({ table: r.name, message: `${r.name} in a ${kind} is not something the guard can check` });
      }
      return true;
    });
    return [];
  };
  if (type !== "SelectStmt") collect({ RangeVar: body.relation as Node });
  for (const item of ((type === "DeleteStmt" ? body.usingClause : body.fromClause) as Node[] | undefined) ?? []) collect(item);
  conditions.push({ expr: body.whereClause as Node | undefined });
  if (type === "UpdateStmt") refuseScopeAssignments(relations[0]!, body.targetList, problems);

  const scope = checkConditions(relations, parent, conditions, [], problems);
  // Derived tables are evaluated before this block's WHERE (no LATERAL here), so they see the enclosing scope only.
  for (const sub of derived) visitStatement(sub, parent, problems);
  // Subqueries in the select list, WHERE, ON, SET and RETURNING may correlate with this block.
  findSubLinks(body, (sub) => visitStatement(sub, scope, problems));
}

/** Pins what the conditions pin, reports each scoped relation left unpinned, and returns the scope for correlated subqueries. */
function checkConditions(
  relations: readonly Relation[],
  parent: Scope | undefined,
  conditions: readonly Condition[],
  prePinned: readonly string[],
  problems: Unpinned[],
  opts: { readonly excludedIsValue?: boolean; readonly requireAll?: boolean } = {},
): Scope {
  const uf = new UnionFind();
  const valued = new Set<string>([...prePinned, ...(parent?.pinned ?? [])]);
  // Outer-join pins run one way, from a source column to a nullable-side target: [target, source].
  const edges: [string, string][] = [];
  const probe: Scope = { relations, parent, pinned: new Set() };
  const term = (n: Node): string | typeof VALUE | undefined => (isColumnRef(n) ? columnKey(n, probe, opts) : isValue(n) ? VALUE : undefined);
  for (const cond of conditions) {
    const mayPin = (key: string) => !cond.nullable || cond.nullable.some((r) => key.startsWith(`${r.key}.`));
    const pin = (target: string | typeof VALUE | undefined, source: string | typeof VALUE | undefined) => {
      if (typeof target !== "string" || source === undefined || !mayPin(target)) return;
      if (source === VALUE) valued.add(target);
      else if (cond.nullable) edges.push([target, source]);
      else uf.union(target, source);
    };
    for (const conjunct of conjuncts(cond.expr)) {
      const eq = equality(conjunct);
      if (!eq) continue;
      if (eq.kind === "list") {
        // `x = ANY($1)`, `x IN ($1, $2)`: every alternative must be a value.
        if (eq.right.every((x) => term(x) === VALUE)) pin(term(eq.left), VALUE);
        continue;
      }
      const a = term(eq.left);
      const b = term(eq.right[0]!);
      pin(a, b);
      pin(b, a);
    }
  }
  const roots = new Set([...valued].map((k) => uf.find(k)));
  const isPinned = (k: string) => roots.has(uf.find(k));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [target, source] of edges) {
      if (!isPinned(target) && isPinned(source)) {
        roots.add(uf.find(target));
        changed = true;
      }
    }
  }
  // Pinned columns of this block and its ancestors, for correlated subqueries to build on.
  const pinned = new Set<string>(parent?.pinned ?? []);
  for (const k of [...uf.keys(), ...valued, ...edges.map(([t]) => t)]) if (isPinned(k)) pinned.add(k);
  for (const r of relations) {
    for (const c of r.scopeColumns) if (isPinned(`${r.key}.${c}`)) pinned.add(`${r.key}.${c}`);
    if (r.scopeColumns.length === 0) continue;
    const ok = opts.requireAll ? r.scopeColumns.every((c) => pinned.has(`${r.key}.${c}`)) : r.scopeColumns.some((c) => pinned.has(`${r.key}.${c}`));
    if (!ok) {
      const as = r.alias !== r.name.split(".").pop() ? ` (as ${r.alias})` : "";
      problems.push({ table: r.name, message: `${r.name}${as} is not pinned by ${r.scopeColumns.join(opts.requireAll ? " and " : " or ")}` });
    }
  }
  return { relations, parent, pinned };
}

const VALUE = Symbol("value");

/** Resolves a column reference to "<relation key>.<column>", innermost scope first; VALUE for `EXCLUDED.x` in DO UPDATE. */
function columnKey(node: Node, scope: Scope, opts: { readonly excludedIsValue?: boolean }): string | typeof VALUE | undefined {
  const fields = ((unwrap(node).ColumnRef as Node | undefined)?.fields as Node[] | undefined)?.map((f) => (f as { String?: { sval: string } }).String?.sval);
  if (!fields || fields.some((f) => f === undefined)) return undefined;
  const names = fields as string[];
  const column = names[names.length - 1]!;
  if (names.length >= 2 && opts.excludedIsValue && names[names.length - 2] === "excluded") return VALUE;
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    let match: Relation | undefined;
    if (names.length === 1) match = s.relations.length === 1 ? s.relations[0] : undefined;
    else {
      const qualifier = names[names.length - 2]!;
      const schema = names.length >= 3 ? names[names.length - 3] : undefined;
      match = s.relations.find((r) => (schema ? r.name === `${schema}.${qualifier}` && r.alias === qualifier : r.alias === qualifier));
    }
    if (match) return `${match.key}.${column}`;
    if (names.length === 1 && s.relations.length > 0) return undefined; // unqualified with several relations: ambiguous, pins nothing
  }
  return undefined;
}

/** Equality forms that pin: `a = b` (either side may be the column), `a = ANY(b)`, `a IN (b, c)`. */
function equality(n: Node): { kind: "pair" | "list"; left: Node; right: Node[] } | undefined {
  const e = n.A_Expr as Node | undefined;
  if (!e) return undefined;
  const op = (e.name as Node[] | undefined)?.map((x) => (x as { String?: { sval: string } }).String?.sval).join(".");
  if (op !== "=") return undefined;
  const lexpr = e.lexpr as Node;
  const rexpr = e.rexpr as Node;
  if (e.kind === "AEXPR_OP") return { kind: "pair", left: lexpr, right: [rexpr] };
  if (e.kind === "AEXPR_OP_ANY") return { kind: "list", left: lexpr, right: [rexpr] };
  if (e.kind === "AEXPR_IN") return { kind: "list", left: lexpr, right: ((rexpr.List as Node | undefined)?.items as Node[] | undefined) ?? [rexpr] };
  return undefined;
}

/** Flattens top-level ANDs. OR and NOT branches are dropped: they pin nothing. */
function conjuncts(expr: Node | undefined): Node[] {
  if (!expr) return [];
  const b = expr.BoolExpr as Node | undefined;
  if (b?.boolop === "AND_EXPR") return (b.args as Node[]).flatMap(conjuncts);
  return [expr];
}

/**
 * A parameter, constant, or expression of them. A subquery is never a value: it may correlate with the very column
 * it is compared to (`f.bank_id = (SELECT f.bank_id)`), so pinning by subquery would be circular.
 */
function isValue(n: Node): boolean {
  let found = false;
  walk(n, (x) => {
    if (x.ColumnRef || x.SubLink) found = true;
    return !found;
  });
  return !found;
}

function isColumnRef(n: Node): boolean {
  return unwrap(n).ColumnRef !== undefined;
}

function unwrap(n: Node): Node {
  let cur = n;
  while (cur.TypeCast) cur = (cur.TypeCast as Node).arg as Node;
  return cur;
}

function findSubLinks(node: unknown, onSubquery: (sub: Node) => void): void {
  walk(node, (x) => {
    if (x.SubLink) {
      onSubquery((x.SubLink as Node).subselect as Node);
      return false;
    }
    // Derived tables are visited by their block (and CTEs, which `walk` skips); a nested statement is never reached otherwise.
    return !x.RangeSubselect;
  });
}

function walk(node: unknown, enter: (n: Node) => boolean): void {
  if (Array.isArray(node)) {
    for (const x of node) walk(x, enter);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const n = node as Node;
  if (!enter(n)) return;
  for (const [k, v] of Object.entries(n)) {
    if (k === "withClause") continue;
    walk(v, enter);
  }
}

function relationOf(item: Node): Relation {
  const rv = (item.RangeVar ?? item) as { schemaname?: string; relname: string; alias?: { aliasname: string } };
  const name = rv.schemaname ? `${rv.schemaname}.${rv.relname}` : rv.relname;
  const scoped = SCOPED_TABLES[name] ?? (rv.schemaname ? undefined : Object.entries(SCOPED_TABLES).find(([t]) => t.endsWith(`.${rv.relname}`))?.[1]);
  return { key: `r${relationCounter++}`, name, alias: rv.alias?.aliasname ?? rv.relname, scopeColumns: scoped ?? [] };
}

function aliasOf(n: Node): string {
  return ((n.alias as { aliasname?: string } | undefined)?.aliasname ?? "?") as string;
}

function only(node: Node): [string, Node] {
  const [entry] = Object.entries(node);
  if (!entry) throw new Error("empty AST node");
  return [entry[0], entry[1] as Node];
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(k: string): string {
    const p = this.parent.get(k);
    if (p === undefined) this.parent.set(k, k);
    if (p === undefined || p === k) return k;
    const root = this.find(p);
    this.parent.set(k, root);
    return root;
  }
  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
  keys(): string[] {
    return [...this.parent.keys()];
  }
}

// ---------------------------------------------------------------------------------------------- the pool wrapper

const repoRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const guardedConfigs = new WeakSet<object>();

/** The first stack frame in this repository outside this file: where the statement came from. */
function callSite(stack: string | undefined): { site: string; fromTest: boolean } {
  const frames = (stack ?? "").split("\n").slice(1).map((l) => l.trim());
  const app = frames.filter((f) => f.includes(repoRoot) && !f.includes("/node_modules/") && !f.includes("/test/helpers/"));
  // No frame of ours at all (a library issuing SQL on our pool): treat it as application code, so it is checked.
  const first = app[0] ?? "unknown";
  const relative = (f: string) => f.replace(/^at /, "").replaceAll(`file://${repoRoot}/`, "").replaceAll(`${repoRoot}/`, "");
  return { site: app.slice(0, 4).map(relative).join("\n    ") || first, fromTest: first.includes(`${repoRoot}/test/`) };
}

function record(text: string, stack: string | undefined): Error | undefined {
  const { site, fromTest } = callSite(stack);
  if (fromTest) {
    guardLog.testStatements++;
    return undefined;
  }
  const { tag, problems } = checkStatement(text);
  guardLog.checked++;
  guardLog.distinct.add(text);
  if (tag !== undefined) guardLog.tags.set(tag, (guardLog.tags.get(tag) ?? 0) + 1);
  if (problems.length === 0) return undefined;
  const violation = { sql: text, problems, callSite: site };
  guardLog.violations.push(violation);
  return new Error(formatViolation(violation));
}

export function formatViolation(v: GuardViolation): string {
  return `query guard: statement not pinned to one bank\n  ${v.problems.join("\n  ")}\n  at ${v.callSite}\n  SQL: ${v.sql.replace(/\s+/g, " ").trim()}`;
}

type QueryFn = (...args: unknown[]) => unknown;

function textOf(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && typeof (arg as { text?: unknown }).text === "string") return (arg as { text: string }).text;
  return undefined;
}

/** A violating statement is not sent: the query rejects with the offending SQL and its call site. */
function guarded(original: QueryFn, self: object, args: unknown[], stack: string | undefined): unknown {
  const text = textOf(args[0]);
  if (text === undefined) return original.apply(self, args);
  const error = record(text, stack);
  if (!error) return original.apply(self, args);
  const cb = args.find((a) => typeof a === "function") as ((e: Error) => void) | undefined;
  if (cb) {
    cb(error);
    return undefined;
  }
  return Promise.reject(error);
}

export async function installQueryGuard(pool: pg.Pool): Promise<void> {
  await loadParser();
  const poolQuery = pool.query.bind(pool) as QueryFn;
  // pool.query checks with the caller's stack, then hands pg-pool a config object the client wrapper recognises,
  // so the same statement is not checked twice from pg-pool's callback (where the caller is no longer on the stack).
  (pool as unknown as { query: QueryFn }).query = (...args: unknown[]) => {
    const text = textOf(args[0]);
    if (text === undefined) return poolQuery(...args);
    const config = typeof args[0] === "string" ? { text, values: Array.isArray(args[1]) ? args[1] : undefined } : (args[0] as object);
    guardedConfigs.add(config);
    const rest = typeof args[0] === "string" && Array.isArray(args[1]) ? args.slice(2) : args.slice(1);
    return guarded(poolQuery, pool, [config, ...rest], new Error().stack);
  };
  // `acquire` fires on every checkout, also of idle clients opened before the guard (by the migrations); wrap each client once.
  pool.on("acquire", (client) => {
    if (wrappedClients.has(client)) return;
    wrappedClients.add(client);
    const clientQuery = client.query.bind(client) as QueryFn;
    (client as unknown as { query: QueryFn }).query = (...args: unknown[]) => {
      if (args[0] && typeof args[0] === "object" && guardedConfigs.has(args[0])) return clientQuery(...args);
      return guarded(clientQuery, client, args, new Error().stack);
    };
  });
}

const wrappedClients = new WeakSet<object>();
