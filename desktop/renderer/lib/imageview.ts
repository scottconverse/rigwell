// Pure zoom/rotate state for the image preview overlay.
export const ZOOM_MIN = 0.1, ZOOM_MAX = 8, ZOOM_STEP = 1.25;
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 1000) / 1000));
export const zoomIn = (z: number) => clampZoom(z * ZOOM_STEP);
export const zoomOut = (z: number) => clampZoom(z / ZOOM_STEP);
export const rotateRight = (deg: number) => (deg + 90) % 360;
export const dataUrl = (a: { mediaType: string; data: string }) => `data:${a.mediaType};base64,${a.data}`;
