import type { WorkspaceDocument } from '../models/ruleModel';

const DATABASE_NAME = 'ruleweave-db';
const STORE_NAME = 'workspace';
const DOCUMENT_KEY = 'ruleweave.workspace.v1';
const PENDING_KEY = 'ruleweave.workspace.pending.v1';
const DIRTY_KEY = 'ruleweave.workspace.dirty.v1';

export interface DirtyMarker {
  projectId: string;
  updatedAt: number;
}

export interface PendingDocument {
  failedAt: number;
  document: unknown;
}

export interface WorkspaceStorage {
  readPrimary(): Promise<unknown | null>;
  readFallback(): unknown | null;
  write(document: WorkspaceDocument): Promise<void>;
  writeSync(document: WorkspaceDocument): boolean;
  writePending(document: WorkspaceDocument): boolean;
  readPending(): PendingDocument | null;
  clearPending(): void;
  writeDirty(marker: DirtyMarker): void;
  readDirty(): DirtyMarker | null;
  clearDirtyIfCovered(savedUpdatedAt: number): void;
  clearDirty(): void;
}

export class ProjectStorageService implements WorkspaceStorage {
  async readPrimary(): Promise<unknown | null> {
    try {
      return await this.readIndexedDb();
    } catch {
      // The local fallback keeps the workspace usable when browser storage is restricted.
      return null;
    }
  }

  readFallback(): unknown | null {
    try {
      const serialized = globalThis.localStorage?.getItem(DOCUMENT_KEY);
      return serialized ? JSON.parse(serialized) as unknown : null;
    } catch {
      return null;
    }
  }

  async write(document: WorkspaceDocument): Promise<void> {
    const stamped = { ...document, savedAt: Date.now() };
    try {
      await this.writeIndexedDb(stamped);
      try {
        globalThis.localStorage?.setItem(DOCUMENT_KEY, JSON.stringify(stamped));
      } catch {
        // IndexedDB has committed, so a local fallback quota error is non-fatal.
      }
      return;
    } catch (indexedDbError) {
      try {
        const storage = globalThis.localStorage;
        if (!storage) throw indexedDbError;
        storage.setItem(DOCUMENT_KEY, JSON.stringify(stamped));
        return;
      } catch {
        throw new Error(`无法保存规则项目：${indexedDbError instanceof Error ? indexedDbError.message : '浏览器存储不可用'}`);
      }
    }
  }

  // Synchronous fallback write used when the page is about to unload and async
  // IndexedDB transactions are no longer guaranteed to finish.
  writeSync(document: WorkspaceDocument): boolean {
    try {
      const storage = globalThis.localStorage;
      if (!storage) return false;
      storage.setItem(DOCUMENT_KEY, JSON.stringify({ ...document, savedAt: Date.now() }));
      return true;
    } catch {
      return false;
    }
  }

  // Retains the content that could not be written so a later session can recover it.
  writePending(document: WorkspaceDocument): boolean {
    try {
      const storage = globalThis.localStorage;
      if (!storage) return false;
      storage.setItem(PENDING_KEY, JSON.stringify({ failedAt: Date.now(), document }));
      return true;
    } catch {
      return false;
    }
  }

  readPending(): PendingDocument | null {
    try {
      const serialized = globalThis.localStorage?.getItem(PENDING_KEY);
      if (!serialized) return null;
      const parsed = JSON.parse(serialized) as unknown;
      if (typeof parsed !== 'object' || parsed === null || !('document' in parsed)) return null;
      const record = parsed as { failedAt?: unknown; document: unknown };
      return { failedAt: typeof record.failedAt === 'number' ? record.failedAt : 0, document: record.document };
    } catch {
      return null;
    }
  }

  clearPending(): void {
    try {
      globalThis.localStorage?.removeItem(PENDING_KEY);
    } catch {
      // A restricted storage can stay dirty; the next successful save retries the cleanup.
    }
  }

  // Records the newest edit that has not reached durable storage yet, so a hard
  // crash or killed tab can be detected on the next launch.
  writeDirty(marker: DirtyMarker): void {
    try {
      globalThis.localStorage?.setItem(DIRTY_KEY, JSON.stringify(marker));
    } catch {
      // Best effort only; losing the marker degrades detection, not data.
    }
  }

  readDirty(): DirtyMarker | null {
    try {
      const serialized = globalThis.localStorage?.getItem(DIRTY_KEY);
      if (!serialized) return null;
      const parsed = JSON.parse(serialized) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as { projectId?: unknown; updatedAt?: unknown };
      if (typeof record.projectId === 'string' && typeof record.updatedAt === 'number') {
        return { projectId: record.projectId, updatedAt: record.updatedAt };
      }
      return null;
    } catch {
      return null;
    }
  }

  clearDirtyIfCovered(savedUpdatedAt: number): void {
    const marker = this.readDirty();
    if (marker && marker.updatedAt <= savedUpdatedAt) this.clearDirty();
  }

  clearDirty(): void {
    try {
      globalThis.localStorage?.removeItem(DIRTY_KEY);
    } catch {
      // Best effort only.
    }
  }

  private async readIndexedDb(): Promise<unknown | null> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get('active');
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error('读取 IndexedDB 失败'));
    });
  }

  private async writeIndexedDb(document: WorkspaceDocument): Promise<void> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(document, 'active');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('写入 IndexedDB 失败'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 写入已中止'));
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (!globalThis.indexedDB) return Promise.reject(new Error('当前环境不支持 IndexedDB'));
    return new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'));
    });
  }
}
