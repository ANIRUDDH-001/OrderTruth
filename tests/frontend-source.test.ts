import {expect,it} from "vitest";
import {frontendSource} from "../scripts/frontend-source.ts";
it("pins a hosted build without .git, refuses unavailable or contradictory source",()=>{
  const sha="a".repeat(40);
  expect(frontendSource({VERCEL:"1",VERCEL_GIT_COMMIT_SHA:sha},null)).toBe(sha);
  expect(frontendSource({VERCEL:"1",ORDERTRUTH_BUILD_SHA:sha},null)).toBe(sha);
  expect(()=>frontendSource({VERCEL:"1"},null)).toThrow();
  expect(()=>frontendSource({VERCEL:"1",VERCEL_GIT_COMMIT_SHA:sha},"b".repeat(40))).toThrow();
  expect(()=>frontendSource({ORDERTRUTH_BUILD_SHA:"untrusted"},null)).toThrow();
});
it("ignores an empty provider SHA but rejects conflicting nonempty identities",()=>{
  const sha="a".repeat(40);
  expect(frontendSource({VERCEL:"1",VERCEL_GIT_COMMIT_SHA:"",ORDERTRUTH_BUILD_SHA:sha},sha)).toBe(sha);
  expect(()=>frontendSource({VERCEL:"1",VERCEL_GIT_COMMIT_SHA:sha,ORDERTRUTH_BUILD_SHA:"b".repeat(40)},null)).toThrow();
  expect(()=>frontendSource({VERCEL:"1",VERCEL_GIT_COMMIT_SHA:"",ORDERTRUTH_BUILD_SHA:""},null)).toThrow();
  expect(()=>frontendSource({VERCEL:"1",VERCEL_GIT_COMMIT_SHA:" ",ORDERTRUTH_BUILD_SHA:sha},null)).toThrow();
});
