import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { GITHUB_MUTATION_METHOD_NAMES } from "../../src/github/allowed-operations.js";

const FORBIDDEN_CAPABILITIES = Object.freeze([
  "deleteRepository",
  "archiveRepository",
  "transferRepository",
  "updateRepository",
  "updateFile",
  "createOrUpdateFile",
  "rawRequest",
]);
const REJECTED_PUBLIC_MEMBERS = new Set([
  ...FORBIDDEN_CAPABILITIES,
  "request",
  "graphql",
]);

function source(relativeUrl: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativeUrl, import.meta.url)),
    "utf8",
  );
}

function declaredName(node: ts.NamedDeclaration): string | null {
  const { name } = node;
  if (name === undefined || ts.isPrivateIdentifier(name)) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression;
    return ts.isStringLiteralLike(expression) ? expression.text : null;
  }
  return null;
}

function hasModifier(
  node: ts.Node,
  modifier:
    | ts.SyntaxKind.PublicKeyword
    | ts.SyntaxKind.PrivateKeyword
    | ts.SyntaxKind.ProtectedKeyword,
): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some(({ kind }) => kind === modifier) === true
  );
}

function isPublicClassMember(
  member: ts.ClassElement,
): member is ts.ClassElement & ts.NamedDeclaration {
  return (
    (ts.isMethodDeclaration(member) ||
      ts.isPropertyDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)) &&
    !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
    !hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
  );
}

function isPublicInterfaceMember(
  member: ts.TypeElement,
): member is ts.TypeElement & ts.NamedDeclaration {
  return (
    ts.isMethodSignature(member) ||
    ts.isPropertySignature(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  );
}

function publicCapabilityNames(contents: string): readonly string[] {
  const sourceFile = ts.createSourceFile(
    "capability-boundary.ts",
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set<string>();
  const record = (member: ts.NamedDeclaration): void => {
    const name = declaredName(member);
    if (name !== null && REJECTED_PUBLIC_MEMBERS.has(name)) names.add(name);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members) {
        if (isPublicClassMember(member)) record(member);
        if (ts.isConstructorDeclaration(member)) {
          for (const parameter of member.parameters) {
            if (
              ts.isParameterPropertyDeclaration(parameter, member) &&
              !hasModifier(parameter, ts.SyntaxKind.PrivateKeyword) &&
              !hasModifier(parameter, ts.SyntaxKind.ProtectedKeyword)
            ) {
              record(parameter);
            }
          }
        }
      }
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
      for (const member of node.members) {
        if (isPublicInterfaceMember(member)) record(member);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze([...names].sort());
}

describe("GitHub capability boundary", () => {
  it("publishes exactly the six reviewed Star and User List mutations", () => {
    expect(GITHUB_MUTATION_METHOD_NAMES).toEqual([
      "star",
      "unstar",
      "createUserList",
      "updateUserList",
      "deleteUserList",
      "setRepositoryListIds",
    ]);
    expect(Object.isFrozen(GITHUB_MUTATION_METHOD_NAMES)).toBe(true);
  });

  it("contains no repository, content, administration, or generic request escape hatch", () => {
    const files = [
      source("../../src/app/ports/github-port.ts"),
      source("../../src/github/octokit-github-adapter.ts"),
    ];
    for (const contents of files) {
      expect(publicCapabilityNames(contents)).toEqual([]);
    }
  });

  it.each([
    [
      "generic method",
      "request",
      "class Escape { public async request<T>(input: unknown): Promise<T> { throw input; } }",
    ],
    [
      "static method",
      "graphql",
      "class Escape { public static graphql(input: unknown): unknown { return input; } }",
    ],
    [
      "public property",
      "request",
      "class Escape { public request = (input: unknown): unknown => input; }",
    ],
    [
      "interface generic method",
      "graphql",
      "interface Escape { graphql<T>(input: unknown): T; }",
    ],
    [
      "computed public property",
      "request",
      'class Escape { public ["request"] = (input: unknown): unknown => input; }',
    ],
    [
      "constructor parameter property",
      "request",
      "class Escape { constructor(public readonly request: (input: unknown) => unknown) {} }",
    ],
    [
      "default-public readonly constructor parameter property",
      "graphql",
      "class Escape { constructor(readonly graphql: (input: unknown) => unknown) {} }",
    ],
    [
      "public type-literal method",
      "graphql",
      "export type Escape = { graphql<T>(input: unknown): T };",
    ],
    [
      "forbidden administration method",
      "deleteRepository",
      "class Escape { deleteRepository(): void {} }",
    ],
  ])("detects a public %s structurally", (_name, capability, contents) => {
    expect(publicCapabilityNames(contents)).toContain(capability);
  });

  it("ignores comments, strings, object literals, and non-public class members", () => {
    const contents = `
      // deleteRepository, updateFile, request(, and graphql( are forbidden prose.
      const text = "archiveRepository transferRepository rawRequest request(";
      const template = \`
        createOrUpdateFile
        graphql(input)
      \`;
      const helper = {
        request(input: unknown): unknown { return input; },
        updateRepositoryMetadata: true,
      };
      class Safe {
        private request<T>(input: T): T { return input; }
        protected graphql<T>(input: T): T { return input; }
        #rawRequest(): void {}
      }
      void text;
      void template;
      void helper;
      void Safe;
    `;

    expect(publicCapabilityNames(contents)).toEqual([]);
  });
});
