import { createContext, useContext, type ReactNode } from 'react';

interface ProjectContextValue {
  projectId: string;
  cwd: string;
  worktreeId?: string;
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

export function ProjectProvider({
  projectId,
  cwd,
  worktreeId,
  children,
}: ProjectContextValue & { children: ReactNode }) {
  return (
    <ProjectContext.Provider value={{ projectId, cwd, worktreeId }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProjectContext(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProjectContext must be used within a ProjectProvider');
  return ctx;
}

export function useProjectContextOptional(): ProjectContextValue | undefined {
  return useContext(ProjectContext);
}
