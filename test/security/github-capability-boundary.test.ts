import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { GITHUB_MUTATION_METHOD_NAMES } from "../../src/github/allowed-operations.js";

const APPROVED_MUTATION_CAPABILITIES = Object.freeze(
  [
    "star",
    "unstar",
    "createUserList",
    "updateUserList",
    "deleteUserList",
    "setRepositoryListIds",
  ].sort(),
);
const APPROVED_GITHUB_CAPABILITIES = Object.freeze(
  [
    ...APPROVED_MUTATION_CAPABILITIES,
    "checkStar",
    "getReadme",
    "getRepositoryIdentity",
    "getRepositoryListIds",
    "getUserList",
    "getViewer",
    "listStarredRepositories",
    "listUserListItems",
    "listUserLists",
    "probeCapabilities",
    "searchRepositories",
  ].sort(),
);
const UNRESOLVED_PUBLIC_NAME = "<unresolved-public-name>";

function source(relativeUrl: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativeUrl, import.meta.url)),
    "utf8",
  );
}

function compilerDiagnosticsWithMutation(
  member: string | null,
): readonly ts.Diagnostic[] {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const configFile = fileURLToPath(
    new URL("../../tsconfig.json", import.meta.url),
  );
  const virtualFile = fileURLToPath(
    new URL("./github-mutation-exhaustiveness.probe.ts", import.meta.url),
  );
  const config = ts.readConfigFile(configFile, (fileName) =>
    ts.sys.readFile(fileName),
  );
  if (config.error !== undefined) return [config.error];
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    projectRoot,
    { noEmit: true },
    configFile,
  );
  if (parsed.errors.length > 0) return parsed.errors;
  const contents =
    member === null
      ? 'import "../../src/github/allowed-operations.js";\n'
      : `
          import "../../src/github/allowed-operations.js";
          declare module "../../src/app/ports/github-port.js" {
            interface GitHubMutationPort {
              ${member}
            }
          }
        `;
  const canonicalFileName = (fileName: string): string =>
    fileName.replaceAll("\\", "/").toLowerCase();
  const canonicalVirtualFile = canonicalFileName(virtualFile);
  const host = ts.createCompilerHost(parsed.options, true);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) =>
    canonicalFileName(fileName) === canonicalVirtualFile ||
    defaultFileExists(fileName);
  host.readFile = (fileName) =>
    canonicalFileName(fileName) === canonicalVirtualFile
      ? contents
      : defaultReadFile(fileName);
  host.getSourceFile = (
    fileName,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    canonicalFileName(fileName) === canonicalVirtualFile
      ? ts.createSourceFile(
          fileName,
          contents,
          languageVersionOrOptions,
          true,
          ts.ScriptKind.TS,
        )
      : defaultGetSourceFile(
          fileName,
          languageVersionOrOptions,
          onError,
          shouldCreateNewSourceFile,
        );
  const program = ts.createProgram({
    rootNames: [virtualFile],
    options: parsed.options,
    host,
  });
  return ts.getPreEmitDiagnostics(program);
}

function staticPropertyName(expression: ts.Expression): string | null {
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return staticPropertyName(expression.expression);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticPropertyName(expression.left);
    const right = staticPropertyName(expression.right);
    return left === null || right === null ? null : `${left}${right}`;
  }
  return null;
}

function declaredName(node: ts.NamedDeclaration): string | null {
  const { name } = node;
  if (name === undefined || ts.isPrivateIdentifier(name)) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    return staticPropertyName(name.expression) ?? UNRESOLVED_PUBLIC_NAME;
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

function recordObjectLiteralSurface(
  object: ts.ObjectLiteralExpression,
  names: Set<string>,
): void {
  for (let index = 0; index < object.properties.length; index += 1) {
    const member = object.properties[index];
    if (member === undefined) continue;
    if (ts.isSpreadAssignment(member)) {
      names.add(UNRESOLVED_PUBLIC_NAME);
      continue;
    }
    const name = declaredName(member);
    if (name !== null) names.add(name);
  }
}

function exportedObjectLiteral(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return exportedObjectLiteral(expression.expression);
  }
  if (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 1 &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "Object" &&
    expression.expression.name.text === "freeze"
  ) {
    const argument = expression.arguments[0];
    return argument === undefined ? null : exportedObjectLiteral(argument);
  }
  return null;
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
    if (name !== null) names.add(name);
  };
  const recordClass = (node: ts.ClassLikeDeclaration): void => {
    for (let index = 0; index < node.members.length; index += 1) {
      const member = node.members[index];
      if (member === undefined) continue;
      if (isPublicClassMember(member)) record(member);
      if (
        ts.isIndexSignatureDeclaration(member) &&
        !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
        !hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
      ) {
        names.add(UNRESOLVED_PUBLIC_NAME);
      }
      if (!ts.isConstructorDeclaration(member)) continue;
      for (
        let parameterIndex = 0;
        parameterIndex < member.parameters.length;
        parameterIndex += 1
      ) {
        const parameter = member.parameters[parameterIndex];
        if (
          parameter !== undefined &&
          ts.isParameterPropertyDeclaration(parameter, member) &&
          !hasModifier(parameter, ts.SyntaxKind.PrivateKeyword) &&
          !hasModifier(parameter, ts.SyntaxKind.ProtectedKeyword)
        ) {
          record(parameter);
        }
      }
    }
  };
  const recordInterface = (members: ts.NodeArray<ts.TypeElement>): void => {
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index];
      if (member === undefined) continue;
      if (isPublicInterfaceMember(member)) record(member);
      if (ts.isIndexSignatureDeclaration(member)) {
        names.add(UNRESOLVED_PUBLIC_NAME);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      recordClass(node);
      return;
    }
    if (ts.isInterfaceDeclaration(node)) {
      recordInterface(node.members);
      return;
    }
    if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
      recordInterface(node.type.members);
      return;
    }
    if (
      ts.isVariableStatement(node) &&
      ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true
    ) {
      for (
        let declarationIndex = 0;
        declarationIndex < node.declarationList.declarations.length;
        declarationIndex += 1
      ) {
        const declaration = node.declarationList.declarations[declarationIndex];
        if (declaration?.initializer === undefined) continue;
        const object = exportedObjectLiteral(declaration.initializer);
        if (object !== null) recordObjectLiteralSurface(object, names);
      }
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const object = exportedObjectLiteral(node.expression);
      if (object !== null) recordObjectLiteralSurface(object, names);
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

  it("keeps each complete public GitHub capability surface on the exact reviewed allowlist", () => {
    const files = [
      source("../../src/app/ports/github-port.ts"),
      source("../../src/github/octokit-github-adapter.ts"),
    ];
    for (const contents of files) {
      expect(publicCapabilityNames(contents)).toEqual(
        APPROVED_GITHUB_CAPABILITIES,
      );
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
      "class Escape { public static graphql<T>(input: T): T { return input; } }",
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
      "interface generic function property",
      "request",
      "interface Escape { request: <T>(input: T) => T; }",
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
      "public type-literal function property",
      "request",
      "export type Escape = { request: <T>(input: T) => T };",
    ],
    [
      "forbidden administration method",
      "deleteRepository",
      "class Escape { deleteRepository(): void {} }",
    ],
  ])("detects a public %s structurally", (_name, capability, contents) => {
    expect(publicCapabilityNames(contents)).toContain(capability);
  });

  it("resolves static computed names and rejects unresolvable public computed names", () => {
    expect(
      publicCapabilityNames(
        'class Escape { public ["re" + "quest"](): void {} }',
      ),
    ).toEqual(["request"]);
    expect(
      publicCapabilityNames(
        "declare const key: string; class Escape { public [key]<T>(): T { throw new Error(); } }",
      ),
    ).toEqual([UNRESOLVED_PUBLIC_NAME]);
  });

  it("collects the complete mutation surface so seventh and administration mutations cannot hide", () => {
    const approved = `
      interface GitHubMutationPort {
        star(): void;
        unstar(): void;
        createUserList(): void;
        updateUserList(): void;
        deleteUserList(): void;
        setRepositoryListIds(): void;
      }
    `;
    const seventh = approved.replace(
      "\n      }",
      "\n        renameUserList(): void;\n      }",
    );
    const administration = approved.replace(
      "\n      }",
      "\n        deleteRepository(): void;\n      }",
    );

    expect(publicCapabilityNames(approved)).toEqual(
      APPROVED_MUTATION_CAPABILITIES,
    );
    expect(publicCapabilityNames(seventh)).toEqual(
      [...APPROVED_MUTATION_CAPABILITIES, "renameUserList"].sort(),
    );
    expect(publicCapabilityNames(administration)).toEqual(
      [...APPROVED_MUTATION_CAPABILITIES, "deleteRepository"].sort(),
    );
  });

  it("includes callable properties from exported object literals", () => {
    expect(
      publicCapabilityNames(`
        const internal = { request(): void {} };
        export const escape = {
          request<T>(input: T): T { return input; },
        };
        void internal;
      `),
    ).toEqual(["request"]);
  });

  it("makes the mutation manifest fail compilation when GitHubMutationPort grows", () => {
    expect(compilerDiagnosticsWithMutation(null)).toEqual([]);
    expect(
      compilerDiagnosticsWithMutation(
        "seventhMutation(operationId: string): Promise<void>;",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      compilerDiagnosticsWithMutation(
        "deleteRepository(operationId: string): Promise<void>;",
      ).length,
    ).toBeGreaterThan(0);
  }, 90_000);

  it("ignores comments, strings, non-exported object literals, and non-public class members", () => {
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
