export interface TimeEntry {
  id: string;
  date: string;         // "2026-05-12"
  hours: number;
  projectId: string;
  description?: string;
  syncedAt?: string;
  externalIds: {
    tripletex?: string;
    jira?: string;
  };
}

export interface Project {
  id: string;
  displayName: string;
}

export interface ProjectMapping {
  projectId: string;
  syncDirection?: "both" | "tripletex_only"; // default "both"
  tripletex?: {
    projectId: number | null;       // null for absence activities (no project)
    projectName: string;
    activityId: number;
    activityName: string;
    isAbsence?: boolean;            // true for Ferie/Syk/Fravær etc.
  };
  jira?: {
    projectKey: string;
    projectName: string;
    issueKey?: string;
  };
}

export interface ConnectorProject {
  id: string;
  name: string;
}

export interface ConnectorActivity {
  id: string;
  name: string;
}

export interface IConnector {
  name: string;
  getProjects(): Promise<ConnectorProject[]>;
  getEntries(from: string, to: string): Promise<TimeEntry[]>;
  pushEntry(entry: TimeEntry, mapping: ProjectMapping): Promise<string>;
  updateEntry(externalId: string, entry: TimeEntry, mapping: ProjectMapping): Promise<void>;
  deleteEntry(externalId: string): Promise<void>;
}
