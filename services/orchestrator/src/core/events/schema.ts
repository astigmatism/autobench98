import { validateTopicPattern, matchTopicPattern } from './topic';

/**
 * Schema registry for (topicPattern, schemaVersion) -> validator(payload) boolean.
 *
 * Safety-critical behavior is enforced by MessageBus using this registry:
 * - If safety-critical topic and no validator exists for schemaVersion -> reject.
 * - If validator exists and returns false / throws -> reject (safety topics) or warn (non-safety).
 *
 * Determinism: for find(topic, version), first registered matching pattern wins.
 */
export class SchemaRegistry {
  private readonly entries: Array<{
    pattern: string;
    segments: string[];
    version: number;
    validate: (payload: unknown) => boolean;
  }> = [];

  register(topicPattern: string, schemaVersion: number, validator: (payload: unknown) => boolean): void {
    const v = validateTopicPattern(topicPattern);
    if (!v.ok) throw new Error(`invalid schema topicPattern "${topicPattern}": ${v.reason}`);
    if (!Number.isInteger(schemaVersion) || schemaVersion <= 0) {
      throw new Error('schemaVersion must be a positive integer');
    }
    if (typeof validator !== 'function') throw new Error('validator must be a function');

    this.entries.push({
      pattern: topicPattern,
      segments: v.segments,
      version: schemaVersion,
      validate: validator,
    });
  }

  find(topic: string, schemaVersion: number): ((payload: unknown) => boolean) | undefined {
    for (const e of this.entries) {
      if (e.version !== schemaVersion) continue;
      if (matchTopicPattern(e.segments, topic)) return e.validate;
    }
    return undefined;
  }
}
