export type Severity = "info" | "warning" | "critical";

export type EventKind =
  | "native-in"
  | "native-out"
  | "registration"
  | "evm-in"
  | "evm-out"
  | "evm-call"
  | "pqc-key"
  | "evm-window"
  | "system";

export interface Watch {
  id: number;
  address: string;
  evmAddress: string;
  label: string;
  telegramChatId: string | null;
  createdAt: string;
  lastNativeHeight: number;
  lastEvmBlock: number;
  lastPqcFingerprint: string | null;
  lastWindowFingerprint: string | null;
}

export interface AlertEvent {
  id: number;
  watchId: number;
  address: string;
  label: string;
  kind: EventKind;
  severity: Severity;
  title: string;
  detail: string;
  txHash: string | null;
  blockHeight: number | null;
  createdAt: string;
}

export interface NewWatch {
  address: string;
  label?: string;
  telegramChatId?: string | null;
}
