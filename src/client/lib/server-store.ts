import { create } from 'zustand';

export interface ManagedServer {
  id: string;
  projectId: string;
  sessionId: string;
  name: string;
  status: 'pending' | 'starting' | 'running' | 'stopped' | 'failed';
  command: string;
  createdAt: string;
}

interface ServerStore {
  serversByProject: Map<string, ManagedServer[]>;
  addServer: (server: ManagedServer) => void;
  removeServer: (projectId: string, serverId: string) => void;
  updateServer: (projectId: string, serverId: string, updates: Partial<ManagedServer>) => void;
  getServersByProject: (projectId: string) => ManagedServer[];
  clearProject: (projectId: string) => void;
}

export const useServerStore = create<ServerStore>((set, get) => ({
  serversByProject: new Map(),

  addServer: (server: ManagedServer) => {
    set((state) => {
      const map = new Map(state.serversByProject);
      const servers = map.get(server.projectId) ?? [];
      map.set(server.projectId, [...servers, server]);
      return { serversByProject: map };
    });
  },

  removeServer: (projectId: string, serverId: string) => {
    set((state) => {
      const map = new Map(state.serversByProject);
      const servers = (map.get(projectId) ?? []).filter((s) => s.id !== serverId);
      if (servers.length === 0) {
        map.delete(projectId);
      } else {
        map.set(projectId, servers);
      }
      return { serversByProject: map };
    });
  },

  updateServer: (projectId: string, serverId: string, updates: Partial<ManagedServer>) => {
    set((state) => {
      const map = new Map(state.serversByProject);
      const servers = map.get(projectId) ?? [];
      const updated = servers.map((s) => (s.id === serverId ? { ...s, ...updates } : s));
      map.set(projectId, updated);
      return { serversByProject: map };
    });
  },

  getServersByProject: (projectId: string) => {
    return get().serversByProject.get(projectId) ?? [];
  },

  clearProject: (projectId: string) => {
    set((state) => {
      const map = new Map(state.serversByProject);
      map.delete(projectId);
      return { serversByProject: map };
    });
  },
}));
