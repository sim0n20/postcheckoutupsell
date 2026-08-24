export function numericVariantId(value:string){const m=String(value).match(/(\d+)$/); if(!m) throw new Error("Invalid Shopify variant ID"); return Number(m[1]);}
export function shopFromSessionToken(token:Record<string,unknown>){const dest=String(token.dest||token.iss||""); try{return new URL(dest).hostname}catch{return dest.replace(/^https?:\/\//,"").split("/")[0]}}
export function cleanText(v:unknown){return String(v??"").normalize("NFC").trim()}
export function validateFields(fields:any[], values:Record<string,unknown>){
  const out:Record<string,unknown>={};
  for(const f of fields){
    if(f.type==="TEXT"||f.type==="TEXTAREA"){
      const v=cleanText(values?.[f.key]); const len=Array.from(v).length;
      if(f.required&&!v) return {ok:false as const,error:`${f.label} is required.`};
      if(f.minLength&&v&&len<f.minLength) return {ok:false as const,error:`${f.label} must be at least ${f.minLength} characters.`};
      if(f.maxLength&&len>f.maxLength) return {ok:false as const,error:`${f.label} must be no more than ${f.maxLength} characters.`}; out[f.key]=v;
    }else if(f.type==="CHECKBOX") out[f.key]=Boolean(values?.[f.key]);
    else {const v=cleanText(values?.[f.key]); const options=Array.isArray(f.options)?f.options:[]; if(f.required&&!v)return {ok:false as const,error:`${f.label} is required.`}; if(v&&options.length&&!options.includes(v))return {ok:false as const,error:`Invalid ${f.label}.`}; out[f.key]=v;}
  }
  return {ok:true as const,value:out};
}
