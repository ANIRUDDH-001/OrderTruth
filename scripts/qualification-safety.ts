/** Qualification URLs are deliberately narrower than application configuration. */
export function assertLocalDatabase(value: string): void {
  const url = new URL(value);
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55432'
    || url.pathname !== '/ordertruth' || url.username !== 'ordertruth_dev' || !url.password || url.search || url.hash) {
    throw new Error('Owned loopback qualification database required');
  }
}
export function requestRecord(method: string,route: string,status: number,requestId: string,elapsedMs: number) {
  return { method,route,status,requestId,elapsedMs: Math.round(elapsedMs) };
}
