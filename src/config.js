/**
 * Configuracion del nodo.
 *
 * Se puede configurar con variables de entorno o con argumentos de linea
 * de comandos. Los argumentos tienen prioridad, y asi funciona igual en
 * Windows, Linux y macOS sin scripts distintos:
 *
 *   node src/node.js --port 3001 --name "Ana" --seed ws://192.168.1.50:4000
 */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] !== undefined) {
    return process.argv[i + 1];
  }
  return fallback;
}

function intArg(name, envName, fallback) {
  const raw = arg(name, process.env[envName] ?? fallback);
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

const PORT = intArg('port', 'PORT', 3000);
// El semilla usa --port (o --seed-port). El nodo no usa este valor.
const SEED_PORT = intArg(
  'seed-port',
  'SEED_PORT',
  intArg('port', 'SEED_PORT', 4000)
);

const config = {
  // Puerto HTTP + WebSocket del nodo (UI y P2P comparten puerto).
  port: PORT,

  // Nombre visible del nodo en la red.
  name: arg('name', process.env.NODE_NAME || `nodo-${PORT}`),

  // URL del nodo semilla del profesor. Solo sirve para descubrir pares.
  seedUrl: arg('seed', process.env.SEED_URL || 'ws://localhost:4000'),

  // Ceros iniciales que debe tener el hash. Sube para minar mas lento.
  // 6 es un buen valor para ~20 nodos compitiendo; 4 para probar solo.
  difficulty: intArg('difficulty', 'DIFFICULTY', 6),

  // Host donde escucha el servidor.
  host: arg('host', process.env.HOST || '0.0.0.0'),

  // Puerto del nodo semilla (solo lo usa src/seed.js).
  seedPort: SEED_PORT,
};

module.exports = config;
