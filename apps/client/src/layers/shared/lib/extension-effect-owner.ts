/** Private originating client occurrence; a check cannot grant server authority. */
export interface EffectOwner {
  /** Refuse a retired origin immediately before entering or publishing a host effect. */
  beforeEffect(): void;
}
