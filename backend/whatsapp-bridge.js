'use strict';

// Polyfill globalThis.crypto for Node.js < 19 (required by Baileys noise handshake)
if (!globalThis.crypto) {
    const { webcrypto } = require('crypto');
    globalThis.crypto = webcrypto;
}

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');
const pino = require('pino');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.WHATSAPP_BRIDGE_PORT || 3000;
let sock = null;
let isConnected = false;
let currentQR = null;

// ──────────────────────────────────────────────────────────────────────────────
// QR CODE WEB PAGE — open in browser to scan with WhatsApp
// ──────────────────────────────────────────────────────────────────────────────
app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send(`<!DOCTYPE html><html>
            <head><title>WhatsApp Connected</title><meta http-equiv="refresh" content="10"></head>
            <body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px">
                <div style="background:#10b981;color:#fff;border-radius:999px;padding:10px 24px;font-size:20px;font-weight:bold">✅ WhatsApp Connected!</div>
                <p style="color:#a1a1aa">Your backend is live and forwarding transactions to Financial Sheets.</p>
            </body></html>`);
    }

    if (!currentQR) {
        return res.send(`<!DOCTYPE html><html>
            <head><title>WhatsApp Bridge — Waiting</title><meta http-equiv="refresh" content="3"></head>
            <body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px">
                <div style="width:40px;height:40px;border:4px solid #333;border-top:4px solid #6366f1;border-radius:50%;animation:spin 1s linear infinite"></div>
                <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
                <p>Generating QR Code... (auto-refreshes every 3 seconds)</p>
            </body></html>`);
    }

    try {
        const qrDataUrl = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
        res.send(`<!DOCTYPE html><html>
            <head><title>Scan WhatsApp QR</title><meta http-equiv="refresh" content="30"></head>
            <body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:20px;padding:20px;box-sizing:border-box">
                <h1 style="margin:0;font-size:22px">📱 Scan with WhatsApp</h1>
                <img src="${qrDataUrl}" style="border:6px solid #fff;border-radius:12px" alt="WhatsApp QR" />
                <div style="background:#1e1e2e;border-radius:12px;padding:16px 24px;max-width:380px">
                    <ol style="color:#d4d4d8;font-size:14px;line-height:1.8;margin:0;padding-left:20px">
                        <li>Open WhatsApp on your phone</li>
                        <li>Tap <strong>⋮ Menu → Linked Devices</strong></li>
                        <li>Tap <strong>Link a Device</strong></li>
                        <li>Point camera at the QR code above</li>
                    </ol>
                </div>
                <p style="color:#71717a;font-size:12px">QR expires in ~60s • page auto-refreshes every 30s</p>
            </body></html>`);
    } catch (e) {
        res.status(500).send('Failed to render QR: ' + e.message);
    }
});

// ──────────────────────────────────────────────────────────────────────────────
// WHATSAPP CONNECTION
// ──────────────────────────────────────────────────────────────────────────────
async function connectToWhatsApp() {
    console.log('Initializing WhatsApp connection...');
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp Web v${version.join('.')} (isLatest: ${isLatest})`);

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        version,
        printQRInTerminal: false,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            console.log('\n👉 QR ready! Open your Render URL + /qr to scan it in browser\n');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            isConnected = false;
            currentQR = null;
            if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
        } else if (connection === 'open') {
            console.log('🎉 WhatsApp connected!');
            isConnected = true;
            currentQR = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe) {
                    const isGroup = msg.key.remoteJid.endsWith('@g.us');
                    console.log(`[MSG] ${isGroup ? 'Group' : 'DM'} | JID: ${msg.key.remoteJid} | From: ${msg.pushName || 'Unknown'}`);
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
        return res.status(503).json({ error: 'WhatsApp not connected. Visit /qr to scan the QR code first.' });
    }
    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message" fields.' });
    }

    try {
        let jid = to;

        if (!jid.includes('@')) {
            if (/^\d+$/.test(jid)) {
                jid = `${to}@s.whatsapp.net`;
            } else {
                console.log(`Searching for group: "${to}"...`);
                const groups = await sock.groupFetchAllParticipating();
                const match = Object.values(groups).find(
                    (g) => g.subject.toLowerCase() === to.toLowerCase()
                );
                if (match) {
                    jid = match.id;
                    console.log(`Group found: "${to}" → ${jid}`);
                } else {
                    const names = Object.values(groups).map((g) => g.subject);
                    return res.status(404).json({
                        error: `No group named "${to}". Available: ${names.join(', ')}`,
                    });
                }
            }
        }

        await sock.sendMessage(jid, { text: message });
        console.log(`✅ Sent to ${jid}`);
        res.json({ success: true, jid, message });
    } catch (err) {
        console.error('Send error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────────────────────────────────
// STATUS
// ──────────────────────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
    res.json({ connected: isConnected, qrReady: !!currentQR, service: 'whatsapp-bridge' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp bridge on port ${PORT}`);
    console.log(`👉 Open /qr in browser to scan the WhatsApp QR code`);
    connectToWhatsApp().catch((err) => console.error('Connection error:', err));
});
