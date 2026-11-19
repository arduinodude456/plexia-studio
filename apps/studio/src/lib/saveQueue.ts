// Serialize cloud writes and coalesce pending edits by presentation ID.
// A failed write never discards either the failed version or a newer pending version.
export class LatestSaveQueue<T> {
  private pending = new Map<string, T>();
  private running: Promise<void> | null = null;
  private writer: (value: T) => Promise<void>;

  constructor(writer: (value: T) => Promise<void>) {
    this.writer = writer;
  }

  enqueue(id: string, value: T): void {
    this.pending.set(id, value);
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  get busy(): boolean {
    return this.pending.size > 0 || this.running !== null;
  }

  async flush(): Promise<void> {
    // A new caller may arrive while another caller is waiting. Recheck after
    // each await so that only one drain can write at any given time.
    while (this.running) await this.running;
    if (!this.pending.size) return;
    const task = this.drain();
    this.running = task;
    try {
      await task;
    } finally {
      if (this.running === task) this.running = null;
    }
  }

  private async drain(): Promise<void> {
    while (this.pending.size) {
      const [id, value] = this.pending.entries().next().value as [string, T];
      this.pending.delete(id);
      try {
        await this.writer(value);
      } catch (error) {
        if (!this.pending.has(id)) this.pending.set(id, value);
        throw error;
      }
    }
  }
}
