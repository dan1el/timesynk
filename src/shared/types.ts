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
  tripletex?: {
    projectId: number;
    projectName: string;
    activityId: number;
    activityName: string;
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
