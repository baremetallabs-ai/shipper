import { contextBridge, ipcRenderer } from 'electron';

interface ConfigPayload {
  repos: string[];
  activeRepo: string;
}

const shipperAPI = {
  checkPrerequisites: () => ipcRenderer.invoke('check-prerequisites'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  listRepos: () => ipcRenderer.invoke('list-repos'),
  listIssues: (repo: string) => ipcRenderer.invoke('list-issues', { repo }),
  setConfig: (config: ConfigPayload) => ipcRenderer.invoke('set-config', config),
};

contextBridge.exposeInMainWorld('shipperAPI', shipperAPI);
