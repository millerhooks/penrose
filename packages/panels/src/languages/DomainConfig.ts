import { languages, IRange } from "monaco-editor";
import { CommentCommon, CommonTokens } from "./common";

export const DomainConfig: languages.LanguageConfiguration = {
  comments: {
    blockComment: ["/*", "*/"],
    lineComment: "--",
  },
  autoClosingPairs: [{ open: '"', close: '"', notIn: ["string", "comment"] }],
  surroundingPairs: [{ open: '"', close: '"' }],
};

const domainOperators: string[] = ["*", "->", ":", "<:"];

const domainKeywords: string[] = [
  "type",
  "notation",
  "predicate",
  "function",
  "constructor",
  "prelude",
];

export const DomainLanguageTokens = (): languages.IMonarchLanguage => {
  const refs = {
    control: domainKeywords,
    operator: domainOperators,
  };
  return {
    ...refs,
    tokenizer: {
      root: [
        ...CommonTokens,
        [/\$.*\$/, "comment.doc"],
        [
          /[a-z_A-Z$][\w$]*/,
          {
            cases: {
              "@control": "keyword",
              "@default": "identifier",
              "@operator": "operator",
            },
          },
        ],
        { include: "@whitespace" },
      ],
      ...CommentCommon,
    },
  };
};

export const DomainCompletions = (range: IRange) => {
  return domainKeywords.map((type) => ({
    label: type,
    insertText: type,
    kind: languages.CompletionItemKind.Keyword,
    detail: "Domain keywords",
    range,
  }));
};
