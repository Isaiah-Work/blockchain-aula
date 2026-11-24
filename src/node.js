/**
 * Nodo de la blockchain del salon.
 *
 * Un solo puerto sirve:
 *   - La interfaz web (http://IP:PUERTO)
 *   - El WebSocket del navegador (ws://IP:PUERTO/ws)
 *   - El WebSocket P2P entre nodos (ws://IP:PUERTO/p2p)
 *
 * Uso:
 *   node src/node.js --port 3000 --name "Ana" --seed ws://192.168.1.50:4000
 */

const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');

const config = require('./config');
const { Blockchain } = require('./blockchain');
const { P2P } = require('./p2p');

// ---------------------------------------------------------------------------
// Estado del nodo
// ---------------------------------------------------------------------------

const chain = new Blockchain(config.difficulty);
const seenBlocks = new Set(chain.chain.map((block) => block.hash));

let peers = [];
let seedConnected = false;
let miningEnabled = true;
let miningGeneration = 0;
let miningStatus = null;
let lastMiningResult = null;
let lastChainQueryAt = 0;

const browserClients = new Set();
const browserWss = new WebSocket.Server({ noServer: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Estado que se envia al navegador
// ---------------------------------------------------------------------------

function buildState() {
  const confirmedMessages = chain.chain.reduce(
    (total, block) => total + block.messages.length,
    0
  );

  return {
    node: {
      name: config.name,
      port: config.port,
      difficulty: chain.difficulty,
    },
    seedConnected,
    peers,
    chain: chain.chain,
    mempool: [...chain.mempool.values()],
    mining: {
      enabled: miningEnabled,
      active: miningEnabled && chain.mempool.size > 0,
      progress: miningStatus,
      last: lastMiningResult,
    },
    stats: {
      blocks: chain.chain.length,
      confirmedMessages,
      pendingMessages: chain.mempool.size,
      peerConnections: p2p ? p2p.connectionCount() : 0,
    },
  };
}

function broadcastState() {
  const data = JSON.stringify({ type: 'STATE', data: buildState() });
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

let lastProgressAt = 0;

function onMiningProgress(progress) {
  miningStatus = progress;
  const now = Date.now();
  if (now - lastProgressAt > 250) {
    lastProgressAt = now;
    broadcastState();
  }
}

// ---------------------------------------------------------------------------
// P2P
// ---------------------------------------------------------------------------

const p2p = new P2P({
  port: config.port,
  name: config.name,
  seedUrl: config.seedUrl,
  onMessage: handleP2PMessage,
  onPeersChange: (list) => {
    peers = list;
    broadcastState();
  },
  onSeedStatus: (connected) => {
    seedConnected = connected;
    broadcastState();
  },
  onConfig: (data) => {
    const difficulty = parseInt(data.difficulty, 10);
    if (!Number.isFinite(difficulty)) return;

    const reset = chain.setDifficulty(difficulty);
    if (reset) {
      seenBlocks.clear();
      for (const block of chain.chain) seenBlocks.add(block.hash);
      miningGeneration++;
      console.log(`[nodo] dificultad cambiada a ${difficulty}; resincronizando cadena`);
      p2p.broadcast({ type: 'QUERY_CHAIN' });
    }
    broadcastState();
  },
});

function maybeQueryChain(ws) {
  const now = Date.now();
  if (now - lastChainQueryAt < 1000) return;
  lastChainQueryAt = now;
  p2p.send(ws, { type: 'QUERY_CHAIN' });
}

function handleP2PMessage(message, ws) {
  switch (message.type) {
    case 'BLOCK': {
      const block = message.data;
      if (!block || typeof block !== 'object') return;
      if (seenBlocks.has(block.hash)) return;

      if (chain.addBlock(block)) {
        seenBlocks.add(block.hash);
        p2p.broadcast({ type: 'BLOCK', data: block }, ws);
        miningGeneration++; // aborta el minado actual: hay nueva punta
        broadcastState();
      } else if (block.index > chain.lastBlock.index) {
        // Nos falta historia: pedimos la cadena completa.
        maybeQueryChain(ws);
      }
      return;
    }

    case 'CHAIN': {
      const incoming = message.data;
      if (chain.replaceChain(incoming)) {
        for (const block of incoming) seenBlocks.add(block.hash);
        miningGeneration++;
        broadcastState();
      }
      return;
    }

    case 'MESSAGE': {
      const msg = message.data;
      if (chain.addMessage(msg)) {
        p2p.broadcast({ type: 'MESSAGE', data: msg }, ws);
        broadcastState();
      }
      return;
    }

    case 'QUERY_CHAIN': {
      p2p.send(ws, { type: 'CHAIN', data: chain.chain });
      return;
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Minado
// ---------------------------------------------------------------------------

async function miningLoop() {
  while (true) {
    // Solo minamos cuando hay mensajes pendientes: asi la cadena crece
    // cuando alguien escribe y no se llena de bloques vacios.
    if (!miningEnabled || chain.mempool.size === 0) {
      if (miningStatus !== null) {
        miningStatus = null;
        broadcastState();
      }
      await sleep(250);
      continue;
    }

    const generation = miningGeneration;
    const tipHash = chain.lastBlock.hash;

    const result = await chain.mine(
      onMiningProgress,
      () =>
        generation !== miningGeneration ||
        chain.lastBlock.hash !== tipHash ||
        !miningEnabled ||
        chain.mempool.size === 0
    );

    if (result && generation === miningGeneration && chain.lastBlock.hash === tipHash) {
      if (chain.addBlock(result.block)) {
        seenBlocks.add(result.block.hash);
        p2p.broadcast({ type: 'BLOCK', data: result.block });

        lastMiningResult = {
          index: result.block.index,
          attempts: result.attempts,
          elapsed: result.elapsed,
          hashesPerSecond: Math.round(
            (result.attempts / Math.max(result.elapsed, 1)) * 1000
          ),
          hash: result.block.hash,
          at: Date.now(),
        };
        miningStatus = null;
        miningGeneration++;
        broadcastState();
      }
    }

    await sleep(5);
  }
}

// ---------------------------------------------------------------------------
// Servidor HTTP + WebSocket del navegador
// ---------------------------------------------------------------------------

const app = express();
app.get('/api/state', (request, response) => response.json(buildState()));
app.get('/api/health', (request, response) =>
  response.json({ ok: true, node: config.name, blocks: chain.chain.length })
);
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;

  if (pathname === '/ws') {
    browserWss.handleUpgrade(request, socket, head, (ws) => {
      browserWss.emit('connection', ws, request);
    });
    return;
  }

  if (pathname === '/p2p') {
    p2p.handleUpgrade(request, socket, head);
    return;
  }

  socket.destroy();
});

browserWss.on('connection', (ws) => {
  browserClients.add(ws);
  ws.send(JSON.stringify({ type: 'STATE', data: buildState() }));

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'SEND_MESSAGE') {
      const text = String(message.data?.text ?? '').trim().slice(0, 500);
      const author =
        String(message.data?.author ?? '').trim().slice(0, 40) || 'anonimo';
      if (!text) return;

      const newMessage = {
        id: crypto.randomBytes(8).toString('hex'),
        author,
        text,
        timestamp: Date.now(),
      };

      if (chain.addMessage(newMessage)) {
        p2p.broadcast({ type: 'MESSAGE', data: newMessage });
        broadcastState();
      }
      return;
    }

    if (message.type === 'SET_MINING') {
      miningEnabled = Boolean(message.data?.enabled);
      miningGeneration++;
      broadcastState();
      return;
    }

    if (message.type === 'REQUEST_STATE') {
      ws.send(JSON.stringify({ type: 'STATE', data: buildState() }));
    }
  });

  ws.on('close', () => browserClients.delete(ws));
  ws.on('error', () => {});
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

function lanAddresses() {
  const result = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) result.push(net.address);
    }
  }
  return result;
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n[error] El puerto ${config.port} ya esta en uso.`);
    console.error(`        Prueba con otro: node src/node.js --port ${config.port + 1}\n`);
    process.exit(1);
  }
  console.error('[nodo] error:', error.message);
});

server.listen(config.port, config.host, () => {
  console.log('');
  console.log('==================================================');
  console.log(`  NODO: ${config.name}`);
  console.log(`  Dificultad inicial: ${config.difficulty} ceros (la manda el semilla)`);
  console.log('');
  console.log(`  Interfaz:  http://localhost:${config.port}`);
  for (const address of lanAddresses()) {
    console.log(`             http://${address}:${config.port}`);
  }
  console.log('');
  console.log(`  Semilla:   ${config.seedUrl}`);
  console.log('==================================================');
  console.log('');

  p2p.connectToSeed();
  p2p.startSeedHeartbeat();
  miningLoop();
});

process.on('SIGINT', () => {
  console.log('\n[nodo] cerrando...');
  p2p.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});
