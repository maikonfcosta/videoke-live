const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

// Detecção de IP da rede local (IPv4 não interno)
function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Whitelist de rotas estáticas (sem path traversal)
const FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/sing': ['public/sing.html', 'text/html; charset=utf-8'],
  '/tv': ['public/tv.html', 'text/html; charset=utf-8'],
  '/vendor/qrcode.js': ['public/vendor/qrcode.js', 'text/javascript'],
};

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/favicon.ico') {
    const favPath = path.join(__dirname, 'public/assets/favicon.svg');
    if (fs.existsSync(favPath)) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return fs.createReadStream(favPath).pipe(res);
    }
  }

  if (urlPath.startsWith('/assets/')) {
    const assetFile = path.basename(urlPath);
    const assetPath = path.join(__dirname, 'public/assets', assetFile);
    if (fs.existsSync(assetPath)) {
      const ext = path.extname(assetFile).toLowerCase();
      const mime = ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      });
      return fs.createReadStream(assetPath).pipe(res);
    }
  }

  const f = FILES[urlPath];
  if (!f) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }

  const filePath = path.join(__dirname, f[0]);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Error');
    }
    res.writeHead(200, {
      'Content-Type': f[1],
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const rooms = new Map();
let uid = 0;

const send = (ws, m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
const all = (r, m) => {
  send(r.tv, m);
  r.phones.forEach(p => send(p, m));
};

const snap = r => ({
  t: 'state',
  now: r.now,
  queue: r.queue,
  musicaVol: r.musicaVol != null ? r.musicaVol : 1,
  singers: Array.from(r.phones.values()).map(p => ({ id: p.singerId, name: p.name })),
  lastScore: r.lastScore || null
});

const advance = r => {
  if (r.scoreTimer) {
    clearTimeout(r.scoreTimer);
    r.scoreTimer = null;
  }
  r.now = r.queue.shift() || null;
  all(r, snap(r));
};

const clamp = v => Math.min(1, Math.max(0, Number(v) || 0));

// Validação real de embed: oEmbed devolve 200 OK com título; erro 401/404 ou falha de rede devolve null (rejeição segura)
const title = async vid => {
  try {
    const res = await fetch('https://www.youtube.com/oembed?format=json&url=https://youtu.be/' + encodeURIComponent(vid), {
      headers: { 'User-Agent': 'KaraokeWeb/1.0' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.title ? j.title : null;
  } catch {
    return null;
  }
};

wss.on('connection', ws => {
  let room, id, tv = false;

  ws.on('message', raw => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    if (!room) {
      if (m.t === 'host') {
        let code;
        do {
          code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
        } while (rooms.has(code));

        room = {
          code,
          tv: ws,
          phones: new Map(),
          queue: [],
          now: null,
          musicaVol: 1
        };
        tv = true;
        rooms.set(code, room);

        const currentPort = server.address() ? server.address().port : PORT;
        send(ws, { t: 'room', room: code, lanIp: getLanIp(), port: currentPort });
      } else if (m.t === 'join') {
        const roomCode = String(m.room || '').trim().toUpperCase();
        const r = rooms.get(roomCode);
        if (!r) return send(ws, { t: 'error', msg: 'Sala não encontrada' });

        room = r;
        id = String(++uid);
        ws.singerId = id;
        ws.name = String(m.name || '').trim().slice(0, 20) || 'Cantor';
        room.phones.set(id, ws);

        send(ws, { t: 'joined', id });
        send(ws, snap(room));
        send(room.tv, { t: 'phone', id, name: ws.name });
        all(room, snap(room));
      }
      return;
    }

    if (tv) {
      if (m.t === 'sig') {
        const target = room.phones.get(String(m.to));
        if (target) send(target, { t: 'sig', data: m.data });
      } else if (m.t === 'ended') {
        advance(room);
      } else if (m.t === 'score') {
        room.lastScore = {
          score: Math.round(Number(m.score) || 0),
          singer: m.singer || (room.now ? room.now.by : 'Cantor'),
          title: m.title || (room.now ? room.now.title : 'Música'),
          badge: m.badge || 'Show!',
          msg: m.msg || 'Parabéns!'
        };
        all(room, { t: 'score', ...room.lastScore });
        if (room.scoreTimer) clearTimeout(room.scoreTimer);
        room.scoreTimer = setTimeout(() => {
          room.scoreTimer = null;
          advance(room);
        }, 7000);
        if (room.scoreTimer.unref) room.scoreTimer.unref();
      } else if (m.t === 'embed_error') {
        const failedItem = room.now;
        const songName = failedItem ? failedItem.title : 'Vídeo atual';
        all(room, {
          t: 'alert',
          msg: `Aviso: "${songName}" possui restrição de reprodução externa no YouTube e foi pulado.`
        });
        advance(room);
      }
      return;
    }

    // Ações dos celulares (cantores)
    if (m.t === 'sig') {
      send(room.tv, { t: 'sig', from: id, data: m.data });
    } else if (m.t === 'vol') {
      if (m.k === 'voz') {
        send(room.tv, { t: 'vol', id, k: 'voz', v: clamp(m.v) });
      } else if (m.k === 'musica') {
        room.musicaVol = clamp(m.v);
        send(room.tv, { t: 'vol', id, k: 'musica', v: room.musicaVol });
        all(room, snap(room));
      }
    } else if (m.t === 'skip') {
      advance(room);
    } else if (m.t === 'add' && typeof m.vid === 'string' && /^[\w-]{11}$/.test(m.vid) && room.queue.length < 50) {
      title(m.vid).then(ti => {
        if (!ti) {
          return send(ws, { t: 'error', msg: 'Vídeo inexistente ou sem permissão de incorporação' });
        }
        room.queue.push({ n: ++uid, vid: m.vid, title: ti, by: ws.name });
        if (room.now) {
          all(room, snap(room));
        } else {
          advance(room);
        }
      });
    }
  });

  ws.on('close', () => {
    if (!room) return;
    if (tv) {
      if (room.scoreTimer) clearTimeout(room.scoreTimer);
      rooms.delete(room.code);
      room.phones.forEach(p => send(p, { t: 'bye' }));
    } else {
      room.phones.delete(id);
      send(room.tv, { t: 'left', id });
      all(room, snap(room));
    }
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.ping();
  });
}, 30000);
pingInterval.unref();

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('TV: http://localhost:' + PORT + '/tv');
    console.log('Rede local: http://' + getLanIp() + ':' + PORT + '/tv');
  });
}

module.exports = { server, wss, rooms, title, getLanIp };
