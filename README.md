# 500 – multiplayer card game (Aussie rules)

Real-time 4-player 500 for phones and computers: rooms with a 4-letter code / share link, fixed teams,
computer players for empty seats, automatic scoring with per-hand history, chat + emoji reactions.

## Run
- Linux/Mac: `./start.sh` – starts the server (auto-restarts on crash) + a free Cloudflare quick tunnel and prints the public link.
  `NO_TUNNEL=1 ./start.sh` for local only (http://localhost:8500).
- Windows: install Node.js LTS, double-click `start-windows.bat`, send mates the `https://….trycloudflare.com` link it prints.
- Render (durable URL, needs a free Render account): new Web Service from this folder/repo; `render.yaml` is included.
- Docker: `docker build -t game500 . && docker run -p 8500:8500 game500`

## Play
1. Open the link, type your name, **Create a new game**. You get a room code + **Share invite link**.
2. Mates open the link, type their name, **Join**, then **Sit here**. Partners sit opposite (Team A = seats 1 & 3, Team B = 2 & 4).
3. Fill empty seats with **+ Computer**, press **Start game**.
4. Tap a card to select, tap again to play. Legal cards are raised, others dimmed. 📊 = scores, 💬 = chat.
If someone drops out, anyone can press **Bot plays** on their seat; they get it back when they reopen the link (same device).
Watchers can **Take seat** on a computer player mid-game.

## Rules used
See the "Rules used" panel in the app (game.js has the engine). Avondale bid table, misère only after a 7 bid,
open misère beats 10♥, joker = only trump in no-trumps (nominate suit when leading), slam on a bid under 250 = 250,
opponents 10/trick (none in misère), win only by making a bid to 500+, opponents capped at 490, -500 loses.

## Tests
`npm test` (rules/scoring unit tests) and `node test/e2e.js <url>` (4 socket players play a full game with chat,
reconnect, illegal-card rejection; then 1 player + 3 computer players play a full game).
