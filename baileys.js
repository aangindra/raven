const { existsSync, unlinkSync, readdir, mkdirSync } = require('fs')
const { join } = require('path')
const {
  default: makeWASocket,
  makeWALegacySocket,
  useSingleFileAuthState,
  useSingleFileLegacyAuthState,
  makeInMemoryStore,
  Browsers,
  DisconnectReason,
  delay,
} = require('@adiwajshing/baileys')
const P = require("pino");
const { noop, toPairs } = require("lodash");
// const deviceResolver = require('../query/WhatsappDevice');

const sessions = new Map()
const retries = new Map()

const sessionsDir = (sessionId = '') => {
  if (!existsSync(join(__dirname, 'baileys-sessions'))) {
    mkdirSync(join(__dirname, 'baileys-sessions'))
  }
  return join(__dirname, 'baileys-sessions', sessionId ? `${sessionId}.json` : '')
}

const isSessionExists = (sessionId) => {
  return sessions.has(sessionId)
}

const isSessionFileExists = (name) => {
  return existsSync(sessionsDir(name))
}

const shouldReconnect = (sessionId) => {
  let maxRetries = parseInt(process.env.MAX_RETRIES ?? 0)
  let attempts = retries.get(sessionId) ?? 0

  maxRetries = maxRetries < 1 ? 1 : maxRetries

  if (attempts < maxRetries) {
    ++attempts

    console.log('Reconnecting...', { attempts, sessionId })
    retries.set(sessionId, attempts)

    return true
  }

  return false
}

const createSession = async ({ sessionId, isLegacy = false, collection = null, cache = null, socket }) => {
  const sessionFile = (isLegacy ? 'legacy_' : 'md_') + sessionId
  sessionsDir()

  const store = makeInMemoryStore({})
  const { state, saveState } = isLegacy
    ? useSingleFileLegacyAuthState(sessionsDir(sessionFile))
    : useSingleFileAuthState(sessionsDir(sessionFile))

  /**
   * @type {(import('@adiwajshing/baileys').LegacySocketConfig|import('@adiwajshing/baileys').SocketConfig)}
   */
  const waConfig = {
    auth: state,
    version: [2, 2204, 13],
    browser: ['School Talk', 'Google Chrome', '18.04'],
    logger: P({ level: 'trace', enabled: false }),
  }

  /**
   * @type {import('@adiwajshing/baileys').AnyWASocket}
   */
  const wa = isLegacy ? makeWALegacySocket(waConfig) : makeWASocket(waConfig)

  if (!isLegacy) {
    store.readFromFile(sessionsDir(`${sessionId}_store`))
    store.bind(wa.ev)
  }

  sessions.set(sessionId, { ...wa, store, isLegacy });
  if (cache) {
    // await cache.hmset(`baileys-sessions-${sessionId}`, JSON.stringify({ ...wa, store, isLegacy }));
  }
  wa.ev.on('creds.update', saveState)

  wa.ev.on('chats.set', ({ chats }) => {
    if (isLegacy) {
      store.chats.insertIfAbsent(...chats)
    }
  })

  wa.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0]

    // if (!message.key.fromMe && m.type === 'notify') {
    //     await delay(1000)

    //     if (isLegacy) {
    //         await wa.chatRead(message.key, 1)
    //     } else {
    //         await wa.sendReadReceipt(message.key.remoteJid, message.key.participant, [message.key.id])
    //     }
    // }
  })

  wa.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update
    const statusCode = lastDisconnect?.error?.output?.statusCode

    if (connection === 'open') {
      console.log(`Connected with ${sessionId}`)
      socket.emit("DEVICE_STATUS", JSON.stringify({
        status: "CONNECTED"
      }))
      const update = {
        status: 'Connected'
      }
      await collection("Devices").updateOne({
        phone: sessionId
      }, {
        $set: {
          status: "CONNECTED",
          _updatedAt: new Date().toISOString(),
        }
      })
    }

    if (connection === 'close') {
      if (statusCode === DisconnectReason.loggedOut) {
        return deleteSession({ sessionId, isLegacy })
      } else {
        setTimeout(
          () => {
            createSession({ sessionId, isLegacy, collection, cache, socket })
          },
          statusCode === DisconnectReason.restartRequired ? 0 : parseInt(process.env.RECONNECT_INTERVAL ?? 0)
        )
      }
    }

    socket.emit("QR_CODE", JSON.stringify({ qrCode: update.qr }))
  })
}

/**
 * @returns {(import('@adiwajshing/baileys').AnyWASocket|null)}
 */
const getSession = async (sessionId, cache = null) => {
  // let baileysSessions = await cache.hgetAsync("baileys-sessions", sessionId);
  // baileysSessions = baileysSessions ? new Map(toPairs(JSON.parse(baileysSessions))) : new Map();
  return sessions.get(sessionId) ?? null
}

const deleteSession = async ({ sessionId, isLegacy = false, option = null, collection = null }) => {
  if (option === 'logOut') {
    const session = await getSession(sessionId)
    if (session != null) {
      const update = {
        status: 'Disconnect'
      }
      if (collection) {
        await collection("Devices").updateOne({
          phone: sessionId
        }, {
          status: "DISCONNECTED",
          _updatedAt: new Date().toISOString(),
        })
      }
      // await deviceResolver.updateDevice(sessionId, update)

      await session.logout()
    }
  }

  const sessionFile = (isLegacy ? 'legacy_' : 'md_') + sessionId
  const storeFile = `${sessionId}_store`

  if (isSessionFileExists(sessionFile)) {
    unlinkSync(sessionsDir(sessionFile))
  }

  if (isSessionFileExists(storeFile)) {
    unlinkSync(sessionsDir(storeFile))
  }

  sessions.delete(sessionId)
  retries.delete(sessionId);
  return "success";
}

const getChatList = async (sessionId, isGroup = false) => {
  const filter = isGroup ? '@g.us' : '@s.whatsapp.net'

  return await getSession(sessionId).store.chats.filter((chat) => {
    return chat.id.endsWith(filter)
  })
}

/**
 * @param {import('@adiwajshing/baileys').AnyWASocket} session
 */
const isExists = async (session, jid, isGroup = false) => {
  try {
    let result

    if (isGroup) {
      result = await session.groupMetadata(jid)

      return Boolean(result.id)
    }

    if (session.isLegacy) {
      result = await session.onWhatsApp(jid)
    } else {
      ;[result] = await session.onWhatsApp(jid)
    }

    return result.exists
  } catch {
    return false
  }
}

/**
 * @param {import('@adiwajshing/baileys').AnyWASocket} session
 */
const sendMessage = async (session, receiver, message) => {
  try {
    await delay(1000)
    // console.log(receiver)
    return session.sendMessage(receiver, message)
  } catch {
    return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
  }
}

const formatPhone = (phone) => {
  if (phone.endsWith('@s.whatsapp.net')) {
    return phone
  }

  let formatted = phone.replace(/\D/g, '')

  return (formatted += '@s.whatsapp.net')
}

const formatGroup = (group) => {
  if (group.endsWith('@g.us')) {
    return group
  }

  let formatted = group.replace(/[^\d-]/g, '')

  return (formatted += '@g.us')
}

const buildSession = ({ socket, collection }) => {
  readdir(sessionsDir(), (err, files) => {
    if (err) {
      throw err;
    }

    for (const file of files) {
      if (
        !file.endsWith(".json") ||
        (!file.startsWith("md_") && !file.startsWith("legacy_")) ||
        file.includes("_store")
      ) {
        continue;
      }

      const filename = file.replace(".json", "");
      const isLegacy = filename.split("_", 1)[0] !== "md";
      const sessionId = filename.substring(isLegacy ? 7 : 3);

      createSession({ sessionId, collection, isLegacy, socket });
    }
  });
};

module.exports = {
  isSessionExists,
  createSession,
  getSession,
  deleteSession,
  getChatList,
  isExists,
  sendMessage,
  formatPhone,
  formatGroup,
  buildSession,
}
