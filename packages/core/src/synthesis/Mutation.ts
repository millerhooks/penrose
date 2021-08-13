import {
  appendStmt,
  ArgExpr,
  argMatches,
  ArgStmtDecl,
  cascadingDelete,
  matchSignatures,
  removeStmt,
  replaceStmt,
  stmtExists,
} from "analysis/SubstanceAnalysis";
import { prettyStmt, prettySubNode, prettySubstance } from "compiler/Substance";
import consola, { LogLevel } from "consola";
import { dummyIdentifier } from "engine/EngineUtils";
import { Env } from "index";
import { range, without } from "lodash";
import {
  ApplyPredicate,
  Bind,
  SubExpr,
  SubProg,
  SubStmt,
} from "types/substance";
import {
  addID,
  generateArgStmt,
  removeID,
  SynthesisContext,
  WithContext,
} from "./Synthesizer";

const log = consola
  .create({ level: LogLevel.Info })
  .withScope("Substance mutation");

//#region Mutation types

export type MutationGroup = Mutation[];
export type Mutation = Add | Delete | Update;
export type MutationType = Mutation["tag"];

export interface IMutation {
  tag: MutationType;
  additionalMutations?: Mutation[];
  mutate: (
    op: this,
    prog: SubProg,
    ctx: SynthesisContext
  ) => WithContext<SubProg>;
}

export type Update =
  | SwapExprArgs
  | SwapStmtArgs
  | ReplaceStmtName
  | ReplaceExprName
  | ChangeStmtType
  | ChangeExprType;

export interface Add extends IMutation {
  tag: "Add";
  stmt: SubStmt;
}
export interface Delete extends IMutation {
  tag: "Delete";
  stmt: SubStmt;
}

export interface SwapStmtArgs extends IMutation {
  tag: "SwapStmtArgs";
  stmt: ApplyPredicate;
  elem1: number;
  elem2: number;
}

export interface SwapExprArgs extends IMutation {
  tag: "SwapExprArgs";
  stmt: Bind;
  expr: ArgExpr;
  elem1: number;
  elem2: number;
}

export interface ReplaceStmtName extends IMutation {
  tag: "ReplaceStmtName";
  stmt: ApplyPredicate;
  newName: string;
}

export interface ReplaceExprName extends IMutation {
  tag: "ReplaceExprName";
  stmt: Bind;
  expr: ArgExpr;
  newName: string;
}
export interface ChangeStmtType extends IMutation {
  tag: "ChangeStmtType";
  stmt: ApplyPredicate;
  newStmt: SubStmt;
  // NOTE: this array actually includes the delete for the deletion of the original statement
  additionalMutations: Mutation[];
}

export interface ChangeExprType extends IMutation {
  tag: "ChangeExprType";
  stmt: Bind;
  expr: ArgExpr;
  newStmt: SubStmt;
  // NOTE: this array actually includes the delete for the deletion of the original statement
  additionalMutations: Mutation[];
}

export const showMutations = (ops: Mutation[]): string => {
  return ops.map((op) => showMutation(op)).join("\n");
};

export const showMutation = (op: Mutation): string => {
  switch (op.tag) {
    case "SwapStmtArgs":
      return `Swap arguments ${op.elem1} and ${op.elem2} of ${prettyStmt(
        op.stmt
      )}`;
    case "SwapExprArgs":
      return `Swap arguments ${op.elem1} and ${op.elem2} of ${prettySubNode(
        op.expr
      )} in ${prettyStmt(op.stmt)}`;
    case "ChangeStmtType":
    case "ChangeExprType":
      return `Change ${prettyStmt(op.stmt)} to ${prettyStmt(op.newStmt)}`;
    case "ReplaceExprName":
    case "ReplaceStmtName":
      return `Replace the name of ${prettyStmt(op.stmt)} with ${op.newName}`;
    case "Add":
    case "Delete":
      return `${op.tag} ${prettySubNode(op.stmt)}`;
  }
};

//#endregion

//#region Mutation execution

export const executeMutation = (
  mutation: Mutation,
  prog: SubProg,
  ctx: SynthesisContext
): WithContext<SubProg> => mutation.mutate(mutation as any, prog, ctx); // TODO: typecheck this?

export const executeMutations = (
  mutations: Mutation[],
  prog: SubProg,
  ctx: SynthesisContext
): WithContext<SubProg> =>
  mutations.reduce(
    ({ res, ctx }: WithContext<SubProg>, m: Mutation) =>
      m.mutate(m as any, res, ctx),
    { res: prog, ctx }
  );

const swap = <T>(arr: T[], a: number, b: number): T[] =>
  arr.map((current, idx) => {
    if (idx === a) return arr[b];
    if (idx === b) return arr[a];
    return current;
  });

//#endregion

//#region Mutation constructors

export const deleteMutation = (
  stmt: SubStmt,
  newCtx?: SynthesisContext
): Delete => ({
  tag: "Delete",
  stmt,
  // if a new context is provided, use the new context. Otherwise automatically update the context
  mutate: newCtx
    ? ({ stmt }, p) => withCtx(removeStmt(p, stmt), newCtx)
    : removeStmtCtx,
});

export const addMutation = (stmt: SubStmt, newCtx?: SynthesisContext): Add => ({
  tag: "Add",
  stmt,
  // if a new context is provided, use the new context. Otherwise automatically update the context
  mutate: newCtx
    ? ({ stmt }, p) => withCtx(appendStmt(p, stmt), newCtx)
    : appendStmtCtx,
});

//#endregion

//#region Context-sensitive AST operations

const withCtx = <T>(res: T, ctx: SynthesisContext): WithContext<T> => ({
  res,
  ctx,
});

export const appendStmtCtx = (
  { stmt }: Add,
  p: SubProg,
  ctx: SynthesisContext
): WithContext<SubProg> => {
  if (stmt.tag === "Decl") {
    const newCtx = addID(ctx, stmt.type.name.value, stmt.name);
    return withCtx(appendStmt(p, stmt), newCtx);
  } else {
    return withCtx(appendStmt(p, stmt), ctx);
  }
};

export const removeStmtCtx = (
  { stmt }: Delete,
  prog: SubProg,
  ctx: SynthesisContext
): WithContext<SubProg> => {
  if (stmt.tag === "Decl") {
    const newCtx = removeID(ctx, stmt.type.name.value, stmt.name);
    return withCtx(removeStmt(prog, stmt), newCtx);
  } else {
    return withCtx(removeStmt(prog, stmt), ctx);
  }
};

//#endregion

//#region Mutation guard functions

export const checkAddStmts = (
  prog: SubProg,
  cxt: SynthesisContext,
  newStmts: (cxt: SynthesisContext) => WithContext<SubStmt[]>
): Add[] | undefined => {
  const { res: stmts, ctx: newCtx } = newStmts(cxt);
  return stmts.map((stmt: SubStmt) => addMutation(stmt, newCtx));
};

export const checkAddStmt = (
  prog: SubProg,
  cxt: SynthesisContext,
  newStmt: (cxt: SynthesisContext) => WithContext<SubStmt>
): Add | undefined => {
  const { res: stmt, ctx: newCtx } = newStmt(cxt);
  return addMutation(stmt, newCtx);
};

export const checkSwapStmtArgs = (
  stmt: SubStmt,
  elems: (p: ApplyPredicate) => [number, number]
): SwapStmtArgs | undefined => {
  if (stmt.tag === "ApplyPredicate") {
    if (stmt.args.length < 2) return undefined;
    const [elem1, elem2] = elems(stmt);
    return {
      tag: "SwapStmtArgs",
      stmt,
      elem1,
      elem2,
      mutate: (
        { stmt, elem1, elem2 }: SwapStmtArgs,
        prog: SubProg,
        ctx: SynthesisContext
      ): WithContext<SubProg> => {
        const newStmt: SubStmt = {
          ...stmt,
          args: swap(stmt.args, elem1, elem2),
        };
        return withCtx(replaceStmt(prog, stmt, newStmt), ctx);
      },
    };
  } else return undefined;
};

export const checkSwapExprArgs = (
  stmt: SubStmt,
  elems: (p: ArgExpr) => [number, number]
): SwapExprArgs | undefined => {
  if (stmt.tag === "Bind") {
    const { expr } = stmt;
    if (
      expr.tag === "ApplyConstructor" ||
      expr.tag === "ApplyFunction" ||
      expr.tag === "Func"
    ) {
      if (expr.args.length < 2) return undefined;
      const [elem1, elem2] = elems(expr);
      return {
        tag: "SwapExprArgs",
        stmt,
        expr,
        elem1,
        elem2,
        mutate: (
          { stmt, expr, elem1, elem2 }: SwapExprArgs,
          prog: SubProg,
          ctx: SynthesisContext
        ): WithContext<SubProg> => {
          const newStmt: SubStmt = {
            ...stmt,
            expr: {
              ...expr,
              args: swap(expr.args, elem1, elem2),
            } as SubExpr, // TODO: fix types to avoid casting
          };
          return withCtx(replaceStmt(prog, stmt, newStmt), ctx);
        },
      };
    } else return undefined;
  } else return undefined;
};

export const checkReplaceStmtName = (
  stmt: SubStmt,
  newName: (p: ApplyPredicate) => string | undefined
): ReplaceStmtName | undefined => {
  if (stmt.tag === "ApplyPredicate") {
    const name = newName(stmt);
    if (name) {
      return {
        tag: "ReplaceStmtName",
        stmt,
        newName: name,
        mutate: ({ stmt, newName }: ReplaceStmtName, prog, ctx) => {
          return withCtx(
            replaceStmt(prog, stmt, {
              ...stmt,
              name: dummyIdentifier(newName, "SyntheticSubstance"),
            }),
            ctx
          );
        },
      };
    } else return undefined;
  } else return undefined;
};

export const checkReplaceExprName = (
  stmt: SubStmt,
  newName: (p: ArgExpr) => string | undefined
): ReplaceExprName | undefined => {
  if (stmt.tag === "Bind") {
    const { expr } = stmt;
    if (
      expr.tag === "ApplyConstructor" ||
      expr.tag === "ApplyFunction" ||
      expr.tag === "Func"
    ) {
      const name = newName(expr);
      if (name) {
        return {
          tag: "ReplaceExprName",
          stmt,
          expr,
          newName: name,
          mutate: ({ stmt, expr, newName }: ReplaceExprName, prog, ctx) => {
            return withCtx(
              replaceStmt(prog, stmt, {
                ...stmt,
                expr: {
                  ...expr,
                  name: dummyIdentifier(newName, "SyntheticSubstance"),
                },
              }),
              ctx
            );
          },
        };
      } else return undefined;
    } else return undefined;
  } else return undefined;
};

export const checkDeleteStmt = (
  prog: SubProg,
  stmt: SubStmt,
  newCtx?: SynthesisContext
): Delete | undefined => {
  const s = stmt;
  if (stmtExists(s, prog)) {
    return deleteMutation(s, newCtx);
  } else return undefined;
};

const changeType = (
  { stmt, newStmt, additionalMutations }: ChangeStmtType | ChangeExprType,
  prog: SubProg,
  ctx: SynthesisContext
) => {
  const { res: newProg, ctx: newCtx } = executeMutations(
    additionalMutations,
    prog,
    ctx
  );
  return withCtx(appendStmt(newProg, newStmt), newCtx);
};

export const checkChangeStmtType = (
  stmt: SubStmt,
  cxt: SynthesisContext,
  getMutations: (
    s: ApplyPredicate,
    cxt: SynthesisContext
  ) => { newStmt: SubStmt; additionalMutations: Mutation[] } | undefined
): ChangeStmtType | undefined => {
  if (stmt.tag === "ApplyPredicate") {
    const res = getMutations(stmt, cxt);
    if (res) {
      const { newStmt, additionalMutations } = res;
      return {
        tag: "ChangeStmtType",
        stmt,
        newStmt,
        additionalMutations,
        mutate: changeType,
      };
    } else return undefined;
  } else undefined;
};

export const checkChangeExprType = (
  stmt: SubStmt,
  cxt: SynthesisContext,
  getMutations: (
    oldStmt: Bind,
    oldExpr: ArgExpr,
    cxt: SynthesisContext
  ) => { newStmt: SubStmt; additionalMutations: Mutation[] } | undefined
): ChangeExprType | undefined => {
  if (stmt.tag === "Bind") {
    const { expr } = stmt;
    if (
      expr.tag === "ApplyConstructor" ||
      expr.tag === "ApplyFunction" ||
      expr.tag === "Func"
    ) {
      const res = getMutations(stmt, expr, cxt);
      if (res) {
        const { newStmt, additionalMutations } = res;
        return {
          tag: "ChangeExprType",
          stmt,
          expr,
          newStmt,
          additionalMutations,
          mutate: changeType,
        };
      } else return undefined;
    } else return undefined;
  } else return undefined;
};

//#endregion

//#region Mutation enumerators
// TODO: factor out enumeration callbacks

const pairs = <T>(list: T[]): [T, T][] => {
  const res: [T, T][] = [];
  for (let i = 0; i < list.length - 1; i++) {
    for (let j = i; j < list.length - 1; j++) {
      res.push([list[i], list[j + 1]]);
    }
  }
  return res;
};

export const enumSwapStmtArgs = (stmt: SubStmt): SwapStmtArgs[] => {
  if (stmt.tag === "ApplyPredicate" && stmt.args.length > 1) {
    const indexPairs: [number, number][] = pairs(range(0, stmt.args.length));
    return indexPairs.map(([elem1, elem2]: [number, number]) => ({
      tag: "SwapStmtArgs",
      stmt,
      elem1,
      elem2,
      mutate: (
        { stmt, elem1, elem2 }: SwapStmtArgs,
        prog: SubProg,
        ctx: SynthesisContext
      ): WithContext<SubProg> => {
        const newStmt: SubStmt = {
          ...stmt,
          args: swap(stmt.args, elem1, elem2),
        };
        return withCtx(replaceStmt(prog, stmt, newStmt), ctx);
      },
    }));
  } else return [];
};

export const enumSwapExprArgs = (stmt: SubStmt): SwapExprArgs[] => {
  if (stmt.tag === "Bind") {
    const { expr } = stmt;
    if (
      (expr.tag === "ApplyConstructor" ||
        expr.tag === "ApplyFunction" ||
        expr.tag === "Func") &&
      expr.args.length > 1
    ) {
      const indexPairs: [number, number][] = pairs(range(0, expr.args.length));
      return indexPairs.map(([elem1, elem2]: [number, number]) => ({
        tag: "SwapExprArgs",
        stmt,
        expr,
        elem1,
        elem2,
        mutate: (
          { stmt, expr, elem1, elem2 }: SwapExprArgs,
          prog: SubProg,
          ctx: SynthesisContext
        ): WithContext<SubProg> => {
          const newStmt: SubStmt = {
            ...stmt,
            expr: {
              ...expr,
              args: swap(expr.args, elem1, elem2),
            } as SubExpr, // TODO: fix types to avoid casting
          };
          return withCtx(replaceStmt(prog, stmt, newStmt), ctx);
        },
      }));
    } else return [];
  } else return [];
};

export const enumReplaceStmtName = (
  stmt: SubStmt,
  prog: SubProg,
  cxt: SynthesisContext
): ReplaceStmtName[] => {
  if (stmt.tag === "ApplyPredicate") {
    const matchingNames: string[] = matchSignatures(stmt, cxt.env).map(
      (decl) => decl.name.value
    );
    const options = without(matchingNames, stmt.name.value);
    return options.map((name: string) => ({
      tag: "ReplaceStmtName",
      stmt,
      newName: name,
      mutate: ({ stmt, newName }: ReplaceStmtName, prog, ctx) => {
        return withCtx(
          replaceStmt(prog, stmt, {
            ...stmt,
            name: dummyIdentifier(newName, "SyntheticSubstance"),
          }),
          ctx
        );
      },
    }));
  } else return [];
};

export const enumReplaceExprName = (
  stmt: SubStmt,
  prog: SubProg,
  cxt: SynthesisContext
): ReplaceExprName[] => {
  if (stmt.tag === "Bind") {
    const { expr } = stmt;
    if (
      expr.tag === "ApplyConstructor" ||
      expr.tag === "ApplyFunction" ||
      expr.tag === "Func"
    ) {
      const matchingNames: string[] = matchSignatures(expr, cxt.env).map(
        (decl) => decl.name.value
      );
      const options = without(matchingNames, expr.name.value);
      return options.map((name: string) => ({
        tag: "ReplaceExprName",
        stmt,
        expr,
        newName: name,
        mutate: ({ stmt, expr, newName }: ReplaceExprName, prog, ctx) => {
          return withCtx(
            replaceStmt(prog, stmt, {
              ...stmt,
              expr: {
                ...expr,
                name: dummyIdentifier(newName, "SyntheticSubstance"),
              },
            }),
            ctx
          );
        },
      }));
    } else return [];
  } else return [];
};

export const enumChangeStmtType = (
  stmt: SubStmt,
  prog: SubProg,
  cxt: SynthesisContext
): ChangeStmtType[] => {
  if (stmt.tag === "ApplyPredicate") {
    const options = argMatches(stmt, cxt.env);
    return options.map((decl: ArgStmtDecl) => {
      const { res, stmts, ctx: newCtx } = generateArgStmt(decl, cxt);
      const deleteOp: Delete = deleteMutation(stmt, newCtx);
      const addOps: Add[] = stmts.map((s: SubStmt) => addMutation(s, newCtx));
      return {
        tag: "ChangeStmtType",
        stmt,
        newStmt: res,
        additionalMutations: [deleteOp, ...addOps],
        mutate: changeType,
      };
    });
  } else return [];
};

export const enumChangeExprType = (
  stmt: SubStmt,
  prog: SubProg,
  cxt: SynthesisContext
): ChangeExprType[] => {
  if (stmt.tag === "Bind") {
    const { expr } = stmt;
    if (
      expr.tag === "ApplyConstructor" ||
      expr.tag === "ApplyFunction" ||
      expr.tag === "Func"
    ) {
      const options = argMatches(stmt, cxt.env);
      return options.map((decl: ArgStmtDecl) => {
        const { res, stmts, ctx: newCtx } = generateArgStmt(decl, cxt);
        let toDelete: SubStmt[];
        // remove old statement
        if (res.tag === "Bind" && res.variable.type !== stmt.variable.type) {
          // old bind was replaced by a bind with diff type
          toDelete = cascadingDelete(stmt, prog); // remove refs to the old bind
        } else {
          toDelete = [stmt];
        }
        const deleteOps: Delete[] = toDelete.map((s) => deleteMutation(s));
        const addOps: Add[] = stmts.map((s: SubStmt) => addMutation(s, newCtx));
        return {
          tag: "ChangeExprType",
          stmt,
          expr,
          newStmt: res,
          additionalMutations: [...deleteOps, ...addOps],
          mutate: changeType,
        };
      });
    } else return [];
  } else return [];
};

type MutationEnumerator = (
  stmt: SubStmt,
  prog: SubProg,
  cxt: SynthesisContext
) => Mutation[];

export const mutationEnumerators: MutationEnumerator[] = [
  enumReplaceExprName,
  enumReplaceStmtName,
  enumSwapExprArgs,
  enumSwapStmtArgs,
  enumChangeExprType,
  enumChangeStmtType,
];

export const enumerateMutations = (
  stmt: SubStmt,
  prog: SubProg,
  cxt: SynthesisContext
): Mutation[] => mutationEnumerators.map((fn) => fn(stmt, prog, cxt)).flat();

//#endregion
