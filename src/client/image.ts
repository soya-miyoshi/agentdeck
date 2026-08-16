// Downscaling before upload, on the phone. Not bandwidth: the model resizes a 4000px photo anyway,
// so the original spends the uplink on pixels nothing will read.

/** The longest edge any model here reads more detail from. Above it, pixels are discarded twice. */
export const MAX_EDGE = 1568;

/** The scaled size, aspect preserved. Never enlarges: a small screenshot is already right. */
export const scaleTo = (
  width: number,
  height: number,
  max = MAX_EDGE,
): { width: number; height: number } => {
  const longest = Math.max(width, height);
  if (longest <= max || longest === 0) return { width, height };
  const ratio = max / longest;
  // Rounded up, so neither edge can land on 0 for a very long thin image.
  return {
    width: Math.max(1, Math.ceil(width * ratio)),
    height: Math.max(1, Math.ceil(height * ratio)),
  };
};

/**
 * A picked file as a PNG no larger than `MAX_EDGE` on its longest edge. PNG because the subject is
 * a terminal screenshot and JPEG rings around small text; it also normalises HEIC.
 */
export const downscale = async (file: Blob): Promise<Blob> => {
  const bitmap = await createImageBitmap(file);
  try {
    const size = scaleTo(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("this browser would not give the page a 2d canvas");
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        // Null here is the browser refusing, not an empty image. Rejecting keeps the caller from
        // uploading zero bytes and getting a 400 that describes the wrong problem.
        if (blob === null) reject(new Error("this browser would not encode the image"));
        else resolve(blob);
      }, "image/png");
    });
  } finally {
    bitmap.close();
  }
};
