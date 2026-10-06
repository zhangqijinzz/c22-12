import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  pending: { document: WorkspaceDocument; savedAt: number } | null = null;
  failNextSave: Error | null = null;
  failLocal = false;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async save(document: WorkspaceDocument) {
    if (this.failNextSave) {
      const error = this.failNextSave;
      this.failNextSave = null;
      throw error;
    }
    this.document = structuredClone(document);
  }
  saveLocal(document: WorkspaceDocument) {
    if (this.failLocal) return false;
    this.document = structuredClone(document);
    return true;
  }
  loadPending() { return this.pending ? structuredClone(this.pending) : null; }
  stashPending(document: WorkspaceDocument) { this.pending = { document: structuredClone(document), savedAt: Date.now() }; return true; }
  clearPending() { this.pending = null; }
}

class FakeChecker {
  calls = 0;
  nextError: Error | null = null;
  cancelled = false;

  run(project: RuleProject): CheckOperation {
    this.calls += 1;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return { promise: Promise.reject(error), cancel: () => { this.cancelled = true; } };
    }
    return { promise: Promise.resolve(analyzeRules(project)), cancel: () => { this.cancelled = true; } };
  }
}

describe('RuleWorkspaceViewModel', () => {
  beforeEach(() => vi.useFakeTimers());

  it('initializes a usable demo, runs checks, persists edits, and recovers the workspace', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    expect(workspace.getSnapshot().project?.rules).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '已修改策略' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    expect(repository.document?.projects[0].title).toBe('已修改策略');

    const restored = new RuleWorkspaceViewModel(repository, checker);
    await restored.start();
    expect(restored.getSnapshot().project?.title).toBe('已修改策略');
    restored.dispose();
    workspace.dispose();
  });

  it('shows check errors and recovers on the next successful run', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    checker.nextError = new Error('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().phase).toBe('error');
    expect(workspace.getSnapshot().notice).toBe('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    workspace.dispose();
  });

  it('marks cancellation and blocks checks for invalid projects', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    const project = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...project, fields: project.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) });
    expect(workspace.getSnapshot().phase).toBe('validating');
    const callsBefore = checker.calls;
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('error');
    expect(checker.calls).toBe(callsBefore);
    workspace.dispose();
  });

  it('saves versions, freezes and resumes a version, and copies it into a new project', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.saveVersion();
    const savedVersion = workspace.getSnapshot().project?.versions[0];
    expect(savedVersion?.frozen).toBe(false);

    workspace.freezeCurrent();
    const frozen = workspace.getSnapshot().project;
    expect(frozen?.frozenVersionId).toBe(frozen?.versions[0].id);
    expect(workspace.commitProject({ ...(frozen as RuleProject), title: '不允许修改' })).toBe(false);

    workspace.restoreVersion(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().project?.frozenVersionId).toBeUndefined();
    workspace.copyVersionToProject(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    workspace.dispose();
  });

  it('flushes unsaved changes synchronously on unload instead of waiting for the debounce', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    await vi.advanceTimersByTimeAsync(250);
    const savedTitle = repository.document?.projects[0].title;

    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '离开前的最后修改' }, '测试编辑', { recheck: false });
    // The page hides before the 220ms debounce fires: the pending edit must still be written.
    workspace.flushSync();
    expect(repository.document?.projects[0].title).toBe('离开前的最后修改');
    expect(repository.document?.projects[0].title).not.toBe(savedTitle);

    // A second flush with nothing new to write is a no-op and must not throw.
    workspace.flushSync();
    workspace.dispose();
  });

  it('retains the document in the pending slot when saving fails and clears it after a retry', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    await vi.advanceTimersByTimeAsync(250);

    const current = workspace.getSnapshot().project as RuleProject;
    repository.failNextSave = new Error('存储已满');
    workspace.commitProject({ ...current, title: '写不进去的修改' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();

    expect(workspace.getSnapshot().persistence).toBe('error');
    expect(workspace.getSnapshot().saveError).toBe('存储已满');
    expect(workspace.getSnapshot().pendingRetained).toBe(true);
    expect(repository.pending?.document.projects[0].title).toBe('写不进去的修改');
    expect(repository.document?.projects[0].title).not.toBe('写不进去的修改');

    await workspace.retrySave();
    expect(workspace.getSnapshot().persistence).toBe('saved');
    expect(workspace.getSnapshot().pendingRetained).toBeUndefined();
    expect(repository.pending).toBeNull();
    expect(repository.document?.projects[0].title).toBe('写不进去的修改');
    workspace.dispose();
  });

  it('recovers a newer pending document on start and re-saves it', async () => {
    const repository = new MemoryRepository();
    const first = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await first.start();
    await vi.advanceTimersByTimeAsync(250);
    const current = first.getSnapshot().project as RuleProject;
    first.commitProject({ ...current, title: '没来得及保存的标题' }, '测试编辑', { recheck: false });
    // Storage breaks right as the page unloads: the edit only survives in the pending slot.
    repository.failLocal = true;
    first.flushSync();
    expect(repository.document?.projects[0].title).not.toBe('没来得及保存的标题');
    expect(repository.pending?.document.projects[0].title).toBe('没来得及保存的标题');
    first.dispose();
    repository.failLocal = false;

    const restored = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await restored.start();
    expect(restored.getSnapshot().project?.title).toBe('没来得及保存的标题');
    expect(restored.getSnapshot().notice).toContain('已恢复上次未能保存的更改');
    await vi.advanceTimersByTimeAsync(250);
    await restored.flushSave();
    expect(restored.getSnapshot().persistence).toBe('saved');
    expect(repository.pending).toBeNull();
    expect(repository.document?.projects[0].title).toBe('没来得及保存的标题');
    restored.dispose();
  });

  it('drops a stale pending record instead of rolling back newer saved content', async () => {
    const repository = new MemoryRepository();
    const first = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await first.start();
    await vi.advanceTimersByTimeAsync(250);
    const current = first.getSnapshot().project as RuleProject;
    first.commitProject({ ...current, title: '较新的已保存标题' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    await first.flushSave();
    first.dispose();

    // A leftover pending record from an older revision must not win over the saved copy.
    const stale = structuredClone(repository.document) as WorkspaceDocument;
    stale.projects[0] = { ...stale.projects[0], title: '过时的待写内容', updatedAt: 1 };
    repository.pending = { document: stale, savedAt: Date.now() };

    const restored = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await restored.start();
    expect(restored.getSnapshot().project?.title).toBe('较新的已保存标题');
    expect(repository.pending).toBeNull();
    restored.dispose();
  });
});
