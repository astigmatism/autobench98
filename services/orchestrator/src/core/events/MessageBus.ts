import { randomUUID } from 'node:crypto';

import type {
  BusEvent,
  Handler,
  Subscription,
  SubscriptionFilter,
  SubscriptionOptions,
  DisableReason,
  Primitive,
} from './types';
import { validateTopicName, validateTopicPattern, matchTopicPattern } from './topic';
import { matchAttributes } from './filters';
import { SchemaRegistry } from './schema';
import type { BusTelemetry, LoggerBundleLike } from './telemetry';
import { NoopTelemetry, makeBusTelemetry } from './telemetry';

type DeliveredEvent<TPayload = unknown> =
  Readonly<Required<Pick<BusEvent<TPayload>, 'id' | 'seq' | 'ts'>> & BusEvent<TPayload>>;

/**
 * Internal subscriber storage is deliberately NON-generic.
 * The bus routes/delivers envelopes; payload typing belongs at the call sites.
 */
interface Subscriber {
  sid: string;
  name: string;
  filter: SubscriptionFilter;
  patternSegments: string[];
  handler: (event: DeliveredEvent<any>) => void | Promise<void>;
  queueCapacity: number;
  onError?: SubscriptionOptions['onError'];
  onDisabled?: SubscriptionOptions['onDisabled'];
  active: boolean;
  queue: DeliveredEvent<any>[];
  processing: boolean;
}

export interface MessageBusConfig {
  /** Default per-subscriber queue capacity (bounded backpressure). */
  defaultQueueCapacity: number;

  /**
   * Safety-critical topic allowlist.
   * If a published event's topic matches, schemaVersion MUST be registered and payload MUST validate.
   */
  safetyCriticalTopicPatterns: string[];

  /**
   * Telemetry hooks. If omitted, and `logger` is provided, telemetry will be created from the logger.
   */
  telemetry?: BusTelemetry;

  /**
   * Application logger bundle (from the logging package), used to build telemetry if `telemetry` not provided.
   * Must be created by the orchestrator with the shared ClientLogBuffer.
   */
  logger?: LoggerBundleLike;

  /**
   * Channel name used when building telemetry from logger. Default: 'message-bus'
   * (matches LogChannel.message_bus = 'message-bus').
   */
  loggerChannelName?: string;
}

export class MessageBus {
  private readonly telemetry: BusTelemetry;
  private readonly defaultQueueCapacity: number;

  private readonly schemaRegistry = new SchemaRegistry();
  private readonly safetyCriticalPatterns: { raw: string; segments: string[] }[];

  private readonly subscribers = new Map<string, Subscriber>();
  private readonly perTopicSeq = new Map<string, number>();

  private inFlightHandlers = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(cfg: MessageBusConfig) {
    if (!cfg || typeof cfg !== 'object') throw new Error('MessageBusConfig is required');
    if (!Number.isFinite(cfg.defaultQueueCapacity) || cfg.defaultQueueCapacity <= 0) {
      throw new Error('defaultQueueCapacity must be a positive number');
    }
    this.defaultQueueCapacity = cfg.defaultQueueCapacity;

    // Telemetry selection (verification-first: bus does not create log buffers)
    if (cfg.telemetry) {
      this.telemetry = cfg.telemetry;
    } else if (cfg.logger) {
      this.telemetry = makeBusTelemetry(cfg.logger, { channelName: cfg.loggerChannelName ?? 'message-bus' });
    } else {
      this.telemetry = NoopTelemetry;
    }

    // Compile safety-critical patterns
    this.safetyCriticalPatterns = cfg.safetyCriticalTopicPatterns.map((p) => {
      const v = validateTopicPattern(p);
      if (!v.ok) throw new Error(`invalid safetyCriticalTopicPattern "${p}": ${v.reason}`);
      return { raw: p, segments: v.segments };
    });
  }

  /**
   * Register a payload validator for (topicPattern, schemaVersion).
   * Determinism: first matching pattern wins.
   */
  registerSchema(topicPattern: string, schemaVersion: number, validator: (payload: unknown) => boolean): void {
    this.schemaRegistry.register(topicPattern, schemaVersion, validator);
  }

  subscribe<TPayload = unknown>(
    filter: SubscriptionFilter,
    handler: Handler<TPayload>,
    options?: SubscriptionOptions
  ): Subscription {
    return this.subscribeInternal(filter, handler, { ...options, once: false });
  }

  subscribeOnce<TPayload = unknown>(
    filter: SubscriptionFilter,
    handler: Handler<TPayload>,
    options?: SubscriptionOptions
  ): Subscription {
    return this.subscribeInternal(filter, handler, { ...options, once: true });
  }

  publish<TPayload = unknown>(event: BusEvent<TPayload>): void {
    this.publishInternal(event, false);
  }

  async idle(): Promise<void> {
    if (this.isDrained()) return;
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  // ---------- internal implementation ----------

  private subscribeInternal<TPayload = unknown>(
    filter: SubscriptionFilter,
    handler: Handler<TPayload>,
    opts: SubscriptionOptions & { once: boolean }
  ): Subscription {
    if (!filter || typeof filter !== 'object') throw new Error('filter is required');
    const v = validateTopicPattern(filter.topic);
    if (!v.ok) throw new Error(`invalid subscription topic pattern "${filter.topic}": ${v.reason}`);
    if (typeof handler !== 'function') throw new Error('handler must be a function');

    const sid = randomUUID();
    const name = opts.name?.trim() ? opts.name!.trim() : sid;

    // Wrap typed handler into an untyped internal handler to avoid variance issues.
    const wrappedHandler = (evt: DeliveredEvent<any>) => handler(evt as any);

    const sub: Subscriber = {
      sid,
      name,
      filter: { topic: filter.topic, attributes: filter.attributes },
      patternSegments: v.segments,
      handler: wrappedHandler,
      queueCapacity: opts.queueCapacity ?? this.defaultQueueCapacity,
      onError: opts.onError,
      onDisabled: opts.onDisabled,
      active: true,
      queue: [],
      processing: false,
    };

    if (!Number.isFinite(sub.queueCapacity) || sub.queueCapacity <= 0) {
      throw new Error('queueCapacity must be a positive number');
    }

    this.subscribers.set(sid, sub);

    const unsubscribe = () => {
      const s = this.subscribers.get(sid);
      if (!s || !s.active) return;
      s.active = false;
      s.queue.length = 0;
      this.subscribers.delete(sid);
      this.maybeResolveIdle();
    };

    if (!opts.once) {
      return { unsubscribe, isActive: () => this.subscribers.has(sid) && this.subscribers.get(sid)!.active };
    }

    const originalHandler = sub.handler;
    sub.handler = async (evt: DeliveredEvent<any>) => {
      unsubscribe();
      return originalHandler(evt);
    };

    return { unsubscribe, isActive: () => this.subscribers.has(sid) && this.subscribers.get(sid)!.active };
  }

  private publishInternal<TPayload = unknown>(event: BusEvent<TPayload>, internal: boolean): void {
    if (!event || typeof event !== 'object') throw new Error('event is required');

    const tv = validateTopicName(event.topic);
    if (!tv.ok) {
      this.telemetry.messageRejected((event as any).topic ?? '(missing)', `invalid_topic:${tv.reason}`);
      this.telemetry.error('bus rejected publish: invalid topic', { topic: (event as any).topic, reason: tv.reason });
      return;
    }

    if (!internal && (event.topic === 'bus' || event.topic.startsWith('bus.'))) {
      this.telemetry.messageRejected(event.topic, 'reserved_namespace');
      this.telemetry.error('bus rejected publish: reserved namespace bus.*', { topic: event.topic, source: event.source });
      return;
    }

    const id = event.id ?? randomUUID();
    const ts = event.ts ?? Date.now();
    const seq = this.nextSeq(event.topic);

    const delivered: DeliveredEvent<TPayload> = Object.freeze({
      ...event,
      id,
      ts,
      seq,
    });

    this.telemetry.published(event.topic);

    const isSafety = this.isSafetyCritical(event.topic);
    if (isSafety) {
      const validator = this.schemaRegistry.find(event.topic, event.schemaVersion);
      if (!validator) {
        this.rejectSafety(delivered as any, `missing_schema_validator(version=${event.schemaVersion})`);
        return;
      }
      let ok = false;
      try {
        ok = !!validator(event.payload);
      } catch (err) {
        this.rejectSafety(delivered as any, `validator_threw:${String(err)}`);
        return;
      }
      if (!ok) {
        this.rejectSafety(delivered as any, `schema_validation_failed(version=${event.schemaVersion})`);
        return;
      }
    } else {
      const validator = this.schemaRegistry.find(event.topic, event.schemaVersion);
      if (validator) {
        try {
          const ok = !!validator(event.payload);
          if (!ok) {
            this.telemetry.warn('bus payload validation failed (non-safety; delivering anyway)', {
              topic: event.topic,
              schemaVersion: event.schemaVersion,
              source: event.source,
            });
          }
        } catch (err) {
          this.telemetry.warn('bus payload validator threw (non-safety; delivering anyway)', {
            topic: event.topic,
            schemaVersion: event.schemaVersion,
            source: event.source,
            err: String(err),
          });
        }
      }
    }

    for (const sub of this.subscribers.values()) {
      if (!sub.active) continue;
      if (!matchTopicPattern(sub.patternSegments, delivered.topic)) continue;
      if (!matchAttributes(delivered.attributes as Record<string, Primitive> | undefined, sub.filter.attributes)) continue;

      sub.queue.push(delivered as unknown as DeliveredEvent<any>);

      if (sub.queue.length > sub.queueCapacity) {
        this.disableSubscriber(sub, 'backpressure', {
          queueSize: sub.queue.length,
          queueCapacity: sub.queueCapacity,
          lastTopic: delivered.topic,
        });
        continue;
      }

      if (!sub.processing) {
        sub.processing = true;
        queueMicrotask(() => this.drainSubscriber(sub));
      }
    }
  }

  private nextSeq(topic: string): number {
    const prev = this.perTopicSeq.get(topic) ?? 0;
    const next = prev + 1;
    this.perTopicSeq.set(topic, next);
    return next;
  }

  private isSafetyCritical(topic: string): boolean {
    for (const p of this.safetyCriticalPatterns) {
      if (matchTopicPattern(p.segments, topic)) return true;
    }
    return false;
  }

  private rejectSafety(evt: DeliveredEvent<any>, reason: string): void {
    this.telemetry.schemaRejected(evt.topic);
    this.telemetry.messageRejected(evt.topic, reason);
    this.telemetry.error('bus rejected safety-critical message', {
      topic: evt.topic,
      reason,
      schemaVersion: evt.schemaVersion,
      source: evt.source,
      id: evt.id,
      seq: evt.seq,
    });

    this.publishInternal(
      {
        topic: 'bus.message.rejected',
        source: 'bus',
        schemaVersion: 1,
        attributes: { originalTopic: evt.topic, safety: true },
        payload: {
          reason,
          original: {
            topic: evt.topic,
            id: evt.id,
            seq: evt.seq,
            ts: evt.ts,
            source: evt.source,
            schemaVersion: evt.schemaVersion,
          },
        },
      },
      true
    );
  }

  private disableSubscriber(sub: Subscriber, reason: DisableReason, extra?: Record<string, unknown>): void {
    if (!sub.active) return;
    sub.active = false;
    sub.queue.length = 0;
    this.subscribers.delete(sub.sid);

    if (reason === 'backpressure') {
      const t = (extra?.lastTopic as string | undefined) ?? 'unknown';
      this.telemetry.subscriberDisabledBackpressure(t);
    }

    this.telemetry.error('bus disabled subscriber', { subscriber: sub.name, reason, ...extra });

    try {
      sub.onDisabled?.(reason);
    } catch (err) {
      this.telemetry.error('subscriber onDisabled hook threw', { subscriber: sub.name, err: String(err) });
    }

    this.publishInternal(
      {
        topic: 'bus.subscriber.disabled',
        source: 'bus',
        schemaVersion: 1,
        attributes: { subscriber: sub.name, reason },
        payload: {
          subscriber: sub.name,
          reason,
          ...extra,
        },
      },
      true
    );

    this.maybeResolveIdle();
  }

  private async drainSubscriber(sub: Subscriber): Promise<void> {
    while (sub.active && sub.queue.length > 0) {
      const evt = sub.queue.shift()!;
      this.inFlightHandlers += 1;
      try {
        await sub.handler(evt);
        this.telemetry.delivered(evt.topic);
      } catch (err) {
        this.telemetry.handlerThrew(evt.topic);
        this.telemetry.error('subscriber handler threw', {
          subscriber: sub.name,
          topic: evt.topic,
          id: evt.id,
          seq: evt.seq,
          err: String(err),
        });

        try {
          sub.onError?.(err, evt);
        } catch (e2) {
          this.telemetry.error('subscriber onError hook threw', { subscriber: sub.name, err: String(e2) });
        }

        this.publishInternal(
          {
            topic: 'bus.handler.error',
            source: 'bus',
            schemaVersion: 1,
            attributes: { subscriber: sub.name, topic: evt.topic },
            payload: {
              subscriber: sub.name,
              topic: evt.topic,
              id: evt.id,
              seq: evt.seq,
              error: String(err),
            },
          },
          true
        );
      } finally {
        this.inFlightHandlers -= 1;
        this.maybeResolveIdle();
      }
    }

    sub.processing = false;
    this.maybeResolveIdle();
  }

  private isDrained(): boolean {
    if (this.inFlightHandlers !== 0) return false;
    for (const sub of this.subscribers.values()) {
      if (sub.processing) return false;
      if (sub.queue.length > 0) return false;
    }
    return true;
  }

  private maybeResolveIdle(): void {
    if (!this.isDrained()) return;
    const waiters = this.idleWaiters;
    if (waiters.length === 0) return;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
