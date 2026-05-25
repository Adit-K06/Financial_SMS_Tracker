import os
import logging
from datetime import datetime
from typing import Optional
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests

# Set up logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="SMS Transaction Router")

# Enable CORS for React Native testing and cross-origin calls
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Environment Variables
WHATSAPP_GROUP_JID = os.getenv("WHATSAPP_GROUP_JID", "")
WHATSAPP_BRIDGE_URL = os.getenv("WHATSAPP_BRIDGE_URL", "http://localhost:3000/send")
WHATSAPP_BRIDGE_BASE = WHATSAPP_BRIDGE_URL.rsplit("/send", 1)[0]  # Base URL e.g. http://localhost:3000

@app.get("/qr")
def get_qr_code():
    """Proxy the WhatsApp QR code page from the bridge so users can scan from their Render URL."""
    try:
        response = requests.get(f"{WHATSAPP_BRIDGE_BASE}/qr", timeout=5)
        from fastapi.responses import HTMLResponse
        return HTMLResponse(content=response.text, status_code=response.status_code)
    except Exception as e:
        from fastapi.responses import HTMLResponse
        return HTMLResponse(
            content=f"<html><body style='background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px'>"
                    f"<h2>⚠️ Bridge Unavailable</h2><p>WhatsApp bridge not yet started: {e}</p>"
                    f"<p style='color:#a1a1aa'>Please wait 30 seconds and refresh this page.</p></body></html>",
            status_code=503
        )

class Transaction(BaseModel):
    type: str # 'debit' or 'credit'
    amount: float
    name: str
    timestamp: Optional[str] = None
    to: Optional[str] = None # Optional custom group JID or group name

@app.get("/")
def read_root():
    whatsapp_status = "offline"
    try:
        # Check WhatsApp bridge connection status
        status_url = WHATSAPP_BRIDGE_URL.replace("/send", "/status")
        response = requests.get(status_url, timeout=2)
        if response.status_code == 200:
            data = response.json()
            whatsapp_status = "connected" if data.get("connected") else "disconnected"
    except Exception as e:
        logger.warning(f"Failed to check WhatsApp bridge status: {e}")
        whatsapp_status = "unreachable"

    return {
        "status": "online",
        "configured_group_jid": WHATSAPP_GROUP_JID or "NOT_CONFIGURED",
        "whatsapp_bridge_url": WHATSAPP_BRIDGE_URL,
        "whatsapp_status": whatsapp_status
    }

@app.post("/transaction", status_code=status.HTTP_200_OK)
def handle_transaction(tx: Transaction):
    logger.info(f"Received transaction: {tx}")
    
    # 1. Format the message
    tx_type = tx.type.lower()
    if tx_type == "debit":
        emoji = "🔴"
        action = "Spent"
        preposition = "at"
    elif tx_type == "credit":
        emoji = "🟢"
        action = "Received"
        preposition = "from"
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, 
            detail="Transaction type must be 'debit' or 'credit'"
        )
        
    formatted_message = f"{emoji} {action} Rs. {tx.amount:.2f} {preposition} {tx.name}"
    logger.info(f"Formatted message: {formatted_message}")
    
    # 2. Identify the target JID/Group Name (custom from payload, fallback to env)
    target_destination = tx.to or WHATSAPP_GROUP_JID
    if not target_destination:
        logger.warning("No WhatsApp destination JID or group name configured. Logged output only.")
        return {
            "status": "logged_only",
            "message": formatted_message,
            "warning": "Provide 'to' in payload or configure WHATSAPP_GROUP_JID environment variable."
        }
        
    # 3. Forward to WhatsApp Bridge
    try:
        payload = {
            "to": target_destination,
            "message": formatted_message
        }
        response = requests.post(WHATSAPP_BRIDGE_URL, json=payload, timeout=10)
        
        if response.status_code == 200:
            logger.info("Successfully sent message to WhatsApp bridge!")
            return {"status": "sent", "message": formatted_message}
        else:
            logger.error(f"WhatsApp bridge returned error {response.status_code}: {response.text}")
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"WhatsApp bridge error: {response.text}"
            )
            
    except requests.exceptions.RequestException as e:
        logger.error(f"Failed to connect to WhatsApp bridge: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"WhatsApp bridge unreachable: {e}"
        )

if __name__ == "__main__":
    import uvicorn
    # When run directly, start on port 8000
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
