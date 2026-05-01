const express = require('express')
const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys')
const pino = require('pino')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000
app.use(express.json())
app.use(express.static('public'))

const activeUsers = new Map() // Handle multiple users 💀

async function generatePair(number, res) {
    const sessionId = `temp_${number}_${Date.now()}`
    const sessionDir = `./${sessionId}`
    
    if (activeUsers.has(number)) {
        return res.json({ success: false, error: 'Pair request already active for this number. Wait 30sec.' })
    }
    
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('VOID-MD-PAIR'),
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
    })

    activeUsers.set(number, { sock, sessionDir })

    try {
        if (!sock.authState.creds.registered) {
            await new Promise(r => setTimeout(r, 3000)) // Wait for socket ready
            const code = await sock.requestPairingCode(number)
            res.json({ success: true, code: code, sessionId: sessionId })
        } else {
            res.json({ success: false, error: 'Number already registered' })
            cleanup(number)
        }
    } catch (e) {
        console.log('Pair code error:', e.message)
        res.json({ success: false, error: 'Failed to get pair code. Try again in 1 min.' })
        cleanup(number)
        return
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        console.log(`${number} Connection: ${connection}`)
        
        if (connection === 'open') {
            const credsPath = path.join(sessionDir, 'creds.json')
            await new Promise(r => setTimeout(r, 3000))
            
            if (fs.existsSync(credsPath)) {
                const creds = fs.readFileSync(credsPath, 'utf-8')
                const sessionID = 'VOID-MD::' + Buffer.from(creds).toString('base64')
                
                // Send to all connected WebSockets
                wss.clients.forEach(client => {
                    if (client.sessionId === sessionId) {
                        client.send(JSON.stringify({ sessionID, success: true }))
                    }
                })
                
                setTimeout(() => cleanup(number), 10000)
            }
        }
        
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode
            console.log(`${number} Closed: ${reason}`)
            
            if (reason!== 401) { // 401 = logged out, else retry
                wss.clients.forEach(client => {
                    if (client.sessionId === sessionId) {
                        client.send(JSON.stringify({ error: 'Connection closed. Try again.' }))
                    }
                })
            }
            cleanup(number)
        }
    })
}

function cleanup(number) {
    if (activeUsers.has(number)) {
        const { sock, sessionDir } = activeUsers.get(number)
        try { sock?.end() } catch {}
        try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch {}
        activeUsers.delete(number)
        console.log(`Cleaned up ${number}`)
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.post('/pair', async (req, res) => {
    const { number } = req.body
    if (!number) return res.json({ success: false, error: 'Number required' })
    
    const cleanNumber = number.replace(/[^0-9]/g, '')
    if (cleanNumber.length < 10) return res.json({ success: false, error: 'Invalid number format' })
    
    await generatePair(cleanNumber, res)
})

const server = require('http').createServer(app)
const WebSocket = require('ws')
const wss = new WebSocket.Server({ server })

wss.on('connection', (ws, req) => {
    const params = new URLSearchParams(req.url.split('?')[1])
    ws.sessionId = params.get('sessionId')
})

server.listen(PORT, () => console.log(`VOID-MD Pair running on ${PORT} 💀`))
