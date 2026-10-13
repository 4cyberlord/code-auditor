
export function phaseTimer(now=()=>performance.now()){
 const durations={};const begin=now();let current="",started=begin;
 return {
 enter(phase){const stamp=now();if(current)durations[current]=(durations[current]||0)+Math.max(0,Math.round(stamp-started));current=phase;started=stamp;},
 snapshot(){const out={...durations};if(current)out[current]=(out[current]||0)+Math.max(0,Math.round(now()-started));out.totalMs=Math.max(0,Math.round(now()-begin));return out;}
 };
}
