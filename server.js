const express = require('express')
const cors = require('cors')
const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys')
const pino = require('pino')
const fs = require('fs')
const path = require('path')
const http = require('http')
const WebSocket = require('ws')

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())
app.use(express.static('public'))

const activeUsers = new Map()

wss.on('connection', (ws, req) => {
    const params = new URLSearchParams(req.url.split('?')[1])
    ws.sessionId = params.get('sessionId')
    console.log(`WebSocket connected: ${ws.sessionId}`)
})

function sendToClient(sessionId, data) {
    wss.clients.forEach(client => {
        if (client.sessionId === sessionId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data))
        }
    })
}

async function generatePair(number, res) {
    const sessionId = `temp_${number}_${Date.now()}`
    const sessionDir = `./${sessionId}`
    
    console.log(`\n=== NEW REQUEST: ${number} ===`)
    
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
    
    const sock = makeWASocket({
        logger: pino({ level: 'info' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.ios('Safari'), // 2026 FIX
        version: [2, 3000, 1023223821],
        syncFullHistory: false
    })

    activeUsers.set(number, { sock, sessionDir, sessionId })
    let responded = false

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update
        console.log(`[${number}] Connection: ${connection}`)
        
        if (connection === 'open' &&!sock.authState.creds.registered &&!responded) {
            await new Promise(r => setTimeout(r, 1000))
            try {
                const code = await sock.requestPairingCode(number)
                console.log(`[${number}] PAIR CODE SUCCESS: ${code}`)
                responded = true
                res.json({ success: true, code: code, sessionId: sessionId })
            } catch (e) {
                console.log(`[${number}] PAIR FAILED:`, e.message)
                responded = true
                res.json({ success: false, error: `Failed: ${e.message}` })
                cleanup(number)
            }
        }
        
        // GENERATE SESSION ID AFTER LINKING 💀
        if (connection === 'open' && sock.authState.creds.registered) {
            const credsPath = path.join(sessionDir, 'creds.json')
            await new Promise(r => setTimeout(r, 3000))
            
            if (fs.existsSync(credsPath)) {
                const credsData = fs.readFileSync(credsPath, 'utf-8')
                const sessionID = 'VOID-MD::' + Buffer.from(credsData).toString('base64')
                console.log(`[${number}] SESSION ID GENERATED`)
                
                sendToClient(sessionId, { 
                    type: 'session',
                    sessionID: sessionID,
                    message: 'Copy this to config.js'
                })
                setTimeout(() => cleanup(number), 15000)
            }
        }
        
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            console.log(`[${number}] Closed: ${code}`)
            if (!responded) {
                responded = true
                res.json({ success: false, error: `Connection closed: ${code}` })
            }
            cleanup(number)
        }
    })

    sock.ev.on('creds.update', saveCreds)
    
    setTimeout(() => {
        if (!responded) {
            responded = true
            res.json({ success: false, error: 'Timeout. WhatsApp did not respond.' })
            cleanup(number)
        }
    }, 25000)
}

function cleanup(number) {
    if (activeUsers.has(number)) {
        const { sock, sessionDir } = activeUsers.get(number)
        try { sock?.end() } catch {}
        try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch {}
        activeUsers.delete(number)
        console.log(`[${number}] Cleaned up`)
    }
}

app.post('/pair', async (req, res) => {
    const cleanNumber = req.body.number.replace(/[^0-9]/g, '')
    if (cleanNumber.length < 11) return res.json({ success: false, error: 'Invalid number. Use 254...' })
    await generatePair(cleanNumber, res)
})

server.listen(PORT, () => console.log(`VOID-MD Pair v2.0 running on ${PORT} 💀`))
