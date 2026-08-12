export type WakeTerm =
  | readonly ["string", string]
  | readonly ["integer", string]
  | readonly ["float64", string]
  | readonly ["boolean", boolean]
  | readonly ["keyword", string]
  | readonly ["instant", string, string]
  | readonly ["triple", WakeTerm, WakeTerm, WakeTerm];

export interface WakeFramResponse<Result> {
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

export interface WakeFramClient {
  status(options?: Readonly<{ signal?: AbortSignal }>): Promise<WakeFramResponse<unknown>>;
  query(
    query: unknown,
    options?: Readonly<{
      asOf?: bigint | number | string;
      page?: Readonly<{ limit: bigint | number | string; cursor?: WakeTerm }>;
      signal?: AbortSignal;
      since?: unknown;
      timeoutMs?: bigint | number | string;
    }>,
  ): Promise<WakeFramResponse<WakeTerm[][]>>;
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
    framPlanSchemaVersion: 2;
    httpOperationProtocolVersion: 2;
    pluginAbiVersion: 1;
  }>;
  readonly schemaVersion: 1;
  readonly semanticFingerprint: string;
  readonly storageProjectionDigest: string;
}

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

export interface WakeBunAdapter {
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

export interface WakeBunAdapterInput {
  readonly applicationReceipt: WakeApplicationReceipt;
  readonly authorize: (
    context: WakeAuthorizationContext,
  ) => WakeAuthorizationDecision | Promise<WakeAuthorizationDecision>;
  readonly browserClient: string | Uint8Array;
  readonly browserJavaScript: string | Uint8Array;
  readonly cursor?: WakeCursorConfiguration;
  readonly deploymentReceipt: string | Uint8Array;
  readonly fram: WakeFramClient;
  readonly manifest: string | Uint8Array;
  readonly plan: string | Uint8Array;
  readonly providers?: Readonly<Record<
    string,
    (input: unknown) => unknown | Promise<unknown>
  >>;
  readonly schema: WakeSchemaClient;
}

export interface LoadApplicationReceiptInput {
  readonly applicationId: string;
  readonly deploymentReceipt: string | Uint8Array;
  readonly fram: Pick<WakeFramClient, "query">;
  readonly manifest: string | Uint8Array;
  readonly plan: string | Uint8Array;
}

export function createWakeBunAdapter(input: WakeBunAdapterInput): WakeBunAdapter;

export function loadApplicationReceipt(
  input: LoadApplicationReceiptInput,
): Promise<WakeApplicationReceipt>;

export function rejectProviderInput(message: string, detail?: unknown): never;
