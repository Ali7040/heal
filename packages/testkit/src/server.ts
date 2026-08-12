/**
 * Ports and in-process servers for tests.
 *
 * Two rules keep the suite honest. Everything binds to `127.0.0.1`, so nothing
 * here reaches a network the test does not own — the suite's promise of "no
 * network" is about the outside world, and a loopback socket is as local as a
 * temp file. And every port is allocated by the OS rather than hard-coded,
 * because a fixed port turns two tests running at once into a flaky failure that
 * looks like a bug in the code under test.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createSocketServer } from 'node:net';

export interface TestServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Ask the OS for a port, then release it. Racy in theory, reliable in practice. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocketServer();
    socket.on('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      socket.close(() => (port === 0 ? reject(new Error('could not allocate a port')) : resolve(port)));
    });
  });
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export async function startServer(handler: Handler): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Without this, a keep-alive connection from `fetch` holds the server
        // open and the test times out on cleanup rather than on anything real.
        server.closeAllConnections?.();
      }),
  };
}

/**
 * A server whose response can be swapped between requests.
 *
 * That is the whole point: drift is the difference between two responses from
 * the same endpoint, so a fixture that cannot change its mind cannot produce one.
 */
export async function startJsonServer(initial: unknown): Promise<TestServer & { set(body: unknown, status?: number): void }> {
  let body = initial;
  let status = 200;

  const server = await startServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });

  return {
    ...server,
    set(next: unknown, nextStatus = 200) {
      body = next;
      status = nextStatus;
    },
  };
}
