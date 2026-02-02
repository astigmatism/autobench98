export type Primitive = string | number | boolean;

export type DisableReason = 'backpressure' | 'manual';

export interface BusEvent<TPayload = unknown> {
  /** Topic name; must pass validation rules. */
  topic: string;

  /** Unique event id; required on delivery; bus generates if absent. */
  id?: string;

  /** Monotonic per-topic sequence assigned by bus (non-durable). */
  seq?: number;

  /** Publish timestamp (ms since epoch). Bus may set if absent. */
  ts?: number;

  /** Publisher identity (module/service name). */
  source: string;

  /** Payload schema version. */
  schemaVersion: number;

  /** Optional attribute map for filtering/routing. */
  attributes?: Record<string, Primitive>;

  /** Typed payload. */
  payload: TPayload;
}

export type Handler<TPayload = unknown> = (event: Readonly<Required<Pick<BusEvent<TPayload>, 'id' | 'seq' | 'ts'>> & BusEvent<TPayload>>) => void | Promise<void>;

export interface AttributeFilter {
  /** Exact match on key -> value. */
  equals?: Record<string, Primitive>;

  /** Key must exist with any value. */
  exists?: string[];
}

export interface SubscriptionFilter {
  /** Topic pattern, may include wildcards. */
  topic: string;

  /** Optional attribute filter. */
  attributes?: AttributeFilter;
}

export interface SubscriptionOptions {
  /** Optional subscriber identifier for logs/metrics. */
  name?: string;

  /** Backpressure capacity override (defaults to bus config). */
  queueCapacity?: number;

  /** Error hook for this subscriber (handler threw). */
  onError?: (err: unknown, event?: BusEvent) => void;

  /** Called when subscriber is disabled by bus (e.g., backpressure). */
  onDisabled?: (reason: DisableReason) => void;
}

export interface Subscription {
  unsubscribe(): void;
  isActive(): boolean;
}

export interface Bus {
  subscribe<TPayload = unknown>(
    filter: SubscriptionFilter,
    handler: Handler<TPayload>,
    options?: SubscriptionOptions
  ): Subscription;

  subscribeOnce<TPayload = unknown>(
    filter: SubscriptionFilter,
    handler: Handler<TPayload>,
    options?: SubscriptionOptions
  ): Subscription;

  publish<TPayload = unknown>(event: BusEvent<TPayload>): void;

  /** Resolves when all currently enqueued deliveries are complete. */
  idle(): Promise<void>;
}
