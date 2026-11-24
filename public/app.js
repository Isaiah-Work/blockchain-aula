/* Interfaz del nodo: recibe el estado por WebSocket y lo pinta. */

const els = {
  nodeName: document.getElementById('node-name'),
  nodePort: document.getElementById('node-port'),
  difficulty: document.getElementById('difficulty'),
  seedDot: document.getElementById('seed-dot'),
  seedStatus: document.getElementById('seed-status'),
  peerCount: document.getElementById('peer-count'),
  blockCount: document.getElementById('block-count'),
  msgCount: document.getElementById('msg-count'),
  pendingCount: document.getElementById('pending-count'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  author: document.getElementById('author'),
  text: document.getElementById('text'),
  miningCard: document.getElementById('mining-card'),
  miningLabel: document.getElementById('mining-label'),
  miningToggle: document.getElementById('mining-toggle'),
  miningAttempts: document.getElementById('mining-attempts'),
  miningRate: document.getElementById('mining-rate'),
  miningNonce: document.getElementById('mining-nonce'),
  miningHash: document.getElementById('mining-hash'),
  lastBlock: document.getElementById('last-block'),
  chain: document.getElementById('chain'),
  connection: document.getElementById('connection'),
};

let state = null;
let socket = null;
let reconnectTimer = null;
let lastChainSignature = '';
let lastMessagesSignature = '';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('es');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatTime(timestamp) {
  if (!timestamp) return 'génesis';
  return new Date(timestamp).toLocaleTimeString('es', { hour12: false });
}

function shortHash(hash) {
  if (!hash) return '—';
  return `${hash.slice(0, 14)}…${hash.slice(-8)}`;
}

function setConnection(status, text) {
  els.connection.className = status;
  els.connection.textContent = text;
}

// ---------------------------------------------------------------------------
// WebSocket con reconexión automática
// ---------------------------------------------------------------------------

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.addEventListener('open', () => {
    setConnection('live', 'conectado');
    socket.send(JSON.stringify({ type: 'REQUEST_STATE' }));
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message && message.type === 'STATE') render(message.data);
  });

  socket.addEventListener('close', () => {
    setConnection('down', 'sin conexión, reconectando…');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  });

  socket.addEventListener('error', () => socket.close());
}

function send(object) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(object));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(next) {
  state = next;

  els.nodeName.textContent = state.node.name;
  els.nodePort.textContent = `:${state.node.port}`;
  els.difficulty.textContent = `dificultad ${state.node.difficulty}`;

  els.seedStatus.textContent = state.seedConnected ? 'conectado' : 'sin semilla';
  els.seedDot.className = `dot ${state.seedConnected ? 'on' : 'off'}`;

  els.peerCount.textContent = state.stats.peerConnections;
  els.blockCount.textContent = state.stats.blocks;
  els.msgCount.textContent = state.stats.confirmedMessages;
  els.pendingCount.textContent = state.stats.pendingMessages;

  renderMining();
  renderMessages();
  renderChain();
}

function renderMining() {
  const mining = state.mining;
  const progress = mining.progress;

  els.miningCard.classList.toggle('active', mining.active);
  els.miningCard.classList.toggle('paused', !mining.enabled);

  if (!mining.enabled) {
    els.miningLabel.textContent = 'Minado en pausa';
  } else if (mining.active) {
    els.miningLabel.textContent = 'Minando…';
  } else {
    els.miningLabel.textContent = 'Esperando mensajes';
  }

  els.miningToggle.textContent = mining.enabled ? 'Pausar' : 'Reanudar';

  els.miningAttempts.textContent = progress ? formatNumber(progress.attempts) : '—';
  els.miningRate.textContent = progress ? formatNumber(progress.hashesPerSecond) : '—';
  els.miningNonce.textContent = progress ? formatNumber(progress.nonce) : '—';
  els.miningHash.textContent = progress ? progress.hash : 'esperando trabajo…';

  if (mining.last) {
    els.lastBlock.innerHTML =
      `Minaste el bloque <b>#${mining.last.index}</b> en ` +
      `${formatDuration(mining.last.elapsed)} · ` +
      `${formatNumber(mining.last.hashesPerSecond)} H/s`;
  } else {
    els.lastBlock.textContent = 'Todavía no has minado un bloque';
  }
}

function renderMessages() {
  const signature = [
    state.stats.confirmedMessages,
    state.chain[state.chain.length - 1].hash,
    state.mempool.map((message) => message.id).join(','),
  ].join(':');

  if (signature === lastMessagesSignature) return;
  lastMessagesSignature = signature;

  const container = els.messages;
  const nearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 80;

  const entries = [];

  for (const block of state.chain) {
    for (const message of block.messages) {
      if (message.id === 'genesis') continue;
      entries.push({ ...message, blockIndex: block.index });
    }
  }
  for (const message of state.mempool) {
    entries.push({ ...message, blockIndex: null });
  }

  entries.sort((a, b) => a.timestamp - b.timestamp);

  container.replaceChildren();

  if (entries.length === 0) {
    container.append(
      element(
        'div',
        'empty',
        'Aún no hay mensajes. Escribe el primero y mira cómo toda la red compite por minarlo.'
      )
    );
    return;
  }

  for (const entry of entries) {
    const confirmed = entry.blockIndex !== null;
    const card = element('div', `message ${confirmed ? 'confirmed' : 'pending'}`);

    const head = element('div', 'message-head');
    head.append(
      element('span', 'author', entry.author),
      element('span', 'time', formatTime(entry.timestamp)),
      element(
        'span',
        `badge ${confirmed ? 'confirmed' : 'pending'}`,
        confirmed ? `bloque #${entry.blockIndex}` : 'pendiente'
      )
    );

    card.append(head, element('p', 'message-text', entry.text));
    container.append(card);
  }

  if (nearBottom) container.scrollTop = container.scrollHeight;
}

function renderChain() {
  const lastBlock = state.chain[state.chain.length - 1];
  const signature = `${state.chain.length}:${lastBlock.hash}`;
  if (signature === lastChainSignature) return;
  lastChainSignature = signature;

  const container = els.chain;
  container.replaceChildren();

  const blocks = [...state.chain].reverse();

  for (const block of blocks) {
    const isGenesis = block.index === 0;
    const isTip = block.hash === lastBlock.hash;

    const card = element(
      'article',
      `block${isGenesis ? ' genesis' : ''}${isTip ? ' tip' : ''}`
    );

    const head = element('div', 'block-head');
    head.append(element('span', 'block-index', `#${block.index}`));
    if (isGenesis) head.append(element('span', 'block-tag', 'génesis'));
    if (isTip) head.append(element('span', 'block-tag', 'punta'));
    head.append(element('span', 'block-time', formatTime(block.timestamp)));
    card.append(head);

    const data = document.createElement('dl');
    data.className = 'kv';

    const hashTerm = element('dt', null, 'hash');
    const hashValue = element('dd', 'hash', shortHash(block.hash));
    hashValue.title = block.hash;

    const prevTerm = element('dt', null, 'prev');
    const prevValue = element('dd', null, shortHash(block.previousHash));
    prevValue.title = block.previousHash;

    const nonceTerm = element('dt', null, 'nonce');
    const nonceValue = element('dd', null, formatNumber(block.nonce));

    data.append(hashTerm, hashValue, prevTerm, prevValue, nonceTerm, nonceValue);
    card.append(data);

    if (block.messages.length > 0) {
      const list = element('ul', 'block-messages');
      for (const message of block.messages) {
        const item = document.createElement('li');
        if (message.id === 'genesis') {
          item.className = 'm-system';
          item.textContent = message.text;
        } else {
          item.append(
            element('span', 'm-author', `${message.author}: `),
            document.createTextNode(message.text)
          );
        }
        list.append(item);
      }
      card.append(list);
    }

    container.append(card);
  }
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();

  const text = els.text.value.trim();
  const author = els.author.value.trim() || 'anonimo';
  if (!text) return;

  localStorage.setItem('blockchain-aula-author', author);
  els.author.value = author;

  const sent = send({ type: 'SEND_MESSAGE', data: { text, author } });
  if (sent) {
    els.text.value = '';
    els.text.focus();
  }
});

els.miningToggle.addEventListener('click', () => {
  if (!state) return;
  send({ type: 'SET_MINING', data: { enabled: !state.mining.enabled } });
});

els.author.value = localStorage.getItem('blockchain-aula-author') || '';
connect();
