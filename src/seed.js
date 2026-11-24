/**
 * Nodo semilla.
 *
 * NO guarda la cadena ni mina: solo sirve como punto de encuentro para que
 * los nodos se descubran entre si. Una vez conectados, los nodos hablan
 * directamente (P2P puro) y la cadena se sincroniza entre ellos.
 *
 * Uso:
 *   node src/seed.js --port 4000
 */

const os = require('os');
const WebSocket = require('ws');
const config = require('./config');

const PORT = config.seedPort;

const wss = new WebSocket.Server({ port: PORT, host: config.host });

/** ws -> { ip, port, name } */
const nodes = new Map();

function normalizeIp(ip) {
  if (!ip) return '127.0.0.1';
  if (ip === '::1') return '127.0.0.1';
  return ip.replace(/^::ffff:/, '');
}

function urlFor(entry) {
  if (!entry || !entry.port) return null;
  const host = entry.ip.includes(':') ? `[${entry.ip}]` : entry.ip;
  return `ws://${host}:${entry.port}/p2p`;
}

function peersFor(ws) {
  const me = nodes.get(ws);
  const myUrl = urlFor(me);
  const seen = new Set();
  const list = [];

  for (const [otherWs, entry] of nodes) {
    if (otherWs === ws) continue;
    const url = urlFor(entry);
    if (!url) continue;
    if (myUrl && url === myUrl) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    list.push({ url, name: entry.name || null, port: entry.port });
  }

  return list;
}

function sendPeers(ws) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'PEERS', data: peersFor(ws) }));
  }
}

function broadcastPeers() {
  for (const ws of nodes.keys()) sendPeers(ws);
}

wss.on('connection', (ws, request) => {
  const ip = normalizeIp(request.socket.remoteAddress);

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'HELLO') {
      const port = message.data?.port;
      if (!Number.isFinite(port)) return;
      nodes.set(ws, {
        ip,
        port,
        name: message.data?.name || null,
      });
      console.log(`[semilla] nodo conectado: ${message.data?.name || '?'} (${ip}:${port})`);
      // La dificultad la manda el semilla para que toda la red use la misma.
      ws.send(JSON.stringify({ type: 'CONFIG', data: { difficulty: config.difficulty } }));
      broadcastPeers();
      return;
    }

    if (message.type === 'GET_PEERS') {
      sendPeers(ws);
    }
  });

  ws.on('close', () => {
    const entry = nodes.get(ws);
    if (entry) {
      console.log(`[semilla] nodo desconectado: ${entry.name || '?'} (${entry.ip}:${entry.port})`);
    }
    nodes.delete(ws);
    broadcastPeers();
  });

  ws.on('error', () => {});
});

wss.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n[error] El puerto ${PORT} ya esta en uso. Prueba otro con --port.\n`);
    process.exit(1);
  }
  console.error('[semilla] error:', error.message);
});

function lanAddresses() {
  const result = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) result.push(net.address);
    }
  }
  return result;
}

console.log('');
console.log('==================================================');
console.log('  NODO SEMILLA DE LA RED');
console.log(`  Escuchando en el puerto ${PORT}`);
console.log('');
console.log('  Comparte esta URL con tus alumnos:');
const addresses = lanAddresses();
if (addresses.length === 0) {
  console.log(`    ws://localhost:${PORT}`);
} else {
  for (const address of addresses) {
    console.log(`    ws://${address}:${PORT}`);
  }
  console.log('');
  console.log('  Usa la IP de tu Wi-Fi (ignora las de Docker o VPN).');
}
console.log('');
console.log(`  Dificultad de la red: ${config.difficulty} ceros`);
console.log('  Este nodo solo descubre pares. No mina ni guarda la cadena.');
console.log('==================================================');
console.log('');
