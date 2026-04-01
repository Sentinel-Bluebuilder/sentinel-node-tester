const http = require('http');
http.get('http://localhost:3001/api/state', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const s = JSON.parse(d).state;
    console.log('Started:', s.startedAt);
    console.log('Tested:', s.testedNodes, '/', s.totalNodes);
    console.log('Status:', s.status);
  });
}).on('error', e => console.error(e.message));
