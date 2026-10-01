import type ts from 'typescript';

/** The rule ids the checker reports; each is printed beside the file path of a violation. */
export type RuleId = 'fn-length' | 'assertions' | 'marker' | 'skipped-test' | 'recursion' | 'silent-catch';

export type Violation = {
  /** Repo-relative POSIX path, e.g. `src/app/index.tsx`. */
  readonly path: string;
  /** 1-based line and column of the offending node or comment. */
  readonly line: number;
  readonly column: number;
  readonly rule: RuleId;
  readonly message: string;
};

/** One source file to check: a repo-relative POSIX path and its text. */
export type SourceInput = {
  readonly path: string;
  readonly text: string;
};

export type CheckOptions = {
  /** Absolute repo root; file names inside the checker's in-memory program live under it. */
  readonly root: string;
  /** tsconfig `paths` (e.g. `@/*` → `./src/*`), resolved against `root`, so aliased calls link up. */
  readonly paths?: ts.MapLike<string[]>;
};

/** A parsed source plus every node under it, collected once and shared by all rules. */
export type ParsedSource = {
  readonly path: string;
  readonly file: ts.SourceFile;
  readonly nodes: readonly ts.Node[];
  /** Test files may assert with expect()/assert() and are where skipped tests can hide. */
  readonly isTest: boolean;
};
