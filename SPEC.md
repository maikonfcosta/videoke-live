# SPEC — Karaokê Web

## Requisitos
- R1: TV abre `/tv` no navegador e mostra QR code + código de sala (4 letras).
- R2: Celular entra por QR/código, liga o microfone e adiciona músicas por link do YouTube (embed).
- R3: Voz do celular sai na TV junto com a música (WebRTC de áudio, celular → TV).
- R4: Fila compartilhada; qualquer cantor pode pular; sliders de voz e música no celular ajustam o mix na TV.
- R5: TV sem WebRTC: a música toca e a tela avisa que a voz está indisponível.
- R6: TV sem navegador: Fire TV Stick (Silk), Google TV/Android TV com navegador instalado, ou notebook por HDMI abrindo `/tv`.
- R7: Sistema de pontuação (Videokê Score): ao término da música, a TV analisa o engajamento vocal (tempo de canto, estabilidade e dinâmica), exibe nota animada de 0 a 100 com aplausos e classificação, e notifica o celular antes de iniciar a próxima música.

## Cenários de aceitação
1. Dado `/tv` aberta e código válido, quando o celular entra, então a voz toca na TV (alvo: atraso < 500 ms).
2. Dado vídeo sem permissão de embed, quando adicionado, então é rejeitado com mensagem e não entra na fila.
3. Dada fila vazia, quando uma música é adicionada, então toca na hora; ao terminar, a próxima começa sozinha.
4. Dado código inexistente, então "Sala não encontrada" e o microfone é liberado.
5. Dada a TV fechada, então os celulares voltam para a tela de entrada.
6. Dado mic mudo, então nenhum áudio de voz chega à TV.
7. Dada música finalizada, a TV exibe a nota de pontuação (0 a 100) com classificação e aplausos durante 7 segundos antes de avançar para a próxima faixa.

## Limites
- Atraso da voz de 150–300 ms em Wi-Fi; música no ambiente pode vazar para o microfone (eco/microfonia).
- Microfone exige HTTPS no celular: deploy com WebSocket + HTTPS (Render, Fly.io, Railway, LocalTunnel). Vercel não serve.
- Sem servidor TURN: celular em 4G e TV em Wi-Fi podem falhar. Usar a mesma rede.
- Sala de 4 letras sem autenticação: uso doméstico.
- Celular precisa manter a tela ativa para o microfone não cair.
- Sem busca de músicas (exigiria chave da YouTube Data API): entrada por link.
- Rota `/tv` em JS sem async/await para rodar em navegadores de TV antigos.
