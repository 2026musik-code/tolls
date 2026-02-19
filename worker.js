// src/worker.ts
import { connect } from 'cloudflare:sockets';

// GANTI UUID INI
const userID = '90cd2451-9316-43f1-b1e1-123456789abc'; 

const proxyIP = '104.18.2.161'; // IP Proxy Cloudflare (opsional/bisa diganti)

export default {
  async fetch(request, env, ctx) {
    try {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('System Running...', { status: 200 });
      }

      const webSocketPair = new Array(2);
      const [client, server] = Object.values(new WebSocketPair());

      await handleVless(server, userID);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  },
};

async function handleVless(socket, id) {
  let remoteSocket = null;
  
  socket.accept();

  socket.addEventListener('message', async (event) => {
    const chunk = event.data;
    
    if (remoteSocket) {
      const writer = remoteSocket.writable.getWriter();
      await writer.write(chunk);
      writer.releaseLock();
      return;
    }

    // Protokol Handshake VLESS
    const buffer = new Uint8Array(chunk);
    if (buffer[0] !== 0) return; // Versi protokol

    // Validasi UUID (Sederhana)
    const clientUUID = Array.from(buffer.slice(1, 17))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    
    const formattedUUID = id.replace(/-/g, '');
    if (clientUUID !== formattedUUID) {
      socket.close();
      return;
    }

    // Ambil alamat tujuan (TCP)
    const portIndex = 17 + buffer[17] + 1;
    const port = (buffer[portIndex] << 8) | buffer[portIndex + 1];
    const address = new TextDecoder().decode(buffer.slice(18, portIndex));

    // Hubungkan ke server tujuan
    try {
      remoteSocket = connect({ hostname: address, port: port });
      const reader = remoteSocket.readable.getReader();
      
      // Kirim balik data dari server ke Client via WebSocket
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          socket.send(value);
        }
      })();
      
    } catch (e) {
      socket.close();
    }
  });
}
