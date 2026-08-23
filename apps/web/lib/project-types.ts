export interface Project {
  id: string;
  name: string;
  path: string | null;
  description: string | null;
  node_count: number;
  edge_count: number;
  graph_hash: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
  task_count?: number;
  version_status: string;
  effective_version_status: string;
  folder_id: string | null;
}

export interface ProjectFolder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}
