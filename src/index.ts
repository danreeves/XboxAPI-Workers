import type { IRequest } from 'itty-router'

import { Router, error, html, text } from 'itty-router'
import { type Rgb, flattenPng } from './png'
import { XboxService } from './xbox/service'
import home from './home.html'

export interface Env {
  MS_CLIENT_ID?: string
  MS_CLIENT_SECRET?: string
  WEBHOOK_URL?: string
}

// Gamerpics are served by the Xbox image service, so only its hosts can be
// resized. Anything else would turn /resize into an open image proxy.
const GAMERPIC_HOSTS = new Set([
  'images-eds-ssl.xboxlive.com',
  'images-eds.xboxlive.com',
])
const RESIZE_CANVAS_WIDTH = 90
const RESIZE_CANVAS_HEIGHT = 100
const RESIZE_SIZE_RANGE: [number, number] = [50, RESIZE_CANVAS_WIDTH]
const TRANSPARENT_CANVAS_URL =
  'https://placehold.co/90x100/transparent/transparent.png'
// Black blends into the dark portrait frames best, community feedback preferred
// it over the green the unflattened images used to show
const DEFAULT_RESIZE_BACKGROUND = '000000'

const router = Router()

router
  .get('/', handleHome)
  .get('/auth/redirect', handleAuthRedirect)
  .get('/auth/callback', handleAuthCallback)
  .get('/profiles/search/:name', handleSearchRequest)
  .get('/profiles/:id', handleProfileRequest)
  .get('/resize', handleResizeRequest)
  .get('/robots.txt', () => text('User-agent: *\nAllow: /$\nDisallow: /'))
  .all('*', () => error(404))

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return router.handle(request, env, ctx).catch(async (e: Error) => {
      console.error(e.toString())

      if (typeof env.WEBHOOK_URL === 'string') {
        await fetch(env.WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-type': 'application/json',
          },
          body: JSON.stringify({
            content: `**XboxAPI Workers** An error occurred on ${request.url}: \`${e}\``,
          }),
        })
      }

      return error(500, `Internal server error: ${e}`)
    })
  },
}

async function handleAuthRedirect(request: IRequest, env: Env) {
  if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) {
    return error(503, 'Missing client ID/Secret')
  }

  if (!request.query || !request.query.redirect_uri) {
    return error(400, 'Missing query parameters')
  }

  const url = new URL(request.url)
  const uri = `${url.origin}/auth/callback?source=${request.query.redirect_uri}`

  const params = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    redirect_uri: uri,
    scope: 'XboxLive.signin XboxLive.offline_access',
    response_type: 'code',
    prompt: 'select_account',
  })

  if (request.query.state) {
    params.set('state', request.query.state as string)
  }

  return Response.redirect(
    `https://login.live.com/oauth20_authorize.srf?${params}`,
  )
}

async function handleAuthCallback(request: IRequest, env: Env) {
  if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) {
    return error(502, 'Missing client ID/Secret')
  }

  if (!request.query) {
    return error(400, 'Missing query parameters')
  }

  const url = new URL(request.url)
  const callback = `${url.origin}/auth/callback?source=${request.query.source}`

  const response = await fetch('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      code: request.query.code as string,
      redirect_uri: callback,
    }),
  })

  if (!response.ok) {
    throw new Error(
      `Invalid status from Xbox authorization: ${
        response.status
      } - ${await response.text()}`,
    )
  }

  const json = await response.json<{ access_token: string }>()

  // const params = new URLSearchParams({
  //   code: `access_token:${json.access_token}`,
  // })

  // if (request.query.state) {
  //   params.set('state', request.query.state as string)
  // }

  return Response.json(json)
}

async function handleProfileRequest(request: IRequest, env: Env) {
  const id = request.params?.id

  if (!id || !/^\d+$/.test(id)) {
    return error(400, 'Invalid XUID format')
  }

  const service = await XboxService.create(env)
  const response = await service.getProfileByXuid(id)

  if (!response.profile) {
    return error(404, `User '${id}' not found (${response.info})`)
  }

  return Response.json({ ...response.profile, debug: response.info })
}

async function handleSearchRequest(request: IRequest, env: Env) {
  const name = request.params?.name

  if (!name || name.length > 16 || name.includes('(') || name.includes(')')) {
    return error(400, 'Invalid gamertag format')
  }

  const service = await XboxService.create(env)
  const response = await service.getProfileByGamertag(name)

  if (!response.profile) {
    return error(404, `User '${name}' not found (${response.info})`)
  }

  return Response.json({ ...response.profile, debug: response.info })
}

// Same layout as the Steam profile worker's /resize: a 90x100 PNG with the
// square gamerpic centred at `size` pixels, so it can fill a rectangular
// portrait without being stretched. The portrait frame material ignores
// transparency, so the padding is the `background` colour.
async function handleResizeRequest(request: IRequest) {
  const { searchParams } = new URL(request.url)
  const source = searchParams.get('url')

  if (!source) {
    return error(400, 'Missing image URL')
  }

  let imageUrl: URL

  try {
    imageUrl = new URL(source)
  } catch {
    return error(400, 'Invalid image URL')
  }

  if (
    (imageUrl.protocol !== 'https:' && imageUrl.protocol !== 'http:') ||
    !GAMERPIC_HOSTS.has(imageUrl.hostname) ||
    imageUrl.port !== '' ||
    imageUrl.pathname !== '/image'
  ) {
    return error(400, 'Disallowed image URL')
  }

  const size = parseResizeSize(searchParams.get('size'))

  if (size === null) {
    return error(400, `Invalid size [${RESIZE_SIZE_RANGE.join('-')}]`)
  }

  const background = parseBackground(searchParams.get('background'))

  if (background === null) {
    return error(400, 'Invalid background [RRGGBB]')
  }

  const resized = await fetch(TRANSPARENT_CANVAS_URL, {
    cf: {
      image: {
        width: RESIZE_CANVAS_WIDTH,
        height: RESIZE_CANVAS_HEIGHT,
        format: 'png',
        draw: [
          {
            url: imageUrl.toString(),
            width: size,
            height: size,
            fit: 'contain',
            left: Math.floor((RESIZE_CANVAS_WIDTH - size) / 2),
            top: Math.floor((RESIZE_CANVAS_HEIGHT - size) / 2),
          },
        ],
      },
    },
  })

  if (!resized.ok || resized.headers.get('Content-Type') !== 'image/png') {
    return resized
  }

  const png = new Uint8Array(await resized.arrayBuffer())
  let body: Uint8Array = png

  // A PNG that can't be flattened is still returned as Cloudflare made it
  try {
    body = await flattenPng(png, background)
  } catch (e) {
    console.error(`Failed to flatten the resized image: ${e}`)
  }

  return new Response(body, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control':
        resized.headers.get('Cache-Control') ?? 'public, max-age=86400',
    },
  })
}

function parseResizeSize(value: string | null): number | null {
  if (value === null) {
    return RESIZE_CANVAS_WIDTH
  }

  const size = Number(value)

  if (
    !Number.isInteger(size) ||
    size < RESIZE_SIZE_RANGE[0] ||
    size > RESIZE_SIZE_RANGE[1]
  ) {
    return null
  }

  return size
}

// Six hex digits without a `#`, which would start the URL fragment
function parseBackground(value: string | null): Rgb | null {
  const hex = value ?? DEFAULT_RESIZE_BACKGROUND

  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    return null
  }

  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}

async function handleHome() {
  return html(home.replace('{year}', new Date().getFullYear().toString()))
}
