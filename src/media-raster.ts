export interface RasterLimits {
  maxDimension: number;
  maxPixels: number;
  maxPngBytes: number;
}

export interface RasterDimensions {
  width: number;
  height: number;
  scale: number;
}

export interface DocumentRasterLimits {
  maxDimension: number;
  maxPixelsPerPage: number;
  maxTotalPixels: number;
  minScale: number;
  maxScale: number;
}

export type RasterPostProcessor = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number
) => void;

/**
 * Reads a fetch response without allowing an untrusted body to grow past the
 * configured mobile-memory budget. A trustworthy Content-Length can reject
 * before the stream is touched; chunked responses are cancelled immediately
 * after the first overflowing chunk.
 */
export async function readResponseBlobWithinLimit(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Blob> {
  const safeMaxBytes = finitePositiveInteger(maxBytes, "maximum response bytes");
  const abortError = (): Error => new Error("Response body read was aborted.");
  if (signal?.aborted) throw abortError();

  const contentLength = response.headers.get("content-length")?.trim() ?? "";
  if (/^\d+$/u.test(contentLength) && BigInt(contentLength) > BigInt(safeMaxBytes)) {
    throw new Error(`Response Content-Length exceeds the safe encoded-size limit (${contentLength} bytes).`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const reader = response.body?.getReader();
  if (!reader) return new Blob([], { type: contentType });

  const chunks: ArrayBuffer[] = [];
  let totalBytes = 0;
  let cancelled = false;
  const cancelReader = async (reason: unknown): Promise<void> => {
    if (cancelled) return;
    cancelled = true;
    try {
      await reader.cancel(reason);
    } catch {
      // The original overflow/abort/read error is more actionable than a
      // secondary network-stream cancellation failure.
    }
  };
  const onAbort = (): void => {
    void cancelReader(abortError());
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("Response body returned a non-byte chunk.");
      }
      totalBytes += value.byteLength;
      if (totalBytes > safeMaxBytes) {
        throw new Error(`Response body exceeds the safe encoded-size limit (${totalBytes} bytes).`);
      }
      // Fetch streams normally provide fresh chunks, but copying prevents a
      // custom stream from mutating a reused backing buffer before Blob copies it.
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy.buffer);
    }
    return new Blob(chunks, { type: contentType });
  } catch (error) {
    // Reader cancellation is advisory. A custom/WebKit stream whose cancel()
    // never settles must not keep a snapshot queue or its timeout alive.
    void cancelReader(error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Fits an image into a bounded canvas without stretching it. The one-pixel
 * minimum is only observable for extremely thin images where an exact integer
 * aspect ratio cannot be represented by a canvas.
 */
export function getSafeRasterDimensions(
  sourceWidth: number,
  sourceHeight: number,
  limits: Pick<RasterLimits, "maxDimension" | "maxPixels">
): RasterDimensions {
  const width = finitePositiveInteger(sourceWidth, "source width");
  const height = finitePositiveInteger(sourceHeight, "source height");
  const maxDimension = finitePositiveInteger(limits.maxDimension, "maximum dimension");
  const maxPixels = finitePositiveInteger(limits.maxPixels, "maximum pixels");
  const scale = Math.min(
    1,
    maxDimension / width,
    maxDimension / height,
    Math.sqrt(maxPixels / width / height)
  );

  let targetWidth = Math.max(1, Math.floor(width * scale));
  let targetHeight = Math.max(1, Math.floor(height * scale));
  if (targetWidth * targetHeight > maxPixels) {
    const correction = Math.sqrt(maxPixels / targetWidth / targetHeight);
    targetWidth = Math.max(1, Math.floor(targetWidth * correction));
    targetHeight = Math.max(1, Math.floor(targetHeight * correction));
  }

  return {
    width: targetWidth,
    height: targetHeight,
    scale: Math.min(targetWidth / width, targetHeight / height)
  };
}

/**
 * Chooses one scale for every page in a PDF. pdf-lib expands each embedded
 * PNG into a retained three-byte RGB buffer, so a per-page canvas limit alone
 * does not protect a long document from exhausting an iOS WebView heap.
 */
export function getSafeDocumentRasterScale(
  sourceWidth: number,
  sourceHeight: number,
  pageCount: number,
  requestedScale: number,
  limits: DocumentRasterLimits
): number {
  const width = finitePositiveNumber(sourceWidth, "source width");
  const height = finitePositiveNumber(sourceHeight, "source height");
  const pages = finitePositiveInteger(pageCount, "page count");
  const maxDimension = finitePositiveInteger(limits.maxDimension, "maximum dimension");
  const maxPixelsPerPage = finitePositiveInteger(limits.maxPixelsPerPage, "maximum pixels per page");
  const maxTotalPixels = finitePositiveInteger(limits.maxTotalPixels, "maximum total pixels");
  const minScale = finitePositiveNumber(limits.minScale, "minimum scale");
  const maxScale = finitePositiveNumber(limits.maxScale, "maximum scale");
  if (minScale > maxScale) throw new RangeError("Minimum raster scale cannot exceed its maximum.");
  const requested = Number.isFinite(requestedScale)
    ? Math.min(maxScale, Math.max(minScale, requestedScale))
    : minScale;
  const continuousScale = Math.min(
    requested,
    maxDimension / width,
    maxDimension / height,
    Math.sqrt(maxPixelsPerPage / width / height),
    Math.sqrt(maxTotalPixels / width / height / pages)
  );
  const fitsIntegerCanvases = (scale: number): boolean => {
    const pixelWidth = Math.max(1, Math.ceil(width * scale));
    const pixelHeight = Math.max(1, Math.ceil(height * scale));
    const pagePixels = pixelWidth * pixelHeight;
    return pixelWidth <= maxDimension && pixelHeight <= maxDimension &&
      pagePixels <= maxPixelsPerPage && pagePixels * pages <= maxTotalPixels;
  };
  if (!Number.isFinite(continuousScale) || continuousScale + 1e-9 < minScale || !fitsIntegerCanvases(minScale)) {
    throw new RangeError("Document exceeds the safe raster-page memory budget.");
  }
  if (fitsIntegerCanvases(continuousScale)) return Math.max(minScale, continuousScale);

  // Canvas dimensions round upward. Tight continuous limits can therefore
  // exceed a pixel cap by one row or column; find the greatest discrete-safe
  // scale without weakening the configured minimum.
  let low = minScale;
  let high = continuousScale;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const middle = (low + high) / 2;
    if (fitsIntegerCanvases(middle)) low = middle;
    else high = middle;
  }
  return low;
}

/**
 * Renders an HTML image through a bounded canvas and asynchronously encodes
 * it. This is shared by the compatibility renderer so rejected DOM snapshots
 * cannot fall back to an unbounded natural-size canvas.
 */
export async function rasterizeImageToPngBytes(
  image: HTMLImageElement,
  limits: RasterLimits,
  postProcess?: RasterPostProcessor
): Promise<Uint8Array> {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const dimensions = getSafeRasterDimensions(sourceWidth, sourceHeight, limits);
  const canvas = image.ownerDocument.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image raster canvas is unavailable.");

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = dimensions.scale < 1 ? "high" : "medium";
  context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
  postProcess?.(context, dimensions.width, dimensions.height);
  return canvasToPngBytes(canvas, limits.maxPngBytes);
}

export async function canvasToPngBlob(
  canvas: HTMLCanvasElement,
  signal?: AbortSignal
): Promise<Blob> {
  if (signal?.aborted) throw new Error("PNG encoding was aborted.");
  return new Promise<Blob>((resolve, reject) => {
    let settled = false;
    const finish = (blob: Blob | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (!blob) reject(new Error("Canvas returned an empty PNG."));
      else resolve(blob);
    };
    const abort = (): void => finish(null, new Error("PNG encoding was aborted."));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      canvas.toBlob((blob) => finish(blob), "image/png");
    } catch (error) {
      finish(null, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function canvasToPngBytes(
  canvas: HTMLCanvasElement,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const safeMaxBytes = finitePositiveInteger(maxBytes, "maximum PNG bytes");
  const blob = await canvasToPngBlob(canvas, signal);
  if (blob.size > safeMaxBytes) {
    throw new Error(`PNG exceeds the safe encoded-size limit (${blob.size} bytes).`);
  }
  if (signal?.aborted) throw new Error("PNG encoding was aborted.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (signal?.aborted) throw new Error("PNG encoding was aborted.");
  if (!hasPngSignature(bytes)) throw new Error("Canvas returned an invalid PNG.");
  return bytes;
}

export function hasPngSignature(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length > signature.length && signature.every((value, index) => bytes[index] === value);
}

function finitePositiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${label}.`);
  return Math.max(1, Math.floor(value));
}

function finitePositiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${label}.`);
  return value;
}
