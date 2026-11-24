/**
 * Capa P2P sobre WebSocket.
 *
 * Cada nodo:
 *  - Acepta conexiones de otros nodos en /p2p (mismo puerto que la web).
 *  - Se conecta al nodo semilla solo para descubrir pares.
 *  - Se conecta directamente al resto de nodos (P2P puro).
 *  - Propaga mensajes y bloques a todos sus pares.
 */

const WebSocket = require('ws');
const crypto = require('crypto');

const SEED_RETRY_MS = 5000;
const PEERS_REFRESH_MS = 20000;

class P2P {
  constructor({ port, name, seedUrl, onMessage, onPeersChange, onSeedStatus, onConfig }) {
    this.port = port;
    this.name = name;
    this.seedUrl = seedUrl;
    this.onMessage = onMessage;
    this.onPeersChange = onPeersChange;
    this.onSeedStatus = onSeedStatus;
    this.onConfig = onConfig;

    // Identidad unica del nodo (el puerto puede repetirse entre laptops).
    this.nodeId = crypto.randomBytes(8).toString('hex');

    this.peers = new Map(); // ws -> { url, name, port, nodeId }
    this.outgoing = new Set(); // urls de salida ya conectadas / en curso
    this.seedWs = null;
    this.seedConnected = false;

    this.wss = new WebSocket.Server({ noServer: true });
    this.wss.on('connection', (ws) => this.registerPeer(ws, null));
  }

  /** Engancha el upgrade del servidor HTTP en la ruta /p2p. */
  handleUpgrade(request, socket, head) {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }

  registerPeer(ws, url) {
    this.peers.set(ws, { url, name: null, port: null, nodeId: null });

    ws.on('message', (raw) => this.handleRaw(raw, ws));
    ws.on('error', () => {});
    ws.on('close', () => {
      this.peers.delete(ws);
      if (url) this.outgoing.delete(url);
      this.notifyPeers();
    });

    // Presentarse para que el otro nodo muestre nuestro nombre.
    this.send(ws, {
      type: 'HELLO',
      data: { name: this.name, port: this.port, nodeId: this.nodeId },
    });

    // Alguien nuevo se conecto: pedimos su cadena para sincronizarnos ya.
    this.send(ws, { type: 'QUERY_CHAIN' });

    this.notifyPeers();
  }

  connect(url) {
    if (!url || this.outgoing.has(url)) return;
    this.outgoing.add(url);

    const ws = new WebSocket(url);
    let opened = false;

    ws.on('open', () => {
      opened = true;
      this.registerPeer(ws, url);
    });
    ws.on('error', () => {
      if (!opened) this.outgoing.delete(url);
    });
    ws.on('close', () => {
      this.outgoing.delete(url);
      this.peers.delete(ws);
      this.notifyPeers();
    });
  }

  handleRaw(raw, ws) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'HELLO') {
      const info = this.peers.get(ws);
      if (info) {
        info.name = message.data?.name ?? null;
        info.port = message.data?.port ?? null;
        info.nodeId = message.data?.nodeId ?? null;
        this.dedupePeer(ws, info);
        this.notifyPeers();
      }
      return;
    }

    if (typeof this.onMessage === 'function') this.onMessage(message, ws);
  }

  /**
   * Si dos nodos se conectan al mismo tiempo quedan dos sockets entre ellos.
   * Nos quedamos con uno solo: el que inicia el nodo con nodeId menor.
   * Si solo hay una conexion, se conserva (aunque la haya iniciado el otro).
   */
  dedupePeer(ws, info) {
    if (!info.nodeId) return;

    let duplicate = null;
    for (const [otherWs, other] of this.peers) {
      if (otherWs !== ws && other.nodeId === info.nodeId) {
        duplicate = otherWs;
        break;
      }
    }

    if (!duplicate) return;

    const keepOutbound = this.nodeId < info.nodeId;
    const isOutbound = Boolean(info.url);

    if (keepOutbound !== isOutbound) {
      ws.close();
    } else {
      duplicate.close();
    }
  }

  send(ws, object) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(object));
    }
  }

  broadcast(object, exceptWs = null) {
    const data = JSON.stringify(object);
    for (const ws of this.peers.keys()) {
      if (ws === exceptWs) continue;
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  peerList() {
    const seen = new Set();
    const list = [];

    for (const peer of this.peers.values()) {
      const key = peer.nodeId || peer.url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      list.push({ url: peer.url, name: peer.name, port: peer.port });
    }

    return list;
  }

  connectionCount() {
    return this.peers.size;
  }

  notifyPeers() {
    if (typeof this.onPeersChange === 'function') {
      this.onPeersChange(this.peerList());
    }
  }

  connectToSeed() {
    if (!this.seedUrl) return;

    const ws = new WebSocket(this.seedUrl);
    this.seedWs = ws;

    ws.on('open', () => {
      this.seedConnected = true;
      if (this.onSeedStatus) this.onSeedStatus(true);
      this.send(ws, {
        type: 'HELLO',
        data: { port: this.port, name: this.name },
      });
      this.send(ws, { type: 'GET_PEERS' });
    });

    ws.on('message', (raw) => this.handleSeedMessage(raw));

    ws.on('error', () => {});

    ws.on('close', () => {
      this.seedConnected = false;
      if (this.onSeedStatus) this.onSeedStatus(false);
      setTimeout(() => this.connectToSeed(), SEED_RETRY_MS);
    });
  }

  handleSeedMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'CONFIG') {
      if (typeof this.onConfig === 'function') this.onConfig(message.data || {});
      return;
    }

    if (message.type !== 'PEERS') return;
    if (!Array.isArray(message.data)) return;

    for (const peer of message.data) {
      if (peer && typeof peer.url === 'string') this.connect(peer.url);
    }
  }

  /** Pide la lista de pares cada cierto tiempo por si entran nodos nuevos. */
  startSeedHeartbeat() {
    setInterval(() => {
      if (this.seedWs && this.seedWs.readyState === WebSocket.OPEN) {
        this.send(this.seedWs, { type: 'GET_PEERS' });
      }
    }, PEERS_REFRESH_MS);
  }

  close() {
    for (const ws of this.peers.keys()) {
      try {
        ws.close();
      } catch {
        /* ignorar */
      }
    }
    if (this.seedWs) {
      try {
        this.seedWs.close();
      } catch {
        /* ignorar */
      }
    }
    this.wss.close();
  }
}

module.exports = { P2P };
