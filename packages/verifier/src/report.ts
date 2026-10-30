/**
 * Gate A run report and acceptance (plan Task 7; spec §10, §19). Verdicts rest on each rung's recorded checks, which the
 * controller fills only from its own observer SQL, the proxy's events and the trusted PostgreSQL log. A status label never
 * overrides its checks: every applicable rung has a fixed set of required named checks with a required evidence kind.
 * A run is VALID only if its own controls worked: every negative control's recorded rung failed its intended check, and the
 * original candidate's forced race showed the duplicate. Only then can a REFERENCE_FIX be accepted.
 */
export type RungStatus = "PASS" | "FAIL" | "FLAKY" | "LIMITATION" | "NOT_APPLICABLE" | "NOT_RUN" | "INFRA_ERROR";
export type RungId = "L0" | "L1" | "L3" | "L4" | "L5" | "L7" | "L9" | "L21" | "L22" | "AUTH";
export const GATE_A_APPLICABLE: readonly RungId[] = ["L0", "L1", "L3", "L4", "L5", "L7", "L9", "L21", "L22", "AUTH"];
export type NcId = "NC1" | "NC2" | "NC3" | "NC6" | "NC7" | "NC8" | "NC9" | "NC10" | "NC12";
export type CheckKind = "independent_state" | "trusted_log" | "shared_logic";
/** `observed` holds the structured facts a check saw (an order count, a claim code), so oracles can require the intended reason. */
export type Observed = Record<string, string | number | boolean | null>;
export type Check = { name: string; kind: CheckKind; ok: boolean; detail: string; observed?: Observed };
export type RungResult = { id: RungId; status: RungStatus; reproduced?: "forced" | "stress_only"; seed?: string; checks: Check[] };
export type NcObservation = "REJECTED_AS_INTENDED" | "REJECTED_OTHERWISE" | "PASSED" | "INFRA_ERROR";
/** `result` is the NC candidate's own run of its intended rung; `observed` must equal what its checks show. */
export type NcResult = { id: NcId; intended: { rung: RungId; check: string }; result: RungResult; observed: NcObservation; detail: string };
export type RunReport = { runId: string; validity: "VALID" | "INVALID"; invalidReasons: string[];
  candidates: Record<"ORIGINAL" | "REFERENCE_FIX", RungResult[]>; negativeControls: NcResult[];
  environment: { candidateNode: string; postgresVersion: string; images: Record<string, string>; controllerNode: string; manifestSha256: string; sourceCommit: string;
    /** Hash of the guard tree that was accepted (manifest.ts subjectTreeSha). */
    subjectSha256?: string; manifestAnchor?: string };
  limitations: string[] };

const S = "independent_state", T = "trusted_log";
/** The checks every applicable rung must record (plan Task 10 rung table), each with the evidence kind it must come from. */
export const REQUIRED_CHECKS: Readonly<Record<RungId, Readonly<Record<string, CheckKind>>>> = {
  L0: { candidate_node: T, packages_typecheck: T, offline_tests: T, control_api_unreachable: T, templates_unreachable: T, guard_constructs: S },
  L1: { one_matching_order: S, obligations_backed_by_orders: S, claim_corroborated: S, oracle_not_probed: T },
  L3: { "one_matching_order:SYN-INT-1": S, "reuse_corroborated:SYN-INT-1": S, "one_matching_order:SYN-INT-2": S, "reuse_corroborated:SYN-INT-2": S },
  L4: { "forced:one_matching_order": S, "forced:outcomes_corroborated": S, "stress:one_matching_order": S },
  L5: { crashed_call_left_nothing: S, issuance_evidence_present: S, intent_unresolved_until_recovery: S, recovery_not_committed_established: S, retry_one_matching_order: S },
  L7: { "one_matching_order:SYN-INT-1": S, "one_matching_order:SYN-INT-2": S },
  L9: { conflict_primary: S, orders_unchanged_primary: S, conflict_fingerprints: S, conflict_secondary: S, no_claim_secondary_capture: S },
  L21: { "a:committed_from_marker": S, "a:one_order": S, "b:not_committed_established": S, "b:retry_one_order": S, "c:still_unknown_while_held": S,
    "c:resolved_after_release": S, "d:still_unknown_paused": S, "e:issuance_committed": S, "f:still_unknown_after_restart": S, never_two_orders: S },
  L22: { event_ids_distinct: S, installations_correct: S },
  AUTH: { test_authority_rejected: S, audit_evidence_present: S, live_guard_refused: S },
};

/**
 * The oracle each negative control must trip (plan Task 10 table), and the facts it must observe when it does (review CP3 B2):
 * failing the intended check for any other reason, an infrastructure fault included, doesn't count.
 */
export const NC_INTENDED: Readonly<Record<NcId, { rung: RungId; check: string; expect: Observed }>> = {
  NC1: { rung: "L3", check: "one_matching_order:SYN-INT-1", expect: { orders: 2 } },
  NC2: { rung: "L1", check: "one_matching_order", expect: { orders: 0 } },
  NC3: { rung: "L3", check: "one_matching_order:SYN-INT-1", expect: { orders: 2 } },
  NC6: { rung: "L7", check: "one_matching_order:SYN-INT-2", expect: { orders: 0, claimCode: "BINDING_MISMATCH" } },
  NC7: { rung: "L1", check: "oracle_not_probed", expect: { probed: true } },
  NC8: { rung: "L1", check: "obligations_backed_by_orders", expect: { unbacked: 1 } },
  NC9: { rung: "L1", check: "one_matching_order", expect: { orders: 0, claimCode: "STATEMENT_POSTCONDITION" } },
  NC10: { rung: "L0", check: "guard_constructs", expect: { claimCode: "DATA_MODIFYING_CTE" } },
  NC12: { rung: "L1", check: "one_matching_order", expect: { orders: 0 } },
};

export const SUPPORTED_CANDIDATE_NODE = "v22.18.0";
const ORIGINAL_RACE_CHECK = "forced:one_matching_order";

/** A rung's label must agree with its checks: PASS needs checks and no failure; FAIL needs at least one failed check. */
function contradictions(label: string, x: RungResult): string[] {
  if ((x.status === "PASS" || x.status === "FAIL") && x.checks.length === 0) return [`${label} ${x.id}: no checks recorded for ${x.status}`];
  if (x.status === "PASS") return x.checks.filter(c => !c.ok).map(c => `${label} ${x.id}: PASS contradicts failed check ${c.name}`);
  if (x.status === "FAIL" && x.checks.every(c => c.ok)) return [`${label} ${x.id}: FAIL with no failed check`];
  return [];
}
/** Each required check for the rung appears exactly once with its required kind. */
function missingRequired(label: string, x: RungResult): string[] {
  const out: string[] = [];
  for (const [name, kind] of Object.entries(REQUIRED_CHECKS[x.id])) {
    const found = x.checks.filter(c => c.name === name);
    if (found.length === 0) out.push(`${label} ${x.id}: required check ${name} missing`);
    else if (found.length > 1) out.push(`${label} ${x.id}: required check ${name} appears ${found.length} times`);
    else if (found[0]!.kind !== kind) out.push(`${label} ${x.id}: ${name} has kind ${found[0]!.kind}, requires ${kind}`);
  }
  return out;
}

/** What an NC's own recorded checks show, independent of any label it was given. */
export function deriveNcObservation(n: NcResult): NcObservation {
  const want = NC_INTENDED[n.id], r = n.result;
  if (!r || r.id !== want.rung) return "REJECTED_OTHERWISE";
  if (r.status === "INFRA_ERROR") return "INFRA_ERROR";
  if (r.status !== "FAIL" && r.status !== "PASS") return "REJECTED_OTHERWISE";
  if (r.checks.length === 0) return "REJECTED_OTHERWISE";
  const intended = r.checks.filter(c => c.name === want.check);
  const c = intended[0];
  if (r.status === "FAIL" && intended.length === 1 && c && !c.ok && c.kind === REQUIRED_CHECKS[want.rung][want.check]
    && Object.entries(want.expect).every(([k, v]) => c.observed?.[k] === v)) return "REJECTED_AS_INTENDED";
  if (r.status !== "PASS" || r.checks.some(c => !c.ok)) return "REJECTED_OTHERWISE";
  return "PASSED";
}

/** Validity is recomputed from the report's content; the controller may add reasons (e.g. manifest drift) but never remove them. */
export function evaluate(r: RunReport): { validity: "VALID" | "INVALID"; invalidReasons: string[] } {
  const reasons = [...r.invalidReasons];
  for (const id of Object.keys(NC_INTENDED) as NcId[]) {
    const found = r.negativeControls.filter(n => n.id === id);
    const want = NC_INTENDED[id];
    if (found.length !== 1) { reasons.push(`${id}: expected exactly one result, found ${found.length}`); continue; }
    const nc = found[0]!;
    if (nc.intended.rung !== want.rung || nc.intended.check !== want.check)
      reasons.push(`${id}: intended oracle ${nc.intended.rung}/${nc.intended.check} differs from ${want.rung}/${want.check}`);
    const derived = deriveNcObservation(nc);
    if (derived !== nc.observed) reasons.push(`${id}: its checks show ${derived}, but it was recorded as ${nc.observed}`);
    if (derived !== "REJECTED_AS_INTENDED" || nc.observed !== "REJECTED_AS_INTENDED")
      reasons.push(`${id}: observed ${derived}, not REJECTED_AS_INTENDED (${nc.detail})`);
    reasons.push(...contradictions(id, nc.result));
  }
  for (const [candidate, rungs] of Object.entries(r.candidates))
    for (const x of rungs) {
      reasons.push(...contradictions(candidate, x));
      if (x.status === "LIMITATION") reasons.push(`${candidate} ${x.id}: LIMITATION is not allowed in Gate A`);
    }
  // The positive control must show the duplicate itself: two orders for the intent, both corroborated (review CP3 B2).
  const originalL4 = r.candidates.ORIGINAL.filter(x => x.id === "L4");
  const race = originalL4[0]?.checks.filter(c => c.name === ORIGINAL_RACE_CHECK) ?? [];
  const outcomes = originalL4[0]?.checks.filter(c => c.name === "forced:outcomes_corroborated") ?? [];
  if (originalL4.length !== 1 || originalL4[0]!.status !== "FAIL" || originalL4[0]!.reproduced !== "forced"
    || race.length !== 1 || race[0]!.ok || race[0]!.kind !== "independent_state" || race[0]!.observed?.orders !== 2
    || outcomes.length !== 1 || !outcomes[0]!.ok)
    reasons.push(`ORIGINAL L4: the race must be reproduced by forced interleaving: ${ORIGINAL_RACE_CHECK} must fail on independent state with 2 orders, `
      + "and both outcomes must be corroborated");
  if (r.environment.candidateNode !== SUPPORTED_CANDIDATE_NODE)
    reasons.push(`candidate Node ${r.environment.candidateNode} is not the supported ${SUPPORTED_CANDIDATE_NODE}`);
  if (!/^18\./.test(r.environment.postgresVersion)) reasons.push(`PostgreSQL ${r.environment.postgresVersion} is not 18.x`);
  return { validity: reasons.length ? "INVALID" : "VALID", invalidReasons: reasons };
}

/**
 * A REFERENCE_FIX is accepted only if the run is VALID, it ran against the expected manifest, and every applicable rung is
 * present once with PASS and every required check present once, from the required kind of evidence, and passing.
 */
export function accept(r: RunReport, o: { expectedManifestSha256: string }): { accepted: boolean; reasons: string[] } {
  const reasons = [...evaluate(r).invalidReasons];
  if (!o.expectedManifestSha256 || r.environment.manifestSha256 !== o.expectedManifestSha256)
    reasons.push(`manifest ${r.environment.manifestSha256} differs from the expected ${o.expectedManifestSha256 || "(none given)"}`);
  for (const id of GATE_A_APPLICABLE) {
    const found = r.candidates.REFERENCE_FIX.filter(x => x.id === id);
    if (found.length !== 1) { reasons.push(`REFERENCE_FIX ${id}: expected exactly one result, found ${found.length}`); continue; }
    const x = found[0]!;
    if (x.status !== "PASS") reasons.push(`REFERENCE_FIX ${id}: ${x.status}`);
    reasons.push(...missingRequired("REFERENCE_FIX", x));
    for (const c of x.checks) if (Object.hasOwn(REQUIRED_CHECKS[id], c.name) && !c.ok) reasons.push(`REFERENCE_FIX ${id}: required check ${c.name} failed`);
  }
  return { accepted: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/**
 * Compares two runs' forced outcomes: per candidate and rung, the status, reproduction and each named check's result; per NC,
 * the observation its checks show. Seeds, timings and details are ignored.
 */
export function compareForced(a: RunReport, b: RunReport): { same: boolean; differences: string[] } {
  const differences: string[] = [];
  const label = (x: RungResult | undefined) => x ? `${x.status}${x.reproduced ? `/${x.reproduced}` : ""}` : "absent";
  const compareChecks = (where: string, x: RungResult | undefined, y: RungResult | undefined) => {
    const names = new Set([...(x?.checks ?? []), ...(y?.checks ?? [])].map(c => c.name));
    for (const name of names) {
      const cx = x?.checks.find(c => c.name === name), cy = y?.checks.find(c => c.name === name);
      const fx = cx ? String(cx.ok) : "absent", fy = cy ? String(cy.ok) : "absent";
      if (fx !== fy) differences.push(`${where} ${name}: ${fx} vs ${fy}`);
    }
  };
  for (const candidate of ["ORIGINAL", "REFERENCE_FIX"] as const) {
    const ids = new Set([...a.candidates[candidate], ...b.candidates[candidate]].map(x => x.id));
    for (const id of ids) {
      const x = a.candidates[candidate].find(r => r.id === id), y = b.candidates[candidate].find(r => r.id === id);
      if (label(x) !== label(y)) differences.push(`${candidate} ${id}: ${label(x)} vs ${label(y)}`);
      compareChecks(`${candidate} ${id}`, x, y);
    }
  }
  const ncs = new Set([...a.negativeControls, ...b.negativeControls].map(n => n.id));
  for (const id of ncs) {
    const x = a.negativeControls.find(n => n.id === id), y = b.negativeControls.find(n => n.id === id);
    const ox = x ? deriveNcObservation(x) : "absent", oy = y ? deriveNcObservation(y) : "absent";
    if (ox !== oy) differences.push(`${id}: ${ox} vs ${oy}`);
  }
  return { same: differences.length === 0, differences };
}

/** Single-run/filtered development checks cannot qualify Gate A. Every requested repeat must agree with the first. */
export function qualification(reports: RunReport[], o: { expectedManifestSha256: string; requestedRuns: number; filtered: boolean }) {
  const partial = o.filtered || o.requestedRuns < 2;
  const differences: string[] = [];
  const reasons: string[] = [];
  if (!Number.isInteger(o.requestedRuns) || o.requestedRuns < 2) reasons.push("Gate A requires at least two fresh runs");
  if (reports.length !== o.requestedRuns) reasons.push(`expected ${o.requestedRuns} reports, received ${reports.length}`);
  if (reports.length < 2) differences.push("fewer than two reports; repetition was not established");
  for (let i = 1; i < reports.length; i++)
    differences.push(...compareForced(reports[0]!, reports[i]!).differences.map(d => `run ${i + 1} vs run 1: ${d}`));
  if (o.filtered) reasons.push("filtered run is development evidence only");
  const acceptance = reports.map(r => accept(r, { expectedManifestSha256: o.expectedManifestSha256 }));
  const comparison = { same: differences.length === 0, differences };
  return { partial, qualifying: !partial && reasons.length === 0 && comparison.same && acceptance.every(a => a.accepted),
    comparison, acceptance, reasons };
}
