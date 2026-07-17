import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { GITHUB_MUTATION_METHOD_NAMES } from "../../src/github/allowed-operations.js";

const APPROVED_GITHUB_CAPABILITIES = Object.freeze(
  [
    "checkStar",
    "createUserList",
    "deleteUserList",
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
    "setRepositoryListIds",
    "star",
    "unstar",
    "updateUserList",
  ].sort(),
);

const APPROVED_PORT_EXPORTS = Object.freeze(
  [
    "AccountBinding",
    "CapabilityState",
    "CreateUserListInput",
    "GitHubCapabilities",
    "GitHubDiscoveryReadPort",
    "GitHubEvidenceReadPort",
    "GitHubListItem",
    "GitHubListReadPort",
    "GitHubLiveReadPort",
    "GitHubMutationPort",
    "GitHubPort",
    "GitHubReadme",
    "GitHubRepository",
    "GitHubSearchInput",
    "GitHubSearchPage",
    "GitHubStar",
    "GitHubStarReadPort",
    "GitHubStatusReadPort",
    "GitHubSyncReadPort",
    "GitHubUserList",
    "MutationReceipt",
    "Page",
    "RateLimitState",
    "RepositoryCoordinates",
    "RepositoryIdentity",
    "UpdateUserListInput",
    "UserListMutationResult",
  ].sort(),
);

const APPROVED_ADAPTER_EXPORTS = Object.freeze(["OctokitGitHubAdapter"]);
const APPROVED_ADAPTER_STATIC_MEMBERS = Object.freeze([] as string[]);
const APPROVED_PORT_ALIAS_EXPORTS = Object.freeze([
  "AccountBinding",
  "RepositoryCoordinates",
]);
const APPROVED_PORT_INTERFACE_EXPORTS = Object.freeze([
  "GitHubDiscoveryReadPort",
  "GitHubEvidenceReadPort",
  "GitHubListReadPort",
  "GitHubLiveReadPort",
  "GitHubMutationPort",
  "GitHubPort",
  "GitHubStarReadPort",
  "GitHubStatusReadPort",
  "GitHubSyncReadPort",
]);
const APPROVED_PORT_TYPE_ALIAS_EXPORTS = Object.freeze([
  "CapabilityState",
  "CreateUserListInput",
  "GitHubCapabilities",
  "GitHubListItem",
  "GitHubReadme",
  "GitHubRepository",
  "GitHubSearchInput",
  "GitHubSearchPage",
  "GitHubStar",
  "GitHubUserList",
  "MutationReceipt",
  "Page",
  "RateLimitState",
  "RepositoryIdentity",
  "UpdateUserListInput",
  "UserListMutationResult",
]);
const UNRESOLVED_COMPUTED_MEMBER = "<computed-public-member>";
const UNRESOLVED_COMPUTED_STATIC_MEMBER = "<computed-public-static-member>";
const FORBIDDEN_PUBLIC_MEMBERS = new Set([
  "request",
  "graphql",
  "deleteRepository",
  "archiveRepository",
  "transferRepository",
  "updateRepository",
  "updateFile",
  "createOrUpdateFile",
  "rawRequest",
]);

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROJECT_CONFIG = fileURLToPath(
  new URL("../../tsconfig.json", import.meta.url),
);
const CONTRACT_PROBE_FILE = fileURLToPath(
  new URL("./github-capability-contract.probe.ts", import.meta.url),
);
const GITHUB_PORT_FILE = fileURLToPath(
  new URL("../../src/app/ports/github-port.ts", import.meta.url),
);
const GITHUB_ADAPTER_FILE = fileURLToPath(
  new URL("../../src/github/octokit-github-adapter.ts", import.meta.url),
);
const ALLOWED_OPERATIONS_FILE = fileURLToPath(
  new URL("../../src/github/allowed-operations.ts", import.meta.url),
);

const GITHUB_PORT_SOURCE = readFileSync(GITHUB_PORT_FILE, "utf8");
const GITHUB_ADAPTER_SOURCE = readFileSync(GITHUB_ADAPTER_FILE, "utf8");

type BoundaryIssue =
  | "compiler-contract"
  | "port-module-exports"
  | "adapter-module-exports"
  | "port-export-symbols"
  | "adapter-export-symbols"
  | "port-public-members"
  | "adapter-public-members"
  | "adapter-public-static-members"
  | "forbidden-public-member";

type BoundaryProof = Readonly<{
  issues: readonly BoundaryIssue[];
  diagnostics: readonly ts.Diagnostic[];
  portExports: readonly string[];
  adapterExports: readonly string[];
  portExportSymbolsValid: boolean;
  adapterExportSymbolsValid: boolean;
  portMembers: readonly string[];
  adapterMembers: readonly string[];
  adapterStaticMembers: readonly string[];
  forbiddenMembers: readonly string[];
}>;

type ExportSymbolShape = Readonly<{
  flags: ts.SymbolFlags;
  declarationKind: ts.SyntaxKind;
  aliasedTarget?: Readonly<{
    flags: ts.SymbolFlags;
    declarationKind: ts.SyntaxKind;
  }>;
}>;

type SourceOverrides = Readonly<Record<string, string>>;
type ProofOptions = Readonly<{ forceCompiler?: boolean }>;

function canonicalFileName(fileName: string): string {
  return fileName.replaceAll("\\", "/").toLowerCase();
}

function requiredReplacement(
  source: string,
  needle: string,
  replacement: string,
): string {
  if (!source.includes(needle)) {
    throw new Error(`Mutation anchor was not found: ${needle}`);
  }
  return source.replace(needle, replacement);
}

function compilerOptions(): ts.CompilerOptions {
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
  return parsed.options;
}

const PROJECT_COMPILER_OPTIONS = compilerOptions();

function productionProgram(overrides: SourceOverrides = {}): ts.Program {
  const overriddenSources = new Map(
    Object.entries(overrides).map(([fileName, source]) => [
      canonicalFileName(fileName),
      source,
    ]),
  );
  const host = ts.createCompilerHost(PROJECT_COMPILER_OPTIONS, true);
  const defaultReadFile = host.readFile.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.readFile = (fileName) =>
    overriddenSources.get(canonicalFileName(fileName)) ??
    defaultReadFile(fileName);
  host.getSourceFile = (
    fileName,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const source = overriddenSources.get(canonicalFileName(fileName));
    return source === undefined
      ? defaultGetSourceFile(
          fileName,
          languageVersionOrOptions,
          onError,
          shouldCreateNewSourceFile,
        )
      : ts.createSourceFile(
          fileName,
          source,
          languageVersionOrOptions,
          true,
          ts.ScriptKind.TS,
        );
  };
  return ts.createProgram({
    rootNames: [CONTRACT_PROBE_FILE],
    options: PROJECT_COMPILER_OPTIONS,
    host,
  });
}

function requiredSourceFile(
  program: ts.Program,
  fileName: string,
): ts.SourceFile {
  const sourceFile = program.getSourceFile(fileName);
  if (sourceFile === undefined) {
    throw new Error(`Production source was not loaded: ${fileName}`);
  }
  return sourceFile;
}

function moduleExports(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): readonly ts.Symbol[] {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    throw new Error(`Module symbol was not resolved: ${sourceFile.fileName}`);
  }
  return checker.getExportsOfModule(moduleSymbol);
}

function moduleExportNames(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): readonly string[] {
  return Object.freeze(
    moduleExports(checker, sourceFile)
      .map((symbol) => symbol.getName())
      .sort(),
  );
}

const ALIASED_INTERFACE_EXPORT_SHAPE: ExportSymbolShape = Object.freeze({
  flags: ts.SymbolFlags.Alias,
  declarationKind: ts.SyntaxKind.ExportSpecifier,
  aliasedTarget: Object.freeze({
    flags: ts.SymbolFlags.Interface,
    declarationKind: ts.SyntaxKind.InterfaceDeclaration,
  }),
});
const INTERFACE_EXPORT_SHAPE: ExportSymbolShape = Object.freeze({
  flags: ts.SymbolFlags.Interface,
  declarationKind: ts.SyntaxKind.InterfaceDeclaration,
});
const TYPE_ALIAS_EXPORT_SHAPE: ExportSymbolShape = Object.freeze({
  flags: ts.SymbolFlags.TypeAlias,
  declarationKind: ts.SyntaxKind.TypeAliasDeclaration,
});
const CLASS_EXPORT_SHAPE: ExportSymbolShape = Object.freeze({
  flags: ts.SymbolFlags.Class,
  declarationKind: ts.SyntaxKind.ClassDeclaration,
});

function expectedPortExportShape(
  exportName: string,
): ExportSymbolShape | undefined {
  if (APPROVED_PORT_ALIAS_EXPORTS.some((name) => name === exportName)) {
    return ALIASED_INTERFACE_EXPORT_SHAPE;
  }
  if (APPROVED_PORT_INTERFACE_EXPORTS.some((name) => name === exportName)) {
    return INTERFACE_EXPORT_SHAPE;
  }
  if (APPROVED_PORT_TYPE_ALIAS_EXPORTS.some((name) => name === exportName)) {
    return TYPE_ALIAS_EXPORT_SHAPE;
  }
  return undefined;
}

function expectedAdapterExportShape(
  exportName: string,
): ExportSymbolShape | undefined {
  return exportName === "OctokitGitHubAdapter" ? CLASS_EXPORT_SHAPE : undefined;
}

function symbolHasExactDeclarationShape(
  symbol: ts.Symbol,
  flags: ts.SymbolFlags,
  declarationKind: ts.SyntaxKind,
): boolean {
  const declarations = symbol.getDeclarations() ?? [];
  return (
    symbol.flags === flags &&
    declarations.length === 1 &&
    declarations[0]?.kind === declarationKind
  );
}

function exportSymbolHasExactShape(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  shape: ExportSymbolShape,
): boolean {
  if (
    !symbolHasExactDeclarationShape(symbol, shape.flags, shape.declarationKind)
  ) {
    return false;
  }
  if (shape.aliasedTarget === undefined) return true;
  const target = checker.getAliasedSymbol(symbol);
  return symbolHasExactDeclarationShape(
    target,
    shape.aliasedTarget.flags,
    shape.aliasedTarget.declarationKind,
  );
}

function moduleExportSymbolsHaveExactShapes(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  expectedNames: readonly string[],
  expectedShape: (exportName: string) => ExportSymbolShape | undefined,
): boolean {
  const symbols = moduleExports(checker, sourceFile);
  const names = symbols.map((symbol) => symbol.getName()).sort();
  return (
    sameNames(names, expectedNames) &&
    symbols.every((symbol) => {
      const shape = expectedShape(symbol.getName());
      return (
        shape !== undefined && exportSymbolHasExactShape(checker, symbol, shape)
      );
    })
  );
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let resolved = symbol;
  const seen = new Set<ts.Symbol>();
  while ((resolved.flags & ts.SymbolFlags.Alias) !== 0) {
    if (seen.has(resolved)) {
      throw new Error(`Cyclic export alias: ${symbol.getName()}`);
    }
    seen.add(resolved);
    resolved = checker.getAliasedSymbol(resolved);
  }
  return resolved;
}

function requiredExport(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  exportName: string,
): ts.Symbol {
  const exported = moduleExports(checker, sourceFile).find(
    (symbol) => symbol.getName() === exportName,
  );
  if (exported === undefined) {
    throw new Error(`Required export was not resolved: ${exportName}`);
  }
  return resolveAlias(checker, exported);
}

function hasModifier(
  node: ts.Node,
  modifier:
    | ts.SyntaxKind.PrivateKeyword
    | ts.SyntaxKind.ProtectedKeyword
    | ts.SyntaxKind.PublicKeyword
    | ts.SyntaxKind.ReadonlyKeyword
    | ts.SyntaxKind.StaticKeyword,
): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some(({ kind }) => kind === modifier) === true
  );
}

function isPrivateOrProtected(node: ts.Node): boolean {
  const name = (node as ts.NamedDeclaration).name;
  return (
    (name !== undefined && ts.isPrivateIdentifier(name)) ||
    hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(node, ts.SyntaxKind.ProtectedKeyword)
  );
}

function publicTypeMemberNames(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): readonly string[] {
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  return Object.freeze(
    checker
      .getPropertiesOfType(type)
      .filter((property) => {
        const declarations = property.getDeclarations() ?? [];
        return (
          declarations.length === 0 ||
          declarations.some((declaration) => !isPrivateOrProtected(declaration))
        );
      })
      .map((property) => property.getName())
      .sort(),
  );
}

function requiredAdapterDeclaration(
  sourceFile: ts.SourceFile,
): ts.ClassDeclaration {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text === "OctokitGitHubAdapter",
  );
  if (declaration === undefined) {
    throw new Error("OctokitGitHubAdapter declaration was not resolved");
  }
  return declaration;
}

function adapterDeclarationMemberNames(
  sourceFile: ts.SourceFile,
): readonly string[] {
  const declaration = requiredAdapterDeclaration(sourceFile);
  const names = new Set<string>();
  for (const member of declaration.members) {
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        if (!isPublicConstructorParameterProperty(parameter)) continue;
        const name = staticDeclarationName(parameter.name);
        if (name !== null) names.add(name);
      }
      continue;
    }
    if (
      isPrivateOrProtected(member) ||
      hasModifier(member, ts.SyntaxKind.StaticKeyword)
    ) {
      continue;
    }
    const name = staticDeclarationName((member as ts.NamedDeclaration).name);
    names.add(name ?? UNRESOLVED_COMPUTED_MEMBER);
  }
  return Object.freeze([...names].sort());
}

function adapterPublicMemberNames(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  sourceFile: ts.SourceFile,
): readonly string[] {
  return Object.freeze(
    [
      ...new Set([
        ...publicTypeMemberNames(checker, symbol),
        ...adapterDeclarationMemberNames(sourceFile),
      ]),
    ].sort(),
  );
}

function adapterDeclarationStaticMemberNames(
  sourceFile: ts.SourceFile,
): readonly string[] {
  const declaration = requiredAdapterDeclaration(sourceFile);
  const names = new Set<string>();
  for (const member of declaration.members) {
    if (
      ts.isConstructorDeclaration(member) ||
      isPrivateOrProtected(member) ||
      !hasModifier(member, ts.SyntaxKind.StaticKeyword)
    ) {
      continue;
    }
    const name = staticDeclarationName((member as ts.NamedDeclaration).name);
    names.add(name ?? UNRESOLVED_COMPUTED_STATIC_MEMBER);
  }
  return Object.freeze([...names].sort());
}

function adapterPublicStaticMemberNames(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  sourceFile: ts.SourceFile,
): readonly string[] {
  const declaration = requiredAdapterDeclaration(sourceFile);
  const staticType = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  const checkerNames = checker
    .getPropertiesOfType(staticType)
    .filter((property) => property.getName() !== "prototype")
    .filter((property) => {
      const declarations = property.getDeclarations() ?? [];
      return (
        declarations.length === 0 ||
        declarations.some(
          (propertyDeclaration) => !isPrivateOrProtected(propertyDeclaration),
        )
      );
    })
    .map((property) => property.getName());
  return Object.freeze(
    [
      ...new Set([
        ...checkerNames,
        ...adapterDeclarationStaticMemberNames(sourceFile),
      ]),
    ].sort(),
  );
}

function staticPropertyExpression(expression: ts.Expression): string | null {
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return staticPropertyExpression(expression.expression);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticPropertyExpression(expression.left);
    const right = staticPropertyExpression(expression.right);
    return left === null || right === null ? null : `${left}${right}`;
  }
  return null;
}

function staticDeclarationName(
  name: ts.DeclarationName | undefined,
): string | null {
  if (name === undefined || ts.isPrivateIdentifier(name)) return null;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return ts.isComputedPropertyName(name)
    ? staticPropertyExpression(name.expression)
    : null;
}

function isClassInterfaceOrTypeMember(node: ts.Node): boolean {
  if (
    !(
      ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isPropertySignature(node)
    )
  ) {
    return false;
  }
  const { parent } = node;
  return (
    ts.isClassDeclaration(parent) ||
    ts.isClassExpression(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeLiteralNode(parent)
  );
}

function isPublicConstructorParameterProperty(node: ts.Node): boolean {
  if (!ts.isParameter(node) || !ts.isConstructorDeclaration(node.parent)) {
    return false;
  }
  const isParameterProperty =
    hasModifier(node, ts.SyntaxKind.PublicKeyword) ||
    hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(node, ts.SyntaxKind.ProtectedKeyword) ||
    hasModifier(node, ts.SyntaxKind.ReadonlyKeyword);
  return isParameterProperty && !isPrivateOrProtected(node);
}

function forbiddenPublicMemberNames(
  sourceFile: ts.SourceFile,
): readonly string[] {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (isClassInterfaceOrTypeMember(node) && !isPrivateOrProtected(node)) ||
      isPublicConstructorParameterProperty(node)
    ) {
      const name = staticDeclarationName((node as ts.NamedDeclaration).name);
      if (name !== null && FORBIDDEN_PUBLIC_MEMBERS.has(name)) {
        names.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze([...names].sort());
}

function sameNames(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((name, index) => name === expected[index])
  );
}

function boundaryCompilerDiagnostics(
  program: ts.Program,
): readonly ts.Diagnostic[] {
  const boundarySources = [
    CONTRACT_PROBE_FILE,
    GITHUB_PORT_FILE,
    GITHUB_ADAPTER_FILE,
    ALLOWED_OPERATIONS_FILE,
  ].map((fileName) => requiredSourceFile(program, fileName));
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...boundarySources.flatMap((sourceFile) => [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ]),
  ].filter(({ category }) => category === ts.DiagnosticCategory.Error);
}

function proveProductionBoundary(
  overrides: SourceOverrides = {},
  options: ProofOptions = {},
): BoundaryProof {
  const program = productionProgram(overrides);
  const checker = program.getTypeChecker();
  const portSource = requiredSourceFile(program, GITHUB_PORT_FILE);
  const adapterSource = requiredSourceFile(program, GITHUB_ADAPTER_FILE);
  const portExports = moduleExportNames(checker, portSource);
  const adapterExports = moduleExportNames(checker, adapterSource);
  const portExportSymbolsValid = moduleExportSymbolsHaveExactShapes(
    checker,
    portSource,
    APPROVED_PORT_EXPORTS,
    expectedPortExportShape,
  );
  const adapterExportSymbolsValid = moduleExportSymbolsHaveExactShapes(
    checker,
    adapterSource,
    APPROVED_ADAPTER_EXPORTS,
    expectedAdapterExportShape,
  );
  const issues = new Set<BoundaryIssue>();
  if (!sameNames(portExports, APPROVED_PORT_EXPORTS)) {
    issues.add("port-module-exports");
  } else if (!portExportSymbolsValid) {
    issues.add("port-export-symbols");
  }
  if (!sameNames(adapterExports, APPROVED_ADAPTER_EXPORTS)) {
    issues.add("adapter-module-exports");
  } else if (!adapterExportSymbolsValid) {
    issues.add("adapter-export-symbols");
  }
  let portMembers: readonly string[] = Object.freeze([]);
  let adapterMembers: readonly string[] = Object.freeze([]);
  let adapterStaticMembers: readonly string[] = Object.freeze([]);
  let forbiddenMembers: readonly string[] = Object.freeze([]);
  if (issues.size === 0) {
    portMembers = publicTypeMemberNames(
      checker,
      requiredExport(checker, portSource, "GitHubPort"),
    );
    adapterMembers = adapterPublicMemberNames(
      checker,
      requiredExport(checker, adapterSource, "OctokitGitHubAdapter"),
      adapterSource,
    );
    adapterStaticMembers = adapterPublicStaticMemberNames(
      checker,
      requiredExport(checker, adapterSource, "OctokitGitHubAdapter"),
      adapterSource,
    );
    forbiddenMembers = Object.freeze(
      [
        ...forbiddenPublicMemberNames(portSource),
        ...forbiddenPublicMemberNames(adapterSource),
      ]
        .filter((name, index, names) => names.indexOf(name) === index)
        .sort(),
    );
    if (!sameNames(portMembers, APPROVED_GITHUB_CAPABILITIES)) {
      issues.add("port-public-members");
    }
    if (!sameNames(adapterMembers, APPROVED_GITHUB_CAPABILITIES)) {
      issues.add("adapter-public-members");
    }
    if (!sameNames(adapterStaticMembers, APPROVED_ADAPTER_STATIC_MEMBERS)) {
      issues.add("adapter-public-static-members");
    }
    if (forbiddenMembers.length > 0) {
      issues.add("forbidden-public-member");
    }
  }
  const diagnostics =
    issues.size === 0 || options.forceCompiler === true
      ? boundaryCompilerDiagnostics(program)
      : [];
  if (diagnostics.length > 0) {
    issues.add("compiler-contract");
  }
  return Object.freeze({
    issues: Object.freeze([...issues]),
    diagnostics: Object.freeze(diagnostics),
    portExports,
    adapterExports,
    portExportSymbolsValid,
    adapterExportSymbolsValid,
    portMembers,
    adapterMembers,
    adapterStaticMembers,
    forbiddenMembers,
  });
}

function withPortSource(source: string): SourceOverrides {
  return { [GITHUB_PORT_FILE]: source };
}

function withAdapterSource(source: string): SourceOverrides {
  return { [GITHUB_ADAPTER_FILE]: source };
}

function withAdapterMembers(members: string): string {
  const classEnd = GITHUB_ADAPTER_SOURCE.lastIndexOf("\n}");
  if (classEnd < 0) throw new Error("Adapter class closing brace is missing");
  return `${GITHUB_ADAPTER_SOURCE.slice(0, classEnd)}\n${members}\n${GITHUB_ADAPTER_SOURCE.slice(classEnd)}`;
}

function diagnosticTouches(proof: BoundaryProof, fileName: string): boolean {
  const expected = canonicalFileName(fileName);
  return proof.diagnostics.some(
    (diagnostic) =>
      diagnostic.file !== undefined &&
      canonicalFileName(diagnostic.file.fileName) === expected,
  );
}

describe("GitHub capability boundary", () => {
  it("publishes exactly the frozen six-name mutation tuple", () => {
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

  it("proves the unchanged production contract, exports, and public members", () => {
    const proof = proveProductionBoundary();

    expect({
      issues: proof.issues,
      diagnosticCount: proof.diagnostics.length,
      portExports: proof.portExports,
      adapterExports: proof.adapterExports,
      portExportSymbolsValid: proof.portExportSymbolsValid,
      adapterExportSymbolsValid: proof.adapterExportSymbolsValid,
      portMembers: proof.portMembers,
      adapterMembers: proof.adapterMembers,
      adapterStaticMembers: proof.adapterStaticMembers,
      forbiddenMembers: proof.forbiddenMembers,
    }).toEqual({
      issues: [],
      diagnosticCount: 0,
      portExports: APPROVED_PORT_EXPORTS,
      adapterExports: APPROVED_ADAPTER_EXPORTS,
      portExportSymbolsValid: true,
      adapterExportSymbolsValid: true,
      portMembers: APPROVED_GITHUB_CAPABILITIES,
      adapterMembers: APPROVED_GITHUB_CAPABILITIES,
      adapterStaticMembers: APPROVED_ADAPTER_STATIC_MEMBERS,
      forbiddenMembers: [],
    });
  });

  it("rejects a seventh port method and proves the mutation tuple is exhaustive", () => {
    const changed = requiredReplacement(
      GITHUB_PORT_SOURCE,
      "export interface GitHubMutationPort {",
      `export interface GitHubMutationPort {
  seventhMutation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt>;`,
    );
    const proof = proveProductionBoundary(withPortSource(changed), {
      forceCompiler: true,
    });

    expect(proof.issues).toContain("compiler-contract");
    expect(proof.issues).toContain("port-public-members");
    expect(diagnosticTouches(proof, ALLOWED_OPERATIONS_FILE)).toBe(true);
  });

  it("rejects a changed existing return type that exposes a client shape", () => {
    const changed = requiredReplacement(
      GITHUB_PORT_SOURCE,
      "getViewer(signal?: AbortSignal): Promise<AccountBinding>;",
      "getViewer(signal?: AbortSignal): Promise<AccountBinding & { readonly client: { request<T>(input: T): T } }>;",
    );
    const proof = proveProductionBoundary(withPortSource(changed), {
      forceCompiler: true,
    });

    expect(proof.issues).toContain("compiler-contract");
    expect(proof.portMembers).toEqual(APPROVED_GITHUB_CAPABILITIES);
  });

  it("rejects a changed existing parameter contract", () => {
    const changed = requiredReplacement(
      GITHUB_PORT_SOURCE,
      "getViewer(signal?: AbortSignal): Promise<AccountBinding>;",
      "getViewer(signal: AbortSignal): Promise<AccountBinding>;",
    );
    const proof = proveProductionBoundary(withPortSource(changed));

    expect(proof.issues).toContain("compiler-contract");
    expect(proof.portMembers).toEqual(APPROVED_GITHUB_CAPABILITIES);
  });

  it.each([
    ["method", "  public boundaryMethod(): void {}"],
    ["property", "  public readonly boundaryProperty = true;"],
    ["accessor", "  public get boundaryAccessor(): boolean { return true; }"],
    ["computed member", '  public ["boundary" + "Computed"](): void {}'],
  ])("rejects an extra public adapter %s", (_label, member) => {
    const proof = proveProductionBoundary(
      withAdapterSource(withAdapterMembers(member)),
    );

    expect(proof.issues).toContain("adapter-public-members");
  });

  it("rejects a public adapter constructor parameter property", () => {
    const changed = requiredReplacement(
      GITHUB_ADAPTER_SOURCE,
      "constructor(transport: GitHubTransport) {",
      "constructor(transport: GitHubTransport, public readonly boundaryParameter: unknown) {",
    );
    const proof = proveProductionBoundary(withAdapterSource(changed));

    expect(proof.issues).toContain("adapter-public-members");
  });

  it.each([
    ["method", "  public static boundaryStatic(): void {}"],
    [
      "raw client property",
      "  public static readonly client = { request(): void {} };",
    ],
  ])("rejects an extra public static adapter %s", (_label, member) => {
    const proof = proveProductionBoundary(
      withAdapterSource(withAdapterMembers(member)),
      { forceCompiler: true },
    );

    expect(proof.issues).toContain("adapter-public-static-members");
    expect(proof.issues).toContain("compiler-contract");
    expect(diagnosticTouches(proof, CONTRACT_PROBE_FILE)).toBe(true);
  });

  it("rejects a namespace merge that preserves the GitHubPort export name", () => {
    const changed = `${GITHUB_PORT_SOURCE}
export namespace GitHubPort {
  export const boundaryNamespaceValue = true;
}
`;
    const proof = proveProductionBoundary(withPortSource(changed));

    expect(proof.issues).toContain("port-export-symbols");
  });

  it.each([
    [
      "port helper",
      GITHUB_PORT_FILE,
      GITHUB_PORT_SOURCE,
      "\nexport function boundaryHelper(): void {}\n",
      "port-module-exports",
    ],
    [
      "port object",
      GITHUB_PORT_FILE,
      GITHUB_PORT_SOURCE,
      "\nexport const boundaryObject = Object.freeze({ safe: true });\n",
      "port-module-exports",
    ],
    [
      "port alias",
      GITHUB_PORT_FILE,
      GITHUB_PORT_SOURCE,
      "\nexport type BoundaryAlias = GitHubPort;\n",
      "port-module-exports",
    ],
    [
      "port re-export",
      GITHUB_PORT_FILE,
      GITHUB_PORT_SOURCE,
      '\nexport { AppError as BoundaryReexport } from "../../domain/errors.js";\n',
      "port-module-exports",
    ],
    [
      "adapter helper",
      GITHUB_ADAPTER_FILE,
      GITHUB_ADAPTER_SOURCE,
      "\nexport function boundaryHelper(): void {}\n",
      "adapter-module-exports",
    ],
    [
      "adapter object",
      GITHUB_ADAPTER_FILE,
      GITHUB_ADAPTER_SOURCE,
      "\nexport const boundaryObject = Object.freeze({ safe: true });\n",
      "adapter-module-exports",
    ],
    [
      "adapter alias",
      GITHUB_ADAPTER_FILE,
      GITHUB_ADAPTER_SOURCE,
      "\nexport type BoundaryAlias = OctokitGitHubAdapter;\n",
      "adapter-module-exports",
    ],
    [
      "adapter re-export",
      GITHUB_ADAPTER_FILE,
      GITHUB_ADAPTER_SOURCE,
      '\nexport { AppError as BoundaryReexport } from "../domain/errors.js";\n',
      "adapter-module-exports",
    ],
    [
      "exported client object",
      GITHUB_PORT_FILE,
      GITHUB_PORT_SOURCE,
      "\nexport const boundaryClient = { request(): void {} };\n",
      "port-module-exports",
    ],
    [
      "exported construct value",
      GITHUB_ADAPTER_FILE,
      GITHUB_ADAPTER_SOURCE,
      "\nexport class BoundaryConstructor {}\n",
      "adapter-module-exports",
    ],
  ] as const)(
    "rejects an extra %s before inspecting its nested surface",
    (_label, fileName, source, addition, expectedIssue) => {
      const proof = proveProductionBoundary({
        [fileName]: `${source}${addition}`,
      });

      expect(proof.issues).toContain(expectedIssue);
      expect(proof.diagnostics).toEqual([]);
      expect(proof.portMembers).toEqual([]);
      expect(proof.adapterMembers).toEqual([]);
    },
  );

  it.each([
    [
      "direct request",
      "  public request<T>(input: T): T { return input; }",
      "request",
    ],
    [
      "direct graphql",
      "  public graphql<T>(input: T): T { return input; }",
      "graphql",
    ],
    ["computed request", '  public ["re" + "quest"](): void {}', "request"],
    ["computed graphql", '  public ["graph" + "ql"](): void {}', "graphql"],
    [
      "repository administration",
      "  public deleteRepository(): void {}",
      "deleteRepository",
    ],
  ])("rejects a %s member in production source", (_label, member, name) => {
    const proof = proveProductionBoundary(
      withAdapterSource(withAdapterMembers(member)),
    );

    expect(proof.issues).toContain("adapter-public-members");
    expect(proof.issues).toContain("forbidden-public-member");
    expect(proof.forbiddenMembers).toContain(name);
  });

  it("ignores comments, strings, private, protected, and #private controls", () => {
    const changed = `${withAdapterMembers(`
  private request<T>(input: T): T { return input; }
  protected graphql<T>(input: T): T { return input; }
  private deleteRepository(): void {}
  private static boundaryStatic(): void {}
  protected static readonly client = { request(): void {} };
  #rawRequest(): void {}
`)}
// request(), graphql(), deleteRepository(), updateFile(), and rawRequest().
const boundaryWords =
  "archiveRepository transferRepository createOrUpdateFile request graphql";
void boundaryWords;
`;
    const proof = proveProductionBoundary(withAdapterSource(changed));

    expect(proof.issues).toEqual([]);
    expect(proof.forbiddenMembers).toEqual([]);
  });
});
