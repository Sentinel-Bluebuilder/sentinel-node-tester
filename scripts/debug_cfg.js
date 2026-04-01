import { buildV2RayClientConfig } from './lib/v3protocol.js';

const metadataStr = JSON.stringify({
    metadata: [
        { port: "2504", proxy_protocol: 2, transport_protocol: 3, transport_security: 1 },
        { port: "20019", proxy_protocol: 1, transport_protocol: 7, transport_security: 1 }
    ]
});

const cfg1 = buildV2RayClientConfig('172.245.81.103', metadataStr, 'ef6a6230-7496-4a0c-9fc5-abfeadb5e1e6', 1080);
console.log(JSON.stringify(cfg1, null, 2));
