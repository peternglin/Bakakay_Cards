# Bakakay Online v2
Real-time browser multiplayer for 2-10 players. Node.js + Express + Socket.IO. Create a room, share the generated link, and play from separate phones. The server owns deck/hand/turn/challenge state so other players do not receive your hand.

## Run
Node.js 18+ recommended.

    npm install
    npm start

Open http://localhost:3000. For same-Wi-Fi testing, use the host computer's LAN address and port 3000.

## Deploy
Deploy this folder to any Node-compatible web host. The start command is `npm start`; the app uses the host's `PORT` environment variable. After deployment, share the site's invite URL. Rooms are in memory in this MVP, so they disappear when the server restarts.

## Production hardening
For a public launch, add authentication/rate limiting, room expiry, reconnection/resume, persistent storage, and stronger anti-abuse controls.
