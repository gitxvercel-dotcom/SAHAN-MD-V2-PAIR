const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const pino = require('pino');
const qrcode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  delay,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { Storage } = require('megajs');
const config = require('./config');

const app = express();
const logger = pino({ level: 'silent' });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// phone -> session data
const sessions = new Map();

// ========== MEGA UPLOAD ==========
async function uploadToMega(credsPath, sessionId) {
  try {
    if (!config.MEGA_EMAIL || config.MEGA_EMAIL.includes('example.com')) {
      return { success: false, error: 'Mega credentials not set' };
    }
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

function generateSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 18; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return config.SESSION_PREFIX + result;
}

function getSessionDir(phoneNumber) {
  return path.join(__dirname, 'temp_sessions', phoneNumber);
}

// ========== CREATE / RESTART SOCKET ==========
async function startSocket(phoneNumber, sessionData) {
  const sessionDir = getSessionDir(phoneNumber);
  await fs.ensureDir(sessionDir);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    console.log(`[PAIR] Using WA version: ${version.join('.')}`);
  } catch {
    version = undefined;
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    defaultQueryTimeoutMs: 60000
  });

  sessionData.sock = sock;
  sessionData.pairingRequested = sessionData.pairingRequested || false;
  sessionData.done = sessionData.done || false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    // ----- QR / Pairing code (request ONCE) -----
    if (qr && !sessionData.done) {
      sessionData.qr = qr;
      if (sessionData.status !== 'code') {
        sessionData.status = 'qr';
      }

      if (!sock.authState.creds.registered && !sessionData.pairingRequested) {
        sessionData.pairingRequested = true;
        try {
          // small delay helps stability
          await delay(1500);
          const code = await sock.requestPairingCode(phoneNumber);
          // format as XXXX-XXXX for display
          const formatted = code.length === 8
            ? code.slice(0, 4) + '-' + code.slice(4)
            : code;
          sessionData.code = code;
          sessionData.status = 'code';
          console.log(`[PAIR] Code for ${phoneNumber}: ${code}`);
        } catch (e) {
          console.error(`[PAIR] Pairing code error (${phoneNumber}):`, e.message);
          sessionData.pairingRequested = false; // allow retry
        }
      }
    }

    // ----- Successfully open -----
    if (connection === 'open' && !sessionData.done) {
      console.log(`[PAIR] Connected: ${phoneNumber}`);
      sessionData.status = 'connected';
      sessionData.done = true;

      try {
        await delay(2500);

        // ensure creds saved
        await saveCreds();
        const credsPath = path.join(sessionDir, 'creds.json');

        // wait until creds.json exists
        for (let i = 0; i < 10; i++) {
          if (await fs.pathExists(credsPath)) break;
          await delay(500);
        }

        const sessionId = generateSessionId();
        sessionData.sessionId = sessionId;

        // Upload full session folder as single JSON (creds) to mega
        const megaResult = await uploadToMega(
          credsPath,
          sessionId.replace(/[^a-z0-9]/gi, '')
        );

        // Self JID
        const me = sock.user?.id || `${phoneNumber}@s.whatsapp.net`;
        const selfJid = me.includes(':')
          ? me.split(':')[0] + '@s.whatsapp.net'
          : me;

        const message =
`*「 SAHAN-MD V2 SESSION 」*

✅ *Successfully Logged In!*

🔐 *SESSION_ID:*
\`\`\`
${sessionId}
\`\`\`

📋 *How to use:*
1. Copy the SESSION_ID above
2. Paste it in Bot *config.js* → SESSION_ID
3. Deploy on Heroku / Railway / Koyeb

🌐 *Mega:* ${megaResult.success ? 'Uploaded ✅' : 'Skipped / Failed'}
${megaResult.link ? `🔗 ${megaResult.link}` : ''}

> Powered by *SAHAN-MD V2*
> Premium Pair Site`;

        try {
          await sock.sendMessage(selfJid, { text: message });
          console.log(`[PAIR] SESSION_ID sent to self chat (${phoneNumber})`);
        } catch (e) {
          console.error('[PAIR] Failed to send to self:', e.message);
          // still mark success – user can copy from status API
        }

        sessionData.status = 'success';

        // Cleanup after 60s (give time to copy)
        setTimeout(async () => {
          try {
            await sock.end(undefined);
          } catch (_) {}
          try {
            await fs.remove(sessionDir);
          } catch (_) {}
          sessions.delete(phoneNumber);
          console.log(`[PAIR] Cleaned session ${phoneNumber}`);
        }, 60000);
      } catch (err) {
        console.error('[PAIR] Post-connect error:', err);
        sessionData.status = 'error';
        sessionData.error = err.message;
      }
    }

    // ----- Connection closed -----
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : lastDisconnect?.error?.output?.statusCode;

      const reason = lastDisconnect?.error?.message || statusCode;
      console.log(`[PAIR] Close ${phoneNumber} | code=${statusCode} | ${reason}`);

      // Already finished successfully
      if (sessionData.done) {
        return;
      }

      // Logged out / banned → stop
      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        sessionData.status = 'logged_out';
        sessions.delete(phoneNumber);
        await fs.remove(sessionDir).catch(() => {});
        return;
      }

      // Restart required after pairing / temporary disconnect → recreate socket
      // Do NOT recreate if already success
      if (!sessionData.done) {
        sessionData.status = 'reconnecting';
        console.log(`[PAIR] Restarting socket for ${phoneNumber}...`);
        await delay(2000);
        try {
          // end old socket quietly
          try { sock.end(undefined); } catch (_) {}
          await startSocket(phoneNumber, sessionData);
        } catch (e) {
          console.error('[PAIR] Restart failed:', e.message);
          sessionData.status = 'error';
          sessionData.error = e.message;
        }
      }
    }
  });

  return sock;
}

async function createPairSession(phoneNumber) {
  // clear old session folder for fresh pair
  const sessionDir = getSessionDir(phoneNumber);
  await fs.remove(sessionDir).catch(() => {});
  await fs.ensureDir(sessionDir);

  const sessionData = {
    sock: null,
    status: 'connecting',
    code: null,
    qr: null,
    sessionId: null,
    pairingRequested: false,
    done: false,
    error: null
  };
  sessions.set(phoneNumber, sessionData);

  await startSocket(phoneNumber, sessionData);
  return sessionData;
}

// ========== API ==========

app.post('/api/pair', async (req, res) => {
  try {
    let { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Phone number required' });

    number = String(number).replace(/[^0-9]/g, '');
    if (number.length < 10 || number.length > 15) {
      return res.status(400).json({ error: 'Invalid phone number (use country code, e.g. 9477xxxxxxx)' });
    }

    // Existing active session → return current state
    if (sessions.has(number)) {
      const existing = sessions.get(number);
      if (existing.status === 'success' || existing.status === 'connected') {
        return res.json({
          status: existing.status,
          code: existing.code,
          sessionId: existing.sessionId
        });
      }
      // still in progress
      if (['code', 'qr', 'connecting', 'reconnecting'].includes(existing.status)) {
        return res.json({
          status: existing.status,
          code: existing.code,
          message: 'Session already in progress. Enter the code if shown.'
        });
      }
      // error / logged_out → allow new
      sessions.delete(number);
    }

    if (sessions.size >= (config.MAX_SESSIONS || 5)) {
      return res.status(429).json({ error: 'Too many active sessions. Try again later.' });
    }

    const session = await createPairSession(number);

    // wait for pairing code (up to ~8s)
    for (let i = 0; i < 16; i++) {
      await delay(500);
      if (session.code || session.status === 'error') break;
    }

    res.json({
      status: session.status,
      code: session.code,
      message: session.code
        ? 'Enter this code in WhatsApp → Linked Devices → Link with phone number instead'
        : 'Generating code… refresh status in a few seconds'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

app.get('/api/status/:number', (req, res) => {
  const number = String(req.params.number).replace(/[^0-9]/g, '');
  const session = sessions.get(number);
  if (!session) {
    return res.json({ status: 'not_found' });
  }
  res.json({
    status: session.status,
    code: session.code,
    sessionId: session.sessionId,
    error: session.error || null
  });
});

app.get('/api/qr/:number', async (req, res) => {
  const number = String(req.params.number).replace(/[^0-9]/g, '');
  const session = sessions.get(number);
  if (!session || !session.qr) {
    return res.status(404).json({ error: 'QR not ready' });
  }
  try {
    const qrImage = await qrcode.toDataURL(session.qr);
    res.json({ qr: qrImage });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', bot: config.BOT_NAME, active: sessions.size });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Keep Heroku awake helper (optional ping)
app.get('/ping', (req, res) => res.send('pong'));

const PORT = process.env.PORT || config.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║     SAHAN-MD V2 PAIR SITE ONLINE     ║
║     Port: ${String(PORT).padEnd(28)}║
║     Fixed reconnect + pair flow      ║
╚══════════════════════════════════════╝
  `);
});
