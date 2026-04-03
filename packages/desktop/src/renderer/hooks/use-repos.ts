import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import { toErrorMessage } from '../../../../core/src/lib/errors.js';

import { getShipperApi } from '../lib/shipper-api.js';
import { repoPattern } from '../lib/constants.js';
import type {
  AppConfig,
  BackgroundCommandsBridge,
  IssuePipelineBridge,
  Prerequisites,
} from '../types.js';

function isValidRepo(repo: string): boolean {
  return repoPattern.test(repo);
}

function toRepoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

function getPrerequisiteMessage(prerequisites: Prerequisites | null): string | null {
  if (!prerequisites) {
    return null;
  }

  if (!prerequisites.ghInstalled.ok) {
    return prerequisites.ghInstalled.message;
  }

  if (!prerequisites.ghAuth.ok) {
    return prerequisites.ghAuth.message;
  }

  return null;
}

interface UseReposOptions {
  pipelineBridgeRef: RefObject<IssuePipelineBridge | null>;
  backgroundBridgeRef: RefObject<BackgroundCommandsBridge | null>;
}

export interface UseReposResult {
  repos: string[];
  activeRepo: string;
  autoMergeRepos: Set<string>;
  prerequisites: Prerequisites | null;
  repoInitialized: boolean | null;
  isPickerOpen: boolean;
  isSavingAutoMerge: boolean;
  prerequisiteMessage: string | null;
  canFetch: boolean;
  hasActiveRepo: boolean;
  setIsPickerOpen: Dispatch<SetStateAction<boolean>>;
  checkInitState: (repo: string) => Promise<void>;
  handleAddRepo: (repo: string) => Promise<void>;
  handleSwitchRepo: (repo: string) => Promise<void>;
  handleReorderRepos: (nextRepos: string[]) => Promise<void>;
  handleCloseRepo: (repo: string) => Promise<void>;
  handleToggleAutoMerge: (repo: string) => Promise<void>;
}

export function useRepos({
  pipelineBridgeRef,
  backgroundBridgeRef,
}: UseReposOptions): UseReposResult {
  const [repos, setRepos] = useState<string[]>([]);
  const [activeRepo, setActiveRepo] = useState('');
  const [autoMergeRepos, setAutoMergeRepos] = useState<Set<string>>(new Set());
  const [prerequisites, setPrerequisites] = useState<Prerequisites | null>(null);
  const [repoInitialized, setRepoInitialized] = useState<boolean | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isSavingAutoMerge, setIsSavingAutoMerge] = useState(false);
  const initVersionRef = useRef(0);
  const autoMergeSaveInFlightRef = useRef(false);

  const prerequisiteMessage = useMemo(() => getPrerequisiteMessage(prerequisites), [prerequisites]);
  const canFetch = prerequisites !== null && prerequisiteMessage === null;
  const hasActiveRepo = activeRepo.length > 0 && isValidRepo(activeRepo);

  const persistConfig = useCallback(async (config: AppConfig) => {
    await getShipperApi().setConfig(config);
  }, []);

  const resetRepoState = useCallback(() => {
    setRepoInitialized(null);
    initVersionRef.current += 1;
  }, []);

  const checkInitState = useCallback(async (repo: string) => {
    const version = initVersionRef.current + 1;
    initVersionRef.current = version;

    try {
      const result = await getShipperApi().checkInit(repo);
      if (version !== initVersionRef.current) {
        return;
      }

      if (result.error) {
        return;
      }

      setRepoInitialized(result.initialized);
    } catch {
      if (version !== initVersionRef.current) {
        return;
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function initialize(): Promise<void> {
      try {
        const [prerequisiteResult, config] = await Promise.all([
          getShipperApi().checkPrerequisites(),
          getShipperApi().getConfig(),
        ]);

        if (cancelled) {
          return;
        }

        setPrerequisites(prerequisiteResult);
        setRepos(config.repos);
        setActiveRepo(config.activeRepo);
        setAutoMergeRepos(new Set(config.autoMergeRepos));

        if (
          prerequisiteResult.ghInstalled.ok &&
          prerequisiteResult.ghAuth.ok &&
          config.activeRepo.length > 0
        ) {
          void checkInitState(config.activeRepo);
          await pipelineBridgeRef.current?.loadIssues(config.activeRepo);
        }
      } catch (error) {
        if (!cancelled) {
          const message = toErrorMessage(error);
          pipelineBridgeRef.current?.setFetchError(`Failed to initialize desktop app: ${message}`);
        }
      }
    }

    void initialize();

    return () => {
      cancelled = true;
      initVersionRef.current += 1;
    };
  }, [checkInitState, pipelineBridgeRef]);

  const handleToggleAutoMerge = useCallback(
    async (repo: string) => {
      if (autoMergeSaveInFlightRef.current) {
        return;
      }

      autoMergeSaveInFlightRef.current = true;
      setIsSavingAutoMerge(true);

      const nextAutoMergeRepos = new Set(autoMergeRepos);
      if (nextAutoMergeRepos.has(repo)) {
        nextAutoMergeRepos.delete(repo);
      } else {
        nextAutoMergeRepos.add(repo);
      }

      try {
        await persistConfig({ repos, activeRepo, autoMergeRepos: [...nextAutoMergeRepos] });
        setAutoMergeRepos(nextAutoMergeRepos);
      } catch (error) {
        const message = toErrorMessage(error);
        pipelineBridgeRef.current?.setFetchError(
          `Failed to save auto-merge preference: ${message}`
        );
      } finally {
        autoMergeSaveInFlightRef.current = false;
        setIsSavingAutoMerge(false);
      }
    },
    [activeRepo, autoMergeRepos, persistConfig, pipelineBridgeRef, repos]
  );

  const handleAddRepo = useCallback(
    async (repo: string) => {
      const nextRepo = repo.trim();
      if (
        !isValidRepo(nextRepo) ||
        repos.some((currentRepo) => toRepoKey(currentRepo) === toRepoKey(nextRepo))
      ) {
        return;
      }

      const nextRepos = [...repos, nextRepo];

      try {
        await persistConfig({
          repos: nextRepos,
          activeRepo: nextRepo,
          autoMergeRepos: [...autoMergeRepos],
        });
        setRepos(nextRepos);
        setActiveRepo(nextRepo);
        resetRepoState();
        pipelineBridgeRef.current?.clearIssueState();

        if (canFetch) {
          void checkInitState(nextRepo);
          await pipelineBridgeRef.current?.loadIssues(nextRepo);
        }
      } catch (error) {
        const message = toErrorMessage(error);
        pipelineBridgeRef.current?.setFetchError(`Failed to save repositories: ${message}`);
      }
    },
    [
      autoMergeRepos,
      canFetch,
      checkInitState,
      persistConfig,
      pipelineBridgeRef,
      repos,
      resetRepoState,
    ]
  );

  const handleSwitchRepo = useCallback(
    async (repo: string) => {
      if (repo === activeRepo) {
        return;
      }

      try {
        await persistConfig({ repos, activeRepo: repo, autoMergeRepos: [...autoMergeRepos] });
        setActiveRepo(repo);
        resetRepoState();
        pipelineBridgeRef.current?.clearIssueState();

        if (canFetch) {
          void checkInitState(repo);
          await pipelineBridgeRef.current?.loadIssues(repo);
        }
      } catch (error) {
        const message = toErrorMessage(error);
        pipelineBridgeRef.current?.setFetchError(`Failed to save repositories: ${message}`);
      }
    },
    [
      activeRepo,
      autoMergeRepos,
      canFetch,
      checkInitState,
      persistConfig,
      pipelineBridgeRef,
      repos,
      resetRepoState,
    ]
  );

  const handleReorderRepos = useCallback(
    async (nextRepos: string[]) => {
      if (
        repos.length < 2 ||
        nextRepos.length !== repos.length ||
        nextRepos.every((repo, index) => repo === repos[index])
      ) {
        return;
      }

      const currentRepoKeys = new Set(repos.map((repo) => toRepoKey(repo)));
      const nextRepoKeys = new Set(nextRepos.map((repo) => toRepoKey(repo)));
      if (
        currentRepoKeys.size !== repos.length ||
        nextRepoKeys.size !== nextRepos.length ||
        currentRepoKeys.size !== nextRepoKeys.size
      ) {
        return;
      }

      for (const repoKey of currentRepoKeys) {
        if (!nextRepoKeys.has(repoKey)) {
          return;
        }
      }

      if (activeRepo && !nextRepos.some((repo) => toRepoKey(repo) === toRepoKey(activeRepo))) {
        return;
      }

      try {
        await persistConfig({ repos: nextRepos, activeRepo, autoMergeRepos: [...autoMergeRepos] });
        setRepos(nextRepos);
      } catch (error) {
        const message = toErrorMessage(error);
        pipelineBridgeRef.current?.setFetchError(`Failed to save repositories: ${message}`);
      }
    },
    [activeRepo, autoMergeRepos, persistConfig, pipelineBridgeRef, repos]
  );

  const handleCloseRepo = useCallback(
    async (repo: string) => {
      const index = repos.findIndex((currentRepo) => currentRepo === repo);
      if (index < 0) {
        return;
      }

      const nextRepos = repos.filter((currentRepo) => currentRepo !== repo);
      const nextActiveRepo =
        repo === activeRepo ? (nextRepos[index] ?? nextRepos.at(-1) ?? '') : activeRepo;
      const nextAutoMergeRepos = [...autoMergeRepos].filter((currentRepo) => currentRepo !== repo);

      try {
        await persistConfig({
          repos: nextRepos,
          activeRepo: nextActiveRepo,
          autoMergeRepos: nextAutoMergeRepos,
        });
        setRepos(nextRepos);
        setActiveRepo(nextActiveRepo);
        setAutoMergeRepos(new Set(nextAutoMergeRepos));
        backgroundBridgeRef.current?.clearAutoShipStateForRepo(repo);
        pipelineBridgeRef.current?.clearStageCacheForRepo(repo);

        if (repo === activeRepo) {
          resetRepoState();
          pipelineBridgeRef.current?.clearIssueState();

          if (canFetch && nextActiveRepo) {
            void checkInitState(nextActiveRepo);
            await pipelineBridgeRef.current?.loadIssues(nextActiveRepo);
          }
        }
      } catch (error) {
        const message = toErrorMessage(error);
        pipelineBridgeRef.current?.setFetchError(`Failed to save repositories: ${message}`);
      }
    },
    [
      activeRepo,
      autoMergeRepos,
      backgroundBridgeRef,
      canFetch,
      checkInitState,
      persistConfig,
      pipelineBridgeRef,
      repos,
      resetRepoState,
    ]
  );

  return {
    repos,
    activeRepo,
    autoMergeRepos,
    prerequisites,
    repoInitialized,
    isPickerOpen,
    isSavingAutoMerge,
    prerequisiteMessage,
    canFetch,
    hasActiveRepo,
    setIsPickerOpen,
    checkInitState,
    handleAddRepo,
    handleSwitchRepo,
    handleReorderRepos,
    handleCloseRepo,
    handleToggleAutoMerge,
  };
}
