import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Store = typeof import('../shared/todo-store');

const projectId = 'p1';
const otherProjectId = 'p2';

describe('todo store', () => {
  let db: InstanceType<typeof Database>;
  let store: Store;

  beforeEach(async () => {
    vi.resetModules();

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);

      CREATE TABLE project_todos (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_id  TEXT REFERENCES project_todos(id) ON DELETE CASCADE,
        text       TEXT NOT NULL DEFAULT '',
        done       INTEGER NOT NULL DEFAULT 0,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?), (?, ?)').run(
      projectId,
      'Project one',
      otherProjectId,
      'Project two',
    );

    vi.doMock('../shared/db', () => ({ getDb: () => db }));
    store = await import('../shared/todo-store');
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('keeps new top-level items in the order they were added', () => {
    store.createTodo({ projectId, text: 'First' });
    store.createTodo({ projectId, text: 'Second' });
    store.createTodo({ projectId, text: 'Third' });

    expect(store.listTodos(projectId).map((t) => t.text)).toEqual(['First', 'Second', 'Third']);
  });

  // Sub-items are positioned within their parent, so they must not inherit the
  // top level's counter and land out of order.
  it('positions sub-items within their own parent', () => {
    const parent = store.createTodo({ projectId, text: 'Ship login' });
    store.createTodo({ projectId, text: 'Later top-level' });
    const a = store.createTodo({ projectId, text: 'Write tests', parentId: parent.id });
    const b = store.createTodo({ projectId, text: 'Wire the route', parentId: parent.id });

    expect(a.position).toBe(0);
    expect(b.position).toBe(1);
  });

  it('trims the text it stores', () => {
    expect(store.createTodo({ projectId, text: '  Ship login  ' }).text).toBe('Ship login');
  });

  it('refuses an empty todo', () => {
    expect(() => store.createTodo({ projectId, text: '   ' })).toThrow(/needs text/);
    expect(store.listTodos(projectId)).toEqual([]);
  });

  /**
   * The lead passes ids it read from an earlier tool result. A stale one from
   * another project would put the item in a tree this project never draws, so
   * it would simply vanish from the panel.
   */
  it('refuses a parent from another project', () => {
    const foreign = store.createTodo({ projectId: otherProjectId, text: 'Elsewhere' });

    expect(() => store.createTodo({ projectId, text: 'Mine', parentId: foreign.id })).toThrow(
      /No todo/,
    );
    expect(store.listTodos(projectId)).toEqual([]);
  });

  it('refuses a parent that does not exist', () => {
    expect(() => store.createTodo({ projectId, text: 'Mine', parentId: 'nope' })).toThrow(/No todo/);
  });

  it('ticks an item off', () => {
    const todo = store.createTodo({ projectId, text: 'Ship login' });

    expect(store.updateTodo(projectId, todo.id, { done: true })?.done).toBe(1);
    expect(store.updateTodo(projectId, todo.id, { done: false })?.done).toBe(0);
  });

  it('reports a missing todo rather than silently doing nothing', () => {
    expect(store.updateTodo(projectId, 'nope', { done: true })).toBeUndefined();
  });

  // Scoping the update by project is what stops one project's lead from
  // reaching into another's list.
  it('will not update a todo belonging to another project', () => {
    const foreign = store.createTodo({ projectId: otherProjectId, text: 'Elsewhere' });

    expect(store.updateTodo(projectId, foreign.id, { text: 'Hijacked' })).toBeUndefined();
    expect(store.getTodo(otherProjectId, foreign.id)?.text).toBe('Elsewhere');
  });

  it('moves an item to the top level with a null parent', () => {
    const parent = store.createTodo({ projectId, text: 'Ship login' });
    const child = store.createTodo({ projectId, text: 'Write tests', parentId: parent.id });

    expect(store.updateTodo(projectId, child.id, { parentId: null })?.parentId).toBeNull();
  });

  /**
   * Re-parenting an item under itself or its own descendant detaches that whole
   * branch into a cycle: it is no longer reachable from any root, so the panel
   * stops drawing it and there is no way to get it back.
   */
  it('refuses to make a todo its own parent', () => {
    const todo = store.createTodo({ projectId, text: 'Ship login' });

    expect(() => store.updateTodo(projectId, todo.id, { parentId: todo.id })).toThrow(/own parent/);
  });

  it('refuses to move a todo under its own sub-item', () => {
    const parent = store.createTodo({ projectId, text: 'Ship login' });
    const child = store.createTodo({ projectId, text: 'Write tests', parentId: parent.id });
    const grandchild = store.createTodo({ projectId, text: 'Cover errors', parentId: child.id });

    expect(() => store.updateTodo(projectId, parent.id, { parentId: grandchild.id })).toThrow(
      /own sub-item/,
    );
    expect(store.getTodo(projectId, parent.id)?.parentId).toBeNull();
  });

  it('deletes sub-items along with their parent', () => {
    const parent = store.createTodo({ projectId, text: 'Ship login' });
    store.createTodo({ projectId, text: 'Write tests', parentId: parent.id });

    expect(store.deleteTodo(projectId, parent.id)).toBe(true);
    expect(store.listTodos(projectId)).toEqual([]);
  });

  it('will not delete a todo belonging to another project', () => {
    const foreign = store.createTodo({ projectId: otherProjectId, text: 'Elsewhere' });

    expect(store.deleteTodo(projectId, foreign.id)).toBe(false);
    expect(store.getTodo(otherProjectId, foreign.id)).toBeTruthy();
  });

  describe('outline', () => {
    it('indents sub-items and carries the ids the tools take', () => {
      const parent = store.createTodo({ projectId, text: 'Ship login' });
      const child = store.createTodo({ projectId, text: 'Write tests', parentId: parent.id });
      store.updateTodo(projectId, child.id, { done: true });

      expect(store.renderTodoOutline(projectId)).toBe(
        `- [ ] Ship login (${parent.id})\n  - [x] Write tests (${child.id})`,
      );
    });

    it('says so when there is nothing on the list', () => {
      expect(store.renderTodoOutline(projectId)).toBe('No todos yet.');
    });

    it('shows only this project\'s todos', () => {
      store.createTodo({ projectId, text: 'Mine' });
      store.createTodo({ projectId: otherProjectId, text: 'Theirs' });

      expect(store.renderTodoOutline(projectId)).toContain('Mine');
      expect(store.renderTodoOutline(projectId)).not.toContain('Theirs');
    });

    /**
     * An item whose parent is not in this project's tree is unreachable by the
     * walk. Dropping it would tell the lead the work does not exist, so it
     * would plan around a gap it cannot see.
     */
    it('still lists an item whose parent is unreachable', () => {
      const orphan = store.createTodo({ projectId, text: 'Orphan' });
      db.prepare('UPDATE project_todos SET parent_id = ? WHERE id = ?').run(null, orphan.id);
      db.prepare('PRAGMA foreign_keys = OFF').run();
      db.prepare('UPDATE project_todos SET parent_id = ? WHERE id = ?').run('ghost', orphan.id);

      expect(store.renderTodoOutline(projectId)).toContain('Orphan');
    });
  });
});
