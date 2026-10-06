// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  pending: { document: WorkspaceDocument; savedAt: number } | null = null;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
  saveLocal(document: WorkspaceDocument) { this.document = structuredClone(document); return true; }
  loadPending() { return this.pending ? structuredClone(this.pending) : null; }
  stashPending(document: WorkspaceDocument) { this.pending = { document: structuredClone(document), savedAt: Date.now() }; return true; }
  clearPending() { this.pending = null; }
}

class FakeChecker {
  run(project: RuleProject): CheckOperation {
    return { promise: Promise.resolve(analyzeRules(project)), cancel: () => undefined };
  }
}

describe('RuleWorkspaceViewModel unload flushing (dom)', () => {
  beforeEach(() => vi.useFakeTimers());

  it('writes pending edits to local storage when the page hides', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    await vi.advanceTimersByTimeAsync(250);

    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '关闭标签页前的修改' }, '测试编辑', { recheck: false });
    // The user closes the tab inside the debounce window.
    window.dispatchEvent(new Event('pagehide'));
    expect(repository.document?.projects[0].title).toBe('关闭标签页前的修改');
    workspace.dispose();
  });

  it('flushes when the tab becomes hidden and stops listening after dispose', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    await vi.advanceTimersByTimeAsync(250);

    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '切走标签页时的修改' }, '测试编辑', { recheck: false });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(repository.document?.projects[0].title).toBe('切走标签页时的修改');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    workspace.dispose();
    const titleAfterDispose = repository.document?.projects[0].title;
    window.dispatchEvent(new Event('pagehide'));
    expect(repository.document?.projects[0].title).toBe(titleAfterDispose);
  });
});
