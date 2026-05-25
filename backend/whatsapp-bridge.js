import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

import qrcode from 'qrcode-terminal';
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

async function connectToWhatsApp() {
    console.log('Initializing WhatsApp connection...');
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
    
    // Fetch latest WhatsApp Web version to prevent 405 Connection Failure
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp Web version [${version.join('.')}] (isLatest: ${isLatest})`);

    sock = makeWASocket({
        logger: pino({ level: 'error' }), // only show errors to prevent console clutter
        auth: state,
        version: version,
        printQRInTerminal: false
    });
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n==================================================');
            console.log('SCAN THE QR CODE BELOW WITH WHATSAPP TO LOG IN:');
            console.log('==================================================\n');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const error = lastDisconnect.error;
            console.error('WhatsApp connection closed error:', error);
            const shouldReconnect = error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Reconnecting...', shouldReconnect);
            isConnected = false;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('\n==================================================');
            console.log('🎉 WHATSAPP CONNECTION SUCCESSFULLY OPENED! 🎉');
            console.log('==================================================\n');
            isConnected = true;
        }
    });
    
    sock.ev.on('creds.update', saveCreds);

    // Help the user identify group JIDs by logging message metadata
    sock.ev.on('messages.upsert', (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (!msg.key.fromMe) {
                    const fromGroup = msg.key.remoteJid.endsWith('@g.us');
                    console.log(`[INFO] Msg from JID: ${msg.key.remoteJid} (${fromGroup ? 'Group' : 'Direct Message'}) | Sender: ${msg.pushName || 'Unknown'}`);
                }
            }
        }
    });
}

app.post('/send', async (req, res) => {
    const { to, message } = req.body;
    
    if (!sock || !isConnected) {
        return res.status(503).json({ error: 'WhatsApp Web client is not connected.' });
    }
    
    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" (JID/Group Name) or "message" in request body.' });
    }
    
    try {
        let jid = to;
        
        // If target doesn't look like a direct JID, search for matching group names or format as contact JID
        if (!jid.includes('@')) {
            if (/^\d+$/.test(jid)) {
                // If it's a numeric string, treat it as a direct contact phone number
                jid = `${to}@s.whatsapp.net`;
            } else {
                // Treat as a WhatsApp Group Name/Subject search!
                console.log(`Searching for WhatsApp group with name: "${to}"...`);
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    const matchedGroup = Object.values(groups).find(
                        (g) => g.subject.toLowerCase() === to.toLowerCase()
                    );
                    
                    if (matchedGroup) {
                        jid = matchedGroup.id;
                        console.log(`Found group match! "${to}" -> JID: ${jid}`);
                    } else {
                        console.log(`No group matching "${to}" found. Available groups:`, Object.values(groups).map(g => g.subject));
                        return res.status(404).json({ 
                            error: `Could not find a WhatsApp group named "${to}". Please ensure you have joined the group and matching is exact.` 
                        });
                    }
                } catch (groupError) {
                    console.error('Failed to search groups:', groupError);
                    return res.status(500).json({ error: 'Failed to search WhatsApp groups: ' + groupError.message });
                }
            }
        }
        
        console.log(`Sending message to JID ${jid}: "${message}"`);
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, jid, message });
    } catch (error) {
        console.error('Failed to send message:', error);
        res.status(500).json({ error: 'Failed to send message: ' + error.message });
    }
});

app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        service: 'whatsapp-bridge'
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp bridge running on port ${PORT}`);
    connectToWhatsApp().catch(err => console.error('Error connecting to WhatsApp:', err));
});
