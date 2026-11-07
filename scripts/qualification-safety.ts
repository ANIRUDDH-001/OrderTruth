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

/** Test-only target selection: hosted URLs remain forbidden in both modes. */
export function assertPostgresTestTarget(database: Record<string,string | undefined>,runtime: Record<string,string | undefined>): 'managed-local' | 'github-service' {
  const url = new URL(database.DATABASE_URL ?? '');
  const github = runtime.CI === 'true' && runtime.GITHUB_ACTIONS === 'true' && runtime.RUNNER_OS === 'Linux'
    && runtime.GITHUB_REPOSITORY === 'ANIRUDDH-001/OrderTruth';
  const service = github && url.username === 'ordertruth_ci';
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || !(service ? url.port === '55432' : ['55432','55435'].includes(url.port))
    || url.pathname !== '/ordertruth' || url.username !== (service ? 'ordertruth_ci' : 'ordertruth_dev') || !url.password || url.search || url.hash
    || database.PGHOST !== url.hostname || database.PGPORT !== url.port || database.PGDATABASE !== 'ordertruth'
    || database.PGUSER !== url.username || database.PGPASSWORD !== decodeURIComponent(url.password)) {
    throw new Error('Owned disposable PostgreSQL test target required');
  }
  return service ? 'github-service' : 'managed-local';
}
