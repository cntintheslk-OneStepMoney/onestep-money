import fs from 'node:fs/promises';
import path from 'node:path';

export const IMPORT_OUTCOMES = Object.freeze({
  READY: 'ready',
  DUPLICATE: 'duplicate',
  PENDING: 'pending',
  NEEDS_REVIEW: 'needs_review',
  FAILED: 'failed'
});

export function completedImportForDocument(state, documentId) {
  return state.importBatches.some((batch) => batch.documentId === documentId);
}

export function classifyKnownDocument(state, document, pendingDocumentIds = new Set()) {
  if (completedImportForDocument(state, document.id) || document.parseStatus === 'imported') return IMPORT_OUTCOMES.DUPLICATE;
  if (pendingDocumentIds.has(document.id)) return IMPORT_OUTCOMES.PENDING;
  return IMPORT_OUTCOMES.READY;
}

export class DocumentImportCoordinator {
  constructor({ store, extractPdfDocument, parseImportedDocument, recordFailure, canonicalDocumentName }) {
    this.store = store;
    this.extractPdfDocument = extractPdfDocument;
    this.parseImportedDocument = parseImportedDocument;
    this.recordFailure = recordFailure;
    this.canonicalDocumentName = canonicalDocumentName;
    this.pendingDocumentIds = new Set();
    this.tail = Promise.resolve();
  }

  processSelection(options) {
    const operation = this.tail.then(() => this.processSelectionNow(options));
    this.tail = operation.catch(() => {});
    return operation;
  }

  reconcilePending(state) {
    for (const id of this.pendingDocumentIds) {
      const document = state.documents.find((item) => item.id === id);
      if (!document || document.deletedAt || document.parseStatus === 'imported' || document.parseStatus === 'needs_review' || completedImportForDocument(state, id)) {
        this.pendingDocumentIds.delete(id);
      }
    }
  }

  async processSelectionNow({ filePaths, kind, accountId = '', getState, saveState }) {
    let state = getState();
    this.reconcilePending(state);
    const results = [];
    let stateChanged = false;
    let backupCreated = false;

    const ensureBackup = async () => {
      if (backupCreated) return;
      await this.store.createAutomaticBackup('before-import');
      backupCreated = true;
    };

    for (const filePath of filePaths) {
      const extension = path.extname(filePath).toLowerCase();
      let document;
      let prepared;
      try {
        prepared = await this.store.inspectDocument(filePath, state.documents);
        if (prepared.duplicate) {
          document = prepared.document;
          const outcome = classifyKnownDocument(state, document, this.pendingDocumentIds);
          if (outcome !== IMPORT_OUTCOMES.READY) {
            results.push({ status: outcome, document });
            continue;
          }
          await ensureBackup();
        } else {
          await ensureBackup();
          const stored = await this.store.storeDocument(filePath, kind, state.documents, prepared);
          document = stored.document;
          state.documents.push(document);
          stateChanged = true;
        }

        const payload = extension === '.pdf' ? await this.extractPdfDocument(filePath) : await fs.readFile(filePath, 'utf8');
        const preview = this.parseImportedDocument(path.basename(filePath), payload, kind, accountId);
        preview.records = preview.records.map((record) => ({
          ...record,
          sourceDocumentId: document.id,
          accounts: Array.isArray(record.accounts) ? record.accounts.map((account) => ({ ...account, sourceDocumentId: document.id })) : record.accounts
        }));
        document.displayName = this.canonicalDocumentName(document, preview, accountId, state);
        document.parseStatus = preview.records.length ? (preview.reconciled ? 'ready' : 'review') : 'needs_review';
        document.linkedRecordIds = preview.records.flatMap((record) => [record.id, ...(record.accounts || []).map((account) => account.id)]);
        stateChanged = true;
        const status = preview.records.length ? IMPORT_OUTCOMES.READY : IMPORT_OUTCOMES.NEEDS_REVIEW;
        if (status === IMPORT_OUTCOMES.READY) this.pendingDocumentIds.add(document.id);
        results.push({ status, document, preview, retry: prepared.duplicate });
      } catch (error) {
        if (!document) throw error;
        const fault = await this.recordFailure(error, kind, extension);
        const label = kind === 'payslip' ? 'payslip' : kind === 'credit-report' ? 'credit report' : 'bank statement';
        const reason = `We couldn't read this ${label}. Error reference: ${fault.reference}.`;
        document.parseStatus = 'needs_review';
        document.linkedRecordIds = [];
        this.pendingDocumentIds.delete(document.id);
        stateChanged = true;
        results.push({
          status: IMPORT_OUTCOMES.FAILED,
          document,
          preview: { kind, records: [], rejected: [{ row: 0, reason }], warnings: [], summary: {}, reconciled: false, errorReference: fault.reference }
        });
      }
    }

    if (stateChanged) {
      state = await saveState(state);
    }
    return results;
  }
}
