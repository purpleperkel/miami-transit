import ts from 'typescript';

import { invariant } from '../../../src/lib/invariant';
import { asFunction, enclosingFunction, functionName, violationAt } from './ast';
import { type Graph, isCycle, stronglyConnected } from './tarjan';
import type { CheckOptions, ParsedSource, Violation } from './types';

/**
 * No recursion: build the call graph of every checked function — across files, through imports
 * and tsconfig path aliases — and report every function on a cycle (iterative Tarjan SCCs).
 *
 * Edges: a call (or JSX element) inside function F that the type checker resolves to function G
 * gives F → G. An anonymous inline function is reachable from the function it is written in
 * (F → callback), so `f → arr.forEach(() => f())` is a cycle too.
 */

type FunctionRecord = {
  readonly fn: ts.FunctionLikeDeclaration;
  readonly source: ParsedSource;
  readonly name: string | null;
};

type CallGraph = Graph & {
  readonly functions: readonly FunctionRecord[];
  readonly ids: ReadonlyMap<ts.Node, number>;
  readonly edges: number[][];
};

export function findRecursion(sources: readonly ParsedSource[], options: CheckOptions): Violation[] {
  invariant(sources.every((s) => s.file.fileName.startsWith(options.root)), 'every source lives under the root');
  const checker = createChecker(sources, options);
  const graph = indexFunctions(sources);
  for (const source of sources) {
    for (const node of source.nodes) {
      linkNode(node, checker, graph);
    }
  }
  const violations: Violation[] = [];
  for (const component of stronglyConnected(graph)) {
    if (isCycle(component, graph)) {
      violations.push(...cycleViolations(component, graph));
    }
  }
  invariant(violations.every((v) => v.rule === 'recursion'), 'findRecursion only reports recursion');
  return violations;
}

/** A type checker over exactly the checked sources, served from memory (no lib, no node_modules). */
function createChecker(sources: readonly ParsedSource[], options: CheckOptions): ts.TypeChecker {
  const files = new Map(sources.map((s) => [s.file.fileName, s.file]));
  invariant(files.size === sources.length, 'each source is parsed exactly once');
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => files.get(fileName),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: (fileName) => {
      throw new Error(`the standards checker never emits (asked to write ${fileName})`);
    },
    getCurrentDirectory: () => options.root,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName)?.text,
  };
  const compilerOptions: ts.CompilerOptions = {
    noLib: true,
    noEmit: true,
    allowJs: true,
    types: [],
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    ...(options.paths === undefined ? {} : { paths: options.paths }),
  };
  const program = ts.createProgram({ rootNames: [...files.keys()], options: compilerOptions, host });
  invariant(program.getSourceFiles().every((f) => files.get(f.fileName) === f), 'the program reuses the parsed sources');
  return program.getTypeChecker();
}

function indexFunctions(sources: readonly ParsedSource[]): CallGraph {
  invariant(sources.length > 0, 'the call graph needs at least one source');
  const functions: FunctionRecord[] = [];
  const ids = new Map<ts.Node, number>();
  for (const source of sources) {
    for (const node of source.nodes) {
      const fn = asFunction(node);
      if (fn !== null) {
        ids.set(fn, functions.length);
        functions.push({ fn, source, name: functionName(fn, source.file) });
      }
    }
  }
  const edges = functions.map((): number[] => []);
  invariant(ids.size === functions.length, 'every function has one graph id');
  return { size: functions.length, functions, ids, edges };
}

/** Adds the edges `node` contributes: inline-function containment and resolved calls. */
function linkNode(node: ts.Node, checker: ts.TypeChecker, graph: CallGraph): void {
  invariant(graph.edges.length === graph.size, 'one adjacency list per function');
  const inline = asFunction(node);
  if (inline !== null && functionName(inline, node.getSourceFile()) === null) {
    const outer = enclosingFunction(inline);
    if (outer !== null) {
      addEdge(graph, outer, inline);
    }
  }
  const callee = calleeOf(node);
  const caller = callee === null ? null : enclosingFunction(node);
  if (callee === null || caller === null) {
    return;
  }
  const target = resolveFunction(callee, checker, graph);
  if (target !== null) {
    addEdge(graph, caller, target);
  }
  invariant(graph.ids.has(caller), 'every caller is an indexed function');
}

/** What a node invokes: a call's callee, or a JSX element's tag (React calls the component). */
function calleeOf(node: ts.Node): ts.Node | null {
  invariant(node.pos <= node.end, 'a parsed node has a well-formed span');
  let callee: ts.Node | null = null;
  if (ts.isCallExpression(node)) {
    callee = node.expression;
  } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    callee = node.tagName;
  }
  invariant(callee === null || callee.parent === node, 'the callee belongs to this node');
  return callee;
}

/** The checked function a callee resolves to (following import aliases), or null. */
function resolveFunction(callee: ts.Node, checker: ts.TypeChecker, graph: CallGraph): ts.FunctionLikeDeclaration | null {
  invariant(callee.pos <= callee.end, 'a parsed callee has a well-formed span');
  invariant(graph.ids.size === graph.size, 'the graph indexes every function');
  const at = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  let symbol = checker.getSymbolAtLocation(at);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  for (const declaration of symbol?.declarations ?? []) {
    const fn = declaredFunction(declaration);
    if (fn !== null && graph.ids.has(fn)) {
      return fn;
    }
  }
  return null;
}

/** The function a declaration defines: itself, or a variable / property initialised with one. */
function declaredFunction(declaration: ts.Declaration): ts.FunctionLikeDeclaration | null {
  invariant(declaration.pos <= declaration.end, 'a parsed declaration has a well-formed span');
  const own = asFunction(declaration);
  if (own !== null) {
    return own;
  }
  const holdsValue =
    ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration);
  const initializer = holdsValue ? declaration.initializer : undefined;
  const fn = initializer === undefined ? null : asFunction(initializer);
  invariant(fn === null || fn.parent === declaration, 'an initialiser function belongs to its declaration');
  return fn;
}

function addEdge(graph: CallGraph, from: ts.Node, to: ts.Node): void {
  const source = graph.ids.get(from);
  const target = graph.ids.get(to);
  invariant(source !== undefined && target !== undefined, 'edges join indexed functions');
  const successors = graph.edges[source];
  invariant(successors !== undefined, 'every indexed function has an adjacency list');
  if (!successors.includes(target)) {
    successors.push(target);
  }
}

/** One violation per NAMED function on the cycle (all members if none is named). */
function cycleViolations(component: readonly number[], graph: CallGraph): Violation[] {
  invariant(component.length > 0, 'a cycle has members');
  const members = component
    .map((id) => graph.functions[id])
    .filter((m): m is FunctionRecord => m !== undefined)
    .sort((a, b) => a.source.path.localeCompare(b.source.path) || a.fn.pos - b.fn.pos);
  invariant(members.length === component.length, 'every component id is an indexed function');
  const named = members.filter((m) => m.name !== null);
  const route = members.map((m) => describeMember(m)).join(' -> ');
  return (named.length > 0 ? named : members).map((m) => {
    const label = m.name ?? 'anonymous function';
    const what = members.length === 1 ? `\`${label}\` calls itself` : `\`${label}\` is on a call cycle: ${route}`;
    return violationAt(m.source, m.fn, 'recursion', `${what} — replace the recursion with a bounded loop`);
  });
}

function describeMember(member: FunctionRecord): string {
  invariant(member.fn.getSourceFile() === member.source.file, 'a member lives in its source');
  const line = member.source.file.getLineAndCharacterOfPosition(member.fn.getStart(member.source.file)).line + 1;
  invariant(line >= 1, 'source lines are 1-based');
  return `${member.name ?? 'anonymous function'} (${member.source.path}:${line})`;
}
