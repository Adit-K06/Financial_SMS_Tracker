// Polyfill globalThis.crypto for Node.js < 19 (required by Baileys)
import { webcrypto } from 'crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import baileys from '@whiskeysockets/baileys';
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
import QRCode from 'qrcode';
import express from 'express';
import bodyParser from 'body-parser';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

const PORT = process.env.WHATSAPP_BRIDGE_PORT || 3000;
let sock = null;
let isConnected = false;
let currentQR = null; // Store latest QR string

// ──────────────────────────────────────────────────────────────────────────────
// QR CODE WEB PAGE — open this in browser to scan!
// ──────────────────────────────────────────────────────────────────────────────
app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bridge — Connected</title>
                <meta http-equiv="refresh" content="10">
                <style>
                    body { font-family: sans-serif; background: #111; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; flex-direction: column; gap: 16px; }
                    .badge { background: #10b981; color: #fff; border-radius: 999px; padding: 8px 20px; font-size: 18px; font-weight: bold; }
                </style>
            </head>
            <body>
                <div class="badge">✅ WhatsApp Connected!</div>
                <p style="color:#a1a1aa">Your WhatsApp bridge is live and ready to forward transactions.</p>
            </body>
            </html>
        `);
    }

    if (!currentQR) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bridge — Waiting for QR</title>
                <meta http-equiv="refresh" content="3">
                <style>
                    body { font-family: sans-serif; background: #111; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; flex-direction: column; gap: 16px; }
                    .spinner { width: 40px; height: 40px; border: 4px solid #333; border-top: 4px solid #6366f1; border-radius: 50%; animation: spin 1s linear infinite; }
                    @keyframes spin { to { transform: rotate(360deg); } }
                </style>
            </head>
            <body>
                <div class="spinner"></div>
                <p>Generating QR Code... Please wait (auto-refreshes every 3 seconds)</p>
            </body>
            </html>
        `);
    }

    try {
        const qrDataUrl = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bridge — Scan QR</title>
                <meta http-equiv="refresh" content="30">
                <style>
                    body { font-family: sans-serif; background: #111; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; flex-direction: column; gap: 20px; }
                    h1 { font-size: 22px; margin: 0; }
                    p { color: #a1a1aa; margin: 0; text-align: center; }
                    img { border: 6px solid #fff; border-radius: 12px; }
                    .steps { background: #1e1e2e; border-radius: 12px; padding: 16px 24px; max-width: 380px; }
                    .steps li { margin-bottom: 8px; color: #d4d4d8; font-size: 14px; }
                </style>
            </head>
            <body>
                <h1>📱 Scan with WhatsApp</h1>
                <img src="${qrDataUrl}" alt="WhatsApp QR Code" />
                <div class="steps">
                    <ol>
                        <li>Open WhatsApp on your phone</li>
                        <li>Tap <strong>⋮ Menu → Linked Devices</strong></li>
                        <li>Tap <strong>Link a Device</strong></li>
                        <li>Point your camera at the QR code above</li>
                    </ol>
                </div>
                <p style="font-size:12px">QR code expires in ~60s — page auto-refreshes every 30s</p>
            </body>
            </html>
        `);
    } catch (e) {
        res.status(500).send('Failed to generate QR: ' + e.message);
    }
});

// ──────────────────────────────────────────────────────────────────────────────
// WHATSAPP CONNECTION
// ──────────────────────────────────────────────────────────────────────────────
async function connectToWhatsApp() {
    console.log('Initializing WhatsApp connection...');
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
    
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp Web version [${version.join('.')}] (isLatest: ${isLatest})`);

    sock = makeWASocket({
        logger: pino({ level: 'error' }),
        auth: state,
        version: version,
        printQRInTerminal: false
    });
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQR = qr;
            console.log('\n==================================================');
            console.log('QR CODE READY! Open this URL in your browser to scan:');
            // The FastAPI backend exposes /qr on port 8000 via proxy
            console.log('  http://<your-render-url>/qr  OR  http://localhost:3000/qr');
            console.log('==================================================\n');
        }
        
        if (connection === 'close') {
            const error = lastDisconnect?.error;
            const shouldReconnect = error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            isConnected = false;
            currentQR = null;
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            console.log('🎉 WhatsApp connected successfully!');
            isConnected = true;
            currentQR = null; // Clear QR once connected
        }
    });
    
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (!msg.key.fromMe) {
                    const fromGroup = msg.key.remoteJid.endsWith('@g.us');
                    console.log(`[MSG] JID: ${msg.key.remoteJid} (${fromGroup ? 'Group' : 'DM'}) | From: ${msg.pushName || 'Unknown'}`);
                }
            }
        }
    });
}

// ──────────────────────────────────────────────────────────────────────────────
// SEND MESSAGE
// ──────────────────────────────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
    const { to, message } = req.body;
    
    if (!sock || !isConnected) {
        return res.status(503).json({ error: 'WhatsApp not connected. Scan the QR at /qr first.' });
    }
    
    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message" in request body.' });
    }
    
    try {
        let jid = to;
        
        if (!jid.includes('@')) {
            if (/^\d+$/.test(jid)) {
                jid = `${to}@s.whatsapp.net`;
            } else {
                console.log(`Searching for group: "${to}"...`);
                const groups = await sock.groupFetchAllParticipating();
                const matchedGroup = Object.values(groups).find(
                    (g) => g.subject.toLowerCase() === to.toLowerCase()
                );
                
                if (matchedGroup) {
                    jid = matchedGroup.id;
                    console.log(`Group found: "${to}" → ${jid}`);
                } else {
                    const available = Object.values(groups).map(g => g.subject);
                    console.log(`Group "${to}" not found. Available:`, available);
                    return res.status(404).json({ 
                        error: `No group named "${to}" found. Available groups: ${available.join(', ')}` 
                    });
                }
            }
        }
        
        await sock.sendMessage(jid, { text: message });
        console.log(`✅ Sent to ${jid}: "${message}"`);
        res.json({ success: true, jid, message });
    } catch (error) {
        console.error('Send failed:', error);
        res.status(500).json({ error: 'Failed to send: ' + error.message });
    }
});

// ──────────────────────────────────────────────────────────────────────────────
// STATUS
// ──────────────────────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        qrReady: !!currentQR,
        service: 'whatsapp-bridge'
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp bridge running on port ${PORT}`);
    console.log(`👉 Open /qr in browser to scan the WhatsApp QR code`);
    connectToWhatsApp().catch(err => console.error('Connection error:', err));
});
