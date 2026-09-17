const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const pino = require('pino');
const qrcode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, delay } = require('@whiskeysockets/baileys');
const { Storage } = require('megajs');
const config = require('./config');

const app = express();
const logger = pino({ level: 'silent' });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map(); // phone -> { sock, status, code, qr }

// ========== MEGA UPLOAD ==========
async function uploadToMega(credsPath, sessionId) {
  try {
    const storage = await new Storage({
      email: config.MEGA_EMAIL,
      password: config.MEGA_PASSWORD
    }).ready;

    const data = await fs.readFile(credsPath);
    const fileName = `${sessionId}.json`;
    const file = await storage.upload({ name: fileName }, data).complete;
    const link = await file.link();
    console.log(`[MEGA] Uploaded: ${link}`);
    return { success: true, link, fileId: file.nodeId || file.name };
  } catch (err) {
    console.error('[MEGA] Upload failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ========== GENERATE SESSION ID ==========
function generateSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 18; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return config.SESSION_PREFIX + result;
}

// ========== CREATE SOCKET ==========
async function createPairSession(phoneNumber) {
  const sessionDir = path.join(__dirname, 'temp_sessions', phoneNumber);
  await fs.ensureDir(sessionDir);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS('Safari'),
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  const sessionData = {
    sock,
    status: 'connecting',
    code: null,
    qr: null,
    sessionId: null
  };
  sessions.set(phoneNumber, sessionData);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionData.qr = qr;
      sessionData.status = 'qr';
      // Also request pairing code if not registered
      if (!sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          sessionData.code = code;
          sessionData.status = 'code';
          console.log(`[PAIR] Code for ${phoneNumber}: ${code}`);
        } catch (e) {
          console.error('Pairing code error:', e.message);
        }
      }
    }

    if (connection === 'open') {
      console.log(`[PAIR] Connected: ${phoneNumber}`);
      sessionData.status = 'connected';

      // Wait a bit for full sync
      await delay(3000);

      // Generate SESSION_ID
      const sessionId = generateSessionId();
      sessionData.sessionId = sessionId;

      // Save creds
      const credsPath = path.join(sessionDir, 'creds.json');
      await saveCreds();

      // Upload to Mega
      const megaResult = await uploadToMega(credsPath, sessionId.replace(/[^a-z0-9~]/gi, ''));

      // Send SESSION_ID to self chat
      const me = sock.user.id;
      const selfJid = me.includes(':') ? me.split(':')[0] + '@s.whatsapp.net' : me;

      const message = `*「 SAHAN-MD V2 SESSION 」*

✅ *Successfully Logged In!*

🔐 *SESSION_ID:*
\`\`\`
${sessionId}
\`\`\`

📋 *How to use:*
1. Copy the SESSION_ID above
2. Paste it in your Bot's *config.js* → SESSION_ID
3. Deploy on Heroku / Railway / Koyeb

🌐 *Mega Status:* ${megaResult.success ? 'Uploaded ✅' : 'Failed ❌'}
${megaResult.link ? `Link: ${megaResult.link}` : ''}

> Powered by *SAHAN-MD V2*
> Premium Pair Site`;

      try {
        await sock.sendMessage(selfJid, { text: message });
        console.log(`[PAIR] SESSION_ID sent to self chat`);
      } catch (e) {
        console.error('Failed to send to self:', e.message);
      }

      // Cleanup after 30s
      setTimeout(async () => {
        try {
          await sock.logout();
          await fs.remove(sessionDir);
          sessions.delete(phoneNumber);
        } catch (e) {}
      }, 30000);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log(`[PAIR] Reconnecting ${phoneNumber}...`);
      } else {
        sessions.delete(phoneNumber);
        await fs.remove(sessionDir).catch(() => {});
      }
    }
  });

  return sessionData;
}

// ========== API ROUTES ==========

// Pair with code
app.post('/api/pair', async (req, res) => {
  try {
    let { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Phone number required' });

    number = number.replace(/[^0-9]/g, '');
    if (number.length < 10 || number.length > 15) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    if (sessions.has(number)) {
      const existing = sessions.get(number);
      return res.json({
        status: existing.status,
        code: existing.code,
        qr: existing.qr,
        sessionId: existing.sessionId
      });
    }

    if (sessions.size >= config.MAX_SESSIONS) {
      return res.status(429).json({ error: 'Too many active sessions. Try later.' });
    }

    const session = await createPairSession(number);

    // Wait a little for code/qr
    await delay(2500);

    res.json({
      status: session.status,
      code: session.code,
      message: 'Enter the pairing code in WhatsApp → Linked Devices → Link with phone number'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get status
app.get('/api/status/:number', (req, res) => {
  const number = req.params.number.replace(/[^0-9]/g, '');
  const session = sessions.get(number);
  if (!session) return res.json({ status: 'not_found' });
  res.json({
    status: session.status,
    code: session.code,
    sessionId: session.sessionId
  });
});

// QR endpoint (optional)
app.get('/api/qr/:number', async (req, res) => {
  const number = req.params.number.replace(/[^0-9]/g, '');
  const session = sessions.get(number);
  if (!session || !session.qr) return res.status(404).json({ error: 'QR not ready' });
  try {
    const qrImage = await qrcode.toDataURL(session.qr);
    res.json({ qr: qrImage });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', bot: config.BOT_NAME }));

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(config.PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║     SAHAN-MD V2 PAIR SITE ONLINE     ║
║     Port: ${config.PORT}                        ║
║     Premium Session Generator        ║
╚══════════════════════════════════════╝
  `);
});
