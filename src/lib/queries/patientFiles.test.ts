// Cover for the upload path that failed with
// "new row violates row-level security policy for table file_labels".
//
// getOrCreateLabel used to INSERT into Meridian's file_labels catalogue
// whenever its own lookup came back empty, and it discarded the
// lookup's error, so a missing label and an unreadable one both became
// a write Lounge staff have no privilege for. The replacement is
// read-only and loud. These tests pin that behaviour, plus the storage
// cleanup that keeps a failed patient_files insert from leaving an
// unreachable object in the case-files bucket.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface QueryState {
  labelRows: Array<{ id: string }>;
  labelError: { message: string } | null;
  insert: {
    data: Record<string, unknown> | null;
    error: { message: string; code?: string } | null;
  };
  update: {
    data: Record<string, unknown> | null;
    error: { message: string; code?: string } | null;
  };
  eventError: { message: string } | null;
  uploadError: { message: string } | null;
  removeError: { message: string } | null;
  // can_write_patient_files_now() probe: the patient's production
  // cases, and any open scan cleanup on them.
  caseRows: Array<{ id: string }>;
  caseError: { message: string } | null;
  lockRows: Array<{ id: string }>;
  lockError: { message: string } | null;
}

const state: QueryState = {
  labelRows: [],
  labelError: null,
  insert: { data: null, error: null },
  update: { data: null, error: null },
  eventError: null,
  uploadError: null,
  removeError: null,
  caseRows: [],
  caseError: null,
  lockRows: [],
  lockError: null,
};

const storageOps: Array<{ op: 'upload' | 'remove'; paths: string[] }> = [];
const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
const failures: Array<Record<string, unknown>> = [];

function builder(table: string): Record<string, unknown> {
  // Which write this chain is: .single() resolves to the update result
  // for an update chain and the insert result otherwise.
  let op: 'insert' | 'update' = 'insert';
  const settle = () => {
    if (table === 'file_labels') {
      return { data: state.labelRows, error: state.labelError };
    }
    if (table === 'production_case_scan_cleanups') {
      return { data: state.lockRows, error: state.lockError };
    }
    return { data: state.caseRows, error: state.caseError };
  };
  const proxy: Record<string, unknown> = {
    select: () => proxy,
    is: () => proxy,
    in: () => proxy,
    limit: () => Promise.resolve(settle()),
    single: () => Promise.resolve(op === 'update' ? state.update : state.insert),
    // production_cases resolves on .eq(), with no .limit() to await it.
    eq: () => (table === 'production_cases' ? Promise.resolve(settle()) : proxy),
    update(payload: Record<string, unknown>) {
      op = 'update';
      updates.push({ table, payload });
      return proxy;
    },
    insert(payload: Record<string, unknown>) {
      inserts.push({ table, payload });
      if (table === 'patient_events') {
        return Promise.resolve({ data: null, error: state.eventError });
      }
      return proxy;
    },
  };
  return proxy;
}

vi.mock('../supabase.ts', () => ({
  supabase: {
    from: (t: string) => builder(t),
    storage: {
      from: () => ({
        upload: (path: string) => {
          storageOps.push({ op: 'upload', paths: [path] });
          return Promise.resolve({ error: state.uploadError });
        },
        remove: (paths: string[]) => {
          storageOps.push({ op: 'remove', paths });
          return Promise.resolve({ error: state.removeError });
        },
      }),
    },
  },
}));

vi.mock('../failureLog.ts', () => ({
  logFailure: (f: Record<string, unknown>) => {
    failures.push(f);
    return Promise.resolve();
  },
}));

const { getLabelId, setPatientFileLabel, uploadPatientFile } = await import('./patientFiles.ts');

const fakeFile = {
  name: 'before.jpg',
  type: 'image/jpeg',
  size: 2048,
} as unknown as File;

const uploadArgs = {
  patientId: 'p1',
  patientName: 'Sarah Henderson',
  file: fakeFile,
  labelKey: 'before_photo',
  labelDisplayName: 'Before photo',
  uploaderAccountId: 'acc-1',
};

beforeEach(() => {
  state.labelRows = [{ id: 'lbl-before' }];
  state.labelError = null;
  state.insert = { data: { id: 'pf-1' }, error: null };
  state.update = { data: { id: 'pf-1', label_id: 'lbl-before' }, error: null };
  state.eventError = null;
  state.uploadError = null;
  state.removeError = null;
  state.caseRows = [];
  state.caseError = null;
  state.lockRows = [];
  state.lockError = null;
  storageOps.length = 0;
  inserts.length = 0;
  updates.length = 0;
  failures.length = 0;
});

describe('getLabelId — read-only label resolution', () => {
  it('returns the catalogue row id', async () => {
    await expect(getLabelId('before_photo')).resolves.toBe('lbl-before');
    expect(failures).toHaveLength(0);
  });

  it('never writes to file_labels', async () => {
    state.labelRows = [];
    await expect(getLabelId('before_photo')).rejects.toThrow(/missing from the file_labels catalogue/);
    expect(inserts.some((i) => i.table === 'file_labels')).toBe(false);
  });

  it('names the missing label and logs the gap', async () => {
    state.labelRows = [];
    await expect(getLabelId('after_photo')).rejects.toThrow(/"after_photo"/);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.severity).toBe('error');
    expect(failures[0]!.source).toBe('patient_files.getLabelId');
  });

  it('surfaces a read failure instead of turning it into a write', async () => {
    state.labelError = { message: 'permission denied for table file_labels' };
    await expect(getLabelId('before_photo')).rejects.toThrow(/permission denied/);
    expect(inserts).toHaveLength(0);
    expect(failures).toHaveLength(1);
  });

  it('treats a duplicate key as critical rather than picking one at random', async () => {
    state.labelRows = [{ id: 'lbl-a' }, { id: 'lbl-b' }];
    await expect(getLabelId('before_photo')).rejects.toThrow(/more than one row/);
    expect(failures[0]!.severity).toBe('critical');
  });
});

describe('uploadPatientFile — storage and row stay in step', () => {
  it('writes the file then the row', async () => {
    const row = await uploadPatientFile(uploadArgs);
    expect(row).toEqual({ id: 'pf-1' });
    expect(storageOps.map((o) => o.op)).toEqual(['upload']);
    const pf = inserts.find((i) => i.table === 'patient_files');
    expect(pf?.payload.label_id).toBe('lbl-before');
    expect(pf?.payload.description).toBe('Before photo');
    expect(pf?.payload.uploaded_by).toBe('acc-1');
  });

  it('stops before touching storage when the label is missing', async () => {
    state.labelRows = [];
    await expect(uploadPatientFile(uploadArgs)).rejects.toThrow(/missing from the file_labels catalogue/);
    expect(storageOps).toHaveLength(0);
  });

  it('removes the uploaded object when the patient_files insert is refused', async () => {
    state.insert = {
      data: null,
      error: { message: 'new row violates row-level security policy for table "patient_files"' },
    };
    await expect(uploadPatientFile(uploadArgs)).rejects.toThrow(/row-level security/);
    expect(storageOps.map((o) => o.op)).toEqual(['upload', 'remove']);
    // Same path both ways, so nothing is left behind.
    expect(storageOps[1]!.paths).toEqual(storageOps[0]!.paths);
    expect(failures[0]!.severity).toBe('error');
    expect((failures[0]!.context as Record<string, unknown>).orphanRemoved).toBe(true);
  });

  it('records a failed cleanup rather than losing the orphan path', async () => {
    state.insert = { data: null, error: { message: 'boom' } };
    state.removeError = { message: 'object not found' };
    await expect(uploadPatientFile(uploadArgs)).rejects.toThrow('boom');
    const ctx = failures[0]!.context as Record<string, unknown>;
    expect(ctx.orphanRemoved).toBe(false);
    expect(ctx.cleanupError).toBe('object not found');
    expect(ctx.storagePath).toBe(storageOps[0]!.paths[0]);
  });

  it('keeps the upload when only the patient_events write fails, and logs it', async () => {
    state.eventError = { message: 'permission denied for table patient_events' };
    await expect(uploadPatientFile(uploadArgs)).resolves.toEqual({ id: 'pf-1' });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.severity).toBe('warning');
    expect(storageOps.map((o) => o.op)).toEqual(['upload']);
  });
});

describe('uploadPatientFile — the scan-cleanup lock is explained, not leaked', () => {
  const refused = {
    data: null,
    error: {
      code: '42501',
      message: 'new row violates row-level security policy for table "patient_files"',
    },
  };

  it('names the open cleanup instead of quoting the policy', async () => {
    state.insert = refused;
    state.caseRows = [{ id: 'pc-1' }];
    state.lockRows = [{ id: 'cleanup-1' }];
    await expect(uploadPatientFile(uploadArgs)).rejects.toThrow(
      /part way through a scan cleanup/,
    );
    const ctx = failures[0]!.context as Record<string, unknown>;
    expect(ctx.refusalCause).toMatch(/scan cleanup/);
    // The raw policy text still reaches lng_system_failures.
    expect(failures[0]!.message).toMatch(/row-level security/);
  });

  it('keeps the original error when no cleanup is open', async () => {
    state.insert = refused;
    state.caseRows = [{ id: 'pc-1' }];
    state.lockRows = [];
    await expect(uploadPatientFile(uploadArgs)).rejects.toThrow(/row-level security/);
    expect((failures[0]!.context as Record<string, unknown>).refusalCause).toBeNull();
  });

  it('blames nothing it cannot see when the probe is itself refused', async () => {
    state.insert = refused;
    state.caseRows = [{ id: 'pc-1' }];
    state.lockError = { message: 'permission denied for table production_case_scan_cleanups' };
    await expect(uploadPatientFile(uploadArgs)).rejects.toThrow(/row-level security/);
    expect((failures[0]!.context as Record<string, unknown>).refusalCause).toBeNull();
  });

  it('does not probe when the refusal was not an RLS denial', async () => {
    state.insert = { data: null, error: { code: '23502', message: 'null value in column "description"' } };
    state.caseRows = [{ id: 'pc-1' }];
    state.lockRows = [{ id: 'cleanup-1' }];
    await expect(uploadPatientFile(uploadArgs)).rejects.toThrow(/null value in column/);
    expect((failures[0]!.context as Record<string, unknown>).refusalCause).toBeNull();
  });

  it('still removes the orphaned object when the lock refuses the write', async () => {
    state.insert = refused;
    state.caseRows = [{ id: 'pc-1' }];
    state.lockRows = [{ id: 'cleanup-1' }];
    await expect(uploadPatientFile(uploadArgs)).rejects.toThrow(/scan cleanup/);
    expect(storageOps.map((o) => o.op)).toEqual(['upload', 'remove']);
  });
});

describe('setPatientFileLabel — repairing a mislabelled photo', () => {
  const relabelArgs = {
    fileId: 'pf-1',
    patientId: 'p1',
    labelKey: 'after_photo',
    labelDisplayName: 'After photo',
  };

  it('moves the label and the description together', async () => {
    state.labelRows = [{ id: 'lbl-after' }];
    await setPatientFileLabel(relabelArgs);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe('patient_files');
    expect(updates[0]!.payload).toEqual({ label_id: 'lbl-after', description: 'After photo' });
  });

  it('leaves the stored object alone', async () => {
    state.labelRows = [{ id: 'lbl-after' }];
    await setPatientFileLabel(relabelArgs);
    expect(storageOps).toHaveLength(0);
  });

  it('records the change on the patient timeline', async () => {
    state.labelRows = [{ id: 'lbl-after' }];
    await setPatientFileLabel(relabelArgs);
    const event = inserts.find((i) => i.table === 'patient_events');
    expect(event?.payload).toMatchObject({
      patient_id: 'p1',
      event_type: 'patient_photo_relabelled',
    });
  });

  it('refuses when the target label is not in the catalogue', async () => {
    state.labelRows = [];
    await expect(setPatientFileLabel(relabelArgs)).rejects.toThrow(
      /missing from the file_labels catalogue/
    );
    expect(updates).toHaveLength(0);
  });

  it('names the scan-cleanup lock when the update is refused by RLS', async () => {
    state.labelRows = [{ id: 'lbl-after' }];
    state.update = {
      data: null,
      error: { message: 'new row violates row-level security policy', code: '42501' },
    };
    state.caseRows = [{ id: 'case-1' }];
    state.lockRows = [{ id: 'cleanup-1' }];
    await expect(setPatientFileLabel(relabelArgs)).rejects.toThrow(/scan cleanup/i);
    expect(failures.some((f) => f.source === 'patient_files.setPatientFileLabel')).toBe(true);
  });

  it('still returns the row when the timeline write fails', async () => {
    state.labelRows = [{ id: 'lbl-after' }];
    state.eventError = { message: 'events down' };
    await expect(setPatientFileLabel(relabelArgs)).resolves.toMatchObject({ id: 'pf-1' });
    expect(
      failures.some(
        (f) => f.source === 'patient_files.setPatientFileLabel' && f.severity === 'warning'
      )
    ).toBe(true);
  });
});
