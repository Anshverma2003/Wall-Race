# Wall Race

A two-player online board game in plain **HTML, CSS and JavaScript** (no build step, no backend).
Race your pawn to the opposite edge, and use walls to slow your opponent down.

## Running it

ES modules don't load from `file://`, so serve the folder over HTTP. Any static server works:

| Tool | Command |
|------|---------|
| VS Code | "Live Server" extension → *Open with Live Server* |
| Python | `python -m http.server 8080` |
| Node | `npx serve .` |

Then open `http://localhost:8080`.

**Playing on two devices:** both devices must be able to load the site.
- **Easiest:** deploy the folder to any static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages). It's just files.
- **Same Wi-Fi:** run the server above and open `http://<your-PC-IP>:8080` on the other device. On plain HTTP, "Copy" falls back to an older clipboard method. If that fails, the code is shown on screen.

An internet connection is required. Players connect peer-to-peer over WebRTC using [PeerJS](https://peerjs.com/), and the free PeerJS cloud server is used only to introduce the two browsers to each other. To run your own signalling server, set `NETWORK.PEER_OPTIONS` in [src/config.js](src/config.js).

## How to play

1. **Player 1** clicks **Create room** and gets a unique 6-digit code. They can also copy an invite link (`?room=123456`).
2. **Player 2** enters the code and clicks **Join**.
3. The host can change the match settings, then clicks **Start game**. Who moves first is random.
4. On your turn, do **one** of the following:
   - **Move:** go one square up, down, left or right (the highlighted squares).
   - **Place a wall:** one segment between two adjacent dots. On a mouse, hover to preview and click to place. On touch, tap once to preview and tap again to confirm.
5. The first player to reach the opposite edge **wins instantly**. Both players can then choose **Play again** (a rematch starts when both agree) or **Exit**.

### Move history (`|<` `<` `>` `>|`)
The buttons under the board step through every position of the current game: `|<` goes to the start, `<` and `>` move one move back or forward, and `>|` returns to the live position. Past positions are read-only. When your opponent or the AI makes a move, the board jumps back to live. The history is part of the game state, so it's shared with your opponent and survives a page refresh. No database is needed.

### Premoves
While it's your opponent's (or the AI's) turn, click any square or wall gap to queue a premove. You can queue as many as you like. They're played automatically, one per turn and in order, as soon as it's your turn.
- Premoves are shown only on your own screen, in amber shades from dark (played first) to light (played last). For pawn premoves, your pawn is drawn on the last premoved square.
- Anything can be queued. Each premove is checked only when its turn comes. If it's illegal then (for example, a new wall blocks it), it and every premove after it are discarded silently.
- **Clear premoves** removes the whole queue.

### Rules
- P1 (red) starts top-centre and must reach the bottom row. P2 (blue) starts bottom-centre and must reach the top row. The edge each player is racing to is faintly tinted in their colour.
- Walls block both players and can't be placed on the outer border or on top of another wall.
- **A wall is rejected if it would leave either player with no possible path to their goal.** This covers sealing a row from edge to edge, boxing a pawn in, and similar traps.
- **Jumping:** if the pawns are face to face, you may jump straight over your opponent. If a wall (or the board edge) is behind them, you can step diagonally to either side of them instead.

## Play vs AI

Choose **Easy / Medium / Hard** on the home screen and press **Play vs AI**. You play P1 (red), the AI plays P2 (blue), and who starts is random. Grid size and wall limit come from ⚙ Settings.

The AI is **pure code: no language model, no API, no internet**. It runs in a Web Worker so the page never freezes. Each turn it:

1. **Scores positions** with `(your shortest path − AI's shortest path) + tempo + walls-in-hand bonus`. Path lengths come from a distance table built outward from the goal row (dynamic programming / breadth-first search).
2. **Lists candidates:** every legal pawn move (including jumps) plus a shortlist of wall slots on and around your shortest path. Moves and walls are judged by the same score, so a wall is placed only when it gains more than stepping forward.
3. **Looks ahead** with minimax and alpha-beta pruning. It tries a candidate, explores your best reply, then **undoes it (backtracking)** and tries the next. Branches that can't change the result are skipped.
4. **Memoizes** positions in a transposition table, keyed by a Zobrist hash of the position, so a position reached through a different move order is never searched twice (dynamic programming).
5. **Iterative deepening:** it searches depth 1, 2, 3 … until the level's depth or time limit is reached.

| Level | Looks ahead | Walls considered | Behaviour |
|-------|-------------|------------------|-----------|
| Easy | 1 turn | 4 | Random noise and reluctant to wall, so it makes mistakes |
| Medium | 2 turns | 14 | Small noise, walls when you're ahead |
| Hard | up to 4 turns | 28 | No noise, aggressive and precise walls |

It always takes a winning move, and it can never place an illegal wall: every action is re-checked by `GameModel`. You can tune the levels in `AI_LEVELS` in [src/config.js](src/config.js). A vs-AI game in progress survives a page refresh (`wallrace.aiSession` in localStorage).

The AI stops searching after a fixed amount of work (`maxNodes`), not after a time limit, and its randomness is seeded per game. The same position therefore always produces the same move on every device, which lets the server re-check vs-AI wins.

## Player profile and leaderboard

### Your profile (`name#tag`)
- On first open every player picks a **name** and a **4-digit tag**, for example `baba yaga#2003`.
- **The tag is unique**: no two players can have the same tag (0000–9999, so up to 10,000 players). If a tag is taken you are told straight away.
- **The name** can be anything (3–16 letters, numbers, spaces, `_` or `-`) and can change any time. **The tag** can change once every 30 days; Settings shows the date it unlocks.
- There is no login. Instead each profile has a secret **recovery code** (`WR-XXXX-XXXX-XXXX-XXXX`), shown once on creation and later in Settings. Entering it on another device, or after clearing the browser, restores the profile.

### Leaderboards (home → Leaderboard)
| Board | Ranked by | Columns |
|-------|-----------|---------|
| Online | Elo rating (everyone starts at 1200, K = 32) | Rating, W–L, win %, best streak |
| vs Hard AI | Wins against the Hard AI (last 7 days, last 30 days or all time); ties go to the fastest win | Hard wins, fastest win (your moves, board size), last win |

The top 50 are shown, plus your own row wherever you rank.

### How results are kept honest
Finished games are sent to a Vercel function, [api/report.js](api/report.js), which **replays every move** with the real `GameModel` before saving anything:
- **Online:** both players' browsers report the game, and it counts only when the two reports are identical. Ratings are then updated once, in a single database transaction.
- **vs Hard AI:** every AI move is recomputed with the game's seed and must match exactly, so a forged game against a "dumb" AI is rejected.

Browsers use Supabase's **publishable** key and can only call the functions in [supabase/schema.sql](supabase/schema.sql) that are granted to `anon` (create, read or update their own profile, read leaderboards). Only the Vercel function holds the **secret** key and can write results.

### Setup
1. **Database:** in Supabase open SQL Editor, paste the whole of [supabase/schema.sql](supabase/schema.sql) and click Run. It is safe to run again.
2. **Secret key:** in Supabase open Project Settings → API Keys and copy a **secret** key (`sb_secret_...`). In Vercel open the project → Settings → Environment Variables and add `SUPABASE_SECRET_KEY` with that value for Production and Preview. Never put this key in the frontend or in git.
3. Redeploy. The publishable key and project URL are already in [src/config.js](src/config.js).

On a local static server (no Vercel functions) profiles and leaderboards work, but finished games are not recorded.

## Settings (⚙ top right)

| Setting | Who | Notes |
|---------|-----|-------|
| Theme (dark / light) | Everyone | Dark by default |
| Show my pawn at the bottom | Everyone | Rotates the board so your pawn starts at the bottom of your screen. Turn it off to see the fixed layout (P1 top, P2 bottom). |
| Grid size | Host / vs-AI player | 7×7 or 9×9 (odd sizes only, so both pawns start dead centre) |
| Walls per player | Host / vs-AI player | 0–50, or Unlimited (default 10) |

Match settings can be changed in the lobby (the guest sees changes live) or between games. They are locked during a match.

## Sessions and reconnecting (localStorage)

| Key | Contents |
|-----|----------|
| `wallrace.settings` | Theme, board orientation, preferred grid size and wall limit |
| `wallrace.profile` | A random player id, used to give a reconnecting player back their seat |
| `wallrace.session` | The current room (for the host, also the full game state). Expires after 30 minutes. |
| `wallrace.aiSession` | The vs-AI game in progress (difficulty, seed and game state). Expires after 30 minutes. |
| `wallrace.player` | Your leaderboard profile (id, name, tag, stats) and recovery code |
| `wallrace.pendingReports` | Finished games that could not be sent yet (retried on the next visit) |

- **Guest refreshes or drops:** their seat is held mid-match. The page rejoins automatically, and the host sees a "waiting for opponent" banner in the meantime.
- **Host refreshes:** the host reopens the same room code with the saved game, and the guest reconnects automatically (it retries for about 20 seconds).
- **Leave / Exit** ends the session for good. If the guest leaves, the host goes back to the lobby and can wait for someone new.

## Project structure (MVC)

```
index.html                  Markup for all screens and dialogs
assets/css/
  variables.css             Design tokens: dark + light themes
  base.css                  Reset, page layout, top bar
  components.css            Buttons, inputs, cards, dialogs, toasts
  screens.css               Home, lobby and game HUD layout
  board.css                 SVG board styles
src/
  main.js                   Entry point
  config.js                 Constants: grid sizes, limits, network, storage keys
  core/EventEmitter.js      Tiny pub/sub base class
  ai/
    AIEngine.js             Search engine: score formula, DP distances, alpha-beta, transposition table
    ai.worker.js            Web Worker entry so the AI never blocks the UI
  models/
    GameModel.js            Pure rules engine: moves, jumps, walls, path check, win
    RoomModel.js            Room code, seats, status, match settings, rematch votes
    SettingsModel.js        Persisted user preferences
    PremoveQueue.js         The local player's queued premoves (never sent to the opponent)
    PlayerModel.js          Your name#tag profile, recovery code and validation rules
  views/
    BoardView.js            SVG board rendering and pointer input
    GameView.js             HUD, status, banner and footer around the board
    ProfileView.js          First-open name screen, recovery, Profile section in Settings, top-bar badge
    LeaderboardView.js      Leaderboard screen and tables
    HomeView.js / LobbyView.js / SettingsView.js / ModalView.js / ToastView.js / ScreenView.js
  controllers/
    AppController.js        Composition root and screen navigation
    RoomController.js       Online session: create/join/leave, network protocol, host authority
    AIController.js         vs-AI session: local game, asks the AI for its moves
    GameController.js       Board input → actions, game-over and rematch flow (works with either session)
    SettingsController.js   Settings dialog ↔ model, theme, host-only gating
    ProfileController.js    Create / restore / rename profile, tag availability
    LeaderboardController.js  Loads the leaderboards
  services/
    PeerService.js          PeerJS wrapper with heartbeat and disconnect detection
    AIService.js            Promise wrapper around the AI worker (main-thread fallback)
    SupabaseService.js      Calls the public database functions (publishable key)
    ResultsService.js       Sends finished games to /api/report, retries later if offline
    StorageService.js       Safe localStorage wrapper
  utils/
    random.js               Room codes, ids, UUIDs and AI seeds (crypto RNG)
    clipboard.js            Copy with fallback
```

Server side (Vercel) and database:
```
api/report.js               POST /api/report: verify a finished game, then record it
api/_lib/verify.js          Replays games with GameModel (and the AI for vs-AI wins)
api/_lib/db.js              Supabase REST calls with the secret key
supabase/schema.sql         Tables, security rules, profile + leaderboard functions, Elo update
package.json                Marks the JS as ES modules for the Vercel function (no dependencies)
```

### Networking model
The **host is authoritative**. The guest sends only *intents* (`action`, `rematch`, `leave`). The host validates each one with `GameModel`, applies it, and broadcasts the full state (`sync`) back. A modified client therefore can't make illegal moves, and the two boards can't drift apart. The protocol is documented at the top of [src/controllers/RoomController.js](src/controllers/RoomController.js).

## Known limitations
- Without a login, one person could create two profiles and play themselves to farm rating. New profiles are limited to 10 per network per hour.
- Someone could have a copy of the Hard AI play for them. The server can confirm that a game is legal, not who chose the moves.
- If the host closes the tab for good, the room ends. There is no server to keep it alive.
- Very strict networks (some corporate or mobile carriers) can block WebRTC. PeerJS's default TURN relay helps, but it isn't guaranteed.
