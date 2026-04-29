import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app, ipcMain } from 'electron';
import { gh, isPlainObject, toErrorMessage } from '@dnsquared/shipper-core';

import { parseRepo } from './shared.js';

interface AppConfig {
  repos: string[];
  activeRepo: string;
  autoMergeRepos: string[];
}

interface ParseConfigResult {
  config: AppConfig;
  changed: boolean;
}

type RepoPickerGroup = 'owner' | 'other';

interface RepoPickerRepository {
  nameWithOwner: string;
  group: RepoPickerGroup;
}

const defaultConfig: AppConfig = { repos: [], activeRepo: '', autoMergeRepos: [] };

const repoPickerRepositoriesQuery = `
query DesktopRepoPickerRepositories($limit: Int!) {
  viewer {
    login
    repositories(
      first: $limit
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      isArchived: false
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      nodes {
        nameWithOwner
        owner {
          login
        }
      }
    }
  }
}
`;

function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

function readConfig(): AppConfig {
  const configPath = getConfigPath();

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    const parsedConfig = parseConfig(parsed);
    if (parsedConfig !== null) {
      if (parsedConfig.changed) {
        writeConfig(parsedConfig.config);
      }

      return parsedConfig.config;
    }

    const legacyRepo =
      typeof parsed === 'object' && parsed !== null && 'repo' in parsed
        ? parseRepo(parsed.repo)
        : null;
    if (legacyRepo !== null) {
      const migratedConfig: AppConfig = {
        repos: [legacyRepo],
        activeRepo: legacyRepo,
        autoMergeRepos: [],
      };
      writeConfig(migratedConfig);
      return migratedConfig;
    }

    return defaultConfig;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return defaultConfig;
    }

    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return defaultConfig;
    }

    throw error;
  }
}

function writeConfig(config: AppConfig): void {
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function toRepoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

function parseConfig(value: unknown): ParseConfigResult | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('repos' in value) ||
    !Array.isArray(value.repos) ||
    !('activeRepo' in value)
  ) {
    return null;
  }

  const repos: string[] = [];
  const seenRepos = new Set<string>();
  let changed = false;

  for (const repo of value.repos) {
    const parsedRepo = parseRepo(repo);
    if (parsedRepo === null) {
      return null;
    }

    if (repo !== parsedRepo) {
      changed = true;
    }

    const repoKey = toRepoKey(parsedRepo);
    if (seenRepos.has(repoKey)) {
      changed = true;
      continue;
    }

    seenRepos.add(repoKey);
    repos.push(parsedRepo);
  }

  const repoByKey = new Map(repos.map((repo) => [toRepoKey(repo), repo]));

  if (typeof value.activeRepo !== 'string') {
    return null;
  }

  if (repos.length === 0) {
    const hasAutoMergeRepos =
      'autoMergeRepos' in value &&
      Array.isArray(value.autoMergeRepos) &&
      value.autoMergeRepos.length > 0;
    return {
      config: { repos, activeRepo: '', autoMergeRepos: [] },
      changed:
        changed ||
        value.activeRepo.trim().length > 0 ||
        !('autoMergeRepos' in value) ||
        !Array.isArray(value.autoMergeRepos) ||
        hasAutoMergeRepos,
    };
  }

  const fallbackActiveRepo = repos[0];
  if (fallbackActiveRepo === undefined) {
    return {
      config: { repos: [], activeRepo: '', autoMergeRepos: [] },
      changed: true,
    };
  }

  const autoMergeRepos: string[] = [];
  const seenAutoMergeRepos = new Set<string>();
  const rawAutoMergeRepos =
    'autoMergeRepos' in value && Array.isArray(value.autoMergeRepos) ? value.autoMergeRepos : null;

  if (rawAutoMergeRepos === null) {
    changed = true;
  } else {
    for (const repo of rawAutoMergeRepos) {
      const parsedRepo = parseRepo(repo);
      if (parsedRepo === null) {
        changed = true;
        continue;
      }

      if (repo !== parsedRepo) {
        changed = true;
      }

      const repoKey = toRepoKey(parsedRepo);
      const matchingRepo = repoByKey.get(repoKey);
      if (matchingRepo === undefined) {
        changed = true;
        continue;
      }

      if (seenAutoMergeRepos.has(repoKey)) {
        changed = true;
        continue;
      }

      seenAutoMergeRepos.add(repoKey);
      if (matchingRepo !== parsedRepo) {
        changed = true;
      }
      autoMergeRepos.push(matchingRepo);
    }
  }

  const parsedActiveRepo = parseRepo(value.activeRepo);
  if (parsedActiveRepo === null) {
    return {
      config: { repos, activeRepo: fallbackActiveRepo, autoMergeRepos },
      changed: true,
    };
  }

  const matchingActiveRepo = repos.find((repo) => toRepoKey(repo) === toRepoKey(parsedActiveRepo));
  if (matchingActiveRepo === undefined) {
    return {
      config: { repos, activeRepo: fallbackActiveRepo, autoMergeRepos },
      changed: true,
    };
  }

  return {
    config: { repos, activeRepo: matchingActiveRepo, autoMergeRepos },
    changed: changed || value.activeRepo !== matchingActiveRepo,
  };
}

function parseRepoList(json: string): RepoPickerRepository[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error('Expected a repository list object.');
    }

    if ('errors' in parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const messages = parsed.errors
        .map((error) =>
          isPlainObject(error) && typeof error.message === 'string' ? error.message.trim() : ''
        )
        .filter((message) => message.length > 0);
      throw new Error(
        messages.length > 0
          ? `GitHub GraphQL returned errors: ${messages.join('; ')}`
          : 'GitHub GraphQL returned errors.'
      );
    }

    if (!('data' in parsed) || !isPlainObject(parsed.data)) {
      throw new Error('Expected repository list data.');
    }

    const { data } = parsed;
    if (!('viewer' in data) || !isPlainObject(data.viewer)) {
      throw new Error('Expected repository list viewer.');
    }

    const { viewer } = data;
    if (!('login' in viewer) || typeof viewer.login !== 'string') {
      throw new Error('Expected repository list viewer login.');
    }

    if (!('repositories' in viewer) || !isPlainObject(viewer.repositories)) {
      throw new Error('Expected repository list repositories.');
    }

    const { repositories } = viewer;
    if (!('nodes' in repositories) || !Array.isArray(repositories.nodes)) {
      throw new Error('Expected repository list nodes.');
    }

    const viewerLogin = viewer.login.toLowerCase();

    return repositories.nodes.flatMap((node: unknown) => {
      if (node === null) {
        return [];
      }

      if (!isPlainObject(node)) {
        throw new Error('Expected repository list node object.');
      }

      if (!('nameWithOwner' in node) || typeof node.nameWithOwner !== 'string') {
        throw new Error('Expected repository list node nameWithOwner.');
      }

      if (!('owner' in node) || !isPlainObject(node.owner)) {
        throw new Error('Expected repository list node owner.');
      }

      if (!('login' in node.owner) || typeof node.owner.login !== 'string') {
        throw new Error('Expected repository list node owner login.');
      }

      return [
        {
          nameWithOwner: node.nameWithOwner,
          group: node.owner.login.toLowerCase() === viewerLogin ? 'owner' : 'other',
        },
      ];
    });
  } catch (error) {
    throw new Error(`Failed to parse repository list from GitHub CLI: ${toErrorMessage(error)}`);
  }
}

export function registerConfigHandlers(): void {
  ipcMain.handle('get-config', () => readConfig());
  ipcMain.handle('list-repos', async () => {
    const result = await gh([
      'api',
      'graphql',
      '-f',
      `query=${repoPickerRepositoriesQuery}`,
      '-F',
      'limit=100',
    ]);
    return parseRepoList(result.stdout);
  });
  ipcMain.handle('set-config', (_event, config: unknown) => {
    const parsedConfig = parseConfig(config);
    if (parsedConfig === null) {
      throw new Error('Invalid config payload.');
    }

    writeConfig(parsedConfig.config);
  });
}
