import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeMinecraft } from './readiness.js';

const servers: net.Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

describe('Minecraft 就绪探测', () => {
  it('收到服务端响应时标记为可用', async () => {
    const payload = Buffer.from(JSON.stringify({ version: { name: 'test', protocol: 1 }, players: { online: 0, max: 20 }, description: { text: 'ready' } }));
    const packetBody = Buffer.concat([Buffer.from([0, payload.length]), payload]);
    const packet = Buffer.concat([Buffer.from([packetBody.length]), packetBody]);
    const server = net.createServer((socket) => socket.once('data', () => socket.end(packet)));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    await expect(probeMinecraft('127.0.0.1', port, 500)).resolves.toBe(true);
  });

  it('连接超时时标记为不可用', async () => {
    await expect(probeMinecraft('127.0.0.1', 1, 100)).resolves.toBe(false);
  });

  it('拒绝非 Minecraft 协议响应', async () => {
    const server = net.createServer((socket) => socket.once('data', () => socket.end(Buffer.from([1, 0]))));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    await expect(probeMinecraft('127.0.0.1', port, 500)).resolves.toBe(false);
  });
});
