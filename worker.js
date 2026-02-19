import { connect } from 'cloudflare:sockets';

/**
 * VLESS & Trojan over WebSocket for Cloudflare Workers
 * Menampilkan Halaman Dashboard untuk Generate Akun VLESS
 */

export default {
  async fetch(request, env, ctx) {
    const upgradeHeader = request.headers.get('Upgrade');
    const url = new URL(request.url);

    // 1. Jika ada Upgrade WebSocket, jalankan Proxy Logic
    if (upgradeHeader === 'websocket') {
      const userID = env.UUID || '90cd2451-9316-43f1-b1e1-123456789abc';
      const [client, server] = Object.values(new WebSocketPair());
      ctx.waitUntil(handleVless(server, userID));
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Jika akses via Web Browser, tampilkan Dashboard Generator
    const userID = env.UUID || '90cd2451-9316-43f1-b1e1-123456789abc';
    const host = request.headers.get('host');
    
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>VLESS Dashboard - Cloudflare Worker</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>
            body { background-color: #f8f9fa; font-family: sans-serif; }
            .card { border-radius: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            pre { background: #eee; padding: 15px; border-radius: 8px; font-size: 0.85rem; word-break: break-all; white-space: pre-wrap; }
            .btn-copy { cursor: pointer; }
        </style>
    </head>
    <body>
        <div class="container py-5">
            <div class="row justify-content-center">
                <div class="col-md-8">
                    <div class="card p-4 mb-4">
                        <h2 class="text-center text-primary mb-4">VLESS Config Generator</h2>
                        <div class="mb-3">
                            <label class="form-label font-weight-bold">Your UUID:</label>
                            <input type="text" class="form-control" value="${userID}" readonly>
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Cloudflare Proxy IP / Port (Opsional):</label>
                            <input type="text" id="proxyInput" class="form-control" placeholder="e.g. 104.18.2.161:443 atau keep default">
                        </div>
                        <button onclick="generateConfig()" class="btn btn-primary w-100">Generate & Copy Config</button>
                    </div>

                    <div class="card p-4">
                        <h5>Raw VLESS Link (v2ray/nekoray):</h5>
                        <pre id="vlessLink">vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=%2F#Cloudflare_VLESS</pre>
                        <button onclick="copyToClipboard('vlessLink')" class="btn btn-sm btn-outline-secondary">Copy VLESS Link</button>
                    </div>
                </div>
            </div>
        </div>

        <script>
            function generateConfig() {
                const proxy = document.getElementById('proxyInput').value || '${host}:443';
                const [cleanProxy, port] = proxy.split(':');
                const finalPort = port || '443';
                const vless = "vless://${userID}@" + cleanProxy + ":" + finalPort + "?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=%2F#Cloudflare_VLESS";
                document.getElementById('vlessLink').innerText = vless;
                alert('Config Updated!');
            }

            function copyToClipboard(id) {
                const text = document.getElementById(id).innerText;
                navigator.clipboard.writeText(text).then(() => alert('Copied to clipboard!'));
            }
        </script>
    </body>
    </html>
    `;

    return new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
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

    const buffer = new Uint8Array(chunk);
    if (buffer[0] !== 0) return socket.close();

    const clientUUID = Array.from(buffer.slice(1, 17))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    
    if (clientUUID !== uuid) return socket.close();

    const addonLen = buffer[17];
    let cursor = 18 + addonLen;
    const command = buffer[cursor]; cursor++;
    const port = (buffer[cursor] << 8) | buffer[cursor + 1]; cursor += 2;
    const addressType = buffer[cursor]; cursor++;

    let address = '';
    if (addressType === 1) {
      address = buffer.slice(cursor, cursor + 4).join('.');
      cursor += 4;
    } else if (addressType === 2) {
      const domainLen = buffer[cursor]; cursor++;
      address = new TextDecoder().decode(buffer.slice(cursor, cursor + domainLen));
      cursor += domainLen;
    } else if (addressType === 3) {
      address = buffer.slice(cursor, cursor + 16).reduce((s, b, i) => s + (i % 2 === 0 && i > 0 ? ':' : '') + b.toString(16).padStart(2, '0'), '');
      cursor += 16;
    }

    try {
      remoteSocket = connect({ hostname: address, port: port });
      const responseHeader = new Uint8Array([0, 0]);
      socket.send(responseHeader);

      const remainingData = buffer.slice(cursor);
      if (remainingData.length > 0) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(remainingData);
        writer.releaseLock();
      }

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
      socket.close();
    }
  });

  socket.addEventListener('close', () => { if (remoteSocket) remoteSocket.close(); });
  socket.addEventListener('error', () => { if (remoteSocket) remoteSocket.close(); });
}
