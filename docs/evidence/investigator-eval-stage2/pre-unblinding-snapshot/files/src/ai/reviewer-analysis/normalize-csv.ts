/** Optional, audited format-only preparation BEFORE unblinding. Never edits a
 * reviewer return. Only overflow in a final free-text note may be rejoined;
 * identity and scoring columns cannot be supplied, moved, inferred or changed. */
import { parseCsv,STAGE1_HEADER,STAGE2_HEADER,TRANSITION_HEADER } from "./adapter.ts";
const headers=[STAGE1_HEADER,STAGE2_HEADER,TRANSITION_HEADER];
const matches=(a:readonly string[],b:readonly string[])=>a.length===b.length&&a.every((x,i)=>x===b[i]);
const escape=(s:string)=>/[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;
function validPrefix(row: string[],header: string[]) {
  const value=(i:number)=>row[i]?.trim().toLowerCase()??"";
  if(!value(0))return false;
  if(matches(header,STAGE2_HEADER))return /^Q(?:0[1-9]|1[0-6])$/.test(row[1]??"")&&["X","Y","Z"].includes(row[2]??"")
    &&["correct","partially correct","partial","incorrect","incorrect (no answer)","unresolved"].includes(value(3))
    &&["yes","no","unresolved"].includes(value(4))
    &&["handled","not handled","not handled (no answer)","n/a","unresolved"].includes(value(5));
  if(matches(header,TRANSITION_HEADER))return /^T[1-4]$/.test(row[1]??"")&&["P","S","T"].includes(row[2]??"")&&["yes","partly","no","unresolved"].includes(value(3));
  return false;
}
export function normalizeTrailingNotes(input:string) {
  const rows=parseCsv(input);let header: string[]|undefined;
  const changes:Array<{row:number;identity:string[];extraColumns:number;note:string}>=[];
  const scoringBefore:string[][]=[];
  const output=rows.map((row,i)=>{
    const next=headers.find(h=>matches(row,h));
    if(next){header=next;return row;}
    if(!header)throw new Error("Missing recognized header before review data");
    if(row.length<header.length)throw new Error("Missing columns cannot be normalized");
    const finalName=header.at(-1);
    if(row.length>header.length&&finalName!=="note")throw new Error("Only a final free-text note can absorb overflow");
    if(row.length>header.length&&!validPrefix(row,header))throw new Error("Ambiguous overflow: invalid fixed identity or scoring fields");
    const prefix=row.slice(0,header.length-1);scoringBefore.push(prefix);
    if(row.length===header.length)return row;
    const note=row.slice(header.length-1).join(",");
    changes.push({row:i+1,identity:row.slice(0,3),extraColumns:row.length-header.length,note});
    return [...prefix,note];
  });
  const csv=output.map(row=>row.map(escape).join(",")).join("\n")+"\n";
  // Independent serialization round-trip: protect every pre-note byte value.
  let parsedHeader:string[]|undefined;const scoringAfter:string[][]=[];
  for(const row of parseCsv(csv)){
    const next=headers.find(h=>matches(row,h));if(next){parsedHeader=next;continue;}
    if(!parsedHeader||row.length!==parsedHeader.length)throw new Error("Normalized CSV failed round-trip");
    scoringAfter.push(row.slice(0,parsedHeader.length-1));
  }
  if(JSON.stringify(scoringAfter)!==JSON.stringify(scoringBefore))throw new Error("Scoring columns changed during normalization");
  return {csv,changes,scoringColumnsPreserved:true as const};
}
