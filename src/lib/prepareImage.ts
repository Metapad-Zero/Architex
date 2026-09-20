import { MAX_BLOCK_BYTES, cidForBytes } from './cid'
import { sniffImageType } from './tokenMetadata'

/**
 * Turns the file a creator picked into the bytes that get pinned.
 *
 * Still images are redrawn onto a canvas no larger than 512px and re-encoded. That keeps every image
 * inside one IPFS block (so its address can be verified by anyone), and it means what is published is
 * pixels our own encoder wrote: the camera's EXIF block, with its GPS position, never leaves the
 * creator's machine, and neither does anything else hidden in the original file. An animated GIF cannot
 * be redrawn without losing its animation, so it is taken as it is when it already fits.
 */
export interface PreparedImage {
  bytes: Uint8Array
  cid: string
  /** A `blob:` URL for the preview. The caller revokes it. */
  previewUrl: string
}

const SIZES = [512, 384, 256] as const
const QUALITIES = [0.9, 0.75] as const

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => (blob ? void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer))) : resolve(undefined)), type, quality)
  })
}

async function finish(bytes: Uint8Array): Promise<PreparedImage> {
  const type = sniffImageType(bytes)
  if (!type) throw new Error('Use a PNG, JPEG, WebP or GIF image.')
  return { bytes, cid: await cidForBytes(bytes), previewUrl: URL.createObjectURL(new Blob([bytes as BlobPart], { type })) }
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const original = new Uint8Array(await file.arrayBuffer())
  const kind = sniffImageType(original)
  if (!kind) throw new Error('Use a PNG, JPEG, WebP or GIF image.')
  if (kind === 'image/gif') {
    if (original.length > MAX_BLOCK_BYTES) throw new Error('GIFs can be up to 256 KB. Try a smaller one, or a still image.')
    return finish(original)
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([original], { type: kind }))
  } catch {
    throw new Error('That image could not be read. Try another file.')
  }
  try {
    for (const size of SIZES) {
      const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('That image could not be read. Try another file.')
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      for (const quality of QUALITIES) {
        // Browsers that cannot write WebP answer with a PNG instead; whichever it is, the bytes are sniffed.
        const bytes = await encode(canvas, 'image/webp', quality)
        if (bytes && bytes.length <= MAX_BLOCK_BYTES && sniffImageType(bytes)) return await finish(bytes)
      }
    }
  } finally {
    bitmap.close()
  }
  throw new Error('That image is too detailed to fit in 256 KB. Try a simpler one.')
}
