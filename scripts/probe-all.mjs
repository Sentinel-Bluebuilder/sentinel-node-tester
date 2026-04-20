import 'dotenv/config';
import { getRpcClient, encodeRpcVarintField, encodeRpcEmbedded, concatBytes, decodeRpcProto } from '../core/chain.js';
const rpc = await getRpcClient();
async function probe(pageSize) {
  const req = concatBytes([
    encodeRpcVarintField(1, 1),
    encodeRpcEmbedded(2, encodeRpcVarintField(3, pageSize)),
  ]);
  const res = await rpc.queryClient.queryAbci('/sentinel.node.v3.QueryService/QueryNodes', req);
  return (decodeRpcProto(new Uint8Array(res.value))[1] || []).length;
}
for (const size of [1000, 5000, 10000, 20000]) {
  try {
    const c = await probe(size);
    console.log(`limit=${size}: ${c} nodes`);
  } catch (e) {
    console.log(`limit=${size}: ERROR ${e.message}`);
  }
}
process.exit(0);
