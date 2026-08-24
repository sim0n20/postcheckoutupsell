import test from "node:test";import assert from "node:assert/strict";
function clean(v){return String(v??"").normalize("NFC").trim()}
function validate(fields,values){const out={};for(const f of fields){if(f.type==="TEXT"){const v=clean(values[f.key]),len=Array.from(v).length;if(f.required&&!v)return{ok:false};if(f.maxLength&&len>f.maxLength)return{ok:false};out[f.key]=v}else if(f.type==="SELECT"){const v=clean(values[f.key]);if(f.required&&!v)return{ok:false};if(v&&f.options&&!f.options.includes(v))return{ok:false};out[f.key]=v}else if(f.type==="CHECKBOX")out[f.key]=Boolean(values[f.key])}return{ok:true,value:out}}
test("trims and preserves Unicode",()=>assert.deepEqual(validate([{key:"name",type:"TEXT",required:true,maxLength:20}],{name:"  José  "}),{ok:true,value:{name:"José"}}));
test("rejects blank required field",()=>assert.equal(validate([{key:"name",type:"TEXT",required:true}],{name:"  "}).ok,false));
test("rejects overlength by code points",()=>assert.equal(validate([{key:"name",type:"TEXT",required:true,maxLength:2}],{name:"abc"}).ok,false));
test("validates select choices",()=>assert.equal(validate([{key:"font",type:"SELECT",required:true,options:["Serif"]}],{font:"Other"}).ok,false));
test("coerces checkbox",()=>assert.equal(validate([{key:"gift",type:"CHECKBOX"}],{gift:1}).value.gift,true));
