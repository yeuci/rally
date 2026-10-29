export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<E extends keyof Events>(event: E, fn: Listener<Events[E]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<never>);
    return () => this.off(event, fn);
  }

  once<E extends keyof Events>(event: E, fn: Listener<Events[E]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off<E extends keyof Events>(event: E, fn: Listener<Events[E]>): void {
    this.listeners.get(event)?.delete(fn as Listener<never>);
  }

  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        (fn as Listener<Events[E]>)(payload);
      } catch (err) {
        console.error(`[rally] listener for "${String(event)}" threw`, err);
      }
    }
  }
}
