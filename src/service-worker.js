import './helpers/text-helpers.js'
import { fileExtMap } from './helpers/file-helpers.js'
import { initializeSentry } from './helpers/sentry-helpers.js'

// Local state -----------------------------------------------------------------
let queue = []
let playing = false
let cancellationToken = false
let bootstrappedResolver = null

const bootstrapped = new Promise((resolve) => (bootstrappedResolver = resolve))

// Bootstrap -------------------------------------------------------------------
initializeSentry()

;(async function Bootstrap() {
  await migrateSyncStorage()
  await handlers.fetchVoices()
  await setDefaultSettings()
  await createContextMenus()
  bootstrappedResolver()
})()

// Event listeners -------------------------------------------------------------
chrome.commands.onCommand.addListener(function (command) {
  console.log('Handling command...', ...arguments)

  if (!handlers[command]) throw new Error(`No handler found for ${command}`)

  handlers[command]()
})

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  console.log('Handling message...', ...arguments)

  const { id, payload } = request

  if (!handlers[id]) throw new Error(`No handler found for ${id}`)
  handlers[id](payload).then(sendResponse)

  return true
})

chrome.storage.onChanged.addListener(function (changes) {
  console.log('Handling storage change...', ...arguments)

  if (!changes.downloadEncoding) return

  updateContextMenus()
})

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  console.log('Handling context menu click...', ...arguments)

  const id = info.menuItemId
  const payload = { text: info.selectionText }

  if (!handlers[id]) throw new Error(`No handler found for ${id}`)

  handlers[id](payload)
})

chrome.runtime.onInstalled.addListener(async function (details) {
  console.log('Handling runtime install...', ...arguments)

  const self = await chrome.management.getSelf()
  if (details.reason === 'update' && self.installType !== 'development') {
    const changelogUrl = chrome.runtime.getURL('public/changelog.html')

    chrome.tabs.create({ url: changelogUrl })
  }
})

// Handlers --------------------------------------------------------------------
export const handlers = {
  readAloud: async function ({ text }) {
    console.log('Reading aloud...', ...arguments)

    if (playing) await this.stopReading()

    const chunks = text.chunk()
    console.log('Chunked text into', chunks.length, 'chunks', chunks)

    queue.push(...chunks)
    playing = true
    updateContextMenus()

    let count = 0
    const sync = await chrome.storage.sync.get()
    const encoding = sync.readAloudEncoding
    const prefetchQueue = []
    cancellationToken = false
    while (queue.length) {
      if (cancellationToken) {
        cancellationToken = false
        playing = false
        updateContextMenus()
        return
      }

      const text = queue.shift()
      const nextText = queue[0]

      if (nextText) {
        prefetchQueue.push(this.getAudioUri({ text: nextText, encoding }))
      }

      const audioUri =
        count === 0
          ? await this.getAudioUri({ text, encoding })
          : await prefetchQueue.shift()

      try {
        await createOffscreenDocument()
        await chrome.runtime.sendMessage({
          id: 'play',
          payload: { audioUri },
          offscreen: true,
        })
      } catch (e) {
        console.warn('Failed to play audio', e)

        // Audio playback may have failed because the user stopped playback, or
        // called the readAloud function again. We need to return early to avoid
        // playing the next chunk.
        return
      }

      console.log('Play through of audio complete. Enqueuing next chunk.')
      count++
    }

    playing = false
    updateContextMenus()
    return Promise.resolve(true)
  },
  readAloudShortcut: async function () {
    console.log('Handling read aloud shortcut...', ...arguments)

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: retrieveSelection,
    })
    const text = result[0].result

    if (playing) {
      await this.stopReading()

      if (!text) return
    }

    this.readAloud({ text })
  },
  stopReading: async function () {
    console.log('Stopping reading...', ...arguments)

    cancellationToken = true
    queue = []
    playing = false
    updateContextMenus()

    try {
      await createOffscreenDocument()
      await chrome.runtime.sendMessage({
        id: 'stop',
        offscreen: true,
      })
    } catch (e) {
      console.warn('Failed to stop audio', e)
    }

    return Promise.resolve(true)
  },
  download: async function ({ text }) {
    console.log('Downloading audio...', ...arguments)

    const { downloadEncoding: encoding } = await chrome.storage.sync.get()
    const url = await this.getAudioUri({ text, encoding })

    console.log('Downloading audio from', url)
    chrome.downloads.download({
      url,
      filename: `tts-download.${fileExtMap[encoding]}`,
    })

    return Promise.resolve(true)
  },
  downloadShortcut: async function () {
    console.log('Handling download shortcut...', ...arguments)

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: retrieveSelection,
    })
    const text = result[0].result

    this.download({ text })
  },
  synthesize: async function ({ text, encoding }) {
    console.log('Synthesizing text...', ...arguments)

    const sync = await chrome.storage.sync.get()
    const voice = sync.voices[sync.language]
    const count = text.length

    if (!sync.apiKey || !sync.apiKeyValid) {
      sendMessageToCurrentTab({
        id: 'setError',
        payload: {
          icon: 'error',
          title: 'API key is missing or invalid',
          message: "Please enter a valid API key in the extension popup. Video instructions are available here: https://www.youtube.com/watch?v=1n8xlVNWEZ0",
        },
      })

      throw new Error('API key is missing or invalid')
    }

    let ssml
    if (text.isSSML()) {
      ssml = text
      text = undefined
    }

    const audioConfig = {
      audioEncoding: encoding,
      pitch: sync.pitch,
      speakingRate: sync.speed,
      volumeGainDb: sync.volumeGainDb,
      effectsProfileId: sync.audioProfile != 'default' ? [sync.audioProfile] : undefined
    }

    const voiceConfig = {
      languageCode: sync.language,
      name: voice
    }

    const response = await fetch(
      `${await getApiUrl()}/text:synthesize?key=${sync.apiKey}`,
      {
        method: 'POST',
        body: JSON.stringify({
          audioConfig,
          voice: voiceConfig,
          input: { text, ssml },
        }),
      }
    )

    if (!response.ok) {
      const message = (await response.json()).error?.message

      sendMessageToCurrentTab({
        id: 'setError',
        payload: { title: 'Failed to synthesize text', message },
      })

      await this.stopReading()

      throw new Error(message)
    }

    const audioContent = (await response.json()).audioContent

    // TODO(mike): pass more details about the request to the analytics endpoint
    // so we can better understand how the extension is being used.
    fetch('https://tunnel.pgmichael.com/insights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resource: 'audio',
        method: 'post',
        body: {
          count,
          version: chrome.runtime.getManifest().version,
          audioConfig,
          voice: voiceConfig,
        },
      }),
    })

    return audioContent
  },
  getAudioUri: async function ({ text, encoding }) {
    console.log('Getting audio URI...', ...arguments)

    const chunks = text.chunk()
    console.log('Chunked text into', chunks.length, 'chunks', chunks)

    const promises = chunks.map((text) => this.synthesize({ text, encoding }))
    const audioContents = await Promise.all(promises)

    return (
      `data:audio/${fileExtMap[encoding]};base64,` +
      btoa(audioContents.map(atob).join(''))
    )
  },
  fetchVoices: async function () {
    console.log('Fetching voices...', ...arguments)

    try {
      const sync = await chrome.storage.sync.get()
      const baseUrl = await getApiUrl()
      const response = await fetch(`${baseUrl}/voices?key=${sync.apiKey}`)

      const voices = (await response.json()).voices
      if (!voices) throw new Error('No voices found')

      await chrome.storage.session.set({ voices })
      await setLanguages()

      return voices
    } catch (e) {
      console.warn('Failed to fetch voices', e)

      return false
    }
  },
}

// Helpers ---------------------------------------------------------------------
async function updateContextMenus() {
  console.log('Updating context menus...', { playing })

  // Prevents context menus from being updated before they are created,
  // which causes an unnecessary error in the console.
  await bootstrapped

  const commands = await chrome.commands.getAll()
  const encoding = (await chrome.storage.sync.get()).downloadEncoding
  const fileExt = fileExtMap[encoding]
  const downloadShortcut = commands.find((c) => c.name === 'downloadShortcut')?.shortcut

  chrome.contextMenus.update('readAloud', {
    enabled: true
  })

  chrome.contextMenus.update('stopReading', {
    enabled: playing
  })

  chrome.contextMenus.update('download', {
    title: `Download ${fileExt?.toUpperCase()}${downloadShortcut && ` (${downloadShortcut})`}`,
  })
}

async function createContextMenus() {
  console.log('Creating context menus...', ...arguments)
  chrome.contextMenus.removeAll()


  const commands = await chrome.commands.getAll()
  const readAloudShortcut = commands.find((c) => c.name === 'readAloudShortcut')?.shortcut
  const downloadShortcut = commands.find((c) => c.name === 'downloadShortcut')?.shortcut
  const downloadEncoding = (await chrome.storage.sync.get()).downloadEncoding
  const fileExt = fileExtMap[downloadEncoding]

  chrome.contextMenus.create({
    id: 'readAloud',
    title: `Read aloud${readAloudShortcut && ` (${readAloudShortcut})`}`,
    contexts: ['selection'],
    enabled: !playing,
  })

  chrome.contextMenus.create({
    id: 'stopReading',
    title: `Stop reading${readAloudShortcut && ` (${readAloudShortcut})`}`,
    contexts: ['all'],
    enabled: playing,
  })

  chrome.contextMenus.create({
    id: 'download',
    title: `Download ${fileExt?.toUpperCase()}${downloadShortcut && ` (${downloadShortcut})`}`,
    contexts: ['selection'],
  })
}

let creating
async function createOffscreenDocument() {
  const path = 'public/offscreen.html'

  if (await hasOffscreenDocument(path)) return

  if (creating) {
    await creating
  } else {
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Plays synthesized audio in the background',
    })
    await creating
    creating = null
  }
}

async function hasOffscreenDocument(path) {
  console.log('Checking if offscreen document exists...', ...arguments)

  const offscreenUrl = chrome.runtime.getURL(path)
  const matchedClients = await clients.matchAll()

  for (const client of matchedClients) {
    if (client.url === offscreenUrl) return true
  }

  return false
}

export async function setDefaultSettings() {
  console.log('Setting default settings...', ...arguments)

  await chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
  })

  const sync = await chrome.storage.sync.get()
  await chrome.storage.sync.set({
    language: sync.language || 'en-US',
    speed: sync.speed || 1,
    pitch: sync.pitch || 0,
    voices: sync.voices || { 'en-US': 'en-US-Polyglot-1' },
    readAloudEncoding: sync.readAloudEncoding || 'OGG_OPUS',
    downloadEncoding: sync.downloadEncoding || 'MP3_64_KBPS',
    apiKey: sync.apiKey || '',
    audioProfile: sync.audioProfile || 'default',
    volumeGainDb: sync.volumeGainDb || 0,
  })
}

async function migrateSyncStorage() {
  console.log('Migrating sync storage...', ...arguments)

  const sync = await chrome.storage.sync.get()

  // Extension with version 8 had WAV and OGG_OPUS as a download option, but
  // it was rolled back in version 9. Due to audio stiching issues.
  if (
    Number(chrome.runtime.getManifest().version) <= 9 &&
    (sync.downloadEncoding == 'OGG_OPUS' || sync.downloadEncoding == 'LINEAR16')
  ) {
    chrome.storage.sync.set({ downloadEncoding: 'MP3_64_KBPS' })
  }

  // Extensions with version < 8 had a different storage structure.
  // We need to migrate them to the new structure before we can use them.
  if (sync.voices || Number(chrome.runtime.getManifest().version) < 8) return

  await chrome.storage.sync.clear()

  const newSync = {}
  if (sync.locale) {
    const oldVoiceParts = sync.locale.split('-')
    newSync.language = [oldVoiceParts[0], oldVoiceParts[1]].join('-')
    newSync.voices = { [newSync.language]: sync.locale }
  }

  if (sync.speed) {
    newSync.speed = Number(sync.speed)
  }

  if (sync.pitch) {
    newSync.pitch = 0
  }

  if (sync.apiKey) {
    newSync.apiKey = sync.apiKey
    newSync.apiKeyValid = true // Assume the old key is valid until proven otherwise
  }

  await chrome.storage.sync.set(newSync)
}

async function setLanguages() {
  console.log('Setting languages...', ...arguments)

  const session = await chrome.storage.session.get()

  if (!session.voices) {
    throw new Error('No voices found. Cannot set languages.')
  }

  const languages = new Set(
    session.voices.map((voice) => voice.languageCodes).flat()
  )

  await chrome.storage.session.set({ languages: Array.from(languages) })

  return languages
}

function retrieveSelection() {
  console.log('Retrieving selection...', ...arguments)

  const activeElement = document.activeElement
  if (activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA') {

    const start = activeElement.selectionStart
    const end = activeElement.selectionEnd

    return activeElement.value.slice(start, end)
  }

  return window.getSelection()?.toString()
}

async function getApiUrl() {
  console.log('Getting API URL...', ...arguments)

  return 'https://texttospeech.googleapis.com/v1beta1'
}

async function sendMessageToCurrentTab(event) {
  console.log('Sending message to current tab...', ...arguments)

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const currentTab = tabs[0]

  if (!currentTab) {
    console.warn('No current tab found. Aborting message send.')
    return
  }

  chrome.tabs.sendMessage(currentTab.id, event)
}
