import { contextBridge, ipcRenderer } from 'electron';

const shipperAPI = {
  checkPrerequisites: () => ipcRenderer.invoke('check-prerequisites'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  listIssues: (repo: string) => ipcRenderer.invoke('list-issues', { repo }),
  setConfig: (config: { repo: string }) => ipcRenderer.invoke('set-config', config),
};

contextBridge.exposeInMainWorld('shipperAPI', shipperAPI);
