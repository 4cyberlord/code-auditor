
import {createHash} from "node:crypto";
const records=new Map();
export function referenceKey(language,harness,reference,version){
 return createHash("sha256").update(JSON.stringify([language,harness,reference,version])).digest("hex");
}
export function isReferenceValidated(key,now=Date.now()){
 const until=records.get(key);if(until===undefined)return false;
 if(until<=now){records.delete(key);return false}return true;
}
export function markReferenceValidated(key,now=Date.now()){
 if(records.size>=128)records.delete(records.keys().next().value);
 records.set(key,now+1800000);
}
export function clearReferenceCache(){records.clear()}
