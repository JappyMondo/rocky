import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  retryRecordSchema,
  retryStepKey,
  exhaustedStepKey,
  uiStartupRetryKey,
} from './retry.js';

import {
  END_STEP,
  JOURNAL_FORMAT_VERSION,
  JournalFormatError,
  appendEntry,
  controlRecordSchema,
  openJournal,
  readJournal,
  type AppendOptions,
  type Journal,
  type JournalEntry,
} from './journal.js';

/** Exclusive daemon owner; the Run map must retain one instance per path. */
export class JournalWriter {
  private tail: Promise<unknown> = Promise.resolve();
  private ended: boolean;
  private highestSeq = -1;
  private constructor(
    private readonly path: string,
    journal: Journal,
  ) {
    this.ended = journal.end !== undefined;
    for (const entry of journal.entries)
      this.highestSeq = Math.max(this.highestSeq, entry.seq);
  }

  static async open(path: string): Promise<JournalWriter> {
    return new JournalWriter(path, await openJournal(path));
  }

  put(key: string, value: unknown): Promise<void> {
    return this.schedule(() => {
      const line = JSON.stringify(
        controlRecordSchema.parse({
          v: JOURNAL_FORMAT_VERSION,
          kind: 'control',
          key,
          value,
          recordedAt: new Date().toISOString(),
        }),
      );
      return async () => {
        this.assertWritable();
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, `${line}\n`, { flush: true });
      };
    });
  }

  append(entry: JournalEntry, options: AppendOptions = {}): Promise<void> {
    return this.schedule(() => {
      const snapshot = structuredClone(entry);
      const capturedOptions = { ...options };
      return async () => {
        this.assertWritable();
        if (snapshot.step === END_STEP && snapshot.seq <= this.highestSeq) {
          throw new JournalFormatError('$end must follow every Step sequence');
        }
        await appendEntry(this.path, snapshot, capturedOptions);
        this.highestSeq = Math.max(this.highestSeq, snapshot.seq);
        this.ended = snapshot.step === END_STEP;
      };
    });
  }

  /** Caller holds scheduler exclusion and has finished workspace recovery. */
  retry(
    requestId: string,
    stepKey: string,
    resetControls: string[] = [],
    recoveryInstructions?: string,
    continueExhausted?: true,
    configurationRepair?: import('@rocky/local-contracts').FlowConfigurationRepair,
  ): Promise<void> {
    return this.schedule(() => async () => {
      if (configurationRepair && !continueExhausted)
        throw new JournalFormatError(
          'Configuration repair requires continuation',
        );
      const journal = await readJournal(this.path);
      if (journal.getControl(`retry:${requestId}`)) return;
      if (
        !this.ended ||
        (continueExhausted
          ? exhaustedStepKey(journal.entries)
          : retryStepKey(journal.entries)) !== stepKey
      )
        throw new JournalFormatError('This Step cannot be retried');
      const record = retryRecordSchema.parse({
        v: JOURNAL_FORMAT_VERSION,
        kind: 'retry',
        ...(continueExhausted ? { continueExhausted } : {}),
        ...(configurationRepair ? { configurationRepair } : {}),
        resetControls,
        requestId,
        stepKey,
        recordedAt: new Date().toISOString(),
        ...(recoveryInstructions === undefined
          ? {}
          : {
              recovery: {
                instructions: recoveryInstructions,
                context: JSON.stringify(
                  journal.entries.slice(-20).map((entry) => ({
                    key: entry.seq,
                    step: entry.step,
                    label: entry.label,
                    status: entry.status,
                    error: entry.error?.message.slice(0, 6000),
                    result:
                      entry.status === 'done'
                        ? JSON.stringify(entry.result)?.slice(0, 2000)
                        : undefined,
                  })),
                ),
              },
            }),
      });
      await appendFile(this.path, `${JSON.stringify(record)}\n`, {
        flush: true,
      });
      this.ended = false;
      this.highestSeq =
        uiStartupRetryKey(journal.entries) === stepKey
          ? Number(stepKey) - 1
          : Math.max(
              ...journal.entries
                .filter((entry) => entry.step !== END_STEP)
                .map((entry) => entry.seq),
            );
    });
  }

  get(key: string): Promise<unknown> {
    return this.schedule(
      () => async () => (await readJournal(this.path)).getControl(key),
    );
  }

  read(): Promise<Journal> {
    return this.schedule(() => () => readJournal(this.path));
  }

  private assertWritable(): void {
    if (this.ended) throw new JournalFormatError('cannot write after $end');
  }

  private schedule<T>(prepare: () => () => Promise<T>): Promise<T> {
    let operation: () => Promise<T>;
    try {
      operation = prepare();
    } catch (error) {
      operation = () => Promise.reject(error);
    }
    const result = this.tail.then(operation);
    this.tail = result;
    // Retain rejection on the queue while avoiding an unhandled internal tail.
    void result.catch(() => undefined);
    return result;
  }
}
