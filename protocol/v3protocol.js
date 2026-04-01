/**
 * Sentinel Node Tester — v3 Protocol
 * Thin adapter: re-exports from Sentinel SDK v3protocol.
 *
 * SDK provides all handshake, config, encoding, and protobuf functions
 * with improvements over the original local implementations:
 *   - CIDR validation on handshake responses
 *   - QUIC transport filtering (0% success rate)
 *   - Bidirectional gun↔grpc variants
 *   - WireGuard MTU=1280 (was 1420), DNS=10.8.0.1, keepalive=15
 *   - ACL enforcement on config files (SecurityError on failure)
 *   - Dynamic transport priority via getDynamicRate()
 *   - Port validation (1-65535, NaN guard)
 *   - Explicit VLESS flow:'' field
 */

export {
  nodeStatusV3,
  generateWgKeyPair,
  initHandshakeV3,
  initHandshakeV3V2Ray,
  buildV2RayClientConfig,
  writeWgConfig,
  extractSessionId,
  waitForPort,
  generateV2RayUUID,
  encodeVarint,
  protoString,
  protoInt64,
  protoEmbedded,
  encodeMsgStartSession,
  encodeMsgStartSubscription,
  encodeMsgSubStartSession,
  validateCIDR,
} from 'sentinel-dvpn-sdk/v3protocol';
