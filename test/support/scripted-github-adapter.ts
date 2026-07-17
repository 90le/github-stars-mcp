import { OctokitGitHubAdapter } from "../../src/github/octokit-github-adapter.js";
import {
  createScriptedGitHubTransport,
  type ScriptedGitHubRequest,
  type ScriptedGitHubStep,
} from "./scripted-github-transport.js";
import type { GraphqlReadOperation } from "../../src/github/allowed-operations.js";

export type { ScriptedGitHubRequest, ScriptedGitHubStep };

export function createScriptedGitHubAdapter(
  transcript: readonly ScriptedGitHubStep[],
) {
  const scripted = createScriptedGitHubTransport(transcript);
  return Object.freeze({
    adapter: new OctokitGitHubAdapter(scripted.transport),
    get requests(): readonly ScriptedGitHubRequest[] {
      return scripted.requests;
    },
    graphqlVariables: (operation: GraphqlReadOperation, occurrence?: number) =>
      scripted.graphqlVariables(operation, occurrence),
    graphqlDocuments: () => scripted.graphqlDocuments(),
    assertExhausted: () => scripted.assertExhausted(),
  });
}
