import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import {
  BLOCKED_LABEL,
  DESIGNED_LABEL,
  DISPLAY_NAME_MAP,
  GROOMED_LABEL,
  IMPLEMENTED_LABEL,
  LOCKED_LABEL,
  NEW_LABEL,
  PLANNED_LABEL,
  PR_OPEN_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
} from '../../../core/src/lib/labels.js';
import type { ListIssueItem } from '@dnsquared/shipper-core';

import { NewIssueDialog } from './components/new-issue-dialog.js';
import { RepoPickerDialog } from './components/repo-picker-dialog.js';
import { RepoTabBar } from './components/repo-tab-bar.js';
import type { TerminalSessionTab } from './components/session-tab-bar.js';
import { TerminalPanel } from './components/terminal-panel.js';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.js';
import { cn } from './lib/utils.js';

interface CheckResult {
  ok: boolean;
  message: string;
}

interface Prerequisites {
  ghInstalled: CheckResult;
  ghAuth: CheckResult;
}

interface AppConfig {
  repos: string[];
  activeRepo: string;
}

type TerminalSession = TerminalSessionTab;

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const PIPELINE_COLUMNS = [
  GROOMED_LABEL,
  DESIGNED_LABEL,
  PLANNED_LABEL,
  IMPLEMENTED_LABEL,
  PR_OPEN_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
] as const;

type PipelineColumnLabel = (typeof PIPELINE_COLUMNS)[number];

function isValidRepo(repo: string): boolean {
  return repoPattern.test(repo);
}

function toRepoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

function buildNewSessionLabel(request: string): string {
  return `new — ${request.trim().slice(0, 30)}`;
}

function getNextActiveSessionId(
  sessions: TerminalSession[],
  activeSessionId: string | null,
  removedSessionId: string
): string | null {
  if (activeSessionId !== removedSessionId) {
    return activeSessionId;
  }

  const removedIndex = sessions.findIndex((session) => session.id === removedSessionId);
  const remainingSessions = sessions.filter((session) => session.id !== removedSessionId);
  if (removedIndex < 0) {
    return remainingSessions[0]?.id ?? null;
  }

  return remainingSessions[removedIndex - 1]?.id ?? remainingSessions[removedIndex]?.id ?? null;
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

interface IssueCardProps {
  issue: ListIssueItem;
  onGroom?: (issueNumber: number) => void;
  groomDisabled?: boolean;
}

function IssueCard({ issue, onGroom, groomDisabled = false }: IssueCardProps): JSX.Element {
  const isBlocked = issue.labels.includes(BLOCKED_LABEL);
  const isLocked = issue.labels.includes(LOCKED_LABEL);
  const isGroomDisabled = groomDisabled || isBlocked || isLocked;

  return (
    <article className="space-y-3 rounded-sm border border-border bg-background px-4 py-4">
      <p className="text-sm font-medium text-muted-foreground">#{issue.number}</p>
      <h4 className="text-sm font-semibold leading-snug text-foreground">{issue.title}</h4>
      {isBlocked || isLocked ? (
        <div className="flex flex-wrap gap-2">
          {isBlocked ? <Badge variant="outline">Blocked</Badge> : null}
          {isLocked ? <Badge variant="outline">Locked</Badge> : null}
        </div>
      ) : null}
      {onGroom ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onGroom(issue.number);
          }}
          disabled={isGroomDisabled}
        >
          Groom
        </Button>
      ) : null}
    </article>
  );
}

export default function App(): JSX.Element {
  const [repos, setRepos] = useState<string[]>([]);
  const [activeRepo, setActiveRepo] = useState('');
  const [prerequisites, setPrerequisites] = useState<Prerequisites | null>(null);
  const [issues, setIssues] = useState<ListIssueItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isNewIssueOpen, setIsNewIssueOpen] = useState(false);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const requestVersionRef = useRef(0);
  const contentPaneRef = useRef<HTMLDivElement | null>(null);
  const toggleButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerPanelRef = useRef<HTMLDivElement | null>(null);
  const sessionsRef = useRef<TerminalSession[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const lastOutputAtBySessionRef = useRef<Map<string, number>>(new Map());

  const prerequisiteMessage = getPrerequisiteMessage(prerequisites);
  const canFetch = prerequisites !== null && prerequisiteMessage === null;
  const hasActiveRepo = activeRepo.length > 0 && isValidRepo(activeRepo);
  const hasSession = sessions.length > 0;
  const pendingCloseSession =
    pendingCloseSessionId === null
      ? null
      : (sessions.find((session) => session.id === pendingCloseSessionId) ?? null);
  const { attentionIssues, columnMap } = useMemo(() => {
    const nextColumnMap = new Map<PipelineColumnLabel, ListIssueItem[]>(
      PIPELINE_COLUMNS.map((label) => [label, []])
    );
    const nextAttentionIssues: ListIssueItem[] = [];

    for (const issue of issues) {
      if (issue.labels.includes(NEW_LABEL)) {
        nextAttentionIssues.push(issue);
        continue;
      }

      let stageLabel: PipelineColumnLabel | null = null;
      for (let index = PIPELINE_COLUMNS.length - 1; index >= 0; index -= 1) {
        const label = PIPELINE_COLUMNS[index];
        if (label && issue.labels.includes(label)) {
          stageLabel = label;
          break;
        }
      }

      if (!stageLabel) {
        continue;
      }

      const columnIssues = nextColumnMap.get(stageLabel);
      if (!columnIssues) {
        throw new Error(`Invariant failed: missing issue bucket for ${stageLabel}`);
      }

      columnIssues.push(issue);
    }

    return {
      attentionIssues: nextAttentionIssues,
      columnMap: nextColumnMap,
    };
  }, [issues]);

  function clearIssueState(): void {
    requestVersionRef.current += 1;
    setIssues([]);
    setLastUpdated(null);
    setFetchError(null);
    setIsLoading(false);
  }

  const loadIssues = useEffectEvent(async (repo: string) => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setIsLoading(true);
    setFetchError(null);

    try {
      const result = await window.shipperAPI.listIssues(repo);
      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      if (!result.ok) {
        setFetchError(result.error);
        return;
      }

      setIssues(result.issues);
      setLastUpdated(new Date());
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      setFetchError(message);
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setIsLoading(false);
      }
    }
  });

  const persistConfig = useEffectEvent(async (config: AppConfig) => {
    await window.shipperAPI.setConfig(config);
  });

  useEffect(() => {
    let cancelled = false;

    async function initialize(): Promise<void> {
      try {
        const [prerequisiteResult, config] = await Promise.all([
          window.shipperAPI.checkPrerequisites(),
          window.shipperAPI.getConfig(),
        ]);

        if (cancelled) {
          return;
        }

        setPrerequisites(prerequisiteResult);
        setRepos(config.repos);
        setActiveRepo(config.activeRepo);

        if (
          prerequisiteResult.ghInstalled.ok &&
          prerequisiteResult.ghAuth.ok &&
          config.activeRepo.length > 0
        ) {
          await loadIssues(config.activeRepo);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setFetchError(`Failed to initialize desktop app: ${message}`);
        }
      }
    }

    void initialize();

    return () => {
      cancelled = true;
      requestVersionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!canFetch || !hasActiveRepo) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadIssues(activeRepo);
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeRepo, canFetch, hasActiveRepo]);

  useEffect(() => {
    const drawerPanel = drawerPanelRef.current;
    if (!drawerPanel) {
      return;
    }

    if (drawerOpen) {
      drawerPanel.removeAttribute('inert');
      return;
    }

    drawerPanel.setAttribute('inert', '');
  }, [drawerOpen]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (pendingCloseSessionId !== null && pendingCloseSession === null) {
      setPendingCloseSessionId(null);
    }
  }, [pendingCloseSession, pendingCloseSessionId]);

  async function handleRefresh(): Promise<void> {
    if (!canFetch || !hasActiveRepo || isLoading) {
      return;
    }

    await loadIssues(activeRepo);
  }

  async function handleAddRepo(repo: string): Promise<void> {
    const nextRepo = repo.trim();
    if (
      !isValidRepo(nextRepo) ||
      repos.some((currentRepo) => toRepoKey(currentRepo) === toRepoKey(nextRepo))
    ) {
      return;
    }

    const nextRepos = [...repos, nextRepo];

    try {
      await persistConfig({ repos: nextRepos, activeRepo: nextRepo });
      setRepos(nextRepos);
      setActiveRepo(nextRepo);
      clearIssueState();

      if (canFetch) {
        await loadIssues(nextRepo);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to save repositories: ${message}`);
    }
  }

  async function handleSwitchRepo(repo: string): Promise<void> {
    if (repo === activeRepo) {
      return;
    }

    try {
      await persistConfig({ repos, activeRepo: repo });
      setActiveRepo(repo);
      clearIssueState();

      if (canFetch) {
        await loadIssues(repo);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to save repositories: ${message}`);
    }
  }

  useEffect(() => {
    const unsubscribe = window.shipperAPI.onPtyOutput((event) => {
      const outputAt = Date.now();
      lastOutputAtBySessionRef.current.set(event.sessionId, outputAt);

      const session = sessionsRef.current.find(
        (currentSession) =>
          currentSession.id === event.sessionId && currentSession.status !== 'exited'
      );
      if (!session || session.status !== 'waiting') {
        return;
      }

      setSessions((currentSessions) => {
        const sessionIndex = currentSessions.findIndex(
          (currentSession) =>
            currentSession.id === event.sessionId && currentSession.status === 'waiting'
        );
        if (sessionIndex < 0) {
          return currentSessions;
        }

        const currentSession = currentSessions[sessionIndex];
        if (!currentSession) {
          return currentSessions;
        }

        const nextSessions = [...currentSessions];
        nextSessions[sessionIndex] = { ...currentSession, status: 'running' };
        return nextSessions;
      });
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.shipperAPI.onPtyExit((event) => {
      setSessions((currentSessions) => {
        const sessionIndex = currentSessions.findIndex(
          (session) => session.id === event.sessionId && session.status !== 'exited'
        );
        if (sessionIndex < 0) {
          return currentSessions;
        }

        const session = currentSessions[sessionIndex];
        if (!session) {
          return currentSessions;
        }

        const nextSessions = [...currentSessions];
        nextSessions[sessionIndex] = { ...session, status: 'exited' };
        return nextSessions;
      });
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (sessions.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const now = Date.now();

      setSessions((currentSessions) => {
        let nextSessions: TerminalSession[] | null = null;

        for (const [index, session] of currentSessions.entries()) {
          const lastOutputAt = lastOutputAtBySessionRef.current.get(session.id);
          if (
            session.status !== 'running' ||
            lastOutputAt === undefined ||
            now - lastOutputAt <= 5_000
          ) {
            continue;
          }

          if (nextSessions === null) {
            nextSessions = [...currentSessions];
          }

          nextSessions[index] = { ...session, status: 'waiting' };
        }

        return nextSessions ?? currentSessions;
      });
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [sessions.length]);

  async function handleShipperNew(request: string): Promise<void> {
    try {
      const result = await window.shipperAPI.spawnShipperNew(request, activeRepo, 120, 30);
      const session: TerminalSession = {
        id: result.sessionId,
        label: buildNewSessionLabel(request),
        status: 'running',
      };

      lastOutputAtBySessionRef.current.set(session.id, Date.now());
      setSessions((currentSessions) => [...currentSessions, session]);
      setActiveSessionId(session.id);
      setDrawerOpen(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to launch shipper new: ${message}`);
    }
  }

  async function handleShipperGroom(issueNumber: number): Promise<void> {
    try {
      const result = await window.shipperAPI.spawnShipperGroom(issueNumber, activeRepo, 120, 30);
      const session: TerminalSession = {
        id: result.sessionId,
        label: `groom — #${issueNumber}`,
        status: 'running',
      };

      lastOutputAtBySessionRef.current.set(session.id, Date.now());
      setSessions((currentSessions) => [...currentSessions, session]);
      setActiveSessionId(session.id);
      setDrawerOpen(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to launch shipper groom: ${message}`);
    }
  }

  function handleToggleDrawer(): void {
    setDrawerOpen((current) => !current);
  }

  function focusVisibleShell(preferToggle: boolean): void {
    window.requestAnimationFrame(() => {
      if (preferToggle && toggleButtonRef.current) {
        toggleButtonRef.current.focus();
        return;
      }

      contentPaneRef.current?.focus();
    });
  }

  function removeSession(sessionId: string): void {
    const currentSessions = sessionsRef.current;
    if (!currentSessions.some((session) => session.id === sessionId)) {
      return;
    }

    const remainingSessions = currentSessions.filter((session) => session.id !== sessionId);
    const nextActiveSessionId = getNextActiveSessionId(
      currentSessions,
      activeSessionIdRef.current,
      sessionId
    );

    sessionsRef.current = remainingSessions;
    activeSessionIdRef.current = nextActiveSessionId;
    lastOutputAtBySessionRef.current.delete(sessionId);
    setSessions(remainingSessions);
    setActiveSessionId(nextActiveSessionId);
    setPendingCloseSessionId((current) => (current === sessionId ? null : current));

    if (remainingSessions.length === 0) {
      setDrawerOpen(false);
      focusVisibleShell(false);
    }
  }

  function handleSelectSession(sessionId: string): void {
    setActiveSessionId(sessionId);
  }

  function handleCloseSession(sessionId: string): void {
    const session = sessionsRef.current.find((currentSession) => currentSession.id === sessionId);
    if (!session) {
      return;
    }

    if (session.status === 'exited') {
      removeSession(sessionId);
      return;
    }

    setPendingCloseSessionId(sessionId);
  }

  function handleSessionInput(sessionId: string): void {
    lastOutputAtBySessionRef.current.set(sessionId, Date.now());

    const session = sessionsRef.current.find(
      (currentSession) => currentSession.id === sessionId && currentSession.status !== 'exited'
    );
    if (!session || session.status !== 'waiting') {
      return;
    }

    setSessions((currentSessions) => {
      const sessionIndex = currentSessions.findIndex(
        (currentSession) => currentSession.id === sessionId && currentSession.status === 'waiting'
      );
      if (sessionIndex < 0) {
        return currentSessions;
      }

      const currentSession = currentSessions[sessionIndex];
      if (!currentSession) {
        return currentSessions;
      }

      const nextSessions = [...currentSessions];
      nextSessions[sessionIndex] = { ...currentSession, status: 'running' };
      return nextSessions;
    });
  }

  async function handleConfirmCloseSession(): Promise<void> {
    const session = pendingCloseSessionId
      ? (sessionsRef.current.find(
          (currentSession) => currentSession.id === pendingCloseSessionId
        ) ?? null)
      : null;
    if (!session) {
      setPendingCloseSessionId(null);
      return;
    }

    if (session.status === 'exited') {
      setPendingCloseSessionId(null);
      removeSession(session.id);
      return;
    }

    try {
      await window.shipperAPI.ptyKill(session.id);
      setPendingCloseSessionId(null);
      removeSession(session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to close terminal session: ${message}`);
    }
  }

  async function handleCloseRepo(repo: string): Promise<void> {
    const index = repos.findIndex((currentRepo) => currentRepo === repo);
    if (index < 0) {
      return;
    }

    const nextRepos = repos.filter((currentRepo) => currentRepo !== repo);
    const nextActiveRepo =
      repo === activeRepo ? (nextRepos[index] ?? nextRepos.at(-1) ?? '') : activeRepo;

    try {
      await persistConfig({ repos: nextRepos, activeRepo: nextActiveRepo });
      setRepos(nextRepos);
      setActiveRepo(nextActiveRepo);

      if (repo === activeRepo) {
        clearIssueState();

        if (canFetch && nextActiveRepo) {
          await loadIssues(nextActiveRepo);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFetchError(`Failed to save repositories: ${message}`);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-transparent">
      <RepoPickerDialog
        open={isPickerOpen}
        onOpenChange={setIsPickerOpen}
        repos={repos}
        onSelectRepo={handleAddRepo}
      />
      <NewIssueDialog
        open={isNewIssueOpen}
        onOpenChange={setIsNewIssueOpen}
        onSubmit={(request) => {
          void handleShipperNew(request);
        }}
      />
      <Dialog
        open={pendingCloseSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingCloseSessionId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingCloseSession?.status === 'exited'
                ? 'Close terminal tab?'
                : 'Close live terminal session?'}
            </DialogTitle>
            <DialogDescription>
              {pendingCloseSession
                ? pendingCloseSession.status === 'exited'
                  ? `"${pendingCloseSession.label}" has already exited. Closing will remove its tab.`
                  : `Closing "${pendingCloseSession.label}" will kill the live process and remove its tab.`
                : 'Closing this session will remove its tab.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPendingCloseSessionId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={pendingCloseSession?.status === 'exited' ? 'default' : 'destructive'}
              onClick={() => {
                void handleConfirmCloseSession();
              }}
            >
              {pendingCloseSession?.status === 'exited' ? 'Close tab' : 'Kill session'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex min-h-0 flex-1">
        <div ref={contentPaneRef} tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto">
          <header className="sticky top-0 z-10 border-b border-border bg-background">
            <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-5">
              <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                    Shipper Desktop
                  </p>
                  <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
                </div>
                <div className="flex items-center gap-3">
                  {lastUpdated ? (
                    <p className="text-sm text-muted-foreground">
                      Last updated {dateFormatter.format(lastUpdated)}
                    </p>
                  ) : null}
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsNewIssueOpen(true);
                    }}
                    disabled={!canFetch || !hasActiveRepo}
                  >
                    New Issue
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      void handleRefresh();
                    }}
                    disabled={!canFetch || !hasActiveRepo || isLoading}
                  >
                    {isLoading ? 'Refreshing...' : 'Refresh'}
                  </Button>
                </div>
              </div>

              {repos.length > 0 ? (
                <RepoTabBar
                  repos={repos}
                  activeRepo={activeRepo}
                  onSelectRepo={(repo) => {
                    void handleSwitchRepo(repo);
                  }}
                  onCloseRepo={(repo) => {
                    void handleCloseRepo(repo);
                  }}
                  onAddRepo={() => {
                    setIsPickerOpen(true);
                  }}
                />
              ) : null}
            </div>
          </header>

          <main className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
            {prerequisiteMessage ? (
              <Alert variant="destructive">
                <AlertTitle>GitHub CLI required</AlertTitle>
                <AlertDescription>{prerequisiteMessage}</AlertDescription>
              </Alert>
            ) : null}

            {fetchError ? (
              <Alert variant="destructive" className="pr-24">
                <AlertTitle>Issue fetch failed</AlertTitle>
                <AlertDescription>{fetchError}</AlertDescription>
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute top-2 right-2"
                  onClick={() => {
                    setFetchError(null);
                  }}
                >
                  Dismiss
                </Button>
              </Alert>
            ) : null}

            {repos.length === 0 ? (
              <section className="flex min-h-[24rem] flex-col items-center justify-center rounded-sm border border-dashed border-border bg-card px-6 py-10 text-center">
                <div className="max-w-md space-y-3">
                  <h2 className="text-xl font-semibold tracking-tight">
                    Add a repository to get started
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Choose a GitHub repository to load its shipper-labeled issues into the desktop
                    inbox.
                  </p>
                  <Button
                    onClick={() => {
                      setIsPickerOpen(true);
                    }}
                  >
                    Add repository
                  </Button>
                </div>
              </section>
            ) : (
              <section className="overflow-hidden rounded-sm border border-border bg-card">
                <div className="border-b border-border px-6 py-4">
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h2 className="text-lg font-semibold">Issues by workflow stage</h2>
                      <p className="text-sm text-muted-foreground">
                        Review the current repository as a pipeline organized by shipper stage.
                      </p>
                    </div>
                    {activeRepo ? (
                      <Badge variant="outline" className="w-fit">
                        {activeRepo}
                      </Badge>
                    ) : null}
                  </div>
                </div>

                {!hasActiveRepo ? (
                  <div className="px-6 py-10 text-sm text-muted-foreground">
                    Select a repository tab to begin.
                  </div>
                ) : issues.length === 0 && !isLoading ? (
                  <div className="px-6 py-10 text-sm text-muted-foreground">
                    No shipper-labeled issues found for this repository.
                  </div>
                ) : (
                  <div className="space-y-6 px-6 py-6">
                    {attentionIssues.length > 0 ? (
                      <div className="space-y-3 border-b border-border pb-6">
                        <div>
                          <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                            Needs attention
                          </h3>
                          <p className="text-sm text-muted-foreground">
                            New issues stay here until they are groomed into the pipeline.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-3">
                          {attentionIssues.map((issue) => (
                            <div key={issue.number} className="min-w-[240px] flex-1 basis-[240px]">
                              <IssueCard
                                issue={issue}
                                onGroom={(issueNumber) => {
                                  void handleShipperGroom(issueNumber);
                                }}
                                groomDisabled={!canFetch || !hasActiveRepo}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="overflow-x-auto pb-1">
                      <div className="flex min-w-max items-start gap-4">
                        {PIPELINE_COLUMNS.map((label) => {
                          const stageIssues = columnMap.get(label) ?? [];
                          const isReadyColumn = label === READY_LABEL;

                          return (
                            <section
                              key={label}
                              className={[
                                'flex min-w-[240px] flex-1 basis-[240px] flex-col gap-4 rounded-sm border px-4 py-4',
                                isReadyColumn
                                  ? 'border-success/30 bg-success/10'
                                  : 'border-border bg-background/40',
                              ].join(' ')}
                            >
                              <div>
                                <h3 className="text-sm font-semibold">{DISPLAY_NAME_MAP[label]}</h3>
                              </div>

                              <div className="space-y-3">
                                {stageIssues.length > 0 ? (
                                  stageIssues.map((issue) => (
                                    <IssueCard key={issue.number} issue={issue} />
                                  ))
                                ) : (
                                  <p className="rounded-sm border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                                    No issues
                                  </p>
                                )}
                              </div>
                            </section>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </section>
            )}
          </main>
        </div>

        {hasSession ? (
          <>
            <button
              ref={toggleButtonRef}
              type="button"
              onClick={handleToggleDrawer}
              className="flex w-5 flex-shrink-0 items-center justify-center border-l border-border bg-background text-muted-foreground outline-none transition-[color,box-shadow] hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              aria-label={drawerOpen ? 'Close terminal drawer' : 'Open terminal drawer'}
            >
              {drawerOpen ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <ChevronLeft className="h-4 w-4" />
              )}
            </button>
            <div
              ref={drawerPanelRef}
              aria-hidden={!drawerOpen}
              className={cn(
                'flex-shrink-0 overflow-hidden transition-[width] duration-200',
                drawerOpen ? 'w-[40%]' : 'pointer-events-none w-0'
              )}
            >
              <div className="h-full min-w-[40vw]">
                <TerminalPanel
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  onSelectSession={handleSelectSession}
                  onCloseSession={handleCloseSession}
                  onSessionInput={handleSessionInput}
                />
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
