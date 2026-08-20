export type WakeTerm =
  | readonly ["string", string]
  | readonly ["integer", string]
  | readonly ["float64", string]
  | readonly ["boolean", boolean]
  | readonly ["keyword", string]
  | readonly ["instant", string, string]
  | readonly ["triple", WakeTerm, WakeTerm, WakeTerm];

export interface WakeStoreResponse<Result> {
  readonly space?: string;
  readonly operation?: string;
  readonly servedVersion: bigint;
  readonly page: null | Readonly<{
    ordinal: number;
    nextCursor: WakeTerm | null;
    done: boolean;
  }>;
  readonly result: Result;
  readonly payload?: WakeTerm | null;
}

export interface WakeStoreClient {
  status(options?: Readonly<{ signal?: AbortSignal }>): Promise<WakeStoreResponse<unknown>>;
  query(
    query: unknown,
    options?: Readonly<{
      asOf?: bigint | number | string;
      page?: Readonly<{ limit: bigint | number | string; cursor?: WakeTerm }>;
      signal?: AbortSignal;
      since?: unknown;
      timeoutMs?: bigint | number | string;
    }>,
  ): Promise<WakeStoreResponse<WakeTerm[][]>>;
}

export interface WakeSchemaClient {
  createUnique(input: unknown): Promise<unknown>;
  transactUnique(input: unknown): Promise<unknown>;
  updateUnique(input: unknown): Promise<unknown>;
  updateUniqueMany(input: unknown): Promise<unknown>;
}

export interface WakeApplicationReceipt {
  readonly applicationId: string;
  readonly deploymentArtifactReceiptDigest: string;
  readonly operationSurfaceDigest: string;
  readonly protocols: Readonly<{
    storePlanSchemaVersion: 2;
    httpOperationProtocolVersion: 2;
    pluginAbiVersion: 1;
  }>;
  readonly schemaVersion: 1;
  readonly semanticFingerprint: string;
  readonly storageProjectionDigest: string;
}

export interface WakeCompilerMetadata {
  readonly name: "wake";
  readonly sourceCommit: string;
  readonly version: "0.1.0";
}

export interface WakeCompilerProtocols {
  readonly storePlanSchemaVersion: 2;
  readonly httpOperationProtocolVersion: 2;
  readonly pluginAbiVersion: 1;
}

export interface WakeCompilerCompatibility {
  readonly compiler: WakeCompilerMetadata;
  readonly manifestSchemaVersion: 1;
  readonly protocols: WakeCompilerProtocols;
}

export const wakeRuntimeCompilerContract: Readonly<{
  compiler: Readonly<Pick<WakeCompilerMetadata, "name" | "version">>;
  manifestSchemaVersion: 1;
  protocols: WakeCompilerProtocols;
}>;

export class WakeCompilerCompatibilityError extends TypeError {
  readonly code: "compiler/invalid-metadata" | "compiler/incompatible";
  constructor(
    code: "compiler/invalid-metadata" | "compiler/incompatible",
    message: string,
  );
}

export function checkWakeCompilerCompatibility(
  input: Readonly<{
    compiler: unknown;
    manifestSchemaVersion: unknown;
    protocols: unknown;
  }>,
): WakeCompilerCompatibility;

export interface WakeAuthorizationContext {
  readonly actor: Readonly<Record<string, unknown>>;
  readonly traceId: string;
  readonly [name: string]: unknown;
}

export interface WakeAuthorizedActor extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly capabilities: readonly string[];
}

export type WakeAuthorizationDecision = boolean | Readonly<{
  allowed: boolean;
  actor: WakeAuthorizedActor;
  authorizationScope?: string;
}>;

export interface WakeOperationContext {
  readonly actor: Readonly<Record<string, unknown>>;
  readonly traceId: string;
}

export interface WakeQueryOptions {
  readonly asOf?: bigint | number | string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WakeApplicationAdapter {
  readonly applicationId: string;
  readonly artifacts: Readonly<{
    manifestDigest: string;
    planDigest: string;
    receiptDigest: string;
  }>;
  readonly semanticFingerprint: string;
  checkReadiness(): Promise<boolean>;
  executeQuery(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options: WakeQueryOptions,
    context: WakeOperationContext,
  ): Promise<unknown>;
  handleOperation(
    request: Request,
    context: WakeOperationContext,
  ): Promise<Response>;
  invokeCommand(
    name: string,
    requestId: string,
    input: Readonly<Record<string, unknown>>,
    context: WakeOperationContext,
  ): Promise<unknown>;
}

export interface WakeCursorConfiguration {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Uint8Array | ArrayBuffer | CryptoKey>
    | Readonly<Record<string, Uint8Array | ArrayBuffer | CryptoKey>>;
  readonly ttlMs?: number;
}

export interface WakeApplicationAdapterInput {
  readonly applicationReceipt: WakeApplicationReceipt;
  readonly authorize: (
    context: WakeAuthorizationContext,
  ) => WakeAuthorizationDecision | Promise<WakeAuthorizationDecision>;
  readonly browserClient: string | Uint8Array;
  readonly browserJavaScript: string | Uint8Array;
  readonly cursor?: WakeCursorConfiguration;
  readonly deploymentReceipt: string | Uint8Array;
  readonly store: WakeStoreClient;
  readonly manifest: string | Uint8Array;
  readonly plan: string | Uint8Array;
  readonly providers?: Readonly<Record<
    string,
    (input: unknown) => unknown | Promise<unknown>
  >>;
  readonly schema: WakeSchemaClient;
  readonly serverValues?: Readonly<Record<string, unknown>>;
}

export interface LoadApplicationReceiptInput {
  readonly applicationId: string;
  readonly deploymentReceipt: string | Uint8Array;
  readonly store: Pick<WakeStoreClient, "query">;
  readonly manifest: string | Uint8Array;
  readonly plan: string | Uint8Array;
}

export interface WakeApplicationInitializeContext {
  readonly applicationReceipt: WakeApplicationReceipt;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly schema: WakeSchemaClient;
}

export interface InstallApplicationInput extends LoadApplicationReceiptInput {
  readonly initialize: (
    context: WakeApplicationInitializeContext,
  ) => void | Promise<void>;
  readonly schema: WakeSchemaClient;
}

export function createWakeApplicationAdapter(
  input: WakeApplicationAdapterInput,
): WakeApplicationAdapter;

/** @deprecated Use WakeApplicationAdapter. */
export type WakeBunAdapter = WakeApplicationAdapter;

/** @deprecated Use WakeApplicationAdapterInput. */
export type WakeBunAdapterInput = WakeApplicationAdapterInput;

/** @deprecated Use createWakeApplicationAdapter. */
export const createWakeBunAdapter: typeof createWakeApplicationAdapter;

export interface WakeWorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface WakeWorkerErrorContext {
  readonly executionContext: WakeWorkerExecutionContext;
  readonly phase:
    | "fallback"
    | "handle"
    | "request"
    | "route";
}

export interface WakeWorkerHost<Environment = unknown> {
  fetch(
    request: Request,
    environment: Environment,
    executionContext: WakeWorkerExecutionContext,
  ): Promise<Response>;
}

export interface WakeWorkerHostInput<Environment = unknown> {
  readonly fallback?: (
    request: Request,
    environment: Environment,
    executionContext: WakeWorkerExecutionContext,
  ) => Response | Promise<Response>;
  readonly onError?: (
    error: unknown,
    context: WakeWorkerErrorContext,
  ) => Response | Promise<Response>;
  readonly handle: (
    request: Request,
    environment: Environment,
    executionContext: WakeWorkerExecutionContext,
  ) => Response | Promise<Response>;
  readonly route: (
    request: Request,
    environment: Environment,
    executionContext: WakeWorkerExecutionContext,
  ) => boolean;
}

export class WakeWorkerConfigError extends TypeError {}

export function createWakeWorkerHost<Environment = unknown>(
  input: WakeWorkerHostInput<Environment>,
): WakeWorkerHost<Environment>;

export function loadApplicationReceipt(
  input: LoadApplicationReceiptInput,
): Promise<WakeApplicationReceipt>;

export function installApplication(
  input: InstallApplicationInput,
): Promise<WakeApplicationReceipt>;

export function rejectProviderInput(message: string, detail?: unknown): never;

export class CheckedValueError extends TypeError {
  readonly code: string;
}

export interface WakeCheckedValueOptions {
  readonly code?: string;
  readonly label?: string;
}

export interface WakeCompiledCheckedValue<Value = unknown> {
  readonly descriptor: unknown;
  normalize(value: unknown, options?: WakeCheckedValueOptions): Value;
}

export function compileCheckedValue<Value = unknown>(
  descriptor: unknown,
  options?: Readonly<{ descriptorCode?: string }>,
): WakeCompiledCheckedValue<Value>;

export function normalizeCheckedValue<Value = unknown>(
  value: unknown,
  descriptor: unknown,
  options?: WakeCheckedValueOptions,
): Value;

export type WakeSafeUrl =
  | Readonly<{ kind: "external"; href: string }>
  | Readonly<{ kind: "internal"; reference: string }>;

export type WakeSafeUrlResolution =
  | Readonly<{ kind: "canonical"; href: string }>
  | Readonly<{ kind: "unavailable" }>;

export function renderSafeDocument(
  value: unknown,
  options: Readonly<{
    descriptor: unknown;
    document?: Document;
    resolveSafeUrl?: (value: WakeSafeUrl) => WakeSafeUrlResolution;
  }>,
): DocumentFragment;
