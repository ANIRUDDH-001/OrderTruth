/** Explicitly allowlist the public source identity; never expose the environment. */
export function frontendSource(env:Record<string,string|undefined>,localCommit:string|null):string|null {
  const supplied=env.VERCEL_GIT_COMMIT_SHA ?? env.ORDERTRUTH_BUILD_SHA;
  if(supplied && !/^[a-f0-9]{40}$/.test(supplied)) throw new Error("Invalid frontend source identity");
  if(env.VERCEL && !supplied) throw new Error("Hosted frontend build requires an explicit source SHA");
  if(supplied && localCommit && supplied!==localCommit) throw new Error("Frontend build source differs from checkout");
  return supplied??localCommit;
}
