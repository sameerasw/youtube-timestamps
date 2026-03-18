const PREVIEW_BORDER_SIZE = 2
const PREVIEW_MARGIN = 8
const OVERLAY_DISPLAY_DURATION = 7000

let currentTimeComments = []
let overlayShownSet = new Set()
let overlayRafId = null
let lastVideoTime = -1
let activeOverlayCards = new Map()

let overlaySide = 'left' // 'left' or 'right'
let isOverlayHidden = false // session-level
let simultaneousTriggerCount = 0
let lastTriggerTime = -1

function init() {
    if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['overlaySide'], (result) => {
            if (result.overlaySide) {
                overlaySide = result.overlaySide
                updateOverlaySideClass()
            }
        })
    }
    main()
    getOrCreateOverlayContainer()
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
} else {
    init()
}

onLocationHrefChange(() => {
    removeBar()
    removeContextMenu()
    removeOverlay()
    main()
})

document.addEventListener('click', e => {
    const stamp = e.target.closest('.__youtube-timestamps__stamp')
    if (!stamp) {
        hideContextMenu()
    }
}, true)
document.addEventListener('contextmenu', e => {
    const stamp = e.target.closest('.__youtube-timestamps__stamp')
    if (!stamp) {
        hideContextMenu()
    }
}, true)

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'toggle-overlay') {
        toggleOverlayVisibility()
    }
})

function toggleOverlayVisibility() {
    isOverlayHidden = !isOverlayHidden
    if (isOverlayHidden) {
        for (const key of activeOverlayCards.keys()) {
            dismissOverlayCard(key)
        }
    }
    
    // Update button opacity if it exists
    const hideBtn = document.querySelector('.__youtube-timestamps__overlay-controls .__youtube-timestamps__overlay-btn:first-child')
    if (hideBtn) {
        hideBtn.style.opacity = isOverlayHidden ? '0.5' : '1'
    }
}

function main() {
    const videoId = getVideoId()
    if (!videoId) {
        return
    }
    fetchTimeComments(videoId)
        .then(result => {
            if (videoId !== getVideoId()) {
                return
            }
            if (result && result.error === 'RATE_LIMIT_REACHED') {
                const rateLimitComment = {
                    commentId: 'rate-limit-notice',
                    authorAvatar: chrome.runtime.getURL('icons/icon48.png'),
                    authorName: 'YouTube Timestamps',
                    timestamp: '0:05',
                    time: 5,
                    text: 'Timed comments rate limited'
                }
                currentTimeComments = [rateLimitComment]
            } else {
                currentTimeComments = result
            }
            addTimeComments(currentTimeComments)
            startOverlayMonitoring()
        })
}

function getVideoId() {
    if (window.location.pathname === '/watch') {
        return parseParams(window.location.href)['v']
    } else if (window.location.pathname.startsWith('/embed/')) {
        return window.location.pathname.substring('/embed/'.length)
    } else {
        return null
    }
}

function getVideo() {
    return document.querySelector('#movie_player video')
}

function fetchTimeComments(videoId) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({type: 'fetchTimeComments', videoId}, resolve)
    })
}

function addTimeComments(timeComments) {
    const bar = getOrCreateBar()
    const videoDuration = getVideo().duration
    let contextMenuTimeComment = null
    for (const tc of timeComments) {
        if (tc.time > videoDuration) {
            continue
        }
        const stamp = document.createElement('div')
        stamp.classList.add('__youtube-timestamps__stamp')
        const offset = tc.time / videoDuration * 100
        stamp.style.left = `calc(${offset}% - 2px)`
        bar.appendChild(stamp)
        stamp.addEventListener('mouseenter', () => {
            showPreview(tc)
        })
        stamp.addEventListener('mouseleave', () => {
            hidePreview()
        })
        stamp.addEventListener('wheel', withWheelThrottle((deltaY) => {
            const preview = getOrCreatePreview()
            if (preview) {
                preview.scrollBy(0, deltaY)
            }
        }))
        stamp.addEventListener('contextmenu', e => {
            e.preventDefault()
            e.stopPropagation()
            if (tc === contextMenuTimeComment && isContextMenuVisible()) {
                hideContextMenu()
            } else {
                showContextMenu(tc, e.pageX, e.pageY)
                contextMenuTimeComment = tc
            }
        })
    }
}

function getOrCreateBar() {
    let bar = document.querySelector('.__youtube-timestamps__bar')
    if (!bar) {
        let container = document.querySelector('#movie_player .ytp-timed-markers-container')
        if (!container) {
            container = document.querySelector('#movie_player .ytp-progress-list')
        }
        bar = document.createElement('div')
        bar.classList.add('__youtube-timestamps__bar')
        container.appendChild(bar)
    }
    return bar
}

function removeBar() {
    const bar = document.querySelector('.__youtube-timestamps__bar')
    if (bar) {
        bar.remove()
    }
}

function getTooltip() {
    return document.querySelector('#movie_player .ytp-tooltip')
}

function showPreview(timeComment) {
    const tooltip = getTooltip()
    const preview = getOrCreatePreview()
    preview.style.display = ''
    preview.querySelector('.__youtube-timestamps__preview__avatar').src = timeComment.authorAvatar
    preview.querySelector('.__youtube-timestamps__preview__name').textContent = timeComment.authorName
    const textNode = preview.querySelector('.__youtube-timestamps__preview__text')
    textNode.textContent = ''
    textNode.appendChild(highlightTextFragment(timeComment.text, timeComment.timestamp))

    const tooltipBgWidth = tooltip.querySelector('.ytp-tooltip-bg').style.width
    const previewWidth = tooltipBgWidth.endsWith('px') ? parseFloat(tooltipBgWidth) : 160
    preview.style.width = (previewWidth + 2*PREVIEW_BORDER_SIZE) + 'px'

    const halfPreviewWidth = previewWidth / 2
    const playerRect = document.querySelector('#movie_player .ytp-progress-bar').getBoundingClientRect()
    const pivot = preview.parentElement.getBoundingClientRect().left
    const minPivot = playerRect.left + halfPreviewWidth
    const maxPivot = playerRect.right - halfPreviewWidth
    let previewLeft
    if (pivot < minPivot) {
        previewLeft = playerRect.left - pivot
    } else if (pivot > maxPivot) {
        previewLeft = -previewWidth + (playerRect.right - pivot)
    } else {
        previewLeft = -halfPreviewWidth
    }
    preview.style.left = (previewLeft - PREVIEW_BORDER_SIZE) + 'px'

    const textAboveVideoPreview = tooltip.querySelector('.ytp-tooltip-edu')
    if (textAboveVideoPreview) {
        preview.style.bottom = (10 + textAboveVideoPreview.clientHeight) + 'px'
    }

    const tooltipTop = tooltip.style.top
    if (tooltipTop.endsWith('px')) {
        let previewHeight = parseFloat(tooltipTop) - 2*PREVIEW_MARGIN
        if (textAboveVideoPreview) {
            previewHeight -= textAboveVideoPreview.clientHeight
        }
        if (previewHeight > 0) {
            preview.style.maxHeight = previewHeight + 'px'
        }
    }

    const highlightedTextFragment = preview.querySelector('.__youtube-timestamps__preview__text-stamp')
    highlightedTextFragment.scrollIntoView({block: 'nearest'})
}

function getOrCreatePreview() {
    const tooltip = getTooltip()
    let preview = tooltip.querySelector('.__youtube-timestamps__preview')
    if (!preview) {
        preview = document.createElement('div')
        preview.classList.add('__youtube-timestamps__preview')
        const previewWrapper = document.createElement('div')
        previewWrapper.classList.add('__youtube-timestamps__preview-wrapper')
        previewWrapper.appendChild(preview)
        tooltip.insertAdjacentElement('afterbegin', previewWrapper)

        const authorElement = document.createElement('div')
        authorElement.classList.add('__youtube-timestamps__preview__author')
        preview.appendChild(authorElement)

        const avatarElement = document.createElement('img')
        avatarElement.classList.add('__youtube-timestamps__preview__avatar')
        authorElement.appendChild(avatarElement)

        const nameElement = document.createElement('span')
        nameElement.classList.add('__youtube-timestamps__preview__name')
        authorElement.appendChild(nameElement)

        const textElement = document.createElement('div')
        textElement.classList.add('__youtube-timestamps__preview__text')
        preview.appendChild(textElement)
    }
    return preview
}

function highlightTextFragment(text, fragment) {
    const result = document.createDocumentFragment()
    const parts = text.split(fragment)
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        if (part) {
            result.appendChild(document.createTextNode(part))
        }
        if (i < parts.length - 1) {
            const fragmentNode = document.createElement('span')
            fragmentNode.classList.add('__youtube-timestamps__preview__text-stamp')
            fragmentNode.textContent = fragment
            result.appendChild(fragmentNode)
        }
    }
    return result
}

function hidePreview() {
    const preview = document.querySelector('.__youtube-timestamps__preview')
    if (preview) {
        preview.style.display = 'none'
    }
}

function parseParams(href) {
    const noHash = href.split('#')[0]
    const paramString = noHash.split('?')[1]
    const params = {}
    if (paramString) {
        const paramsArray = paramString.split('&')
        for (const kv of paramsArray) {
            const tmparr = kv.split('=')
            params[tmparr[0]] = tmparr[1]
        }
    }
    return params
}

function withWheelThrottle(callback) {
    let deltaYAcc = 0
    let afRequested = false
    return (e) => {
        e.preventDefault()

        deltaYAcc += e.deltaY

        if (afRequested) {
            return
        }
        afRequested = true

        window.requestAnimationFrame(() => {
            callback(deltaYAcc)

            deltaYAcc = 0
            afRequested = false
        })
    }
}

function onLocationHrefChange(callback) {
    let currentHref = document.location.href
    const observer = new MutationObserver(() => {
        if (currentHref !== document.location.href) {
            currentHref = document.location.href
            callback()
        }
    })
    observer.observe(document.querySelector("body"), {childList: true, subtree: true})
}

function showContextMenu(timeComment, x, y) {
    const contextMenu = getOrCreateContextMenu()
    contextMenu.style.display = ''
    adjustContextMenuSizeAndPosition(contextMenu, x, y)
    fillContextMenuData(contextMenu, timeComment)
}

function fillContextMenuData(contextMenu, timeComment) {
    contextMenu.dataset.commentId = timeComment.commentId
}

function adjustContextMenuSizeAndPosition(contextMenu, x, y) {
    const menuHeight = contextMenu.querySelector('.ytp-panel-menu').clientHeight
    contextMenu.style.height = menuHeight + 'px'
    contextMenu.style.top = (y - menuHeight) + 'px'
    contextMenu.style.left = x + 'px'
}

function getOrCreateContextMenu() {
    let contextMenu = getContextMenu()
    if (!contextMenu) {
        contextMenu = document.createElement('div')
        contextMenu.id = '__youtube-timestamps__context-menu'
        contextMenu.classList.add('ytp-popup')
        document.body.appendChild(contextMenu)

        const panelElement = document.createElement('div')
        panelElement.classList.add('ytp-panel')
        contextMenu.appendChild(panelElement)

        const menuElement = document.createElement('div')
        menuElement.classList.add('ytp-panel-menu')
        panelElement.appendChild(menuElement)

        menuElement.appendChild(menuItemElement("Open in New Tab", () => {
            const videoId = getVideoId()
            const commentId = contextMenu.dataset.commentId
            window.open(`https://www.youtube.com/watch?v=${videoId}&lc=${commentId}`, '_blank')
        }))
    }
    return contextMenu
}

function menuItemElement(label, callback) {
    const itemElement = document.createElement('div')
    itemElement.classList.add('ytp-menuitem')
    itemElement.addEventListener('click', callback)

    const iconElement = document.createElement('div')
    iconElement.classList.add('ytp-menuitem-icon')
    itemElement.appendChild(iconElement)

    const labelElement = document.createElement('div')
    labelElement.classList.add('ytp-menuitem-label')
    labelElement.textContent = label
    itemElement.appendChild(labelElement)

    return itemElement
}

function getContextMenu() {
    return document.querySelector('#__youtube-timestamps__context-menu')
}

function isContextMenuVisible() {
    const contextMenu = getContextMenu()
    return contextMenu && !contextMenu.style.display
}

function hideContextMenu() {
    const contextMenu = getContextMenu()
    if (contextMenu) {
        contextMenu.style.display = 'none'
    }
}

function removeContextMenu() {
    const contextMenu = getContextMenu()
    if (contextMenu) {
        contextMenu.remove()
    }
}

function getOrCreateOverlayContainer() {
    let container = document.querySelector('.__youtube-timestamps__overlay')
    if (!container) {
        const player = document.querySelector('#movie_player')
        if (!player) return null
        container = document.createElement('div')
        container.classList.add('__youtube-timestamps__overlay')
        if (overlaySide === 'right') container.classList.add('right-side')
        player.appendChild(container)

        createOverlayControls(container)
    }
    return container
}

function createOverlayControls(container) {
    const controls = document.createElement('div')
    controls.classList.add('__youtube-timestamps__overlay-controls')
    container.appendChild(controls)

    // Hide Toggle
    const hideBtn = document.createElement('div')
    hideBtn.classList.add('__youtube-timestamps__overlay-btn')
    hideBtn.title = "Toggle Hide (This video)"
    
    const eyeSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    eyeSvg.setAttribute("viewBox", "0 0 24 24")
    const eyePath = document.createElementNS("http://www.w3.org/2000/svg", "path")
    eyePath.setAttribute("d", "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z")
    eyeSvg.appendChild(eyePath)
    hideBtn.appendChild(eyeSvg)

    hideBtn.onclick = () => {
        toggleOverlayVisibility()
    }
    if (isOverlayHidden) hideBtn.style.opacity = '0.5'
    controls.appendChild(hideBtn)

    // Side Toggle
    const sideBtn = document.createElement('div')
    sideBtn.classList.add('__youtube-timestamps__overlay-btn')
    sideBtn.title = "Toggle Side (Persistent)"
    
    const sideSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    sideSvg.setAttribute("viewBox", "0 0 24 24")
    const sidePath = document.createElementNS("http://www.w3.org/2000/svg", "path")
    sidePath.setAttribute("d", "M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z")
    sideSvg.appendChild(sidePath)
    sideBtn.appendChild(sideSvg)

    sideBtn.onclick = () => {
        overlaySide = overlaySide === 'left' ? 'right' : 'left'
        if (chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ overlaySide })
        }
        updateOverlaySideClass()
    }
    controls.appendChild(sideBtn)
}

function updateOverlaySideClass() {
    const container = document.querySelector('.__youtube-timestamps__overlay')
    if (container) {
        if (overlaySide === 'right') {
            container.classList.add('right-side')
        } else {
            container.classList.remove('right-side')
        }
    }
}

function startOverlayMonitoring() {
    stopOverlayMonitoring()
    overlayShownSet.clear()
    lastVideoTime = -1

    const video = getVideo()
    if (!video) return

    video.addEventListener('pause', onVideoPause)
    video.addEventListener('play', onVideoPlay)

    function tick() {
        overlayRafId = requestAnimationFrame(tick)
        const currentTime = video.currentTime

        if (currentTime < lastVideoTime - 1) {
            overlayShownSet.clear()
        }

        const now = Date.now()
        let triggeredInThisTick = []

        for (const tc of currentTimeComments) {
            const key = tc.commentId + ':' + tc.time
            if (overlayShownSet.has(key)) continue
            if (currentTime >= tc.time && lastVideoTime < tc.time) {
                triggeredInThisTick.push({ tc, key })
            }
        }

        if (triggeredInThisTick.length > 0) {
            // Check if we are still within the same "event burst"
            if (now - lastTriggerTime > 100) {
                simultaneousTriggerCount = 0
            }

            for (const { tc, key } of triggeredInThisTick) {
                overlayShownSet.add(key)
                showOverlayCard(tc, key, simultaneousTriggerCount)
                simultaneousTriggerCount++
            }
            lastTriggerTime = now
        }

        lastVideoTime = currentTime
    }

    overlayRafId = requestAnimationFrame(tick)
}

function stopOverlayMonitoring() {
    if (overlayRafId !== null) {
        cancelAnimationFrame(overlayRafId)
        overlayRafId = null
    }
    const video = getVideo()
    if (video) {
        video.removeEventListener('pause', onVideoPause)
        video.removeEventListener('play', onVideoPlay)
    }
}

function onVideoPause() {
    for (const [, cardInfo] of activeOverlayCards) {
        if (cardInfo.timerId) {
            clearTimeout(cardInfo.timerId)
            cardInfo.timerId = null
        }
    }
}

function onVideoPlay() {
    for (const [key, cardInfo] of activeOverlayCards) {
        if (!cardInfo.timerId) {
            const duration = OVERLAY_DISPLAY_DURATION + (cardInfo.staggerIndex * 1000)
            cardInfo.timerId = setTimeout(() => {
                dismissOverlayCard(key)
            }, duration)
        }
    }
}

function showOverlayCard(timeComment, key, staggerIndex = 0) {
    if (isOverlayHidden) return

    const container = getOrCreateOverlayContainer()
    if (!container) return

    const card = document.createElement('div')
    card.classList.add('__youtube-timestamps__overlay-card')

    const authorRow = document.createElement('div')
    authorRow.classList.add('__youtube-timestamps__overlay-card__author')
    card.appendChild(authorRow)

    const avatar = document.createElement('img')
    avatar.classList.add('__youtube-timestamps__overlay-card__avatar')
    avatar.src = timeComment.authorAvatar
    authorRow.appendChild(avatar)

    const name = document.createElement('span')
    name.classList.add('__youtube-timestamps__overlay-card__name')
    name.textContent = timeComment.authorName
    authorRow.appendChild(name)

    const text = document.createElement('div')
    text.classList.add('__youtube-timestamps__overlay-card__text')
    text.appendChild(highlightTextFragment(timeComment.text, timeComment.timestamp))
    card.appendChild(text)

    container.appendChild(card) // Oldest on top (append newest to bottom)

    const video = getVideo()
    const isPaused = video && video.paused

    const duration = OVERLAY_DISPLAY_DURATION + (staggerIndex * 1000)

    const timerId = isPaused ? null : setTimeout(() => {
        dismissOverlayCard(key)
    }, duration)

    activeOverlayCards.set(key, { element: card, timerId, staggerIndex })
}

function dismissOverlayCard(key) {
    const cardInfo = activeOverlayCards.get(key)
    if (!cardInfo) return

    if (cardInfo.timerId) {
        clearTimeout(cardInfo.timerId)
    }

    const card = cardInfo.element
    card.classList.add('dismissing')
    card.addEventListener('transitionend', () => {
        card.remove()
    }, { once: true })

    setTimeout(() => card.remove(), 400)

    activeOverlayCards.delete(key)
}

function removeOverlay() {
    stopOverlayMonitoring()
    for (const [, cardInfo] of activeOverlayCards) {
        if (cardInfo.timerId) clearTimeout(cardInfo.timerId)
    }
    activeOverlayCards.clear()
    overlayShownSet.clear()
    currentTimeComments = []
    lastVideoTime = -1
    const container = document.querySelector('.__youtube-timestamps__overlay')
    if (container) container.remove()
}
