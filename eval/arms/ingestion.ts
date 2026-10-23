/**
 * Shared by the arms that ingest a conversation into a store once per run (B, C, D): a JSON record
 * under eval/results keyed by conversation (so a rerun skips ingestion, and a bank is never reused
 * for different content), a per-conversation in-flight promise shared by every row, and one queue
 * so ingestions run one at a time (the engines' write-token counters are process-wide, and arm B's
 * `admin grant` is not transactional).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Turn } from "../corpus/normalize.js";

export const digestOf = (turns: readonly Turn[]): string => createHash("sha256").update(JSON.stringify(turns)).digest("hex");

export class IngestionRecord<T extends { readonly digest: string }> {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async readAll(): Promise<Record<string, T>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Record<string, T>;
    } catch {
      return {};
    }
  }

  async get(key: string): Promise<T | undefined> {
    return (await this.readAll())[key];
  }

  /** Serialized read-modify-write; two conversations can finish ingesting at once. */
  save(key: string, value: T): Promise<void> {
    const write = this.writes.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const all = await this.readAll();
      all[key] = value;
      await writeFile(this.file, JSON.stringify(all, null, 2) + "\n");
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  get path(): string {
    return this.file;
  }
}

/** One ingestion at a time per process; per key the promise is shared by every row, and a failure is retried by the next row of that key. */
export class SerializedIngestion<T> {
  private readonly inFlight = new Map<string, Promise<T>>();
  private queue: Promise<unknown> = Promise.resolve();

  ensure(key: string, run: () => Promise<T>): Promise<T> {
    let p = this.inFlight.get(key);
    if (!p) {
      p = this.queue.then(run);
      this.queue = p.catch(() => undefined);
      p = p.catch((e) => {
        this.inFlight.delete(key);
        throw e;
      });
      this.inFlight.set(key, p);
    }
    return p;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
