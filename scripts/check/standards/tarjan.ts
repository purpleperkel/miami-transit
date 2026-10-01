import { invariant } from '../../../src/lib/invariant';

/** A directed graph over nodes 0..size-1; `edges[n]` lists n's successors. */
export type Graph = {
  readonly size: number;
  readonly edges: readonly (readonly number[])[];
};

type Frame = { readonly node: number; nextEdge: number };

type TarjanState = {
  readonly index: number[];
  readonly low: number[];
  readonly onStack: boolean[];
  readonly stack: number[];
  readonly components: number[][];
  next: number;
};

const UNVISITED = -1;

/**
 * Strongly connected components by Tarjan's algorithm, ITERATIVE: an explicit work stack of
 * (node, next edge) frames replaces the textbook recursive strongconnect(), so the checker that
 * bans recursion does not recurse itself and deep call graphs cannot overflow the JS stack.
 */
export function stronglyConnected(graph: Graph): number[][] {
  invariant(graph.edges.length === graph.size, 'one adjacency list per node');
  invariant(graph.edges.every((succ) => succ.every((t) => t >= 0 && t < graph.size)), 'edges stay inside the graph');
  const state: TarjanState = {
    index: new Array<number>(graph.size).fill(UNVISITED),
    low: new Array<number>(graph.size).fill(UNVISITED),
    onStack: new Array<boolean>(graph.size).fill(false),
    stack: [],
    components: [],
    next: 0,
  };
  for (let root = 0; root < graph.size; root += 1) {
    if (state.index[root] === UNVISITED) {
      connectFrom(root, graph, state);
    }
  }
  const assigned = state.components.reduce((sum, component) => sum + component.length, 0);
  invariant(assigned === graph.size, 'every node lands in exactly one component');
  return state.components;
}

/** True when a component is a cycle: several mutually reachable nodes, or one node calling itself. */
export function isCycle(component: readonly number[], graph: Graph): boolean {
  invariant(component.length > 0, 'a component is never empty');
  const only = component[0];
  invariant(only !== undefined && only < graph.size, 'component members are graph nodes');
  return component.length > 1 || (graph.edges[only] ?? []).includes(only);
}

/** One depth-first tree of Tarjan's search, driven by an explicit frame stack. */
function connectFrom(root: number, graph: Graph, state: TarjanState): void {
  invariant(state.stack.length === 0, 'each depth-first tree starts with an empty Tarjan stack');
  const work: Frame[] = [];
  open(root, state, work);
  while (work.length > 0) {
    const frame = work[work.length - 1];
    invariant(frame !== undefined, 'a non-empty work stack has a top frame');
    const successors = graph.edges[frame.node] ?? [];
    const target = successors[frame.nextEdge];
    if (target !== undefined) {
      frame.nextEdge += 1;
      if (read(state.index, target) === UNVISITED) {
        open(target, state, work);
      } else if (state.onStack[target] === true) {
        lower(state, frame.node, read(state.index, target));
      }
      continue;
    }
    work.pop();
    const parent = work[work.length - 1];
    if (parent !== undefined) {
      lower(state, parent.node, read(state.low, frame.node));
    }
    if (read(state.low, frame.node) === read(state.index, frame.node)) {
      closeComponent(frame.node, state);
    }
  }
  invariant(state.stack.length === 0, 'a finished depth-first tree leaves no node on the Tarjan stack');
}

function open(node: number, state: TarjanState, work: Frame[]): void {
  invariant(read(state.index, node) === UNVISITED, 'a node is opened once');
  state.index[node] = state.next;
  state.low[node] = state.next;
  state.next += 1;
  state.stack.push(node);
  state.onStack[node] = true;
  work.push({ node, nextEdge: 0 });
  invariant(read(state.index, node) >= 0, 'an opened node has an index');
}

function lower(state: TarjanState, node: number, candidate: number): void {
  invariant(candidate >= 0, 'only visited nodes lower a low-link');
  state.low[node] = Math.min(read(state.low, node), candidate);
  invariant(read(state.low, node) <= candidate, 'the low-link never exceeds the candidate');
}

/** Pops the component rooted at `root` off the Tarjan stack. */
function closeComponent(root: number, state: TarjanState): void {
  invariant(state.onStack[root] === true, 'a component root is still on the Tarjan stack');
  const component: number[] = [];
  let member: number | undefined;
  do {
    member = state.stack.pop();
    invariant(member !== undefined, 'the component root is below its members on the stack');
    state.onStack[member] = false;
    component.push(member);
  } while (member !== root);
  state.components.push(component);
  invariant(component.includes(root), 'the component contains its root');
}

function read(values: readonly number[], at: number): number {
  invariant(Number.isInteger(at) && at >= 0, 'graph nodes are non-negative integers');
  const value = values[at];
  invariant(value !== undefined, 'every graph node has a slot');
  return value;
}
