// Darktide draws the picture through the portrait frame's icon slot, which
// only uses the colour channels, so any transparency comes out as whatever
// colour the transparent pixels store. Cloudflare's resizing returns a palette
// PNG (PNG8) whose transparent pixels are green, and anti-aliased edges would
// be drawn at full colour. Blending every pixel onto a solid background first
// gives the game an opaque image that looks the same as intended.

export type Rgb = [number, number, number]

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const COLOR_TYPE_RGB = 2
const COLOR_TYPE_PALETTE = 3
const COLOR_TYPE_RGBA = 6

interface Chunk {
  type: string
  data: Uint8Array
}

// Blends 8-bit palette and RGBA PNGs onto `background` and returns an opaque
// RGB PNG. Anything else (interlaced, 16-bit, greyscale, already opaque) is
// returned unchanged.
export async function flattenPng(
  png: Uint8Array,
  background: Rgb,
): Promise<Uint8Array> {
  const chunks = readChunks(png)
  const header = chunks?.find((chunk) => chunk.type === 'IHDR')?.data

  if (!chunks || !header || header.length !== 13) {
    return png
  }

  const view = new DataView(header.buffer, header.byteOffset, header.length)
  const width = view.getUint32(0)
  const height = view.getUint32(4)
  const bitDepth = header[8]
  const colorType = header[9]
  const interlace = header[12]
  const isPalette = colorType === COLOR_TYPE_PALETTE && bitDepth <= 8
  const isRgba = colorType === COLOR_TYPE_RGBA && bitDepth === 8

  if (!(isPalette || isRgba) || interlace !== 0) {
    return png
  }

  const palette = chunks.find((chunk) => chunk.type === 'PLTE')?.data
  const alphas = chunks.find((chunk) => chunk.type === 'tRNS')?.data

  if (isPalette && !palette) {
    throw new Error('Palette PNG without a PLTE chunk')
  }

  const bytesPerPixel = isRgba ? 4 : 1
  const rowBytes = isRgba ? width * 4 : Math.ceil((width * bitDepth) / 8)
  const pixels = unfilter(
    await transform(
      concat(
        chunks.filter((chunk) => chunk.type === 'IDAT').map((c) => c.data),
      ),
      new DecompressionStream('deflate'),
    ),
    rowBytes,
    height,
    bytesPerPixel,
  )

  // Every row starts with filter type 0 (none)
  const rgbRowBytes = width * 3 + 1
  const rgb = new Uint8Array(rgbRowBytes * height)
  const mask = (1 << bitDepth) - 1
  const [backgroundRed, backgroundGreen, backgroundBlue] = background

  for (let y = 0; y < height; y++) {
    const row = y * rowBytes
    let offset = y * rgbRowBytes + 1

    for (let x = 0; x < width; x++) {
      let red: number, green: number, blue: number, alpha: number

      if (isRgba) {
        const pixel = row + x * 4

        red = pixels[pixel]
        green = pixels[pixel + 1]
        blue = pixels[pixel + 2]
        alpha = pixels[pixel + 3]
      } else {
        const bit = x * bitDepth
        const index =
          (pixels[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & mask
        const colour = index * 3

        red = palette![colour] ?? 0
        green = palette![colour + 1] ?? 0
        blue = palette![colour + 2] ?? 0
        alpha = alphas && index < alphas.length ? alphas[index] : 255
      }

      rgb[offset++] = blend(red, backgroundRed, alpha)
      rgb[offset++] = blend(green, backgroundGreen, alpha)
      rgb[offset++] = blend(blue, backgroundBlue, alpha)
    }
  }

  const rgbHeader = new Uint8Array(13)
  const rgbView = new DataView(rgbHeader.buffer)

  rgbView.setUint32(0, width)
  rgbView.setUint32(4, height)
  rgbHeader[8] = 8
  rgbHeader[9] = COLOR_TYPE_RGB

  return concat([
    SIGNATURE,
    writeChunk('IHDR', rgbHeader),
    writeChunk('IDAT', await transform(rgb, new CompressionStream('deflate'))),
    writeChunk('IEND', new Uint8Array(0)),
  ])
}

function blend(value: number, background: number, alpha: number) {
  return Math.round((value * alpha + background * (255 - alpha)) / 255)
}

function readChunks(png: Uint8Array): Chunk[] | null {
  if (png.length < SIGNATURE.length || SIGNATURE.some((b, i) => png[i] !== b)) {
    return null
  }

  const view = new DataView(png.buffer, png.byteOffset, png.length)
  const chunks: Chunk[] = []
  let offset = SIGNATURE.length

  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset)
    const start = offset + 8
    const end = start + length

    if (end + 4 > png.length) {
      return null
    }

    const type = String.fromCharCode(...png.subarray(offset + 4, start))

    chunks.push({ type, data: png.subarray(start, end) })
    offset = end + 4 // Skip the CRC

    if (type === 'IEND') {
      break
    }
  }

  return chunks
}

// Reverses the per-row filters. The Sub, Average and Paeth filters look at the
// byte one pixel to the left, which is a whole byte back even for palette
// pixels smaller than a byte.
function unfilter(
  data: Uint8Array,
  rowBytes: number,
  height: number,
  bytesPerPixel: number,
) {
  if (data.length < (rowBytes + 1) * height) {
    throw new Error('Truncated PNG image data')
  }

  const out = new Uint8Array(rowBytes * height)

  for (let y = 0; y < height; y++) {
    const filter = data[y * (rowBytes + 1)]
    const source = y * (rowBytes + 1) + 1
    const row = y * rowBytes
    const previousRow = row - rowBytes

    for (let x = 0; x < rowBytes; x++) {
      const hasLeft = x >= bytesPerPixel
      const left = hasLeft ? out[row + x - bytesPerPixel] : 0
      const up = y > 0 ? out[previousRow + x] : 0
      const upLeft = hasLeft && y > 0 ? out[previousRow + x - bytesPerPixel] : 0
      const value = data[source + x]

      switch (filter) {
        case 0:
          out[row + x] = value
          break
        case 1:
          out[row + x] = value + left
          break
        case 2:
          out[row + x] = value + up
          break
        case 3:
          out[row + x] = value + ((left + up) >> 1)
          break
        case 4:
          out[row + x] = value + paeth(left, up, upLeft)
          break
        default:
          throw new Error(`Unknown PNG filter type ${filter}`)
      }
    }
  }

  return out
}

function paeth(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)

  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left
  }

  return toUp <= toUpLeft ? up : upLeft
}

async function transform(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const output = new Response(data).body!.pipeThrough(stream)

  return new Uint8Array(await new Response(output).arrayBuffer())
}

function writeChunk(type: string, data: Uint8Array) {
  const chunk = new Uint8Array(data.length + 12)
  const view = new DataView(chunk.buffer)

  view.setUint32(0, data.length)

  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i)
  }

  chunk.set(data, 8)
  view.setUint32(data.length + 8, crc32(chunk.subarray(4, data.length + 8)))

  return chunk
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0

  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }

  return out
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let n = 0; n < 256; n++) {
    let c = n

    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }

    table[n] = c >>> 0
  }

  return table
})()

function crc32(data: Uint8Array) {
  let crc = 0xffffffff

  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}
