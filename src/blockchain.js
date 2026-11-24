/**
 * Cadena de bloques educativa.
 *
 * Reutiliza la logica clasica de "naivecoin" (lhartikk) pero simplificada:
 * no hay wallets ni UTXO. Un mensaje es la unidad de informacion y el
 * bloque minado lo confirma.
 *
 * Hash = SHA-256( index | previousHash | timestamp | mensajes | nonce )
 */

const crypto = require('crypto');

const GENESIS_MESSAGE = {
  id: 'genesis',
  author: 'sistema',
  text: 'Bloque genesis: aqui empieza la cadena del salon',
  timestamp: 0,
};

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Serializacion canonica: siempre el mismo orden de campos para que todos
 * los nodos calculen exactamente el mismo hash.
 */
function serializeMessages(messages) {
  return JSON.stringify(
    messages.map((m) => [m.id, m.author, m.text, m.timestamp])
  );
}

function serializeBlock(block) {
  return [
    block.index,
    block.previousHash,
    block.timestamp,
    serializeMessages(block.messages),
    block.nonce,
  ].join('|');
}

function hashBlock(block) {
  return sha256(serializeBlock(block));
}

function createGenesisBlock() {
  const block = {
    index: 0,
    previousHash: '0'.repeat(64),
    timestamp: 0,
    messages: [GENESIS_MESSAGE],
    nonce: 0,
  };
  block.hash = hashBlock(block);
  return block;
}

function meetsDifficulty(hash, difficulty) {
  return hash.startsWith('0'.repeat(difficulty));
}

function isValidMessage(message) {
  return (
    message &&
    typeof message.id === 'string' &&
    message.id.length > 0 &&
    typeof message.author === 'string' &&
    typeof message.text === 'string' &&
    typeof message.timestamp === 'number'
  );
}

class Blockchain {
  constructor(difficulty) {
    this.difficulty = difficulty;
    this.chain = [createGenesisBlock()];
    this.mempool = new Map(); // id -> mensaje pendiente de minar
  }

  get lastBlock() {
    return this.chain[this.chain.length - 1];
  }

  get confirmedMessageIds() {
    const ids = new Set();
    for (const block of this.chain) {
      for (const message of block.messages) ids.add(message.id);
    }
    return ids;
  }

  /** Agrega un mensaje al mempool. Devuelve true solo si es nuevo. */
  addMessage(message) {
    if (!isValidMessage(message)) return false;
    if (this.mempool.has(message.id)) return false;
    if (this.confirmedMessageIds.has(message.id)) return false;
    this.mempool.set(message.id, message);
    return true;
  }

  removeMessages(ids) {
    for (const id of ids) this.mempool.delete(id);
  }

  createCandidateBlock() {
    return {
      index: this.lastBlock.index + 1,
      previousHash: this.lastBlock.hash,
      timestamp: Date.now(),
      messages: [...this.mempool.values()],
      nonce: 0,
    };
  }

  /**
   * Valida un bloque que llega de la red contra el ultimo bloque local.
   */
  isValidNewBlock(block, previousBlock) {
    if (!block || typeof block !== 'object') return false;
    if (!Array.isArray(block.messages)) return false;
    if (!block.messages.every(isValidMessage)) return false;
    if (block.index !== previousBlock.index + 1) return false;
    if (block.previousHash !== previousBlock.hash) return false;
    if (typeof block.timestamp !== 'number' || typeof block.nonce !== 'number') {
      return false;
    }
    if (hashBlock(block) !== block.hash) return false;
    if (!meetsDifficulty(block.hash, this.difficulty)) return false;
    return true;
  }

  /** Agrega un bloque validado. Devuelve true si la cadena crecio. */
  addBlock(block) {
    if (!this.isValidNewBlock(block, this.lastBlock)) return false;

    // Un mensaje no puede confirmarse dos veces.
    const confirmed = this.confirmedMessageIds;
    if (block.messages.some((message) => confirmed.has(message.id))) return false;

    this.chain.push(block);
    this.removeMessages(block.messages.map((m) => m.id));
    return true;
  }

  /** Valida una cadena completa (usada al sincronizar con otro nodo). */
  isValidChain(chain) {
    if (!Array.isArray(chain) || chain.length === 0) return false;

    const genesis = createGenesisBlock();
    if (JSON.stringify(chain[0]) !== JSON.stringify(genesis)) return false;

    const seen = new Set([GENESIS_MESSAGE.id]);

    for (let i = 1; i < chain.length; i++) {
      if (!this.isValidNewBlock(chain[i], chain[i - 1])) return false;

      for (const message of chain[i].messages) {
        if (seen.has(message.id)) return false;
        seen.add(message.id);
      }
    }
    return true;
  }

  /** Consenso simple: la cadena valida mas larga gana. */
  replaceChain(chain) {
    if (!this.isValidChain(chain)) return false;
    if (chain.length <= this.chain.length) return false;

    // Mensajes confirmados en la cadena nueva.
    const newIds = new Set();
    for (const block of chain) {
      for (const message of block.messages) newIds.add(message.id);
    }

    // Si una bifurcacion pierde, sus mensajes vuelven al mempool para que
    // no se pierdan: se volveran a minar en el siguiente bloque.
    for (const block of this.chain) {
      for (const message of block.messages) {
        if (message.id !== 'genesis' && !newIds.has(message.id)) {
          this.mempool.set(message.id, message);
        }
      }
    }

    this.chain = chain;
    for (const id of newIds) this.mempool.delete(id);
    return true;
  }

  /** Cambia la dificultad. Si ya habia bloques, reinicia para resincronizar. */
  setDifficulty(difficulty) {
    if (!Number.isFinite(difficulty) || difficulty <= 0) return false;
    if (difficulty === this.difficulty) return false;

    this.difficulty = difficulty;
    if (this.chain.length > 1) {
      this.chain = [createGenesisBlock()];
      this.mempool.clear();
      return true;
    }
    return false;
  }

  /**
   * Minado con proof-of-work.
   *
   * @param {(progress: object) => void} onProgress  callback periodico
   * @param {() => boolean} shouldStop               aborta si la punta cambio
   * @returns {Promise<null | {block, attempts, elapsed}>}
   */
  async mine(onProgress, shouldStop) {
    const candidate = this.createCandidateBlock();
    const target = '0'.repeat(this.difficulty);

    // Precomputamos todo menos el nonce: mucho mas rapido.
    const prefix = [
      candidate.index,
      candidate.previousHash,
      candidate.timestamp,
      serializeMessages(candidate.messages),
    ].join('|');

    let nonce = 0;
    let attempts = 0;
    const startedAt = Date.now();

    while (true) {
      const hash = sha256(`${prefix}|${nonce}`);

      if (hash.startsWith(target)) {
        candidate.nonce = nonce;
        candidate.hash = hash;
        return {
          block: candidate,
          attempts: attempts + 1,
          elapsed: Date.now() - startedAt,
        };
      }

      nonce++;
      attempts++;

      // Cada 2000 intentos cedemos el event loop para que el servidor
      // siga atendiendo websockets y no se congele la interfaz.
      if (attempts % 2000 === 0) {
        const elapsed = Date.now() - startedAt;
        if (typeof onProgress === 'function') {
          onProgress({
            attempts,
            nonce,
            hash,
            elapsed,
            hashesPerSecond: Math.round((attempts / Math.max(elapsed, 1)) * 1000),
          });
        }
        await new Promise((resolve) => setImmediate(resolve));
        if (typeof shouldStop === 'function' && shouldStop()) return null;
      }
    }
  }
}

module.exports = {
  Blockchain,
  createGenesisBlock,
  hashBlock,
  serializeBlock,
  meetsDifficulty,
  isValidMessage,
};
