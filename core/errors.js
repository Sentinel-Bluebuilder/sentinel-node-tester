/**
 * Sentinel Node Tester — Error Classes
 * Thin adapter over SDK errors. Adds .diag field for audit diagnostics.
 *
 * SDK provides: SentinelError, ValidationError, NodeError, ChainError,
 * TunnelError, SecurityError, ErrorCodes, ERROR_SEVERITY, isRetryable, userMessage
 */

import {
  SentinelError, ValidationError, NodeError, ChainError as SdkChainError,
  TunnelError as SdkTunnelError, SecurityError,
  ErrorCodes, ERROR_SEVERITY, isRetryable, userMessage,
} from 'blue-js-sdk';

// Re-export SDK error utilities for consumers
export { ErrorCodes, ERROR_SEVERITY, isRetryable, userMessage, SentinelError, ValidationError, NodeError, SecurityError };

// ─── Base Audit Error (extends SDK's SentinelError, adds .diag) ─────────────
export class AuditError extends SentinelError {
  constructor(message, code, diag = {}) {
    super(code, message);
    this.name = 'AuditError';
    this.code = code;
    this.diag = diag;
  }
}

// ─── Chain / LCD / RPC Errors ────────────────────────────────────────────────
export class ChainError extends AuditError {
  constructor(message, diag = {}) {
    super(message, 'CHAIN_ERROR', diag);
    this.name = 'ChainError';
  }
}

// ─── Handshake Errors ────────────────────────────────────────────────────────
export class HandshakeError extends AuditError {
  constructor(message, diag = {}) {
    super(message, 'HANDSHAKE_ERROR', diag);
    this.name = 'HandshakeError';
  }
}

// ─── Tunnel / Connection Errors ──────────────────────────────────────────────
export class TunnelError extends AuditError {
  constructor(message, diag = {}) {
    super(message, 'TUNNEL_ERROR', diag);
    this.name = 'TunnelError';
  }
}

// ─── Payment Errors ──────────────────────────────────────────────────────────
export class PaymentError extends AuditError {
  constructor(message, diag = {}) {
    super(message, 'PAYMENT_ERROR', diag);
    this.name = 'PaymentError';
  }
}

// ─── VPN Interference ────────────────────────────────────────────────────────
export class VpnInterferenceError extends AuditError {
  constructor(message, diag = {}) {
    super(message, 'VPN_INTERFERENCE', diag);
    this.name = 'VpnInterferenceError';
  }
}

// ─── Node Unreachable ────────────────────────────────────────────────────────
export class NodeUnreachableError extends AuditError {
  constructor(message, diag = {}) {
    super(message, 'NODE_UNREACHABLE', diag);
    this.name = 'NodeUnreachableError';
  }
}

// ─── Insufficient Balance ────────────────────────────────────────────────────
export class InsufficientBalanceError extends AuditError {
  constructor(message, diag = {}) {
    super(message, 'INSUFFICIENT_BALANCE', diag);
    this.name = 'InsufficientBalanceError';
  }
}

// ─── Speed Test Errors ───────────────────────────────────────────────────────
export class SpeedTestError extends AuditError {
  constructor(message, diag = {}) {
    super(message, 'SPEEDTEST_ERROR', diag);
    this.name = 'SpeedTestError';
  }
}
