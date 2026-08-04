// AECS — Automated Error Codex System
// TypeScript type definitions

declare module '../src/lib/aecs' {
  // ---------------------------------------------------------------------------
  // Core Types
  // ---------------------------------------------------------------------------

  export interface AECSConfig {
    logDir?: string;
    flushIntervalMs?: number;
    suppressionThreshold?: number;
    suppressionWindowMs?: number;
    fatalImpactThreshold?: number;
    maxCureDepth?: number;
    traceTtlMs?: number;
    handshakeSecret?: string;
    telemetryWebhookUrl?: string;
    telemetryWebhookUrlSecondary?: string;
    telemetryFatalWebhookUrl?: string;
    telemetryFatalWebhookUrlSecondary?: string;
    telemetryHighImpactWebhookUrl?: string;
    telemetryChannelId?: string;
    supportLookupTemplate?: string;
    telemetryTimeoutMs?: number;
    maxBufferSize?: number;
    exitOnFatal?: boolean;
    suppressionMapMaxSize?: number;
  }

  export interface TraceContext {
    traceId: string | null;
    parentTraceId: string | null;
    startedAt: number;
    source: string | null;
    command: string | null;
    subcommand: string | null;
    userId: string | null;
    guildId: string | null;
    channelId: string | null;
    supportId: string;
    healingLedger: Set<string>;
    cureDepth: number;
    metadata?: Record<string, unknown>;
  }

  export type Severity = 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

  export interface ErrorCodeDefinition {
    version?: string;
    title?: string;
    severity?: Severity;
    baseImpact?: number;
    tags?: string[];
    safeMetaKeys?: string[];
    schema?: Record<string, 'string' | 'number' | 'boolean' | 'pruned_string'>;
    escalator?: (meta: Record<string, unknown>, traceContext: TraceContext) => number;
    autocure?: (meta: Record<string, unknown>, traceContext: TraceContext) => Promise<void> | void;
    recoveryHint?: string;
  }

  export interface CodexErrorOptions {
    message?: string;
    originalError?: Error;
  }

  export interface DispatchOptions {
    scope?: string;
    code?: string;
    meta?: Record<string, unknown>;
  }

  export interface DispatchResult {
    record: Record<string, unknown>;
    supportId: string;
    suppressed: boolean;
  }

  export interface SuppressionEntry {
    fingerprint: string;
    code: string;
    scope: string;
    count: number;
    suppressed: number;
    windowStart: number;
  }

  export interface SuppressionSnapshot {
    threshold: number;
    windowMs: number;
    activeFingerprints: number;
    entries: SuppressionEntry[];
  }

  export interface VaultMetrics {
    timestamp: number;
    windowMinutes: number;
    totalErrors: number;
    totalImpact: number;
    bySeverity: Record<Severity, number>;
    latestMinute: Record<string, unknown>;
    logDir: string;
    currentLogFile: string | null;
    currentIdxFile: string | null;
    queued: number;
    maxBufferSize: number;
    persistenceDisabled: boolean;
    persistenceError: string | null;
    persistenceDisabledAt: number | null;
    droppedRecords: number;
    errorsSinceLastSuccess: number;
  }

  export interface AECSMetrics {
    vault: VaultMetrics;
    suppression: SuppressionSnapshot;
  }

  export interface TelemetryResult {
    sent: boolean;
    reason: string;
  }

  export interface TelemetryRoutingOptions {
    telemetryWebhookUrl?: string;
    telemetryWebhookUrlSecondary?: string;
    telemetryFatalWebhookUrl?: string;
    telemetryFatalWebhookUrlSecondary?: string;
    telemetryHighImpactWebhookUrl?: string;
    telemetryChannelId?: string;
    supportLookupTemplate?: string;
    webhookImpactThreshold?: number;
    telemetryTimeoutMs?: number;
  }

  // ---------------------------------------------------------------------------
  // AECS singleton (main export)
  // ---------------------------------------------------------------------------

  export interface AECSCore {
    init(options?: AECSConfig): void;
    reinitialize(options?: AECSConfig): Promise<void>;
    shutdown(): Promise<void>;
    configure(options?: AECSConfig): void;
    dispatch(error: Error | CodexErrorInstance, options?: DispatchOptions): Promise<DispatchResult>;
    runWithTrace<T>(seed: Partial<TraceContext>, callback: () => T | Promise<T>): Promise<T>;
    runWithContext<T>(context: TraceContext, callback: () => T | Promise<T>): Promise<T>;
    withInteraction<T>(interaction: Record<string, unknown>, callback: () => T | Promise<T>): Promise<T>;
    getContext(): TraceContext | null;
    getSupportId(traceId?: string): string;
    signPayload(body: string): string | null;
    verifyPayload(body: string, signature: string): boolean;
    packHandshake(): string | null;
    unpackHandshake<T>(token: string | null, callback: () => T | Promise<T>): Promise<T>;
    getTraceparent(): string;
    adoptTraceparent(
      traceparent: string,
      seed?: Partial<TraceContext>,
      callback?: () => void | Promise<void>
    ): TraceContext | Promise<void>;
    wrapUnknown(error: unknown, code?: string, meta?: Record<string, unknown>): CodexErrorInstance;
     setTelemetryRouting(options: TelemetryRoutingOptions): void;
    getMetrics(): AECSMetrics;
    createTraceId(): string;
    createTraceContext(seed?: Partial<TraceContext>): TraceContext;
    vault: { cleanupOldFiles?(maxAgeDays?: number): number } | null;
    dispatcher: { shouldSuppress(fingerprint: string, code: string, scope: string, severity: string): boolean } | null;
  }

  export interface CodexErrorInstance extends Error {
    name: 'CodexError';
    code: string;
    version: string;
    definition: ErrorCodeDefinition | null;
    meta: Record<string, unknown>;
    timestamp: number;
    originalError: Error | null;
    originalName?: string;
    originalMessage?: string;
    isCodexError: true;
    frozenStack?: string;
  }

  export interface CodexErrorConstructor {
    new (code: string, meta?: Record<string, unknown>, options?: CodexErrorOptions): CodexErrorInstance;
    fromUnknown(error: unknown, code?: string, meta?: Record<string, unknown>): CodexErrorInstance;
  }

  export interface TelemetryAdapterInstance {
    send(record: Record<string, unknown>): Promise<TelemetryResult>;
    buildPayload(record: Record<string, unknown>): Record<string, unknown>;
    hasAnyWebhook(): boolean;
  }

  export interface TelemetryAdapterConstructor {
    new (options?: Record<string, unknown>): TelemetryAdapterInstance;
  }

  export interface ProvisionResultRoute {
    routeKey: string;
    status: 'created' | 'reused' | 'replaced' | 'skipped';
    reason: string | null;
    url: string;
    channelId?: string;
    webhookId?: string;
  }

  export interface ProvisionResult {
    changed: boolean;
    skipped: boolean;
    reason: string | null;
    routes: ProvisionResultRoute[];
    config: {
      telemetryWebhookUrl: string;
      telemetryFatalWebhookUrl: string;
      telemetryHighImpactWebhookUrl: string;
      telemetryChannelId: string;
    } | null;
  }

  export type ProvisionTelemetryWebhooksFn = (
    client: { user?: { id?: string }; channels?: { cache?: { get?: (id: string) => unknown } } },
    options?: Record<string, unknown>
  ) => Promise<ProvisionResult>;

  // ---------------------------------------------------------------------------
  // Module exports
  // ---------------------------------------------------------------------------

  export const AECS: AECSCore;
  export const CodexError: CodexErrorConstructor;
  export const TelemetryAdapter: TelemetryAdapterConstructor;
  export const provisionTelemetryWebhooks: ProvisionTelemetryWebhooksFn;
}
