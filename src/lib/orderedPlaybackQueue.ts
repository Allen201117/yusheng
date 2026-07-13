export class OrderedPlaybackQueue<T> {
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    private readonly consume: (value: T) => Promise<void>,
    private readonly onError?: (error: unknown) => void,
  ) {}

  enqueue(preparing: Promise<T>): void {
    const generation = this.generation;
    this.chain = this.chain
      .then(async () => {
        const value = await preparing;
        if (generation !== this.generation) return;
        await this.consume(value);
      })
      .catch((error) => {
        if (generation === this.generation) this.onError?.(error);
      });
  }

  reset(): void {
    this.generation += 1;
    this.chain = Promise.resolve();
  }

  whenIdle(): Promise<void> {
    return this.chain;
  }
}
