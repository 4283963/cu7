const http = require('http');
http.get('http://localhost:8080/', (res) => {
  console.log('HTTP Status:', res.statusCode);
  let d = '';
  res.on('data', (c) => d += c);
  res.on('end', () => {
    console.log('Body length:', d.length);
    console.log('Contains title:', d.includes('蒸汽舰队'));
    console.log('Contains canvas:', d.includes('mapCanvas'));
  });
}).on('error', (e) => console.error('Error:', e.message));

const WebSocket = require('ws');
setTimeout(() => {
  console.log('\n--- WebSocket Handshake Test ---');
  const ws = new WebSocket('ws://localhost:8080/');
  ws.on('open', () => {
    console.log('WS connected');
    const msg = JSON.stringify({
      type: 'c2s_handshake',
      payload: { clientVersion: '0.1.0', playerName: 'TestBot' },
      id: 'test-1',
      seq: 1,
      ts: Date.now()
    });
    ws.send(msg);
  });
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString());
      console.log('WS received type:', m.type);
      console.log('Contains serverVersion:', m.payload && m.payload.serverVersion);

      const joinMsg = JSON.stringify({
        type: 'c2s_create_room',
        payload: { playerName: 'Bot1', roomName: 'TestRoom' },
        id: 'test-2', seq: 2, ts: Date.now()
      });
      ws.send(joinMsg);
    } catch (e) { console.warn('Parse error:', e); }
  });
  setTimeout(() => {
    console.log('\nAll smoke tests done.');
    process.exit(0);
  }, 1200);
}, 300);
