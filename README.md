# SAHAN-MD V2 PAIR

Premium Pair Site for SAHAN-MD V2

## Features
- Pair Code + QR Code
- Session saved & uploaded to **mega.nz**
- SESSION_ID automatically sent to your **WhatsApp Self Chat**
- Format: `sᴀʜᴀɴ-ᴍᴅ~xxxxxxxxxxxx`
- Premium dark neon UI

## Setup

1. Edit `config.js`
```js
MEGA_EMAIL: "your@email.com",
MEGA_PASSWORD: "yourpassword",
SESSION_PREFIX: "sᴀʜᴀɴ-ᴍᴅ~",
```

2. Install & Run
```bash
npm install
npm start
```

3. Open `http://localhost:3000` (or your deployed URL)

4. Enter number → Pair → Receive SESSION_ID in Self Chat

## Deploy
Works on Heroku, Railway, Render, Koyeb, VPS.

Add env vars if needed for PORT.
