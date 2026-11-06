export type Diagnosis="RACE"|"CROSS_PATH"|"IDENTITY"|"RETRY"|"CLEAN"|"ABSTAIN";
export type Detection={status:"ANALYZED"|"PARSER_FAILURE"|"UNSCORABLE";diagnoses:Diagnosis[];evidenceLines:number[];sharedIdentity:string;explanation:string;edit:{before:string;after:string}|null};
type Token={value:string;start:number;end:number};
/** Bounded lexical subset, not a TypeScript compiler/parser. Unsupported templates/regex abstain. */
function lex(source:string):Token[]{
  if(Buffer.byteLength(source)>12000)throw Error("SOURCE_LIMIT");const out:Token[]=[];let i=0;
  while(i<source.length){
    const c=source[i]!;if(/\s/.test(c)){i++;continue;}
    if(source.startsWith("//",i)){while(i<source.length&&source[i]!=="\n")i++;continue;}
    if(source.startsWith("/*",i)){const end=source.indexOf("*/",i+2);if(end<0)throw SyntaxError("UNCLOSED_COMMENT");i=end+2;continue;}
    const start=i;
    if(c==="'"||c==='"'){const quote=c;i++;let closed=false;while(i<source.length){if(source[i]==="\\"){i+=2;continue;}if(source[i]===quote){i++;closed=true;break;}if(source[i]==="\n")throw SyntaxError("UNCLOSED_STRING");i++;}if(!closed)throw SyntaxError("UNCLOSED_STRING");}
    else if(c==='`'||c==="/")throw Error("UNSUPPORTED_LEXICAL_SYNTAX");
    else if(/[A-Za-z_$]/.test(c)){i++;while(i<source.length&&/[A-Za-z0-9_$]/.test(source[i]!))i++;}
    else if(/[0-9]/.test(c)){i++;while(i<source.length&&/[0-9.]/.test(source[i]!))i++;}
    else if("{}()[];,.=:+-*!<>?&|%".includes(c)){i++;if(["=>","==","!=","<=",">=","&&","||","?.","++","--"].includes(source.slice(start,i+1)))i++;}
    else throw Error("UNSUPPORTED_LEXICAL_SYNTAX");
    out.push({value:source.slice(start,i),start,end:i});if(out.length>2000)throw Error("TOKEN_LIMIT");
  }
  const stack:string[]=[];for(const token of out){if(["(","{","["].includes(token.value))stack.push(token.value);if([")","}","]"].includes(token.value)){if(stack.pop()!==({")":"(","}":"{","]":"["} as Record<string,string>)[token.value])throw SyntaxError("UNBALANCED_DELIMITER");}}
  if(stack.length)throw SyntaxError("UNBALANCED_DELIMITER");return out;
}
export const tokens=(source:string)=>lex(source).map(token=>token.value);
/** General token/dataflow heuristics; no fixture imports, hashes, IDs or exact-body lookup. */
export function detectAndPropose(source:string):Detection {
  const empty=(status:Detection["status"],explanation:string):Detection=>({status,diagnoses:["ABSTAIN"],evidenceLines:[1],sharedIdentity:"Not established from supplied source",explanation,edit:null});
  let t:Token[];try{t=lex(source);}catch(error){return empty(error instanceof SyntaxError?"PARSER_FAILURE":"UNSCORABLE",error instanceof Error?error.message:"LEXICAL_FAILURE");}
  // Matching different delimiter types is checked by lex(); count only the requested pair here.
  const matchClose=(start:number)=>{const open=t[start]?.value,expected=({"(":")","{":"}","[":"]"} as Record<string,string>)[open??""];let depth=0;for(let j=start;j<t.length;j++){if(t[j]!.value===open)depth++;else if(t[j]!.value===expected){depth--;if(depth===0)return j;}}return-1;};
  const functions:Array<{start:number;end:number;body:number;params:string[]}>=[];
  for(let j=0;j<t.length;j++)if(t[j]!.value==="function"){
    if(!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t[j+1]?.value??"")||t[j+2]?.value!=="(")return empty("PARSER_FAILURE","Unsupported or malformed function declaration.");
    const paramsEnd=matchClose(j+2),body=paramsEnd+1;if(t[body]?.value!=="{")return empty("UNSCORABLE","Function syntax exceeds lexical subset.");
    functions.push({start:j,end:matchClose(body),body,params:t.slice(j+3,paramsEnd).filter(token=>token.value!==",").map(token=>token.value)});
  }
  const owner=(index:number)=>functions.filter(fn=>fn.body<index&&index<fn.end).sort((a,b)=>(a.end-a.body)-(b.end-b.body))[0];
  const calls:Array<{receiver:string;method:string;index:number;end:number;args:string[];awaited:boolean}>=[];
  for(let j=0;j<t.length-3;j++)if(/^[A-Za-z_$]/.test(t[j]!.value)&&t[j+1]!.value==="."&&t[j+3]!.value==="("){
    const end=matchClose(j+3);if(end<0)return empty("PARSER_FAILURE","Malformed call.");
    const args:string[]=[];let arg="",depth=0;for(const token of t.slice(j+4,end)){if(token.value===","&&depth===0){args.push(arg);arg="";continue;}arg+=token.value;if(["(","{","["].includes(token.value))depth++;if([")","}","]"].includes(token.value))depth--;}if(arg)args.push(arg);
    calls.push({receiver:t[j]!.value,method:t[j+2]!.value,index:j,end,args,awaited:t[j-1]?.value==="await"});
  }
  const diagnoses=new Set<Diagnosis>(),lines=new Set<number>(),identities=new Set<string>();let edit:Detection["edit"]=null;
  for(const insert of calls.filter(call=>/^(insert|insertOrder|saveOrder)$/.test(call.method))){
    const fn=owner(insert.index);if(!fn)continue;
    const bodyTokens=t.slice(fn.body+1,fn.end).map(token=>token.value);
    if(bodyTokens.some(value=>/^(transaction|withLock|withTransaction)$/.test(value)))continue;
    const find=calls.find(call=>call.awaited&&/^(find|findOrder|lookup)$/.test(call.method)&&call.receiver===insert.receiver&&call.args[0]===insert.args[0]&&call.index<insert.index&&owner(call.index)===fn);
    const mark=calls.find(call=>/^(mark|markProcessed)$/.test(call.method)&&call.receiver===insert.receiver&&call.index<insert.index&&owner(call.index)===fn);
    if(!find&&!mark)continue;
    if(find){diagnoses.add("RACE");const variable=insert.args[0];let expression="";
      for(let j=fn.body+1;j<insert.index;j++)if(["const","let","var"].includes(t[j]!.value)&&t[j+1]?.value===variable&&t[j+2]?.value==="="){let end=j+3;while(end<insert.index&&t[end]!.value!==";")end++;expression=t.slice(j+3,end).map(token=>token.value).join(" ");}
      if(/\b(path|handler|route)\b/i.test(expression))diagnoses.add("CROSS_PATH");
      if(/\bintent(?:Id|_id)?\b/i.test(expression)&&!/capture/i.test(expression))diagnoses.add("IDENTITY");
      for(const match of expression.matchAll(/\.\s*(captureId|intentId|merchantId|paymentId)\b/g))identities.add(match[1]!);
    }
    if(mark)diagnoses.add("RETRY");
    lines.add(source.slice(0,t[(find??mark)!.index]!.start).split("\n").length);lines.add(source.slice(0,t[insert.index]!.start).split("\n").length);
    if(fn.params.join(",")==="db,payment,path"&&insert.receiver==="db"&&insert.method==="insert"&&insert.args[1]==="payment"){
      edit={before:source.slice(t[fn.body]!.end,t[fn.end]!.start),after:"\n  return db.createOrderOnce(payment, path);\n"};
    }
  }
  if(!diagnoses.size)return empty("ANALYZED","No supported defect is established. External helper names and harmless path variables do not prove safety; abstain.");
  return{status:"ANALYZED",diagnoses:[...diagnoses],evidenceLines:[...lines].slice(0,8),sharedIdentity:identities.size?[...identities].join(", "):"Purchase identity carried through lookup/write arguments; full binding not established",
    explanation:"Bounded lexical dataflow finds an awaited lookup before insertion or a separate marker before insertion. These are candidate mechanisms, conditional on omitted storage semantics. The repair comparator is limited to the reviewed smoke adapter.",edit};
}
