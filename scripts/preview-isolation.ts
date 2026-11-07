/** Fail closed until an independently qualified isolated preview API exists.
 * Vercel's build system supplies VERCEL_ENV. No env value is a backend URL. */
export function assertDeploymentTarget(env: Record<string,string | undefined>) {
  if ((env.VERCEL || env.VERCEL_ENV) && env.VERCEL_ENV !== 'production') {
    throw new Error('Preview API isolation is not qualified: refusing to package a preview that rewrites to production. Use local qualification.');
  }
}
