const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocket } = require('ws');
const { server, wss, rooms } = require('../server.js');

let port;
let baseUrl;
let wsUrl;

function waitForMessage(ws, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`Timeout (${timeout}ms) aguardando mensagem`));
    }, timeout);

    function onMsg(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (!predicate || predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve(msg);
        }
      } catch (err) {
        // ignora se não for JSON
      }
    }

    ws.on('message', onMsg);
  });
}

before(async () => {
  await new Promise((resolve, reject) => {
    server.listen(0, () => {
      port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      wsUrl = `ws://127.0.0.1:${port}/ws`;
      resolve();
    });
    server.on('error', reject);
  });
});

after(async () => {
  await new Promise(resolve => {
    wss.close(() => {
      server.close(resolve);
    });
  });
});

describe('Servidor HTTP e Arquivos Estáticos', () => {
  test('Rota / responde 200 com Referrer-Policy e HTML', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    const text = await res.text();
    assert.ok(text.includes('VIDEOKÊ') || text.includes('Entrar'));
  });

  test('Rota /tv responde 200 com HTML da TV', async () => {
    const res = await fetch(`${baseUrl}/tv`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    const text = await res.text();
    assert.ok(text.includes('Videokê Live') || text.includes('TV'));
  });

  test('Rota /vendor/qrcode.js responde 200 com JavaScript', async () => {
    const res = await fetch(`${baseUrl}/vendor/qrcode.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/javascript/);
  });

  test('Rota inexistente responde 404', async () => {
    const res = await fetch(`${baseUrl}/rota-inexistente`);
    assert.equal(res.status, 404);
  });
});

describe('Cenários de Aceitação do Karaokê Web', () => {
  test('Cenário 1: TV cria sala e celular entra com handshake e sinalização WebRTC', async () => {
    const tvWs = new WebSocket(wsUrl);
    await new Promise(resolve => tvWs.on('open', resolve));

    tvWs.send(JSON.stringify({ t: 'host' }));
    const roomMsg = await waitForMessage(tvWs, m => m.t === 'room');
    assert.ok(roomMsg.room && roomMsg.room.length === 4, 'Código da sala deve ter 4 letras');
    assert.ok(roomMsg.lanIp, 'Deve conter o IP da LAN');

    const phoneWs = new WebSocket(wsUrl);
    await new Promise(resolve => phoneWs.on('open', resolve));

    phoneWs.send(JSON.stringify({ t: 'join', room: roomMsg.room, name: 'Maikon Cantor' }));

    const joinedMsg = await waitForMessage(phoneWs, m => m.t === 'joined');
    assert.ok(joinedMsg.id, 'Celular deve receber ID atribuído');

    const phoneOnTvMsg = await waitForMessage(tvWs, m => m.t === 'phone');
    assert.equal(phoneOnTvMsg.name, 'Maikon Cantor');

    // Troca de sinalização WebRTC (Offer do celular para TV)
    phoneWs.send(JSON.stringify({ t: 'sig', data: { sdp: { type: 'offer', sdp: 'fake-offer' } } }));
    const sigOnTv = await waitForMessage(tvWs, m => m.t === 'sig');
    assert.equal(sigOnTv.from, joinedMsg.id);
    assert.equal(sigOnTv.data.sdp.sdp, 'fake-offer');

    // Resposta de sinalização da TV para o celular
    tvWs.send(JSON.stringify({ t: 'sig', to: joinedMsg.id, data: { sdp: { type: 'answer', sdp: 'fake-answer' } } }));
    const sigOnPhone = await waitForMessage(phoneWs, m => m.t === 'sig');
    assert.equal(sigOnPhone.data.sdp.sdp, 'fake-answer');

    tvWs.close();
    phoneWs.close();
  });

  test('Cenário 2: Vídeo inexistente ou com falha de embed é rejeitado com mensagem', async () => {
    const tvWs = new WebSocket(wsUrl);
    await new Promise(resolve => tvWs.on('open', resolve));
    tvWs.send(JSON.stringify({ t: 'host' }));
    const roomMsg = await waitForMessage(tvWs, m => m.t === 'room');

    const phoneWs = new WebSocket(wsUrl);
    await new Promise(resolve => phoneWs.on('open', resolve));
    phoneWs.send(JSON.stringify({ t: 'join', room: roomMsg.room, name: 'Tester' }));
    await waitForMessage(phoneWs, m => m.t === 'joined');

    // Envia ID de vídeo sabidamente inexistente (11 caracteres inválidos no YouTube)
    phoneWs.send(JSON.stringify({ t: 'add', vid: '00000000000' }));
    const errorMsg = await waitForMessage(phoneWs, m => m.t === 'error');
    assert.equal(errorMsg.msg, 'Vídeo inexistente ou sem permissão de incorporação');

    // Verifica que nada entrou na fila
    const roomObj = rooms.get(roomMsg.room);
    assert.equal(roomObj.queue.length, 0);
    assert.equal(roomObj.now, null);

    tvWs.close();
    phoneWs.close();
  });

  test('Cenário 3: Fila vazia toca na hora; ao terminar, a próxima começa sozinha', async () => {
    const tvWs = new WebSocket(wsUrl);
    await new Promise(resolve => tvWs.on('open', resolve));
    tvWs.send(JSON.stringify({ t: 'host' }));
    const roomMsg = await waitForMessage(tvWs, m => m.t === 'room');

    const phoneWs = new WebSocket(wsUrl);
    await new Promise(resolve => phoneWs.on('open', resolve));
    phoneWs.send(JSON.stringify({ t: 'join', room: roomMsg.room, name: 'Cantor A' }));
    await waitForMessage(phoneWs, m => m.t === 'joined');

    const roomObj = rooms.get(roomMsg.room);

    // Injeta manualmente duas músicas simulando sucesso de embed
    roomObj.queue.push({ n: 1, vid: 'vid11111111', title: 'Evidências', by: 'Cantor A' });
    // Dispara skip / avanço para a primeira tocar imediatamente
    phoneWs.send(JSON.stringify({ t: 'skip' }));

    const statePlayingFirst = await waitForMessage(phoneWs, m => m.t === 'state' && m.now && m.now.title === 'Evidências');
    assert.equal(statePlayingFirst.now.title, 'Evidências');
    assert.equal(statePlayingFirst.queue.length, 0);

    // Adiciona segunda música
    roomObj.queue.push({ n: 2, vid: 'vid22222222', title: 'Boate Azul', by: 'Cantor A' });
    phoneWs.send(JSON.stringify({ t: 'vol', k: 'musica', v: 0.8 })); // trigger para snapshot
    const stateWithQueue = await waitForMessage(phoneWs, m => m.t === 'state' && m.queue.length === 1);
    assert.equal(stateWithQueue.queue[0].title, 'Boate Azul');

    // TV envia evento "ended" (vídeo 1 terminou)
    tvWs.send(JSON.stringify({ t: 'ended' }));

    const statePlayingSecond = await waitForMessage(phoneWs, m => m.t === 'state' && m.now && m.now.title === 'Boate Azul');
    assert.equal(statePlayingSecond.now.title, 'Boate Azul');
    assert.equal(statePlayingSecond.queue.length, 0);

    tvWs.close();
    phoneWs.close();
  });

  test('Cenário 4: Código inexistente retorna "Sala não encontrada"', async () => {
    const phoneWs = new WebSocket(wsUrl);
    await new Promise(resolve => phoneWs.on('open', resolve));

    phoneWs.send(JSON.stringify({ t: 'join', room: 'WXYZ', name: 'Alguém' }));
    const errorMsg = await waitForMessage(phoneWs, m => m.t === 'error');
    assert.equal(errorMsg.msg, 'Sala não encontrada');

    phoneWs.close();
  });

  test('Cenário 5: TV fechada envia "bye" e desconecta os celulares', async () => {
    const tvWs = new WebSocket(wsUrl);
    await new Promise(resolve => tvWs.on('open', resolve));
    tvWs.send(JSON.stringify({ t: 'host' }));
    const roomMsg = await waitForMessage(tvWs, m => m.t === 'room');

    const phoneWs = new WebSocket(wsUrl);
    await new Promise(resolve => phoneWs.on('open', resolve));
    phoneWs.send(JSON.stringify({ t: 'join', room: roomMsg.room, name: 'Cantor 1' }));
    await waitForMessage(phoneWs, m => m.t === 'joined');

    // Fecha a TV
    tvWs.close();

    const byeMsg = await waitForMessage(phoneWs, m => m.t === 'bye');
    assert.equal(byeMsg.t, 'bye');
    assert.equal(rooms.has(roomMsg.room), false, 'Sala deve ser removida do mapa');

    phoneWs.close();
  });

  test('Cenário 6: Controle de volume e avanço da música', async () => {
    const tvWs = new WebSocket(wsUrl);
    await new Promise(resolve => tvWs.on('open', resolve));
    tvWs.send(JSON.stringify({ t: 'host' }));
    const roomMsg = await waitForMessage(tvWs, m => m.t === 'room');

    const phoneWs = new WebSocket(wsUrl);
    await new Promise(resolve => phoneWs.on('open', resolve));
    phoneWs.send(JSON.stringify({ t: 'join', room: roomMsg.room, name: 'Cantor Mix' }));
    const joined = await waitForMessage(phoneWs, m => m.t === 'joined');

    // Celular ajusta volume da voz
    phoneWs.send(JSON.stringify({ t: 'vol', k: 'voz', v: 0.65 }));
    const volVozTv = await waitForMessage(tvWs, m => m.t === 'vol' && m.k === 'voz');
    assert.equal(volVozTv.v, 0.65);
    assert.equal(volVozTv.id, joined.id);

    // Celular ajusta volume da música
    phoneWs.send(JSON.stringify({ t: 'vol', k: 'musica', v: 0.4 }));
    const volMusicaTv = await waitForMessage(tvWs, m => m.t === 'vol' && m.k === 'musica');
    assert.equal(volMusicaTv.v, 0.4);

    // Celular recebe snapshot com o novo volume da música
    const stateVol = await waitForMessage(phoneWs, m => m.t === 'state' && m.musicaVol === 0.4);
    assert.equal(stateVol.musicaVol, 0.4);

    // Alerta de erro de incorporação na TV notifica celulares
    tvWs.send(JSON.stringify({ t: 'embed_error', code: 150 }));
    const alertMsg = await waitForMessage(phoneWs, m => m.t === 'alert');
    assert.ok(alertMsg.msg.includes('restrição de reprodução externa'));

    tvWs.close();
    phoneWs.close();
  });

  test('Cenário 7: Exibição de pontuação (Score) ao finalizar a música e avanço de fila', async () => {
    const tvWs = new WebSocket(wsUrl);
    await new Promise(resolve => tvWs.on('open', resolve));
    tvWs.send(JSON.stringify({ t: 'host' }));
    const roomMsg = await waitForMessage(tvWs, m => m.t === 'room');

    const phoneWs = new WebSocket(wsUrl);
    await new Promise(resolve => phoneWs.on('open', resolve));
    phoneWs.send(JSON.stringify({ t: 'join', room: roomMsg.room, name: 'Maikon Cantor' }));
    await waitForMessage(phoneWs, m => m.t === 'joined');

    const roomObj = rooms.get(roomMsg.room);
    roomObj.queue.push({ n: 1, vid: 'vid11111111', title: 'Evidências', by: 'Maikon Cantor' });
    roomObj.queue.push({ n: 2, vid: 'vid22222222', title: 'Como Nossos Pais', by: 'Maikon Cantor' });
    phoneWs.send(JSON.stringify({ t: 'skip' })); // toca a primeira

    await waitForMessage(phoneWs, m => m.t === 'state' && m.now && m.now.title === 'Evidências');

    // TV finaliza a música e emite pontuação (Videokê Score)
    tvWs.send(JSON.stringify({
      t: 'score',
      score: 96,
      singer: 'Maikon Cantor',
      title: 'Evidências',
      badge: '🌟 SUPERSTAR! 🌟',
      msg: 'Show impecável!'
    }));

    // Celular recebe a notificação da pontuação
    const scorePhone = await waitForMessage(phoneWs, m => m.t === 'score');
    assert.equal(scorePhone.score, 96);
    assert.equal(scorePhone.badge, '🌟 SUPERSTAR! 🌟');
    assert.equal(scorePhone.singer, 'Maikon Cantor');

    // Celular ou TV aciona skip para avançar imediatamente para a próxima
    phoneWs.send(JSON.stringify({ t: 'skip' }));

    const stateNext = await waitForMessage(phoneWs, m => m.t === 'state' && m.now && m.now.title === 'Como Nossos Pais');
    assert.equal(stateNext.now.title, 'Como Nossos Pais');

    tvWs.close();
    phoneWs.close();
  });
});
