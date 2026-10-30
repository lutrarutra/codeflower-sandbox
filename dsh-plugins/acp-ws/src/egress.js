import { createConnection, createServer } from 'node:net';

// In a network-isolated sandbox, HTTPS_PROXY points here, and each connection
// is passed unchanged to the app's proxy through its socket.
export const EGRESS_HOST = '127.0.0.1';
export const EGRESS_PORT = 3128;

export async function startEgressForwarder(socketPath, { host = EGRESS_HOST, port = EGRESS_PORT } = {}) {
  const connections = new Set();
  // Half-open, so an answer still arrives after the client finished sending.
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const app = createConnection({ path: socketPath, allowHalfOpen: true });
    connections.add(client).add(app);
    // Each side ends the other through the pipes; a failure ends both.
    const fail = () => {
      client.destroy();
      app.destroy();
    };
    for (const side of [client, app]) {
      side.on('error', fail);
      side.on('close', () => connections.delete(side));
    }
    client.pipe(app).pipe(client);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: server.address().port,
    close() {
      for (const connection of connections) connection.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
