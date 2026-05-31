const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const fs = require('fs')
const { spawn } = require('child_process')

Object.keys(require.cache).forEach(key => {
  if (key.includes('ytdl-core')) delete require.cache[key]
})
const ytdl = require('ytdl-core')
const axios = require('axios')
const yts = require('yt-search')

try {
    process.env.FFMPEG_PATH = require('ffmpeg-static')
} catch(e) {
    console.log('ffmpeg-static not found. Run: npm install ffmpeg-static')
}

// MAIN OWNER - change this to your real number
const MAIN_OWNER = '2347058642511'

// Store owner numbers and optional LID mappings
const OWNER_FILE = './owner.json'
let ownerConfig = { numbers: [MAIN_OWNER], lids: [] }

const normalizeNumber = (value) => String(value || '').replace(/\D/g, '')
const getJidUser = (jid) => String(jid || '').split('@')[0].split(':')[0]

const loadOwnerConfig = () => {
    if (!fs.existsSync(OWNER_FILE)) return
    let data
    try {
        data = JSON.parse(fs.readFileSync(OWNER_FILE))
    } catch (err) {
        console.error('Failed to parse owner.json:', err)
        return
    }

    if (Array.isArray(data)) {
        ownerConfig.numbers = data.map(normalizeNumber).filter(Boolean)
        ownerConfig.lids = []
        return
    }

    if (Array.isArray(data.numbers)) {
        ownerConfig.numbers = data.numbers.map(normalizeNumber).filter(Boolean)
    } else if (data.main) {
        ownerConfig.numbers = [normalizeNumber(data.main)].filter(Boolean)
    }

    if (Array.isArray(data.lids)) {
        ownerConfig.lids = data.lids.map(getJidUser).filter(Boolean)
    }
}

loadOwnerConfig()
ownerConfig.numbers = [...new Set(ownerConfig.numbers)]
ownerConfig.lids = [...new Set(ownerConfig.lids)]

const saveOwner = () => {
    fs.writeFileSync(OWNER_FILE, JSON.stringify(ownerConfig, null, 2))
}

const welcomeSent = new Set()
const gameSessions = new Map()
const groupSettings = new Map()

async function startBot() {
   const { state, saveCreds } = await useMultiFileAuthState('auth')

   const sock = makeWASocket({
       auth: state,
       logger: pino({ level: 'silent' }),
       getMessage: async (key) => {
           if (global.messageStore && global.messageStore[key.id]) {
               return global.messageStore[key.id]
           }
           return { conversation: '' }
       }
   })

   global.messageStore = {}
   const startTime = Date.now()

   sock.ev.on('connection.update', (update) => {
       const { connection, lastDisconnect, qr } = update

       if(qr) {
           qrcode.generate(qr, { small: true })
           console.log('📱 Scan QR with WhatsApp > Linked Devices')
       }

       if(connection === 'close') {
           const shouldReconnect = (lastDisconnect.error)?.output?.statusCode!== DisconnectReason.loggedOut
           console.log('❌ Disconnected. Reconnecting:', shouldReconnect)
           if(shouldReconnect) startBot()
       } else if(connection === 'open') {
           console.log('✅ LUNA-V5 Online!')
       }
   })

   sock.ev.on('creds.update', saveCreds)

   sock.ev.on('messages.upsert', async ({ messages, type }) => {
       if(type!== 'notify') return
       const msg = messages[0]
       if(!msg.message) return
       if(msg.key.id && msg.message) {
           global.messageStore[msg.key.id] = msg.message
       }
   })

   sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if(!msg.message) return
    if(msg.key.remoteJid === 'status@broadcast') return

    const from = msg.key.remoteJid
    const senderJid = msg.key.participant || msg.key.remoteJid
    const senderId = getJidUser(senderJid)
    const isGroup = from.endsWith('@g.us')
    const sender = senderJid

    const resolveOwnerJid = async (number) => {
        if (!number) return null
        if (senderId === number) return senderJid
        try {
            const [result] = await sock.onWhatsApp(number)
            return result?.jid || null
        } catch {
            return null
        }
    }

    const isOwnerJid = async () => {
        if (!senderId) return false
        if (ownerConfig.numbers.includes(senderId)) return true
        if (ownerConfig.lids.includes(senderId)) return true

        if (senderJid.includes('@lid.whatsapp.net')) {
            for (const number of ownerConfig.numbers) {
                const ownerJid = await resolveOwnerJid(number)
                if (ownerJid === senderJid) {
                    const lid = getJidUser(senderJid)
                    if (!ownerConfig.lids.includes(lid)) {
                        ownerConfig.lids.push(lid)
                        ownerConfig.lids = [...new Set(ownerConfig.lids)]
                        saveOwner()
                    }
                    return true
                }
            }
        }

        return false
    }

    const isOwner = await isOwnerJid()
    console.log('Sender:', senderId, 'isOwner:', isOwner)

    const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption

    if(!text) return
    console.log(`[${senderId}] ${text}`)
    if(!text.startsWith('.')) return
    const [command,...rest] = text.trim().split(' ')
    const cmd = command.toLowerCase()
    const args = rest.join(' ').trim()
    const uptime = Math.floor((Date.now() - startTime) / 1000)
    const hrs = Math.floor(uptime / 3600)
    const mins = Math.floor((uptime % 3600) / 60)
    const secs = uptime % 60

    const isYTUrl = (url) => {
        return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/.test(url)
    }

    const streamToBuffer = async (stream) => {
        const chunks = []
        for await(const chunk of stream) {
            chunks.push(chunk)
            if(Buffer.concat(chunks).length > 16000000) {
                throw new Error('File too large')
            }
        }
        return Buffer.concat(chunks)
    }

    // ═══════════════
    // OWNER COMMANDS
    // ═══════════════

    if(cmd === '.addowner' && isOwner) {
        if(!args) return await sock.sendMessage(from, { text: 'Usage:.addowner 2347058642511' })

        const targetNumber = normalizeNumber(args)
        if(!targetNumber) return await sock.sendMessage(from, { text: '❌ Invalid number.' })
        if(ownerConfig.numbers.includes(targetNumber)) {
            return await sock.sendMessage(from, { text: '❌ That number is already an owner.' })
        }

        try {
            const [result] = await sock.onWhatsApp(targetNumber)
            if (!result?.exists) {
                return await sock.sendMessage(from, { text: '❌ Number not on WhatsApp.' })
            }

            ownerConfig.numbers.push(targetNumber)
            ownerConfig.numbers = [...new Set(ownerConfig.numbers)]

            let addedLid = ''
            if (result.jid.includes('@lid.whatsapp.net')) {
                const lid = getJidUser(result.jid)
                if (!ownerConfig.lids.includes(lid)) {
                    ownerConfig.lids.push(lid)
                    ownerConfig.lids = [...new Set(ownerConfig.lids)]
                    addedLid = ` LID: ${lid}`
                }
            }

            saveOwner()
            await sock.sendMessage(from, { text: `✅ Added ${targetNumber} as owner.${addedLid}` })
        } catch {
            await sock.sendMessage(from, { text: '❌ Failed to check number.' })
        }
        return
    }

    if(cmd === '.removeowner' && isOwner) {
        if(!args) return await sock.sendMessage(from, { text: 'Usage:.removeowner 2347058642511' })

        const targetNumber = normalizeNumber(args)
        ownerConfig.numbers = ownerConfig.numbers.filter(n => n !== targetNumber)
        ownerConfig.lids = ownerConfig.lids.filter(lid => lid !== targetNumber)
        saveOwner()
        await sock.sendMessage(from, { text: `✅ Removed ${targetNumber} from owners.` })
        return
    }

    // ═══════════════
    // PUBLIC COMMANDS
    // ═══════════════

    if(cmd === '.ping') {
        const start = Date.now()
        await sock.sendMessage(from, { text: '🏓 Pinging...' })
        const latency = Date.now() - start
        await sock.sendMessage(from, { text: `🏓 *Pong!*\nSpeed: ${latency}ms\nUptime: ${hrs}h ${mins}m ${secs}s` })
    }

    if(cmd === '.alive') {
        await sock.sendMessage(from, {
            text: `✅ *LUNA-V5 is Online*\n\n🟢 Status: Active\n⏱️ Uptime: ${hrs}h ${mins}m ${secs}s`
        })
    }

    if(cmd === '.info') {
        await sock.sendMessage(from, {
            text: `ℹ️ *LUNA-V5 Bot Info*\n\nBuilt with Baileys MD\nNode: ${process.version}\nPlatform: ${process.platform}\nCreated by LUNA-TEAM`
        })
    }

    if(cmd === '.help') {
        await sock.sendMessage(from, {
            text: `❓ *Need Help?*\n\nOwners: ${ownerConfig.numbers.join(', ') || 'None'}\nCheck *.menu* for commands`
        })
    }

    if(cmd === '.owner') {
        await sock.sendMessage(from, { text: `👑 *Owner Numbers*\n${ownerConfig.numbers.join(', ') || 'None'}\n\n*Mapped LIDs*\n${ownerConfig.lids.join(', ') || 'None'}` })
    }

    if(cmd === '.jid') {
        await sock.sendMessage(from, {
            text: `📍 *JID Info*\n\nChat: ${from}\nSender: ${sender}`
        })
    }

    if(cmd === '.quote') {
        const quotes = [
            "Code is poetry written in logic.",
            "Every bug is a lesson in disguise.",
            "Consistency beats intensity.",
            "Level 100 today, level 200 tomorrow.",
            "Debugging is like being a detective in a crime movie where you are also the culprit."
        ]
        const randomQuote = quotes[Math.floor(Math.random() * quotes.length)]
        await sock.sendMessage(from, { text: `💬 *Quote*\n\n"${randomQuote}"` })
    }

    if(cmd === '.joke') {
        try {
            const res = await axios.get('https://official-joke-api.appspot.com/random_joke')
            await sock.sendMessage(from, { text: `😂 *${res.data.setup}*\n\n${res.data.punchline}` })
        } catch {
            await sock.sendMessage(from, { text: '❌ Failed to get joke' })
        }
    }

    if(cmd === '.meme') {
        try {
            const res = await axios.get('https://meme-api.com/gimme')
            await sock.sendMessage(from, {
                image: { url: res.data.url },
                caption: `😆 ${res.data.title}\n\nr/${res.data.subreddit}`
            })
        } catch {
            await sock.sendMessage(from, { text: '❌ Failed to get meme' })
        }
    }

    if(cmd === '.echo' || cmd === '.say') {
        if(!args) return await sock.sendMessage(from, { text: 'Usage:.echo hello' })
        await sock.sendMessage(from, { text: args })
    }

    if(cmd === '.getpp') {
        if(!args) return await sock.sendMessage(from, { text: 'Usage:.getpp 1234567890' })
        const targetNumber = normalizeNumber(args)
        if(!targetNumber) return await sock.sendMessage(from, { text: '❌ Invalid number. Use country code, e.g. 2347012345678' })
        const target = `${targetNumber}@s.whatsapp.net`
        try {
            const pp = await sock.profilePictureUrl(target, 'image')
            await sock.sendMessage(from, { image: { url: pp }, caption: '👤 Profile Picture' })
        } catch {
            await sock.sendMessage(from, { text: '❌ No profile picture found. Make sure the number is correct and on WhatsApp.' })
        }
    }

    // ═══════════════
    // MEDIA COMMANDS
    // ═══════════════

    if(cmd === '.sticker' || cmd === '.s') {
        const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
        const mediaMsg = msg.message.imageMessage || msg.message.videoMessage || quoted?.imageMessage || quoted?.videoMessage

        if(!mediaMsg) {
            return await sock.sendMessage(from, { text: '📸 Reply to an image/video with *.sticker*' })
        }

        if(mediaMsg.seconds > 10) {
            return await sock.sendMessage(from, { text: '❌ Video too long. Max 10 seconds' })
        }

        try {
            const stream = await sock.downloadContentFromMessage(mediaMsg, mediaMsg.mimetype.includes('video')? 'video' : 'image')
            let buffer = Buffer.from([])
            for await(const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk])
            }

            if(buffer.length > 500000) {
                return await sock.sendMessage(from, { text: '❌ File too large for sticker' })
            }

            await sock.sendMessage(from, { sticker: buffer })
        } catch(e) {
            console.log(e)
            await sock.sendMessage(from, { text: '❌ Failed to create sticker' })
        }
    }

    if(cmd === '.toimg') {
        const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
        const stickerMsg = quoted?.stickerMessage

        if(!stickerMsg) {
            return await sock.sendMessage(from, { text: 'Reply to a sticker with *.toimg*' })
        }

        try {
            const stream = await sock.downloadContentFromMessage(stickerMsg, 'sticker')
            let buffer = Buffer.from([])
            for await(const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk])
            }
            await sock.sendMessage(from, { image: buffer })
        } catch {
            await sock.sendMessage(from, { text: '❌ Failed to convert sticker' })
        }
    }

    if(cmd === '.vv') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
    if(!quoted) return await sock.sendMessage(from, { text: 'Reply to a view-once image or video with *.vv*' })

    let mediaMsg = null
    let type = null

    // Unwrap viewOnceMessage
    if(quoted.viewOnceMessageV2) {
        mediaMsg = quoted.viewOnceMessageV2.message.imageMessage || quoted.viewOnceMessageV2.message.videoMessage
        type = mediaMsg.imageMessage ? 'image' : 'video'
    } else if(quoted.viewOnceMessageV2Extension) {
        mediaMsg = quoted.viewOnceMessageV2Extension.message.imageMessage || quoted.viewOnceMessageV2Extension.message.videoMessage
        type = mediaMsg.imageMessage ? 'image' : 'video'
    } else if(quoted.imageMessage?.viewOnce || quoted.videoMessage?.viewOnce) {
        mediaMsg = quoted.imageMessage || quoted.videoMessage
        type = quoted.imageMessage ? 'image' : 'video'
    }

    if(!mediaMsg) return await sock.sendMessage(from, { text: '❌ Not a view-once media' })

    try {
        const stream = await sock.downloadContentFromMessage(mediaMsg, type)
        let buffer = Buffer.from([])
        for await(const chunk of stream) buffer = Buffer.concat([buffer, chunk])
        
        if(type === 'image') {
            await sock.sendMessage(from, { image: buffer, caption: '🔁 View once removed' })
        } else {
            await sock.sendMessage(from, { video: buffer, caption: '🔁 View once removed' })
        }
    } catch (err) {
        console.log('VV error:', err)
        await sock.sendMessage(from, { text: '❌ Failed to retrieve view-once media. WhatsApp might have patched it.' })
    }
}

    if(cmd === '.ttp') {
        if(!args) return sock.sendMessage(from, { text: 'Usage:.ttp hello' })
        const url = `https://api.neoxr.eu.org/api/ttp?q=${encodeURIComponent(args)}`
        await sock.sendMessage(from, { sticker: { url } })
    }

    if(cmd === '.attp') {
        if(!args) return sock.sendMessage(from, { text: 'Usage:.attp hello' })
        const url = `https://api.neoxr.eu.org/api/attp?q=${encodeURIComponent(args)}`
        await sock.sendMessage(from, { sticker: { url } })
    }

    if(cmd === '.tts') {
        const ttsText = args
        if(!ttsText) return await sock.sendMessage(from, { text: 'Usage:.tts Hello' })
        try {
            const url = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(ttsText)}`
            await sock.sendMessage(from, {
                audio: { url },
                mimetype: 'audio/mp4',
                ptt: true
            })
        } catch {
            await sock.sendMessage(from, { text: '❌ TTS failed' })
        }
    }

    // ═══════════════
    // AI COMMANDS
    // ═══════════════

    if(cmd === '.ai') {
        if(!args) return sock.sendMessage(from, {text: 'Ask me anything'})
        try {
            const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: 'llama3-8b-8192',
                messages: [{role: 'user', content: args}]
            }, {headers: {Authorization: 'Bearer YOUR_GROQ_KEY'}})
            sock.sendMessage(from, {text: res.data.choices[0].message.content})
        } catch {
            sock.sendMessage(from, {text: '❌ AI error. Check API key'})
        }
    }

    if(cmd === '.aisong' || cmd === '.song') {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.aisong make me a happy tune'})
        try {
            const url = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent('Sing this song: ' + args)}`
            await sock.sendMessage(from, {
                audio: { url },
                mimetype: 'audio/mp4',
                ptt: false
            })
        } catch {
            sock.sendMessage(from, {text: '❌ AI song failed'})
        }
    }

    if(cmd === '.imagine') {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.imagine cyberpunk cat'})
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(args)}`
        sock.sendMessage(from, {image: {url}, caption: args})
    }

    if(cmd === '.rizz') {
        const rizzLines = [
            'Are you a magician? Because whenever I look at you, everyone else disappears.',
            'Do you have a map? I keep getting lost in your eyes.',
            'Is your name Wi-Fi? Because I’m feeling a connection.',
            'You must be tired because you’ve been running through my mind all day.'
        ]
        const random = rizzLines[Math.floor(Math.random() * rizzLines.length)]
        sock.sendMessage(from, { text: `💘 *Rizz*

${random}` })
    }

    if(cmd === '.motivations' || cmd === '.motivation') {
        const motivations = [
            'Believe in yourself and all that you are.',
            'Small steps every day add up to big results.',
            'The only limit is the one you set for yourself.',
            'Keep going. Great things take time.'
        ]
        const random = motivations[Math.floor(Math.random() * motivations.length)]
        sock.sendMessage(from, { text: `💡 *Motivation*

${random}` })
    }

    if(cmd === '.creatore') {
        const creatorNum = normalizeNumber(MAIN_OWNER)
        await sock.sendMessage(from, {
            text: `👤 *Creator*
+${creatorNum}\nhttps://wa.me/${creatorNum}`
        })
    }

    if(cmd === '.lyrics') {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.lyrics song name artist'})
        try {
            const url = `https://some-random-api.ml/lyrics?title=${encodeURIComponent(args)}`
            const res = await axios.get(url)
            const lyrics = res.data?.lyrics || 'Lyrics not found'
            const title = res.data?.title || args
            const artist = res.data?.artist || 'Unknown'
            const text = lyrics.length > 4096 ? lyrics.substring(0, 4090) + '...' : lyrics
            sock.sendMessage(from, {text: `🎵 *${title}* - ${artist}\n\n${text}`})
        } catch {
            sock.sendMessage(from, {text: '❌ Lyrics not found'})
        }
    }

    if(cmd === '.dm' || cmd === '.privatewarn') {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.dm @user message'})
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if(!mentioned) return sock.sendMessage(from, {text: 'Tag a user to send DM'})
        try {
            await sock.sendMessage(mentioned, {text: `📨 *Message from ${senderId}*\n\n${args}`})
            sock.sendMessage(from, {text: '✅ DM sent'})
        } catch {
            sock.sendMessage(from, {text: '❌ Failed to send DM'})
        }
    }

    if(cmd === '.translate') {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.translate es hello world'})
        const [lang, ...textArr] = args.split(' ')
        const textToTranslate = textArr.join(' ')
        if(!textToTranslate) return sock.sendMessage(from, {text: 'Usage:.translate es hello world'})
        try {
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=en|${lang}`
            const res = await axios.get(url)
            const result = res.data?.responseData?.translatedText || 'Translation failed'
            sock.sendMessage(from, {text: `🔤 *Translated to ${lang}*\n\n${result}`})
        } catch {
            sock.sendMessage(from, {text: '❌ Translation failed'})
        }
    }

    // ═══════════════
    // UTILITY COMMANDS
    // ═══════════════

    if(cmd === '.weather') {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.weather Lagos'})
        try {
            const geo = await axios.get(`https://geocoding-api.open-meteo.com/v1/search?name=${args}&count=1`)
            if(!geo.data.results) return sock.sendMessage(from, {text: 'City not found'})
            const { latitude, longitude, name } = geo.data.results[0]
            const res = await axios.get(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`)
            const w = res.data.current_weather
            sock.sendMessage(from, {text: `🌤️ *Weather in ${name}*\nTemp: ${w.temperature}°C\nWind: ${w.windspeed}km/h`})
        } catch {
            sock.sendMessage(from, {text: '❌ Failed to get weather'})
        }
    }

    if(cmd === '.calc') {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.calc 2+2*5'})
        try {
            const result = Function('"use strict";return (' + args + ')')()
            sock.sendMessage(from, {text: `🧮 *Result*: ${result}`})
        } catch {
            sock.sendMessage(from, {text: '❌ Invalid calculation'})
        }
    }

    if(cmd === '.qr') {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.qr hello'})
        const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(args)}`
        sock.sendMessage(from, {image: {url}, caption: args})
    }

    if(cmd === '.ssweb') {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.ssweb google.com'})
        const url = `https://api.apiflash.com/v1/urltoimage?access_key=free&url=${args}`
        sock.sendMessage(from, {image: {url}, caption: args})
    }

    // ═══════════════
    // GAME COMMANDS
    // ═══════════════

    if(cmd === '.tictactoe') {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.tictactoe @user'})
        const opponent = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if(!opponent) return sock.sendMessage(from, {text: 'Tag a user to play'})

        const gameId = from
        gameSessions.set(gameId, {
            board: ['1','2','3','4','5','6','7','8','9'],
            turn: sender,
            players: [sender, opponent],
            active: true
        })

        const board = gameSessions.get(gameId).board.join(' | ')
        sock.sendMessage(from, {
            text: `🎮 *Tic Tac Toe*\n\n${board}\n\n@${senderId}'s turn (X)\nReply with 1-9`,
            mentions: [sender, opponent]
        })
    }

    if(cmd === '.truthordare') {
        const type = args.toLowerCase() === 'dare'? 'dare' : 'truth'
        const truths = ['What\'s your biggest secret?', 'Who do you like?', 'Last person you texted?']
        const dares = ['Send a voice note singing', 'Change your name for 10 min', 'Send last photo in gallery']
        const list = type === 'truth'? truths : dares
        const random = list[Math.floor(Math.random() * list.length)]
        sock.sendMessage(from, {text: `🎲 *${type.toUpperCase()}*\n\n${random}`})
    }

    if(cmd === '.guess') {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.guess start\nThen guess 1-10'})
        if(args === 'start') {
            const number = Math.floor(Math.random() * 10) + 1
            gameSessions.set(from, {type: 'guess', number, active: true})
            sock.sendMessage(from, {text: '🎯 I picked a number 1-10. Guess it!'})
        } else {
            const game = gameSessions.get(from)
            if(!game || game.type!== 'guess' ||!game.active) {
                return sock.sendMessage(from, {text: 'No active game. Type *.guess start*'})
            }
            const guess = parseInt(args)
            if(guess === game.number) {
                game.active = false
                sock.sendMessage(from, {text: '🎉 Correct! You win!'})
            } else {
                sock.sendMessage(from, {text: guess < game.number? '📈 Higher!' : '📉 Lower!'})
            }
        }
    }

    if(cmd === '.roll') {
        const value = Math.floor(Math.random() * 6) + 1
        sock.sendMessage(from, { text: `🎲 You rolled: *${value}*` })
    }

    if(cmd === '.flip') {
        const result = Math.random() < 0.5 ? 'Heads' : 'Tails'
        sock.sendMessage(from, { text: `🪙 Coin flip: *${result}*` })
    }

    if(cmd === '.time') {
        const now = new Date()
        const localTime = now.toLocaleString('en-US', { timeZone: 'UTC', hour12: false })
        sock.sendMessage(from, { text: `🕒 Current UTC time: ${localTime}` })
    }

    // ═══════════════
    // GROUP COMMANDS
    // ═══════════════

    if(cmd === '.tagall' && isGroup && isOwner) {
        const groupMetadata = await sock.groupMetadata(from)
        const participants = groupMetadata.participants.map(p => p.id)
        const messageText = args || '🔔 *ATTENTION EVERYONE!*'
        await sock.sendMessage(from, {
            text: messageText,
            mentions: participants
        })
    }

    if(cmd === '.hidetag' && isGroup && isOwner) {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.hidetag message'})
        const groupMetadata = await sock.groupMetadata(from)
        const participants = groupMetadata.participants.map(p => p.id)
        await sock.sendMessage(from, {
            text: args,
            mentions: participants
        })
    }

    if(cmd === '.setdesc' && isGroup && isOwner) {
        if(!args) return sock.sendMessage(from, {text: 'Usage:.setdesc new description'})
        await sock.groupUpdateDescription(from, args)
        sock.sendMessage(from, {text: '✅ Group description updated'})
    }

    if(cmd === '.antilink' && isGroup && isOwner) {
        const status = args.toLowerCase()
        if(status === 'on') {
            groupSettings.set(from + '_antilink', true)
            sock.sendMessage(from, {text: '✅ Antilink enabled'})
        } else if(status === 'off') {
            groupSettings.set(from + '_antilink', false)
            sock.sendMessage(from, {text: '❌ Antilink disabled'})
        } else {
            sock.sendMessage(from, {text: 'Usage:.antilink on/off'})
        }
    }

    if(cmd === '.antidelete' && isGroup && isOwner) {
        const status = args.toLowerCase()
        if(status === 'on') {
            groupSettings.set(from + '_antidelete', true)
            sock.sendMessage(from, {text: '✅ Antidelete enabled'})
        } else if(status === 'off') {
            groupSettings.set(from + '_antidelete', false)
            sock.sendMessage(from, {text: '❌ Antidelete disabled'})
        } else {
            sock.sendMessage(from, {text: 'Usage:.antidelete on/off'})
        }
    }

    if(cmd === '.ban' && isGroup && isOwner) {
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid
        if(!mentioned || mentioned.length === 0) return await sock.sendMessage(from, { text: 'Tag the user to ban' })
        try {
            await sock.groupParticipantsUpdate(from, mentioned, 'remove')
            await sock.sendMessage(from, { text: '🚫 User banned from group' })
        } catch {
            await sock.sendMessage(from, { text: '❌ Failed to ban user' })
        }
    }

    if(cmd === '.promote' && isGroup && isOwner) {
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid
        if(!mentioned) return await sock.sendMessage(from, { text: 'Tag the user to promote' })
        await sock.groupParticipantsUpdate(from, mentioned, 'promote')
        await sock.sendMessage(from, { text: '⬆️ User promoted to admin' })
    }

    if(cmd === '.demote' && isGroup && isOwner) {
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid
        if(!mentioned) return await sock.sendMessage(from, { text: 'Tag the user to demote' })
        await sock.groupParticipantsUpdate(from, mentioned, 'demote')
        await sock.sendMessage(from, { text: '⬇️ User demoted from admin' })
    }

    // ═══════════════
    // YOUTUBE COMMANDS
    // ═══════════════

    if(cmd === '.play') {
    const query = args
    if(!query) return await sock.sendMessage(from, { text: 'Usage:.play constellations' })
    
    await sock.sendMessage(from, { text: `🔍 Searching for *${query}*...` })
    
    try {
        let video
        let videoUrl
        
        if(isYTUrl(query)) {
            const info = await ytdl.getInfo(query)
            const details = info.videoDetails
            videoUrl = query
            video = {
                url: query,
                title: details.title,
                author: { name: details.author.name },
                thumbnail: details.thumbnails?.slice(-1)[0]?.url,
                seconds: parseInt(details.lengthSeconds, 10),
                timestamp: new Date(parseInt(details.lengthSeconds, 10) * 1000).toISOString().substr(11, 8)
            }
        } else {
            const search = await yts(query)
            if(!search.videos || search.videos.length === 0) return await sock.sendMessage(from, { text: '❌ No results found' })
            video = search.videos[0]
            videoUrl = video.url || `https://www.youtube.com/watch?v=${video.videoId}`
            video.url = videoUrl
        }

        if(!video) return await sock.sendMessage(from, { text: '❌ No results found' })
        if(video.seconds > 1800) return await sock.sendMessage(from, { text: '❌ Video too long. Max 30 min' })
        
        const timestamp = video.timestamp || new Date(video.seconds * 1000).toISOString().substr(11, 8)
        await sock.sendMessage(from, { 
            text: `🎵 *${video.title}*\n⏱️ ${timestamp}\n⏳ Downloading audio...` 
        })
        
        const apiUrl = `https://api.popcat.xyz/ytmp3?url=${encodeURIComponent(videoUrl)}`
        let audioUrl = null
        try {
            const res = await axios.get(apiUrl, { timeout: 60000 })
            audioUrl = res.data?.link || res.data?.url || res.data?.download_url || null
        } catch (apiError) {
            console.log('play API error:', apiError.message || apiError)
        }

        if(audioUrl) {
            return await sock.sendMessage(from, {
                audio: { url: audioUrl },
                mimetype: 'audio/mpeg',
                fileName: `${video.title}.mp3`,
                contextInfo: {
                    externalAdReply: {
                        title: video.title,
                        body: video.author?.name || 'YouTube',
                        thumbnailUrl: video.thumbnail || video.image,
                        mediaType: 1,
                        sourceUrl: videoUrl
                    }
                }
            })
        }

        // Fallback: download audio directly if API is unavailable
        const info = await ytdl.getInfo(videoUrl)
        const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' })
        const stream = ytdl.downloadFromInfo(info, { format: audioFormat })
        const buffer = await streamToBuffer(stream)
        await sock.sendMessage(from, {
            audio: buffer,
            mimetype: 'audio/mpeg',
            fileName: `${video.title}.mp3`,
            contextInfo: {
                externalAdReply: {
                    title: video.title,
                    body: video.author?.name || 'YouTube',
                    thumbnailUrl: video.thumbnail || video.image,
                    mediaType: 1,
                    sourceUrl: videoUrl
                }
            }
        })
    } catch(e) {
        console.log('play error:', e)
        await sock.sendMessage(from, { text: '❌ Failed to download. Try another song or check your connection.' })
    }
}
    if(cmd.startsWith('.ytmp4 ')) {
        const url = args
        if(!isYTUrl(url)) return await sock.sendMessage(from, { text: '❌ Invalid YouTube URL' })
        await sock.sendMessage(from, { text: '⏳ Downloading video...' })
        try {
            let videoUrl = null
            try {
                const apiRes = await axios.get(`https://api.popcat.xyz/ytmp4?url=${encodeURIComponent(url)}`)
                videoUrl = apiRes.data?.link || apiRes.data?.url || null
            } catch (apiError) {
                console.log('ytmp4 API failed:', apiError.message)
            }

            if(videoUrl) {
                return await sock.sendMessage(from, {
                    video: { url: videoUrl },
                    mimetype: 'video/mp4',
                    fileName: 'download.mp4'
                })
            }

            const info = await ytdl.getInfo(url)
            const title = info.videoDetails.title.replace(/[^ -]/g, '')
            const format = ytdl.chooseFormat(ytdl.filterFormats(info.formats, 'audioandvideo'), { quality: 'highestvideo' })
            const stream = ytdl.downloadFromInfo(info, { format })
            const buffer = await streamToBuffer(stream)
            await sock.sendMessage(from, {
                video: buffer,
                mimetype: 'video/mp4',
                fileName: `${title}.mp4`,
                caption: title
            })
        } catch(e) {
            console.log('ytmp4 error:', e)
            await sock.sendMessage(from, { text: '❌ Video too long or failed to download' })
        }
    }

    // ═══════════════
    // MENU
    // ═══════════════

    if(cmd === '.menu') {
        const menuImage = fs.existsSync('./luna.jpeg') ? fs.readFileSync('./luna.jpeg') : null
        const publicCommands = ['.ping', '.alive', '.info', '.help', '.jid', '.owner', '.getpp', '.say', '.creatore']
        const mediaCommands = ['.sticker', '.toimg', '.vv', '.ttp', '.attp', '.tts']
        const aiCommands = ['.ai', '.imagine', '.aisong']
        const utilityCommands = ['.weather', '.calc', '.qr', '.ssweb', '.time', '.antidelete', '.motivations', '.lyrics', '.translate', '.dm']
        const gameCommands = ['.tictactoe', '.truthordare', '.guess', '.roll', '.flip', '.quote', '.joke', '.meme', '.rizz']
        const groupCommands = ['.tagall', '.hidetag', '.setdesc', '.antilink', '.ban', '.promote', '.demote']
        const youtubeCommands = ['.play', '.ytmp3', '.ytmp4']
        const ownerCommands = ['.restart', '.studown', '.broadcast', '.addowner', '.removeowner']
        const totalCommands = publicCommands.length + mediaCommands.length + aiCommands.length + utilityCommands.length + gameCommands.length + groupCommands.length + youtubeCommands.length + (isOwner ? ownerCommands.length : 0)
        const now = new Date()
        const dayName = now.toLocaleDateString('en-US', { weekday: 'long' })
        const dateText = now.toLocaleDateString('en-GB')
        const timeText = now.toLocaleTimeString('en-GB', { hour12: false })
        const ownerSection = isOwner ? `\n┌─ OWNER ─┐\n${ownerCommands.map(c => `│${c}`).join('\n')}\n└─────────┘` : ''
        const menuText = `
╔═════════════════════════╗
║ 🌙 LUNA-VI STATUS PANEL ║
╚═════════════════════════╝

┌─ SYSTEM ─┐
│ Owner: FELICE-HART
│ Prefix: .
│ Version: 1.0.0
│ Commands: ${totalCommands}
│ Day: ${dayName}
│ Date: ${dateText}
│ Time: ${timeText}
│ Uptime: ${hrs}h ${mins}m ${secs}s
│ Runtime: ${hrs}h ${mins}m ${secs}s
└───────────┘

┌─ PUBLIC ──┐
${publicCommands.map(c => `│${c}`).join('\n')}
└──────────┘

┌─ MEDIA ──┐
${mediaCommands.map(c => `│${c}`).join('\n')}
└─────────┘

┌─ AI ─┐
${aiCommands.map(c => `│${c}`).join('\n')}
└──────┘

┌─ UTILITY ─┐
${utilityCommands.map(c => `│${c}`).join('\n')}
└───────────┘

┌─ GAMES ─┐
${gameCommands.map(c => `│${c}`).join('\n')}
└─────────┘

┌─ YOUTUBE ─┐
${youtubeCommands.map(c => `│${c}`).join('\n')}
└───────────┘

┌─ GROUP ─┐
${groupCommands.map(c => `│${c}`).join('\n')}
└─────────┘${ownerSection}`.trim()

        if(menuImage) {
            await sock.sendMessage(from, { image: menuImage, caption: menuText })
        } else {
            await sock.sendMessage(from, { text: menuText })
        }
    }

    // ═══════════════
    // OWNER COMMANDS
    // ═══════════════

    if(!isOwner) return

    if(cmd === '.restart' && isOwner) {
        await sock.sendMessage(from, { text: '🔄 Restarting bot...' })
        const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: 'ignore'
        })
        child.unref()
        process.exit(0)
    }

    if(cmd === '.studown' && isOwner) {
        await sock.sendMessage(from, { text: '⛔ Shutting down bot...' })
        process.exit(0)
    }

    if(cmd.startsWith('.broadcast ')) {
        if(!args) return await sock.sendMessage(from, { text: 'Usage:.broadcast Hello everyone' })
        await sock.sendMessage(from, { text: '📢 Broadcasting...' })
        await sock.sendMessage(from, { text: '✅ Broadcast complete' })
    }

   })

   // ═════════ ANTI-DELETE ═════════
   sock.ev.on('messages.delete', async ({ keys }) => {
       for(let key of keys) {
           const deletedMsg = global.messageStore[key.id]
           const antiDeleteEnabled = groupSettings.get(key.remoteJid + '_antidelete')
           if(!antiDeleteEnabled) continue
           if(deletedMsg && ownerConfig.numbers.length) {
               const ownerJid = ownerConfig.numbers[0] + '@s.whatsapp.net'
               try {
                   if(deletedMsg.conversation || deletedMsg.extendedTextMessage) {
                        const text = deletedMsg.conversation || deletedMsg.extendedTextMessage.text
                             await sock.sendMessage(ownerJid, {
                              text: `🗑️ *Message Deleted*\nChat: ${key.remoteJid}\n\n${text}`
                        })
                    } else if(deletedMsg.imageMessage) {
                       await sock.sendMessage(ownerJid, {
                           image: await sock.downloadMediaMessage({ message: deletedMsg, key }),
                           caption: `🗑️ Image deleted in ${key.remoteJid}`
                       })
                   } else if(deletedMsg.videoMessage) {
                       await sock.sendMessage(ownerJid, {
                           video: await sock.downloadMediaMessage({ message: deletedMsg, key }),
                           caption: `🗑️ Video deleted in ${key.remoteJid}`
                       })
                   }
               } catch(e) {
                   console.log('Anti-delete error:', e)
               }
           }
       }
   })

   // Antilink handler
   sock.ev.on('messages.upsert', async ({ messages }) => {
       const msg = messages[0]
       if(!msg.message ||!msg.key.remoteJid.endsWith('@g.us')) return
       const from = msg.key.remoteJid
       const sender = msg.key.participant
       const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
       const antilinkEnabled = groupSettings.get(from + '_antilink')
       if(antilinkEnabled && /https?:\/\//.test(text)) {
           const groupMetadata = await sock.groupMetadata(from)
           const isAdmin = groupMetadata.participants.find(p => p.id === sender)?.admin
           if(!isAdmin) {
               await sock.sendMessage(from, {delete: msg.key})
               await sock.sendMessage(from, {text: '🚫 Links not allowed!'})
           }
       }
   })
}

startBot()