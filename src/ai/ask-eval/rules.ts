/**
 * Arm A: deterministic baseline for Ask OrderTruth (docs/ASK_EVAL_PROTOCOL.md §3).
 * Built to be as strong as practical without a model: normalization (shorthand, common Hinglish
 * and Hindi words, conservative typo repair), refusal of action requests and injection, abstention
 * classes, and multi-intent matching that unions facts for compound questions. Tuned only on the
 * implementer's development set (devset.ts), never on the frozen holdout.
 */
import { factIds,type SnapshotId } from "./catalog.ts";
import type { Answer } from "./contract.ts";

const PHRASES: Array<[RegExp,string]> = [[/\bdo baar\b/g,"twice"],[/\bdo bar\b/g,"twice"],[/\bho gaya\b/g,"happened"],[/\bho gya\b/g,"happened"],[/\bpaisa wapas\b/g,"refund"],
  [/\bदो बार\b/gu,"twice"],[/दो बार/gu,"twice"]];
const WORDS: Record<string,string> = { cust: "customer",dbl: "double",dupe: "duplicate",dup: "duplicate",dups: "duplicates",pmt: "payment",pymt: "payment",txn: "transaction",
  ord: "order",pls: "please",plz: "please",u: "you",ur: "your",msg: "message",paisa: "money",paise: "money",kata: "charged",kaata: "charged",kat: "charged",
  kaunsa: "which",konsa: "which",kaun: "which",rakhna: "keep",rakhe: "keep",rakho: "keep",kyun: "why",kyu: "why",kyon: "why",kitne: "how many",kitna: "how much",wapas: "refund",
  "पैसा": "money","पैसे": "money","ऑर्डर": "order","आर्डर": "order","कितने": "how many","कितना": "how much","क्यों": "why","रिफंड": "refund","कौनसा": "which","कौन": "which" };
const VOCAB = ["many","much","payment","payments","paypal","money","charged","charge","charges","twice","double","order","orders","duplicate","duplicates","refund","refunds","refunded",
  "approved","approve","approval","fixed","resolved","created","webhook","idempotency","overlap","overlapped","transaction","customer","buyer","keeping","expire","expires","detected",
  "cancel","capture","captured","shipped","shipping","address","email","phone","receipt","repair","plan","handler","handlers","timing","writes","committed","concurrent","simultaneous",
  "race","condition","deduplication","keys","voided","void","which","where","when","what","again","month","week","tomorrow","future","parcel","package","delivered","tracking",
  "instructions","ignore","previous","please","sandbox","real","test","genuine","amount","deducted","happen","happened","second","first","extra","removed","gone","worked","success",
  "status","changed","touched","affected","reverse","reversed","delete","execute","contact","message"];

// Optimal string alignment distance (Damerau–Levenshtein with adjacent transpositions).
function distance(a: string,b: string) {
  const d = Array.from({ length: a.length+1 },(_,i) => Array.from({ length: b.length+1 },(_,j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i-1] === b[j-1] ? 0 : 1;
    d[i]![j] = Math.min(d[i-1]![j]!+1,d[i]![j-1]!+1,d[i-1]![j-1]!+cost);
    if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1]) d[i]![j] = Math.min(d[i]![j]!,d[i-2]![j-2]!+1);
  }
  return d[a.length]![b.length]!;
}
// Conservative repair: 4-letter words only for swapped letters; 5–7 letters one edit; 8+ two edits; only a unique closest match.
function repair(token: string) {
  if (token.length < 4 || VOCAB.includes(token) || !/^[a-z]+$/.test(token)) return token;
  const limit = token.length >= 8 ? 2 : 1;
  const scored = VOCAB.map(v => ({ v,d: distance(token,v) })).filter(x => x.d <= limit && (token.length > 4 || (x.v.length === 4 && [...token].sort().join("") === [...x.v].sort().join(""))));
  const best = Math.min(...scored.map(x => x.d)),winners = scored.filter(x => x.d === best);
  return winners.length === 1 ? winners[0]!.v : token;
}
export function normalizeQuestion(question: string) {
  let s = question.normalize("NFKC").toLowerCase().replace(/[’']/g,"");
  for (const [rx,to] of PHRASES) s = s.replace(rx,to);
  s = s.replace(/[^\p{L}\p{N}\p{M}_]+/gu," ").trim();
  return s.split(/\s+/).filter(Boolean).map(t => WORDS[t] ?? repair(t)).join(" ");
}

const ACT = "(?:refund|cancel|void|delete|remove|approve|execute|charge|capture|recapture|email|contact|message|ship|send|reverse|mark|close|merge|fix)";
const ACTION = [new RegExp(`^(?:(?:please|kindly|now|just|ok|okay|hey|go ahead and)\\s+)*${ACT}\\b`),new RegExp(`\\b(?:can|could|would|will) you\\s+(?:please\\s+)?${ACT}\\b`),
  new RegExp(`\\b(?:go ahead and|i want you to|i need you to|make sure to|please)\\s+${ACT}\\b`),new RegExp(`\\b${ACT}\\b.*\\bfor me\\b`)];
const INJECTION = /\bignore\b.*\b(?:instructions?|rules|prompt|above|previous|prior)\b|\b(?:system prompt|hidden instructions|jailbreak|pretend you)\b/;
const PERSONAL = /\b(?:email|e mail|phone|address|name|contact details|lives?|living|who is)\b.*\b(?:buyers?|customers?|clients?|person|they|their|his|her)\b|\b(?:buyers?|customers?|clients?)\b.*\b(?:email|e mail|phone|address|name|contact details)\b|\b(?:shipping|ship|deliver(?:ed|y)?) to\b/;
const OTHER = /\b(?:this|last|per) (?:month|week|year|day)\b|\btoday\b|\byesterday\b|\b(?:all|other|every|most) (?:orders|customers|payments|cases|merchants)\b|\bin total\b|\boverall\b|\bhow often\b|\btrends?\b|\bon average\b/;
const FUTURE = /\bwill (?:this|it|that) happen\b|\bhappen again\b|\bin (?:the )?future\b|\btomorrow\b|\bnext time\b|\bgoing forward\b|\bprevent\b|\bavoid (?:this|it)\b/;
const SHIPPING = /\b(?:shipped|shipping|parcel|package|tracking|delivered|delivery|courier|warehouse|dispatch(?:ed)?)\b/;

type Rule = { rx: RegExp; facts: (s: SnapshotId) => string[]; partial?: string };
const PAYMENT_WORD = /\b(?:paid|pay|payment|payments|money|charged|charge|captured|capture|paypal|transaction)\b/;
const RULES: Rule[] = [
  { rx: /\b(?:real|test|testing|sandbox|live|genuine|fake|production)\b/,facts: () => ["PAY_SOURCE","PAY_STATUS"] },
  { rx: /\b(?:charged|charge|paid|pay|payment|money|deducted|billed|capture|captured)\b(?:\s+\S+){0,3}\s+(?:twice|double|again|two times|2 times)\b|\b(?:twice|double|two|2|multiple)\s+(?:\S+\s+)?(?:charged|charges|payments|captures|charge)\b|\bhow many (?:payments|captures|charges)\b/,facts: () => ["PAY_CAPTURE_COUNT","PAY_CAPTURE"] },
  { rx: /\b(?:transaction|capture|paypal|payment|reference)\b(?:\s+\S+){0,2}\s+(?:id|ids|number|reference|ref)\b|\bid\b.*\bpaypal\b/,facts: () => ["PAY_CAPTURE","PAY_STATUS"] },
  { rx: /\bhow much\b|\bamount\b|\bprice\b|\bvalue\b/,facts: () => ["PAY_CAPTURE"] },
  { rx: /\bhow many(?:\s+\S+){0,2}\s+orders?\b|\bnumber of orders\b|\b(?:two|2|multiple|duplicate|extra|second)\s+orders\b|\borders? (?:are|is) there\b/,facts: () => ["ORD_COUNT"] },
  { rx: /\bwhich orders\b|\bwhat orders\b|\border (?:ids?|numbers?)\b|\b(?:list|show)\b.*\borders\b|\bthese orders\b|\bwhich ones\b/,facts: () => ["ORD_A","ORD_B"] },
  { rx: /\b(?:where did|come from|came from|created|create|creating|wrote|written|source|handlers?|which part|which code|path|origin)\b(?=.*\b(?:orders?|duplicate|second|first|each)\b)|\b(?:orders?|duplicate|second|first|each)\b.*\b(?:come from|came from|created|written|handlers?)\b/,facts: () => ["ORD_A","ORD_B"] },
  { rx: /\bwhy\b|\bcause[ds]?\b|\breason\b|\bhow did (?:this|it|that) happen\b|\bwhat happened\b|\bwhat went wrong\b|\bexplain\b/,facts: () => ["KEYS","TIMING","ORD_A","ORD_B"],partial: "Why both handlers wrote an order is not established by the recorded evidence." },
  { rx: /\b(?:race|concurrent|concurrently|simultaneous|simultaneously|same time|overlap|overlapped|overlapping|at once|parallel|timing|how far apart|apart|gap)\b/,facts: () => ["TIMING","TIMING_NOTE"] },
  { rx: /\bwebhook\b.*\b(?:late|delay|delayed|slow|lag|latency)\b|\b(?:late|delayed|slow)\b.*\bwebhook\b/,facts: () => ["TIMING_NOTE","TIMING"],partial: "When PayPal delivered the webhook is not recorded in this case." },
  { rx: /\b(?:idempotency|idempotent|dedup|dedupe|deduplication|key|keys)\b/,facts: () => ["KEYS"] },
  { rx: /\bhow many writes\b|\bwrites? (?:went|go|got)\b|\bcommitted\b|\bdatabase (?:rows?|writes?)\b|\brows?\b/,facts: () => ["WRITES"] },
  { rx: /\b(?:keep|keeping|kept|plan|void|voiding|stays|survives|what will (?:the )?(?:fix|repair|it) do|fix do|repair do|be removed|be cancelled|be canceled)\b/,facts: () => ["PLAN"] },
  { rx: /\b(?:expire|expires|expiry|expiration|deadline|how long|time limit|window)\b/,facts: () => ["PLAN"] },
  { rx: /\b(?:approved|approve|approval|signed off|sign off|authori[sz]ed|authori[sz]e)\b/,facts: () => ["APPROVAL"] },
  { rx: /\b(?:fixed|resolved|done|gone|removed|worked|work|successful|success|succeeded|repaired|still (?:there|active|exists)|cleaned up|sorted)\b/,facts: s => s === "POST" ? ["RECEIPT","ORD_B","ORD_COUNT"] : ["APPROVAL","ORD_COUNT"] },
  { rx: /\b(?:refund|refunded|refunds|reversed|reverse|touch|touched|affect|affected|modify|modified|money back)\b|\bchanged? (?:the )?payment\b/,facts: s => s === "POST" ? ["PAYPAL_UNCHANGED","PAY_CAPTURE","POLICY"] : ["PAY_CAPTURE","POLICY"],
    partial: "A refund made outside OrderTruth after the PayPal observation would not be visible here." },
  { rx: /\bwhat (?:should|do|can) (?:i|we) do\b|\bnext steps?\b|\bwhat now\b|\bwhat next\b|\bnow what\b|\baction needed\b/,facts: s => s === "POST" ? ["RECEIPT"] : ["PLAN","APPROVAL"] },
  { rx: /\b(?:when|what time)\b.*\b(?:detected|detect|found|flagged|noticed|spotted|caught|alerted)\b|\bincident\b|\bviolation\b|\balert\b|\bmismatch\b/,facts: () => ["INCIDENT"] },
];

const answer = (status: Answer["status"],reason: Answer["reason"],ids: string[] = [],unknowns: string[] = []): Answer => ({ status,factIds: ids,hypotheses: [],unknowns,reason });
export function rulesAnswer(question: string,snapshot: SnapshotId): Answer {
  const s = normalizeQuestion(question);
  if (INJECTION.test(s) || ACTION.some(rx => rx.test(s))) return answer("REFUSED","ACTION_REQUEST",["POLICY"]);
  if (PERSONAL.test(s)) return answer("ABSTAINED","PERSONAL_DATA");
  if (OTHER.test(s)) return answer("ABSTAINED","OTHER_CASES");
  if (FUTURE.test(s)) return answer("ABSTAINED","FUTURE");
  if (SHIPPING.test(s)) return answer("ABSTAINED","NOT_IN_EVIDENCE");
  const ids: string[] = [],unknowns: string[] = [];
  for (const rule of RULES) if (rule.rx.test(s)) { ids.push(...rule.facts(snapshot)); if (rule.partial) unknowns.push(rule.partial); }
  if (!ids.length && PAYMENT_WORD.test(s)) ids.push("PAY_CAPTURE","PAY_STATUS");
  if (!ids.length && /\b(?:orders?|duplicates?)\b/.test(s)) ids.push("INCIDENT","ORD_COUNT");
  const available = factIds(snapshot),facts = [...new Set(ids)].filter(id => available.has(id)).slice(0,8);
  if (!facts.length) return answer("ABSTAINED","UNCLEAR");
  const unk = [...new Set(unknowns)].slice(0,3);
  return answer(unk.length ? "PARTIAL" : "ANSWERED","NONE",facts,unk);
}
