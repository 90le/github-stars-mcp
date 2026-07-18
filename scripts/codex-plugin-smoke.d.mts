export interface LocalPluginFixtureInput {
  installedPackageRoot: string;
  marketplaceRoot: string;
  repositoryRoot?: string;
}

export interface LocalPluginFixture {
  marketplaceRoot: string;
  marketplaceName: string;
  pluginRoot: string;
  pluginSelector: string;
  cliPath: string;
}

export function createLocalPluginFixture(
  input: LocalPluginFixtureInput,
): Promise<LocalPluginFixture>;
