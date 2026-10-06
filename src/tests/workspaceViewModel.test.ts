import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import { createDemoWorkspace } from '../models/projectFactory';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  pending: WorkspaceDocument | null = null;
  dirty: { projectId: string; updatedAt: number } | null = null;
  failNextSave: Error | null = null;
  recoveredOnLoad = false;
  lostOnLoad = false;

  async load() {
    return {
      document: this.document ? structuredClone(this.document) : null,
      recoveredPending: this.recoveredOnLoad,
      lostUnsavedChanges: this.lostOnLoad,
    };
  }
  async save(document: WorkspaceDocument) {
    if (this.failNextSave) {
      const error = this.failNextSave;
      this.failNextSave = null;
      this.pending = structuredClone(document);
      throw error;
    }
    this.document = structuredClone(document);
    this.pending = null;
    this.dirty = null;
  }
  saveSync(document: WorkspaceDocument) {
    this.document = structuredClone(document);
    this.pending = null;
    this.dirty = null;
    return true;
  }
  markDirty(projectId: string, updatedAt: number) {
    this.dirty = { projectId, updatedAt };
  }
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

  it('flushes debounced edits synchronously when the page is about to unload', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '关闭前的最后修改' }, '测试编辑', { recheck: false });
    // The edit is still inside the debounce window, so nothing has been written yet.
    expect(repository.document?.projects[0].title).not.toBe('关闭前的最后修改');
    expect(repository.dirty).not.toBeNull();

    workspace.flushOnExit();
    expect(repository.document?.projects[0].title).toBe('关闭前的最后修改');
    expect(repository.dirty).toBeNull();
    workspace.dispose();
  });

  it('skips the exit flush once every edit has reached durable storage', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    const savedDocument = repository.document;
    workspace.flushOnExit();
    expect(repository.document).toBe(savedDocument);
    workspace.dispose();
  });

  it('keeps unsaved content with a sticky error when saving fails and recovers on retry', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    await vi.advanceTimersByTimeAsync(250);
    const current = workspace.getSnapshot().project as RuleProject;

    repository.failNextSave = new Error('本地存储空间不足');
    workspace.commitProject({ ...current, title: '写不进去的修改' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    expect(workspace.getSnapshot().persistence).toBe('error');
    expect(workspace.getSnapshot().saveError).toBe('本地存储空间不足');
    // The rejected content is retained so a later session can recover it.
    expect(repository.pending?.projects[0].title).toBe('写不进去的修改');
    expect(repository.document?.projects[0].title).not.toBe('写不进去的修改');

    workspace.retrySave();
    await vi.advanceTimersByTimeAsync(250);
    expect(workspace.getSnapshot().persistence).toBe('saved');
    expect(workspace.getSnapshot().lastSavedAt).toEqual(expect.any(Number));
    expect(repository.document?.projects[0].title).toBe('写不进去的修改');
    expect(repository.pending).toBeNull();
    workspace.dispose();
  });

  it('re-saves immediately when retained pending content was recovered on load', async () => {
    const repository = new MemoryRepository();
    repository.document = createDemoWorkspace();
    repository.recoveredOnLoad = true;
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    expect(workspace.getSnapshot().notice).toContain('已恢复');
    expect(workspace.getSnapshot().persistence).toBe('saving');

    await vi.advanceTimersByTimeAsync(250);
    expect(workspace.getSnapshot().persistence).toBe('saved');
    workspace.dispose();
  });

  it('warns about edits lost before the previous exit until the next successful save', async () => {
    const repository = new MemoryRepository();
    repository.document = createDemoWorkspace();
    repository.lostOnLoad = true;
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    expect(workspace.getSnapshot().lostUnsavedChanges).toBe(true);
    expect(workspace.getSnapshot().notice).toContain('未能保存');

    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '重新修改' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    expect(workspace.getSnapshot().lostUnsavedChanges).toBe(false);
    workspace.dispose();
  });
});
