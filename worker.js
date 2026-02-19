import { connect } from 'cloudflare:sockets';

/**
 * VLESS over WebSocket for Cloudflare Workers
 * Optimized and Fixed for Deployment
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('VLESS Proxy Service is Active', { status: 200 });
      }

      const [client, server] = Object.values(new WebSocketPair());
      
      // Gunakan UUID dari environment variable untuk keamanan
      const userID = env.UUID || '90cd2451-9316-43f1-b1e1-123456789abc';

      ctx.waitUntil(handleVless(server, userID));

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    } catch (err) {
      return new Response(err.stack, { status: 500 });
    }
  },
};

async function handleVless(socket, id) {
  socket.accept();

  let remoteSocket = null;
  const uuid = id.replace(/-/g, '');

  socket.addEventListener('message', async (event) => {
    const chunk = event.data;

    if (remoteSocket) {
      const writer = remoteSocket.writable.getWriter();
      await writer.write(chunk);
      writer.releaseLock();
      return;
    }

    // VLESS Protocol Handshake Parsing
    const buffer = new Uint8Array(chunk);
    
    // 1. Version Check (Must be 0)
    if (buffer[0] !== 0) return socket.close();

    // 2. UUID Validation
    const clientUUID = Array.from(buffer.slice(1, 17))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    
    if (clientUUID !== uuid) {
      console.error('Handshake failed: Invalid UUID');
      return socket.close();
    }

    // 3. Skip Addons length byte and content
    const addonLen = buffer[17];
    let cursor = 18 + addonLen;

    // 4. Command (1 = TCP, 2 = UDP)
    const command = buffer[cursor];
    cursor++;

    // 5. Port (Big Endian)
    const port = (buffer[cursor] << 8) | buffer[cursor + 1];
    cursor += 2;

    // 6. Address Type (1=IPv4, 2=Domain, 3=IPv6)
    const addressType = buffer[cursor];
    cursor++;
    let address = '';

    if (addressType === 1) {
      address = buffer.slice(cursor, cursor + 4).join('.');
      cursor += 4;
    } else if (addressType === 2) {
      const domainLen = buffer[cursor];
      cursor++;
      address = new TextDecoder().decode(buffer.slice(cursor, cursor + domainLen));
      cursor += domainLen;
    } else if (addressType === 3) {
      address = Array.from(buffer.slice(cursor, cursor + 16))
        .map((b, i) => b.toString(16).padStart(2, '0') + (i % 2 === 1 && i < 15 ? ':' : '')).join('');
      cursor += 16;
    } else {
      return socket.close();
    }

    // Establish TCP connection using Cloudflare Sockets
    try {
      remoteSocket = connect({ hostname: address, port: port });

      // Send VLESS Response Header (Protocol Version 0, Addon length 0)
      // This is mandatory for a successful handshake with VLESS clients
      const responseHeader = new Uint8Array([0, 0]);
      socket.send(responseHeader);

      // Send remaining initial data (payload after the header)
      const remainingData = buffer.slice(cursor);
      if (remainingData.length > 0) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(remainingData);
        writer.releaseLock();
      }

      // Forward data from Remote Target back to WebSocket
      const reader = remoteSocket.readable.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            socket.send(value);
          }
        } catch (e) {
          socket.close();
        } finally {
          socket.close();
        }
      })();

    } catch (e) {
      console.error(`Socket Error connecting to ${address}:${port}:`, e);
      socket.close();
    }
  });

  socket.addEventListener('close', () => {
    if (remoteSocket) {
      try { remoteSocket.close(); } catch (e) {}
    }
  });

  socket.addEventListener('error', () => {
    if (remoteSocket) {
      try { remoteSocket.close(); } catch (e) {}
    }
  });
}
