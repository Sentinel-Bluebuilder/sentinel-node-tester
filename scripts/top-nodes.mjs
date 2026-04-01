import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('./results/results.json', 'utf8'));

const wgPasses = r.filter(x => x.type === 'WireGuard' && x.actualMbps > 0 && x.error == null)
  .sort((a,b) => b.actualMbps - a.actualMbps).slice(0,10);
console.log('=== TOP 10 WIREGUARD ===');
wgPasses.forEach(x => console.log(x.address, '|', (x.moniker||'?').padEnd(35), '|', String(x.actualMbps).padStart(6)+'Mbps', '|', x.country));

const v2Passes = r.filter(x => x.type === 'V2Ray' && x.actualMbps > 0 && x.error == null)
  .sort((a,b) => b.actualMbps - a.actualMbps).slice(0,10);
console.log();
console.log('=== TOP 10 V2RAY ===');
v2Passes.forEach(x => console.log(x.address, '|', (x.moniker||'?').padEnd(35), '|', String(x.actualMbps).padStart(6)+'Mbps', '|', x.country));
