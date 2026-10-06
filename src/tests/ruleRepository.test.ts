import { describe, expect, it } from 'vitest';
import { createDemoWorkspace } from '../models/projectFactory';
import type { WorkspaceDocument } from '../models/ruleModel';
import { RuleRepository } from '../repositories/ruleRepository';
import type { DirtyMarker, PendingDocument, WorkspaceStorage } from '../services/projectStorageService';

class MemoryStorage implements WorkspaceStorage {
  primary: unknown = null;
  fallback: unknown = null;
  pending: PendingDocument | null = null;
  dirty: DirtyMarker | null = null;
  failWrites = false;

  async readPrimary() { return this.primary ? structuredClone(this.primary) : null; }
  readFallback() { return this.fallback ? structuredClone(this.fallback) : null; }
  async write(document: WorkspaceDocument) {
    if (this.failWrites) throw new Error('存储不可用');
    const stamped = { ...document, savedAt: Date.now() };
    this.primary = structuredClone(stamped);
    this.fallback = structuredClone(stamped);
  }
  writeSync(document: WorkspaceDocument) {
    if (this.failWrites) return false;
    this.fallback = structuredClone({ ...document, savedAt: Date.now() });
    return true;
  }
  writePending(document: WorkspaceDocument) {
    this.pending = { failedAt: Date.now(), document: structuredClone(document) };
    return true;
  }
  readPending() { return this.pending ? structuredClone(this.pending) : null; }
  clearPending() { this.pending = null; }
  writeDirty(marker: DirtyMarker) { this.dirty = marker; }
  readDirty() { return this.dirty; }
  clearDirtyIfCovered(savedUpdatedAt: number) {
    if (this.dirty && this.dirty.updatedAt <= savedUpdatedAt) this.dirty = null;
  }
  clearDirty() { this.dirty = null; }
}

function documentWithProjectUpdatedAt(updatedAt: number): WorkspaceDocument {
  const workspace = createDemoWorkspace();
  return { ...workspace, projects: workspace.projects.map((project) => ({ ...project, updatedAt })) };
}

describe('RuleRepository', () => {
  it('prefers the newer localStorage copy when IndexedDB is stale after an exit flush', async () => {
    const storage = new MemoryStorage();
    storage.primary = documentWithProjectUpdatedAt(100);
    storage.fallback = documentWithProjectUpdatedAt(200);
    const result = await new RuleRepository(storage).load();
    expect(result.document?.projects[0].updatedAt).toBe(200);
    expect(result.recoveredPending).toBe(false);
    expect(result.lostUnsavedChanges).toBe(false);
  });

  it('recovers retained pending content that never reached durable storage', async () => {
    const storage = new MemoryStorage();
    storage.fallback = documentWithProjectUpdatedAt(100);
    storage.pending = { failedAt: 1, document: documentWithProjectUpdatedAt(200) };
    const repository = new RuleRepository(storage);

    const result = await repository.load();
    expect(result.recoveredPending).toBe(true);
    expect(result.document?.projects[0].updatedAt).toBe(200);
    // The retained copy survives until a save succeeds, then it is cleaned up.
    expect(storage.pending).not.toBeNull();
    await repository.save(result.document as WorkspaceDocument);
    expect(storage.pending).toBeNull();
  });

  it('drops retained pending content that is older than the saved document', async () => {
    const storage = new MemoryStorage();
    storage.fallback = documentWithProjectUpdatedAt(200);
    storage.pending = { failedAt: 1, document: documentWithProjectUpdatedAt(100) };
    const result = await new RuleRepository(storage).load();
    expect(result.recoveredPending).toBe(false);
    expect(result.document?.projects[0].updatedAt).toBe(200);
    expect(storage.pending).toBeNull();
  });

  it('flags edits that never reached storage and consumes the dirty marker', async () => {
    const storage = new MemoryStorage();
    const saved = documentWithProjectUpdatedAt(100);
    storage.fallback = saved;
    storage.dirty = { projectId: saved.projects[0].id, updatedAt: 200 };
    const result = await new RuleRepository(storage).load();
    expect(result.lostUnsavedChanges).toBe(true);
    expect(storage.dirty).toBeNull();
  });

  it('stays quiet when the dirty marker is already covered by the saved document', async () => {
    const storage = new MemoryStorage();
    const saved = documentWithProjectUpdatedAt(200);
    storage.fallback = saved;
    storage.dirty = { projectId: saved.projects[0].id, updatedAt: 200 };
    const result = await new RuleRepository(storage).load();
    expect(result.lostUnsavedChanges).toBe(false);
    expect(storage.dirty).toBeNull();
  });

  it('retains content on save failure and clears markers only when covered', async () => {
    const storage = new MemoryStorage();
    const repository = new RuleRepository(storage);
    const workspace = documentWithProjectUpdatedAt(100);

    storage.failWrites = true;
    await expect(repository.save(workspace)).rejects.toThrow('存储不可用');
    expect((storage.pending?.document as WorkspaceDocument).activeProjectId).toBe(workspace.activeProjectId);

    storage.failWrites = false;
    repository.markDirty(workspace.projects[0].id, 100);
    await repository.save(workspace);
    expect(storage.dirty).toBeNull();
    expect(storage.pending).toBeNull();

    // An edit marked dirty while a save was in flight must survive that save's cleanup.
    repository.markDirty(workspace.projects[0].id, 200);
    await repository.save(workspace);
    expect(storage.dirty).toEqual({ projectId: workspace.projects[0].id, updatedAt: 200 });
  });

  it('writes synchronously on saveSync and clears the covered dirty marker', async () => {
    const storage = new MemoryStorage();
    const repository = new RuleRepository(storage);
    const workspace = documentWithProjectUpdatedAt(100);
    repository.markDirty(workspace.projects[0].id, 100);

    expect(repository.saveSync(workspace)).toBe(true);
    expect((storage.fallback as WorkspaceDocument).activeProjectId).toBe(workspace.activeProjectId);
    expect(storage.dirty).toBeNull();

    storage.failWrites = true;
    expect(repository.saveSync(workspace)).toBe(false);
  });
});
