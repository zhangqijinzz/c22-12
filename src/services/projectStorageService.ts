import type { WorkspaceDocument } from '../models/ruleModel';

const DATABASE_NAME = 'ruleweave-db';
const STORE_NAME = 'workspace';
const DOCUMENT_KEY = 'ruleweave.workspace.v1';
const PENDING_KEY = 'ruleweave.workspace.pending.v1';

export interface PendingDocument {
  savedAt: number;
  reason: string;
  document: unknown;
}

export class ProjectStorageService {
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
    try {
      await this.writeIndexedDb(document);
      // IndexedDB has committed, so a local fallback quota error is non-fatal.
      this.writeLocal(document);
      return;
    } catch (indexedDbError) {
      if (this.writeLocal(document)) return;
      throw new Error(`无法保存规则项目：${indexedDbError instanceof Error ? indexedDbError.message : '浏览器存储不可用'}`);
    }
  }

  // Synchronous best-effort write used when the page is unloading, where async IndexedDB
  // commits are not guaranteed to finish. Returns whether the document was persisted.
  writeLocal(document: WorkspaceDocument): boolean {
    try {
      globalThis.localStorage?.setItem(DOCUMENT_KEY, JSON.stringify(document));
      return true;
    } catch {
      return false;
    }
  }

  // The pending slot retains the latest document when a save could not be committed,
  // so unsaved changes survive a reload and can be recovered on the next start.
  writePending(document: WorkspaceDocument, reason: string): boolean {
    try {
      const record: PendingDocument = { savedAt: Date.now(), reason, document };
      globalThis.localStorage?.setItem(PENDING_KEY, JSON.stringify(record));
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
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Partial<PendingDocument>;
      if (typeof record.savedAt !== 'number' || record.document === undefined || record.document === null) return null;
      return { savedAt: record.savedAt, reason: typeof record.reason === 'string' ? record.reason : '', document: record.document };
    } catch {
      return null;
    }
  }

  clearPending(): void {
    try {
      globalThis.localStorage?.removeItem(PENDING_KEY);
    } catch {
      // A restricted storage can reject removals; the stale record is filtered out on load.
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
