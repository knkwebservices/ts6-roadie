// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (...args: any[]) => unknown;

/** Tiny typed event emitter. A throwing listener never breaks the emitter or other listeners. */
export class TypedEmitter<E extends { [K in keyof E]: unknown[] }> {
  #listeners = new Map<keyof E, Set<AnyListener>>();
  onError: (err: unknown, event: string) => void = () => {};

  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
    };
  }

  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        const r = fn(...args);
        if (r instanceof Promise) r.catch((e) => this.onError(e, String(event)));
      } catch (e) {
        this.onError(e, String(event));
      }
    }
  }
}
