const express = require('express')
const cors = require('cors')
const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys')
const pino = require('pino')
const fs = require('fs')
const path = require('path')
const http = require('http')

const app = express()
const server = http.createServer(app)
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())
app.use(express.static('public'))

console.log('VOID-MD Pair starting...')

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.post('/pair', async (req, res) => {
    const number = req.body.number?.replace(/[^0-9]/g, '')
    if (!number || number.length < 11) {
        return res.json({ success: false, error: 'Invalid number. Use 254...' })
    }
    
    console.log(`\n=== REQUEST: ${number} ===`)
    const sessionDir = `./temp_${number}`
    
    try {
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true })
        fs.mkdirSync(sessionDir)
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
        const sock = makeWASocket({
            logger: pino({ level: 'silent' }),
            auth: state,
            browser: Browsers.ios('Safari'),
            version: [2, 3000, 1023223821]
        })

        let done = false
        
        sock.ev.on('connection.update', async (update) => {
            const { connection } = update
            console.log(`[${number}] ${connection}`)
            
            if (connection === 'open' &&!sock.authState.creds.registered &&!done) {
                await new Promise(r => setTimeout(r, 1000))
                try {
                    const code = await sock.requestPairingCode(number)
                    console.log(`[${number}] CODE: ${code}`)
                    done = true
                    res.json({ success: true, code: code })
                } catch (e) {
                    console.log(`[${number}] ERROR:`, e.message)
                    done = true
                    res.json({ success: false, error: e.message })
                }
            }
        })

        sock.ev.on('creds.update', saveCreds)
        
        setTimeout(() => {
            if (!done) {
                done = true
                res.json({ success: false, error: 'Timeout after 20s' })
            }
            try { sock?.end() } catch {}
            try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch {}
        }, 20000)
        
    } catch (err) {
        console.log(`[${number}] CRASH:`, err.message)
        res.json({ success: false, error: 'Server error: ' + err.message })
    }
})

server.listen(PORT, () => console.log(`VOID-MD running on ${PORT} 💀`))
