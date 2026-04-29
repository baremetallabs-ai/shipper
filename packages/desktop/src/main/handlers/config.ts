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

type RepoPickerRepository =
  | { nameWithOwner: string; group: 'owner' }
  | { nameWithOwner: string; group: 'other' }
  | { nameWithOwner: string; group: 'organization'; organizationLogin: string };

type RepoPickerSearchRepository = Extract<RepoPickerRepository, { group: 'owner' | 'other' }>;

interface RepoPickerSearchPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface RepoPickerSearchResult {
  repositories: RepoPickerSearchRepository[];
  pageInfo: RepoPickerSearchPageInfo;
}

interface RepoPickerSearchScope {
  viewerLogin: string;
  organizationLogins: string[];
  collaboratorRepositories: RepoPickerSearchRepository[];
}

const defaultConfig: AppConfig = { repos: [], activeRepo: '', autoMergeRepos: [] };
const repoPickerPageSize = 100;
let repoSearchScopePromise: Promise<RepoPickerSearchScope> | null = null;

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
          __typename
          login
          ... on Organization {
            viewerIsAMember
            viewerCanAdminister
          }
        }
      }
    }
  }
}
`;

const repoPickerViewerLoginQuery = `
query DesktopRepoPickerViewerLogin {
  viewer {
    login
  }
}
`;

const repoPickerOrganizationsQuery = `
query DesktopRepoPickerOrganizations($limit: Int!, $cursor: String) {
  viewer {
    organizations(first: $limit, after: $cursor) {
      nodes {
        login
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`;

const repoPickerCollaboratorRepositoriesQuery = `
query DesktopRepoPickerCollaboratorRepositories($limit: Int!, $cursor: String) {
  viewer {
    repositories(
      first: $limit
      after: $cursor
      affiliations: [COLLABORATOR]
      isArchived: false
    ) {
      nodes {
        nameWithOwner
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`;

const repoPickerSearchQuery = `
query DesktopRepoPickerSearch($searchQuery: String!, $limit: Int!, $cursor: String) {
  search(query: $searchQuery, type: REPOSITORY, first: $limit, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on Repository {
        nameWithOwner
        isArchived
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

async function githubGraphql(
  query: string,
  variables: Record<string, string | number | boolean | null | undefined>
): Promise<string> {
  const args = ['api', 'graphql', '-f', `query=${query}`];

  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) {
      continue;
    }

    args.push('-F', `${key}=${String(value)}`);
  }

  const result = await gh(args);
  return result.stdout;
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

    return repositories.nodes.flatMap<RepoPickerRepository>((node: unknown) => {
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

      if (!('__typename' in node.owner) || typeof node.owner.__typename !== 'string') {
        throw new Error('Expected repository list node owner typename.');
      }

      if (node.owner.login.toLowerCase() === viewerLogin) {
        return [{ nameWithOwner: node.nameWithOwner, group: 'owner' }];
      }

      if (node.owner.__typename === 'Organization') {
        if (
          !('viewerIsAMember' in node.owner) ||
          typeof node.owner.viewerIsAMember !== 'boolean' ||
          !('viewerCanAdminister' in node.owner) ||
          typeof node.owner.viewerCanAdminister !== 'boolean'
        ) {
          throw new Error('Expected repository list node organization viewer flags.');
        }

        if (node.owner.viewerIsAMember || node.owner.viewerCanAdminister) {
          return [
            {
              nameWithOwner: node.nameWithOwner,
              group: 'organization',
              organizationLogin: node.owner.login,
            },
          ];
        }
      }

      return [
        {
          nameWithOwner: node.nameWithOwner,
          group: 'other',
        },
      ];
    });
  } catch (error) {
    throw new Error(`Failed to parse repository list from GitHub CLI: ${toErrorMessage(error)}`);
  }
}

function parseGraphqlEnvelope(json: string, context: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error(`Expected ${context} object.`);
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
    throw new Error(`Expected ${context} data.`);
  }

  return parsed.data;
}

function parsePageInfo(value: unknown, context: string): RepoPickerSearchPageInfo {
  if (!isPlainObject(value)) {
    throw new Error(`Expected ${context} pageInfo.`);
  }

  if (!('hasNextPage' in value) || typeof value.hasNextPage !== 'boolean') {
    throw new Error(`Expected ${context} pageInfo hasNextPage.`);
  }

  if (
    !('endCursor' in value) ||
    (value.endCursor !== null && typeof value.endCursor !== 'string')
  ) {
    throw new Error(`Expected ${context} pageInfo endCursor.`);
  }

  return { hasNextPage: value.hasNextPage, endCursor: value.endCursor };
}

function requireViewer(data: Record<string, unknown>, context: string): Record<string, unknown> {
  if (!('viewer' in data) || !isPlainObject(data.viewer)) {
    throw new Error(`Expected ${context} viewer.`);
  }

  return data.viewer;
}

function parseViewerLogin(json: string): string {
  try {
    const data = parseGraphqlEnvelope(json, 'repository search viewer login');
    const viewer = requireViewer(data, 'repository search viewer login');
    if (!('login' in viewer) || typeof viewer.login !== 'string' || viewer.login.length === 0) {
      throw new Error('Expected repository search viewer login.');
    }

    return viewer.login;
  } catch (error) {
    throw new Error(
      `Failed to parse repository search viewer login from GitHub CLI: ${toErrorMessage(error)}`
    );
  }
}

function parseOrganizationPage(json: string): {
  logins: string[];
  pageInfo: RepoPickerSearchPageInfo;
} {
  try {
    const data = parseGraphqlEnvelope(json, 'repository search organizations');
    const viewer = requireViewer(data, 'repository search organizations');
    if (!('organizations' in viewer) || !isPlainObject(viewer.organizations)) {
      throw new Error('Expected repository search organizations.');
    }

    const { organizations } = viewer;
    if (!('nodes' in organizations) || !Array.isArray(organizations.nodes)) {
      throw new Error('Expected repository search organization nodes.');
    }

    return {
      logins: organizations.nodes.flatMap((node: unknown) => {
        if (node === null) {
          return [];
        }

        if (!isPlainObject(node)) {
          throw new Error('Expected repository search organization node object.');
        }

        if (!('login' in node) || typeof node.login !== 'string') {
          throw new Error('Expected repository search organization login.');
        }

        const login = node.login.trim();
        return login.length > 0 ? [login] : [];
      }),
      pageInfo: parsePageInfo(organizations.pageInfo, 'repository search organizations'),
    };
  } catch (error) {
    throw new Error(
      `Failed to parse repository search organizations from GitHub CLI: ${toErrorMessage(error)}`
    );
  }
}

function parseCollaboratorRepositoryPage(json: string): {
  repositories: RepoPickerSearchRepository[];
  pageInfo: RepoPickerSearchPageInfo;
} {
  try {
    const data = parseGraphqlEnvelope(json, 'repository search collaborator repositories');
    const viewer = requireViewer(data, 'repository search collaborator repositories');
    if (!('repositories' in viewer) || !isPlainObject(viewer.repositories)) {
      throw new Error('Expected repository search collaborator repositories.');
    }

    const { repositories } = viewer;
    if (!('nodes' in repositories) || !Array.isArray(repositories.nodes)) {
      throw new Error('Expected repository search collaborator repository nodes.');
    }

    return {
      repositories: repositories.nodes.flatMap((node: unknown) => {
        if (node === null) {
          return [];
        }

        if (!isPlainObject(node)) {
          throw new Error('Expected repository search collaborator repository node object.');
        }

        if (!('nameWithOwner' in node) || typeof node.nameWithOwner !== 'string') {
          throw new Error('Expected repository search collaborator repository nameWithOwner.');
        }

        return [{ nameWithOwner: node.nameWithOwner, group: 'other' }];
      }),
      pageInfo: parsePageInfo(repositories.pageInfo, 'repository search collaborator repositories'),
    };
  } catch (error) {
    throw new Error(
      `Failed to parse repository search collaborator repositories from GitHub CLI: ${toErrorMessage(
        error
      )}`
    );
  }
}

async function fetchRepoSearchScope(): Promise<RepoPickerSearchScope> {
  const viewerLogin = parseViewerLogin(await githubGraphql(repoPickerViewerLoginQuery, {}));
  const organizationLogins: string[] = [];
  const seenOrganizationLogins = new Set<string>();
  let organizationCursor: string | null = null;

  do {
    const page = parseOrganizationPage(
      await githubGraphql(repoPickerOrganizationsQuery, {
        limit: repoPickerPageSize,
        cursor: organizationCursor,
      })
    );

    for (const login of page.logins) {
      const loginKey = login.toLowerCase();
      if (seenOrganizationLogins.has(loginKey)) {
        continue;
      }

      seenOrganizationLogins.add(loginKey);
      organizationLogins.push(login);
    }

    organizationCursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (organizationCursor !== null);

  const collaboratorRepositories: RepoPickerSearchRepository[] = [];
  const seenCollaboratorRepositories = new Set<string>();
  let collaboratorCursor: string | null = null;

  do {
    const page = parseCollaboratorRepositoryPage(
      await githubGraphql(repoPickerCollaboratorRepositoriesQuery, {
        limit: repoPickerPageSize,
        cursor: collaboratorCursor,
      })
    );

    for (const repository of page.repositories) {
      const repoKey = toRepoKey(repository.nameWithOwner);
      if (seenCollaboratorRepositories.has(repoKey)) {
        continue;
      }

      seenCollaboratorRepositories.add(repoKey);
      collaboratorRepositories.push(repository);
    }

    collaboratorCursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (collaboratorCursor !== null);

  return { viewerLogin, organizationLogins, collaboratorRepositories };
}

async function getRepoSearchScope(): Promise<RepoPickerSearchScope> {
  repoSearchScopePromise ??= fetchRepoSearchScope();

  try {
    return await repoSearchScopePromise;
  } catch (error) {
    repoSearchScopePromise = null;
    throw error;
  }
}

function normalizeSearchTerms(query: string): string[] {
  return query
    .trim()
    .split(/[\s/]+/)
    .map((term) => term.replace(/[^A-Za-z0-9_.-]/g, ''))
    .filter((term) => term.length > 0);
}

function buildRepositorySearchQuery(query: string, scope: RepoPickerSearchScope): string {
  return [
    ...normalizeSearchTerms(query),
    'in:name',
    'archived:false',
    'fork:true',
    `user:${scope.viewerLogin}`,
    ...scope.organizationLogins.map((login) => `org:${login}`),
  ].join(' ');
}

function findCollaboratorSearchMatches(
  scope: RepoPickerSearchScope,
  query: string
): RepoPickerSearchRepository[] {
  const queryKey = toRepoKey(query);
  return scope.collaboratorRepositories.filter(
    (repository) => toRepoKey(repository.nameWithOwner) === queryKey
  );
}

function parseRepoSearchResult(json: string, viewerLogin: string): RepoPickerSearchResult {
  try {
    const data = parseGraphqlEnvelope(json, 'repository search result');
    if (!('search' in data) || !isPlainObject(data.search)) {
      throw new Error('Expected repository search result search.');
    }

    const { search } = data;
    if (!('nodes' in search) || !Array.isArray(search.nodes)) {
      throw new Error('Expected repository search result nodes.');
    }

    const viewerLoginKey = viewerLogin.toLowerCase();

    return {
      repositories: search.nodes.flatMap((node: unknown) => {
        if (node === null) {
          return [];
        }

        if (!isPlainObject(node)) {
          return [];
        }

        if (!('nameWithOwner' in node) && !('owner' in node) && !('isArchived' in node)) {
          return [];
        }

        if (!('nameWithOwner' in node) || typeof node.nameWithOwner !== 'string') {
          throw new Error('Expected repository search result node nameWithOwner.');
        }

        if (!('owner' in node) || !isPlainObject(node.owner)) {
          throw new Error('Expected repository search result node owner.');
        }

        if (!('login' in node.owner) || typeof node.owner.login !== 'string') {
          throw new Error('Expected repository search result node owner login.');
        }

        if (!('isArchived' in node) || typeof node.isArchived !== 'boolean') {
          throw new Error('Expected repository search result node isArchived.');
        }

        if (node.isArchived) {
          return [];
        }

        return [
          {
            nameWithOwner: node.nameWithOwner,
            group: node.owner.login.toLowerCase() === viewerLoginKey ? 'owner' : 'other',
          },
        ];
      }),
      pageInfo: parsePageInfo(search.pageInfo, 'repository search result'),
    };
  } catch (error) {
    throw new Error(
      `Failed to parse repository search result from GitHub CLI: ${toErrorMessage(error)}`
    );
  }
}

function mergeSearchRepositories(
  first: RepoPickerSearchRepository[],
  second: RepoPickerSearchRepository[]
): RepoPickerSearchRepository[] {
  const merged: RepoPickerSearchRepository[] = [];
  const seenRepos = new Set<string>();

  for (const repository of [...first, ...second]) {
    const repoKey = toRepoKey(repository.nameWithOwner);
    if (seenRepos.has(repoKey)) {
      continue;
    }

    seenRepos.add(repoKey);
    merged.push(repository);
  }

  return merged;
}

function parseSearchPayload(payload: unknown): { query: string; cursor: string | null } {
  if (!isPlainObject(payload) || !('query' in payload) || typeof payload.query !== 'string') {
    throw new Error('Invalid repository search payload.');
  }

  if (
    'cursor' in payload &&
    payload.cursor !== null &&
    payload.cursor !== undefined &&
    typeof payload.cursor !== 'string'
  ) {
    throw new Error('Invalid repository search payload.');
  }

  const cursor = 'cursor' in payload && typeof payload.cursor === 'string' ? payload.cursor : null;

  return { query: payload.query, cursor };
}

export function registerConfigHandlers(): void {
  ipcMain.handle('get-config', () => readConfig());
  ipcMain.handle('list-repos', async () => {
    return parseRepoList(
      await githubGraphql(repoPickerRepositoriesQuery, { limit: repoPickerPageSize })
    );
  });
  ipcMain.handle('search-repos', async (_event, payload: unknown) => {
    const parsedPayload = parseSearchPayload(payload);
    const trimmedQuery = parsedPayload.query.trim();

    if (trimmedQuery.length === 0) {
      return {
        repositories: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      } satisfies RepoPickerSearchResult;
    }

    const scope = await getRepoSearchScope();
    const searchQuery = buildRepositorySearchQuery(trimmedQuery, scope);
    const searchResult = parseRepoSearchResult(
      await githubGraphql(repoPickerSearchQuery, {
        searchQuery,
        limit: repoPickerPageSize,
        cursor: parsedPayload.cursor,
      }),
      scope.viewerLogin
    );

    if (parsedPayload.cursor !== null) {
      return searchResult;
    }

    return {
      repositories: mergeSearchRepositories(
        findCollaboratorSearchMatches(scope, trimmedQuery),
        searchResult.repositories
      ),
      pageInfo: searchResult.pageInfo,
    } satisfies RepoPickerSearchResult;
  });
  ipcMain.handle('set-config', (_event, config: unknown) => {
    const parsedConfig = parseConfig(config);
    if (parsedConfig === null) {
      throw new Error('Invalid config payload.');
    }

    writeConfig(parsedConfig.config);
  });
}
