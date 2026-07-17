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
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROJECT_CONFIG = fileURLToPath(
  new URL("../../tsconfig.json", import.meta.url),
);
const GITHUB_PORT_FILE = fileURLToPath(
  new URL("../../src/app/ports/github-port.ts", import.meta.url),
);
const GITHUB_ADAPTER_FILE = fileURLToPath(
  new URL("../../src/github/octokit-github-adapter.ts", import.meta.url),
);
const VIRTUAL_LIB_NAME = "github-capability-lib.d.ts";
const VIRTUAL_LIB_SOURCE = `
  interface Array<T> {
    readonly length: number;
    readonly [index: number]: T;
  }
  interface Boolean {}
  interface CallableFunction extends Function {}
  interface Function {}
  interface IArguments {}
  interface NewableFunction extends Function {}
  interface Number {}
  interface Object {}
  interface RegExp {}
  interface String {}
  interface Promise<T> {}
  interface PromiseConstructor {
    readonly prototype: Promise<unknown>;
  }
  declare const Promise: PromiseConstructor;
  interface Error {}
  interface ErrorConstructor {
    new (message?: string): Error;
  }
  declare const Error: ErrorConstructor;
  interface ObjectConstructor {
    assign<T extends object, U extends object>(target: T, source: U): T & U;
  }
  declare const Object: ObjectConstructor;
  type Readonly<T> = {
    readonly [P in keyof T]: T[P];
  };
`;

function canonicalFileName(fileName: string): string {
  return fileName.replaceAll("\\", "/").toLowerCase();
}

function compilerDiagnosticsWithMutation(
  member: string | null,
): readonly ts.Diagnostic[] {
  const virtualFile = fileURLToPath(
    new URL("./github-mutation-exhaustiveness.probe.ts", import.meta.url),
  );
  const config = ts.readConfigFile(PROJECT_CONFIG, (fileName) =>
    ts.sys.readFile(fileName),
  );
  if (config.error !== undefined) return [config.error];
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    PROJECT_ROOT,
    { noEmit: true },
    PROJECT_CONFIG,
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

type ProgramSurface = Readonly<{
  program: ts.Program;
  sourceFiles: readonly ts.SourceFile[];
}>;

let cachedProjectProgram: ts.Program | undefined;

function projectProgram(): ts.Program {
  if (cachedProjectProgram !== undefined) return cachedProjectProgram;
  const config = ts.readConfigFile(PROJECT_CONFIG, (fileName) =>
    ts.sys.readFile(fileName),
  );
  if (config.error !== undefined) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, " "),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    PROJECT_ROOT,
    { noEmit: true },
    PROJECT_CONFIG,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map(({ messageText }) =>
          ts.flattenDiagnosticMessageText(messageText, " "),
        )
        .join("; "),
    );
  }
  cachedProjectProgram = ts.createProgram({
    rootNames: [GITHUB_PORT_FILE, GITHUB_ADAPTER_FILE],
    options: parsed.options,
  });
  return cachedProjectProgram;
}

function projectSurface(fileName: string): ProgramSurface {
  const program = projectProgram();
  const sourceFile = program.getSourceFile(fileName);
  if (sourceFile === undefined) {
    throw new Error(`Project source was not loaded: ${fileName}`);
  }
  return { program, sourceFiles: [sourceFile] };
}

function virtualFileName(name: string): string {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

function virtualSurface(
  modules: Readonly<Record<string, string>>,
  entryNames: readonly string[],
): ProgramSurface {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noLib: true,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2023,
    types: [],
  };
  const virtualFiles = new Map<
    string,
    Readonly<{ fileName: string; contents: string }>
  >();
  const virtualLibFile = virtualFileName(VIRTUAL_LIB_NAME);
  virtualFiles.set(canonicalFileName(virtualLibFile), {
    fileName: virtualLibFile,
    contents: VIRTUAL_LIB_SOURCE,
  });
  for (const [name, contents] of Object.entries(modules)) {
    const fileName = virtualFileName(name);
    virtualFiles.set(canonicalFileName(fileName), { fileName, contents });
  }
  const host = ts.createCompilerHost(options, true);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) =>
    virtualFiles.has(canonicalFileName(fileName)) ||
    defaultFileExists(fileName);
  host.readFile = (fileName) =>
    virtualFiles.get(canonicalFileName(fileName))?.contents ??
    defaultReadFile(fileName);
  host.getSourceFile = (
    fileName,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const virtual = virtualFiles.get(canonicalFileName(fileName));
    return virtual === undefined
      ? defaultGetSourceFile(
          fileName,
          languageVersionOrOptions,
          onError,
          shouldCreateNewSourceFile,
        )
      : ts.createSourceFile(
          virtual.fileName,
          virtual.contents,
          languageVersionOrOptions,
          true,
          ts.ScriptKind.TS,
        );
  };
  const rootNames = [...virtualFiles.values()].map(({ fileName }) => fileName);
  const program = ts.createProgram({ rootNames, options, host });
  const sourceFiles = entryNames.map((name) => {
    const fileName = virtualFileName(name);
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile === undefined) {
      throw new Error(`Virtual source was not loaded: ${name}`);
    }
    return sourceFile;
  });
  return { program, sourceFiles };
}

function isPrivateOrProtected(node: ts.Node): boolean {
  const name = (node as ts.NamedDeclaration).name;
  return (
    (name !== undefined && ts.isPrivateIdentifier(name)) ||
    hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(node, ts.SyntaxKind.ProtectedKeyword)
  );
}

function recordComputedName(
  name: ts.DeclarationName | undefined,
  names: Set<string>,
): void {
  if (name === undefined || !ts.isComputedPropertyName(name)) return;
  names.add(staticPropertyName(name.expression) ?? UNRESOLVED_PUBLIC_NAME);
}

function scanComputedTypeNode(node: ts.TypeNode, names: Set<string>): void {
  if (ts.isTypeLiteralNode(node)) {
    scanComputedMembers(node.members, names);
    return;
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (let index = 0; index < node.types.length; index += 1) {
      const nested = node.types[index];
      if (nested !== undefined) scanComputedTypeNode(nested, names);
    }
    return;
  }
  if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) {
    scanComputedTypeNode(node.type, names);
    return;
  }
  if (ts.isTypeReferenceNode(node)) {
    for (let index = 0; index < (node.typeArguments?.length ?? 0); index += 1) {
      const nested = node.typeArguments?.[index];
      if (nested !== undefined) scanComputedTypeNode(nested, names);
    }
    return;
  }
  if (ts.isArrayTypeNode(node)) {
    scanComputedTypeNode(node.elementType, names);
  }
}

function scanComputedExpression(
  expression: ts.Expression,
  names: Set<string>,
): void {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    scanComputedExpression(expression.expression, names);
    return;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    for (let index = 0; index < expression.properties.length; index += 1) {
      const property = expression.properties[index];
      if (property === undefined) continue;
      if (ts.isSpreadAssignment(property)) {
        scanComputedExpression(property.expression, names);
        continue;
      }
      if (!isPrivateOrProtected(property)) {
        recordComputedName(property.name, names);
      }
      if (ts.isPropertyAssignment(property)) {
        scanComputedExpression(property.initializer, names);
      }
    }
    return;
  }
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
    for (
      let index = 0;
      index < (expression.arguments?.length ?? 0);
      index += 1
    ) {
      const argument = expression.arguments?.[index];
      if (argument !== undefined) scanComputedExpression(argument, names);
    }
    return;
  }
  if (ts.isClassExpression(expression)) {
    scanComputedMembers(expression.members, names);
  }
}

function scanComputedMembers(
  members: ts.NodeArray<ts.ClassElement | ts.TypeElement>,
  names: Set<string>,
): void {
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (member === undefined || isPrivateOrProtected(member)) continue;
    if (ts.isIndexSignatureDeclaration(member)) {
      names.add(UNRESOLVED_PUBLIC_NAME);
      continue;
    }
    recordComputedName((member as ts.NamedDeclaration).name, names);
    if (
      (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) &&
      member.type !== undefined
    ) {
      scanComputedTypeNode(member.type, names);
    }
    if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
      scanComputedExpression(member.initializer, names);
    }
  }
}

function scanComputedDeclaration(
  declaration: ts.Declaration,
  names: Set<string>,
): void {
  if (
    ts.isClassDeclaration(declaration) ||
    ts.isClassExpression(declaration) ||
    ts.isInterfaceDeclaration(declaration)
  ) {
    scanComputedMembers(declaration.members, names);
    return;
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    scanComputedTypeNode(declaration.type, names);
    return;
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined
  ) {
    scanComputedExpression(declaration.initializer, names);
  }
}

function symbolIsNonPublic(symbol: ts.Symbol): boolean {
  const declarations = symbol.getDeclarations();
  return (
    declarations !== undefined &&
    declarations.length > 0 &&
    declarations.every(isPrivateOrProtected)
  );
}

function isExternalDeclaration(declaration: ts.Declaration): boolean {
  const sourceFile = declaration.getSourceFile();
  return (
    sourceFile.isDeclarationFile ||
    canonicalFileName(sourceFile.fileName).includes("/node_modules/")
  );
}

function typeHasSourceDeclaration(type: ts.Type): boolean {
  const symbols = [type.aliasSymbol, type.getSymbol()];
  for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex += 1) {
    const symbol = symbols[symbolIndex];
    if (
      symbol
        ?.getDeclarations()
        ?.some((declaration) => !isExternalDeclaration(declaration)) === true
    ) {
      return true;
    }
  }
  return symbols.every((symbol) => symbol === undefined);
}

const PRIMITIVE_TYPE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Void |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never;

function collectCapabilityNames(surface: ProgramSurface): readonly string[] {
  const { program, sourceFiles } = surface;
  const checker = program.getTypeChecker();
  const names = new Set<string>();
  const visitedTypes = new Set<ts.Type>();
  const visitedModules = new Set<ts.Symbol>();

  const visitType = (type: ts.Type, force: boolean): void => {
    if (
      (type.flags &
        (ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.TypeParameter)) !==
      0
    ) {
      names.add(UNRESOLVED_PUBLIC_NAME);
      return;
    }
    if ((type.flags & PRIMITIVE_TYPE_FLAGS) !== 0) return;
    if (visitedTypes.has(type)) return;
    visitedTypes.add(type);

    if (type.isUnionOrIntersection()) {
      for (let index = 0; index < type.types.length; index += 1) {
        const nested = type.types[index];
        if (nested !== undefined) visitType(nested, force);
      }
      return;
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) return;
    if (!force && !typeHasSourceDeclaration(type)) return;

    for (const symbol of [type.aliasSymbol, type.getSymbol()]) {
      for (const declaration of symbol?.getDeclarations() ?? []) {
        scanComputedDeclaration(declaration, names);
      }
    }
    if (
      checker.getIndexInfoOfType(type, ts.IndexKind.String) !== undefined ||
      checker.getIndexInfoOfType(type, ts.IndexKind.Number) !== undefined
    ) {
      names.add(UNRESOLVED_PUBLIC_NAME);
    }

    const interfaceType = type as ts.InterfaceType;
    if (
      (interfaceType.objectFlags &
        (ts.ObjectFlags.Class | ts.ObjectFlags.Interface)) !==
      0
    ) {
      for (const base of checker.getBaseTypes(interfaceType) ?? []) {
        visitType(base, true);
      }
    }

    const properties = checker.getPropertiesOfType(type);
    for (let index = 0; index < properties.length; index += 1) {
      const property = properties[index];
      if (property === undefined || symbolIsNonPublic(property)) continue;
      const propertyName = property.getName();
      if (propertyName.startsWith("#")) continue;
      if (
        propertyName.startsWith("__@") ||
        propertyName.includes("__computed")
      ) {
        names.add(UNRESOLVED_PUBLIC_NAME);
        continue;
      }
      const declarations = property.getDeclarations() ?? [];
      const location =
        property.valueDeclaration ?? declarations[0] ?? sourceFiles[0];
      if (location === undefined) {
        names.add(UNRESOLVED_PUBLIC_NAME);
        continue;
      }
      let propertyType: ts.Type;
      try {
        propertyType = checker.getTypeOfSymbolAtLocation(property, location);
      } catch {
        names.add(UNRESOLVED_PUBLIC_NAME);
        continue;
      }
      if (
        (propertyType.flags &
          (ts.TypeFlags.Any |
            ts.TypeFlags.Unknown |
            ts.TypeFlags.TypeParameter)) !==
        0
      ) {
        names.add(UNRESOLVED_PUBLIC_NAME);
        continue;
      }
      const declaredCapability = declarations.some(
        (declaration) =>
          ts.isMethodDeclaration(declaration) ||
          ts.isMethodSignature(declaration) ||
          ts.isGetAccessorDeclaration(declaration) ||
          ts.isSetAccessorDeclaration(declaration),
      );
      if (
        declaredCapability ||
        checker.getSignaturesOfType(propertyType, ts.SignatureKind.Call)
          .length > 0
      ) {
        names.add(propertyName);
        continue;
      }
      if (propertyName !== "prototype") visitType(propertyType, false);
    }
  };

  const resolveAlias = (symbol: ts.Symbol): ts.Symbol | null => {
    const seen = new Set<ts.Symbol>();
    let current = symbol;
    while ((current.flags & ts.SymbolFlags.Alias) !== 0) {
      if (seen.has(current)) return null;
      seen.add(current);
      try {
        current = checker.getAliasedSymbol(current);
      } catch {
        return null;
      }
    }
    return current;
  };

  const visitExport = (exported: ts.Symbol): void => {
    const target = resolveAlias(exported);
    if (target === null) {
      names.add(UNRESOLVED_PUBLIC_NAME);
      return;
    }
    for (const declaration of target.getDeclarations() ?? []) {
      scanComputedDeclaration(declaration, names);
    }

    if ((target.flags & ts.SymbolFlags.Module) !== 0) {
      if (visitedModules.has(target)) return;
      visitedModules.add(target);
      for (const nested of checker.getExportsOfModule(target)) {
        visitExport(nested);
      }
    }

    const location =
      target.valueDeclaration ??
      target.getDeclarations()?.[0] ??
      sourceFiles[0];
    let inspected = false;
    if (
      (target.flags &
        (ts.SymbolFlags.Class |
          ts.SymbolFlags.Interface |
          ts.SymbolFlags.TypeAlias |
          ts.SymbolFlags.TypeParameter |
          ts.SymbolFlags.Enum)) !==
      0
    ) {
      inspected = true;
      try {
        visitType(checker.getDeclaredTypeOfSymbol(target), true);
      } catch {
        names.add(UNRESOLVED_PUBLIC_NAME);
      }
    }
    if ((target.flags & ts.SymbolFlags.Value) !== 0) {
      inspected = true;
      if (location === undefined) {
        names.add(UNRESOLVED_PUBLIC_NAME);
      } else {
        try {
          const valueType = checker.getTypeOfSymbolAtLocation(target, location);
          if (
            (valueType.flags &
              (ts.TypeFlags.Any |
                ts.TypeFlags.Unknown |
                ts.TypeFlags.TypeParameter)) !==
            0
          ) {
            names.add(UNRESOLVED_PUBLIC_NAME);
          } else if (
            checker.getSignaturesOfType(valueType, ts.SignatureKind.Call)
              .length > 0
          ) {
            names.add(exported.getName());
          } else {
            visitType(valueType, true);
          }
        } catch {
          names.add(UNRESOLVED_PUBLIC_NAME);
        }
      }
    }
    if (!inspected) names.add(UNRESOLVED_PUBLIC_NAME);
  };

  for (let index = 0; index < sourceFiles.length; index += 1) {
    const sourceFile = sourceFiles[index];
    if (sourceFile === undefined) {
      names.add(UNRESOLVED_PUBLIC_NAME);
      continue;
    }
    const diagnostics = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ];
    if (
      diagnostics.some(
        ({ category }) => category === ts.DiagnosticCategory.Error,
      )
    ) {
      names.add(UNRESOLVED_PUBLIC_NAME);
    }
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol === undefined) {
      continue;
    }
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      visitExport(exported);
    }
  }
  return Object.freeze([...names].sort());
}

function publicCapabilityNames(contents: string): readonly string[] {
  return collectCapabilityNames(
    virtualSurface({ "github-capability-fixture.ts": contents }, [
      "github-capability-fixture.ts",
    ]),
  );
}

function publicCapabilityNamesFromModules(
  modules: Readonly<Record<string, string>>,
  entryName = "github-capability-fixture.ts",
): readonly string[] {
  return collectCapabilityNames(virtualSurface(modules, [entryName]));
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
    for (const fileName of [GITHUB_PORT_FILE, GITHUB_ADAPTER_FILE]) {
      expect(collectCapabilityNames(projectSurface(fileName))).toEqual(
        APPROVED_GITHUB_CAPABILITIES,
      );
    }
  }, 90_000);

  it.each([
    [
      "generic method",
      "request",
      "export class Escape { public async request<T>(input: unknown): Promise<T> { throw input; } }",
    ],
    [
      "static method",
      "graphql",
      "export class Escape { public static graphql<T>(input: T): T { return input; } }",
    ],
    [
      "public property",
      "request",
      "export class Escape { public request = (input: unknown): unknown => input; }",
    ],
    [
      "interface generic method",
      "graphql",
      "export interface Escape { graphql<T>(input: unknown): T; }",
    ],
    [
      "interface generic function property",
      "request",
      "export interface Escape { request: <T>(input: T) => T; }",
    ],
    [
      "computed public property",
      "request",
      'export class Escape { public ["request"] = (input: unknown): unknown => input; }',
    ],
    [
      "constructor parameter property",
      "request",
      "export class Escape { constructor(public readonly request: (input: unknown) => unknown) {} }",
    ],
    [
      "default-public readonly constructor parameter property",
      "graphql",
      "export class Escape { constructor(readonly graphql: (input: unknown) => unknown) {} }",
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
      "export class Escape { deleteRepository(): void {} }",
    ],
  ])("detects a public %s structurally", (_name, capability, contents) => {
    expect(publicCapabilityNames(contents)).toContain(capability);
  });

  it("resolves static computed names and rejects unresolvable public computed names", () => {
    expect(
      publicCapabilityNames(
        'export class Escape { public ["re" + "quest"](): void {} }',
      ),
    ).toEqual(["request"]);
    expect(
      publicCapabilityNames(
        "declare const key: string; export class Escape { public [key]<T>(): T { throw new Error(); } }",
      ),
    ).toEqual([UNRESOLVED_PUBLIC_NAME]);
  });

  it("collects the complete mutation surface so seventh and administration mutations cannot hide", () => {
    const approved = `
      export interface GitHubMutationPort {
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

  it.each([
    ["Readonly type aliases", "export type E = Readonly<{ request<T>(): T }>;"],
    [
      "intersection type aliases",
      "export type E = { safe: true } & { request<T>(): T };",
    ],
    [
      "export-list aliases",
      `
        const E = {
          request<T>(): T { throw new Error(); },
        };
        export { E };
      `,
    ],
    [
      "Object.assign compositions",
      `
        export const E = Object.assign({}, {
          request<T>(): T { throw new Error(); },
        });
      `,
    ],
  ])("resolves callable capabilities through %s", (_name, contents) => {
    expect(publicCapabilityNames(contents)).toContain("request");
  });

  it("resolves callable capabilities through re-exports", () => {
    expect(
      publicCapabilityNamesFromModules({
        "github-capability-base.ts": "export interface E { request<T>(): T; }",
        "github-capability-fixture.ts":
          'export { E } from "./github-capability-base.js";',
      }),
    ).toEqual(["request"]);
  });

  it("fails closed for an unresolved public re-export", () => {
    expect(
      publicCapabilityNames(
        'export { E } from "./missing-capability-module.js";',
      ),
    ).toEqual([UNRESOLVED_PUBLIC_NAME]);
  });

  it("resolves inherited and nested callable export surfaces without exposing container keys", () => {
    expect(
      publicCapabilityNames(`
        interface Base {
          request<T>(): T;
        }
        export interface E extends Base {
          nested: {
            graphql<T>(): T;
          };
        }
      `),
    ).toEqual(["graphql", "request"]);
  });

  it("fails closed when an exported capability surface has type any", () => {
    expect(
      publicCapabilityNames(`
        declare const unresolved: any;
        export { unresolved as E };
      `),
    ).toEqual([UNRESOLVED_PUBLIC_NAME]);
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
