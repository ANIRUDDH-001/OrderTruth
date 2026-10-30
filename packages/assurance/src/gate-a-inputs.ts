/** Reviewed historical inputs, independent of the editable publication manifest. New runs need a reviewed pin update. */
export const GATE_A_INPUTS = {
  sourceCommit: "fc85ac3db1388bd84a3a55b8198d9dc3b2ad6c86",
  runId: "gate-a-2026-10-30T15-58-19-399Z",
  verifierManifestSha256: "b9e880ee0970c0bd0fb4bbd63086dc86beab1e179690fb4fe52f594309e44f72",
  subjectSha256: "7bef5fc5e0c5eaa5ac9bdcf16f6fa7c8bca86f5df83637d2e3c80f4e61f70f42",
  reviewEvidenceSha256: "f39cf734ce6da47a744fde1b08bffb775bf69d2054a2f7632695473e2d79a74e",
  raw: {
    report1: "b9e30b8cc40323950768b03caff367feeb14e5ac287e85f819262127cefd44d9",
    report2: "8e312d86103af1cd1a8cd7c4695940954ffcbc9463bd4f4dd4e5d5194c6fce03",
    summary: "23ee9fb1742797aa445855db48ae35482065b437c088ef31fc3430d97638116d",
    cleanup: "f43e787ed824a362e2748770897b5af7cab733944ef84c215d723f3a6dabcefe",
  },
};
export type InputPins = { sourceCommit: string; runId: string; verifierManifestSha256: string; subjectSha256: string; reviewEvidenceSha256: string;
  raw: Record<"report1" | "report2" | "summary" | "cleanup", string> };
