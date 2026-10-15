"use client";
import type { CouncilReportSummary } from "@/lib/sessions";

type Port = {
  language?:string; status?:string; code?:string;
  error?:string; run?:{remoteElapsedMs?:number|null; passed?:number; failed?:number};
};
type Published = {
  winner?:string; standing?:string;
  presentation?:{code?:string;language?:string;complexity?:string};
  ports?:Port[];
};
/**
 * The running cloud job may already have a fully verified preferred-language
 * solution. Ports are independently tested and appear when ready, without
 * replacing or hiding that working primary answer.
 */
export function ProgressiveCouncilResult({
  report,processing,
}:{
  report:CouncilReportSummary; processing:boolean;
}){
  const details=report.report as Published;
  const primary=details?.presentation;
  const primaryReady=details?.standing==="verified"&&Boolean(primary?.code);
  const ports=Array.isArray(details?.ports)?details.ports:[];
  if(!primaryReady&&!ports.length)return null;
  return <div className="progressive-verified-result">
    {primaryReady&&<>
      <div className="progressive-result-heading">
        <strong>Verified solution ready</strong>
        <span className="badge" data-tone="good">E2B passed</span>
      </div>
      <p>{primary?.language||"Primary language"} · Candidate {details.winner||report.winner||"?"}</p>
      {primary?.complexity&&<p>Reviewed complexity: {primary.complexity}</p>}
      <details open>
        <summary>Working {primary?.language||"primary"} code</summary>
        <pre className="progressive-result-code">{primary?.code}</pre>
      </details>
    </>}
    {ports.length>0&&<div className="progressive-result-ports">
      <strong>Other language versions</strong>
      <p>{processing?"Translations are still being prepared and tested.":"Language verification finished."}</p>
      {ports.map(port=>{
        const accepted=port.status==="verified"&&Boolean(port.code);
        const rejected=port.status==="failed";
        return <details key={port.language||"unknown"}>
          <summary>
            {port.language||"Unknown language"} — {accepted?"E2B verified":rejected?"Not verified":"Preparing"}
          </summary>
          {accepted
            ? <>
                <pre className="progressive-result-code">{port.code}</pre>
                <p>{port.run?.passed??0} executable tests passed
                  {Number.isFinite(port.run?.remoteElapsedMs)
                    ? " · Measured execution "+port.run?.remoteElapsedMs+" ms":""}
                </p>
              </>
            : rejected?<p>{port.error||"Failed independent verification."}</p>
              :<p>Awaiting independent translation and sandbox tests.</p>}
        </details>;
      })}
      <p className="progressive-result-note">
        Timing measurements across Python, Rust and C++ are not directly comparable without equivalent workloads and controlled benchmarks.
      </p>
    </div>}
  </div>;
}
