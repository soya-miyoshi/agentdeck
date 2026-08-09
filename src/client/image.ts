// Downscaling before upload, on the phone.
//
// Not a bandwidth optimisation. A photo library image is 4000px wide and the model resizes it down
// anyway, so sending the original spends the phone's uplink on pixels nothing will ever read - and
// a screenshot of the deck is legible at this size, which is the whole reason the button exists.

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
 * A picked file as a PNG no larger than `MAX_EDGE` on its longest edge.
 *
 * PNG rather than JPEG because the expected subject is a screenshot of a terminal: JPEG rings
 * around small text, and unreadable text in the image is the one failure this feature cannot
 * survive. It also normalises HEIC, which is what an iPhone hands over from the photo library and
 * which nothing downstream reads.
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
