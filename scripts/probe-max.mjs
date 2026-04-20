import 'dotenv/config';
import { getRpcClient, encodeRpcVarintField, encodeRpcEmbedded, concatBytes, decodeRpcProto } from '../core/chain.js';
const rpc = await getRpcClient();
async function probe(planId, pageSize) {
  const req = concatBytes([
    encodeRpcVarintField(1, BigInt(planId)),
    encodeRpcVarintField(2, 1),
    encodeRpcEmbedded(3, encodeRpcVarintField(3, pageSize)),
  ]);
  const res = await rpc.queryClient.queryAbci('/sentinel.node.v3.QueryService/QueryNodesForPlan', req);
  return (decodeRpcProto(new Uint8Array(res.value))[1] || []).length;
}
for (const size of [1000, 2000, 5000, 10000]) {
  try {
    const c = await probe(36, size);
    console.log(`limit=${size}: ${c} nodes`);
  } catch (e) {
    console.log(`limit=${size}: ERROR ${e.message}`);
  }
}
process.exit(0);
