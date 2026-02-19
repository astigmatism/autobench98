// services/orchestrator/src/core/sinks/sheets/worker/sheets.errors.ts
export type SheetsWorkerErrorShape = {
  message: string
  code?: string
  retryable?: boolean
}

export function toWorkerError(err: unknown): SheetsWorkerErrorShape {
  if (err instanceof Error) {
    const anyErr = err as any
    return {
      message: err.message,
      code: typeof anyErr.code === 'string' ? anyErr.code : undefined,
      retryable: typeof anyErr.retryable === 'boolean' ? anyErr.retryable : undefined,
    }
  }
  return { message: String(err) }
}
