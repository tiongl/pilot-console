import { randomUUID } from 'crypto';
import { getDb } from './db';

export interface Todo {
  id: string;
  projectId: string;
  parentId: string | null;
  text: string;
  done: number;
  position: number;
  createdAt: string | null;
}

const SELECT = `
  SELECT id, project_id AS projectId, parent_id AS parentId, text, done, position,
         created_at AS createdAt
  FROM project_todos
`;

/** Ordered as the panel draws them: siblings by position, oldest first on ties. */
export function listTodos(projectId: string): Todo[] {
  return getDb()
    .prepare(`${SELECT} WHERE project_id = ? ORDER BY position, created_at`)
    .all(projectId) as Todo[];
}

export function getTodo(projectId: string, id: string): Todo | undefined {
  return getDb().prepare(`${SELECT} WHERE id = ? AND project_id = ?`).get(id, projectId) as
    | Todo
    | undefined;
}

/**
 * A parent from another project would put the item in a tree the panel never
 * draws, so it would vanish. The lead passes ids it read from a tool result, so
 * this is the boundary that has to catch a stale or mistyped one.
 */
function assertParent(projectId: string, parentId: string | null | undefined): string | null {
  if (!parentId) return null;
  const parent = getTodo(projectId, parentId);
  if (!parent) throw new Error(`No todo ${parentId} in this project`);
  return parent.id;
}

export function createTodo(input: {
  projectId: string;
  text: string;
  parentId?: string | null;
}): Todo {
  const text = input.text.trim();
  if (!text) throw new Error('A todo needs text');
  const parentId = assertParent(input.projectId, input.parentId);

  const db = getDb();
  const id = randomUUID();
  const { maxPos } = db
    .prepare(
      'SELECT COALESCE(MAX(position), -1) AS maxPos FROM project_todos WHERE project_id = ? AND parent_id IS ?',
    )
    .get(input.projectId, parentId) as { maxPos: number };
  db.prepare(
    'INSERT INTO project_todos (id, project_id, parent_id, text, position) VALUES (?, ?, ?, ?, ?)',
  ).run(id, input.projectId, parentId, text, maxPos + 1);

  return getTodo(input.projectId, id)!;
}

export interface TodoPatch {
  text?: string;
  done?: boolean;
  parentId?: string | null;
  position?: number;
}

export function updateTodo(projectId: string, id: string, patch: TodoPatch): Todo | undefined {
  if (!getTodo(projectId, id)) return undefined;

  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.text !== undefined) {
    const text = patch.text.trim();
    if (!text) throw new Error('A todo needs text');
    sets.push('text = ?');
    values.push(text);
  }
  if (patch.done !== undefined) {
    sets.push('done = ?');
    values.push(patch.done ? 1 : 0);
  }
  if (patch.parentId !== undefined) {
    // Re-parenting under itself or its own descendant detaches that whole
    // branch into a cycle no query would ever reach again.
    if (patch.parentId === id) throw new Error('A todo cannot be its own parent');
    const parentId = assertParent(projectId, patch.parentId);
    if (parentId && descendantIds(projectId, id).has(parentId)) {
      throw new Error('A todo cannot be moved under its own sub-item');
    }
    sets.push('parent_id = ?');
    values.push(parentId);
  }
  if (patch.position !== undefined) {
    sets.push('position = ?');
    values.push(patch.position);
  }
  if (sets.length === 0) return getTodo(projectId, id);

  values.push(id, projectId);
  getDb()
    .prepare(`UPDATE project_todos SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`)
    .run(...values);
  return getTodo(projectId, id);
}

function descendantIds(projectId: string, rootId: string): Set<string> {
  const todos = listTodos(projectId);
  const found = new Set<string>();
  const walk = (parentId: string) => {
    for (const todo of todos) {
      if (todo.parentId === parentId && !found.has(todo.id)) {
        found.add(todo.id);
        walk(todo.id);
      }
    }
  };
  walk(rootId);
  return found;
}

/** Sub-items go with it: `project_todos.parent_id` cascades on delete. */
export function deleteTodo(projectId: string, id: string): boolean {
  return (
    getDb().prepare('DELETE FROM project_todos WHERE id = ? AND project_id = ?').run(id, projectId)
      .changes > 0
  );
}

/**
 * The list an agent reads. Ids are included because every other todo tool takes
 * one, and the indentation is what tells it which items are sub-items.
 */
export function renderTodoOutline(projectId: string): string {
  const todos = listTodos(projectId);
  if (todos.length === 0) return 'No todos yet.';

  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const todo of todos.filter((t) => t.parentId === parentId)) {
      lines.push(`${'  '.repeat(depth)}- [${todo.done ? 'x' : ' '}] ${todo.text} (${todo.id})`);
      walk(todo.id, depth + 1);
    }
  };
  walk(null, 0);

  // An item whose parent was deleted mid-write, or that arrived with a parent
  // from another project, would otherwise be silently missing from the outline.
  const rendered = new Set(lines.map((line) => line.slice(line.lastIndexOf('(') + 1, -1)));
  for (const todo of todos) {
    if (!rendered.has(todo.id)) {
      lines.push(`- [${todo.done ? 'x' : ' '}] ${todo.text} (${todo.id})`);
    }
  }
  return lines.join('\n');
}
