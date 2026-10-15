"use client";
import type { CouncilReportSummary } from "@/lib/sessions";
import { codeLineDiff } from "@/lib/codeLineDiff";

type Port = {
  language?:string;status?:string;code?:string;
  error?:string;run?:{remoteElapsedMs?:number|null;passed?:number;failed?:number};
};
type EarlySolution = {
  status?:string;letter?:string;model?:string;language?:string;code?:string;
  complexity?:string;passed?:number;failed?:number;
  verification?:string;
  screenedComplexity?:{claimedBound?:string;targetBound?:string|null;reason?:string;disclaimer?:string};
};
type Published = {
  stage?:string;winner?:string;standing?:string;
  provisional?:EarlySolution;
  upgrade?:{changed?:boolean;from?:string;to?:string;reason?:string};
  solutionHistory?:Array<{version?:string;letter?:string;code?:string;at?:string}>;
  presentation?:{code?:string;language?:string;complexity?:string};
  ports?:Port[];
  semanticBlueprint?:{
    sourceLanguage?:string;explanation?:string;brief?:string;
    structure?:{classes?:string[];definitions?:Array<{name:string;parameters:string}>;variables?:string[]};
  };
};

/**
 * The first E2B-passing solution is early *provisional* evidence. Once every
 * Council review/judge finishes, the deterministic gate can replace it with a
 * stronger *final* verified winner. This must never silently overwrite history.
 * Later independently validated Rust/C++/Python versions appear incrementally.
 */
export function ProgressiveCouncilResult({
  report,processing,
}:{
  report:CouncilReportSummary;processing:boolean;
}){
  const details=report.report as unknown as Published;
  const primary=details?.presentation;
  const primaryReady=details?.standing==="verified"&&Boolean(primary?.code);
  const early=details?.provisional;
  const earlyReady=Boolean(early?.code);
  const ports=Array.isArray(details?.ports)?details.ports:[];
  const upgraded=primaryReady&&earlyReady&&Boolean(details.upgrade?.changed);
  const diff=upgraded?codeLineDiff(early?.code||"",primary?.code||""):[];
  if(!primaryReady&&!earlyReady&&!ports.length)return null;

  return <div className="progressive-verified-result">
    {!primaryReady&&earlyReady&&<>
      <div className="progressive-result-heading">
        <strong>Provisional solution available</strong>
        <span className="badge" data-tone="warn">E2B tests passed · Council reviewing</span>
      </div>
      <p>{early?.language||"Primary language"} · Candidate {early?.letter||"?"}
        {" · "}{early?.passed||0} passing executable tests</p>
      {early?.complexity&&<p>Preliminary Big-O claim: {early.complexity} (not independently audited yet)</p>}
      <p className="progressive-result-note">
        This version passed the generated E2B test cases and initial complexity screening.
        {processing
          ? "Other solvers and independent complexity judges are still working. The Council may replace this code with a stronger verified solution."
          : "The Council did not finish its final decision. This provisional code is not an authoritative final answer."}
      </p>
      <details open>
        <summary>Show provisional {early?.language||"source"} code</summary>
        <pre className="progressive-result-code">{early?.code}</pre>
      </details>
    </>}

    {primaryReady&&<>
      <div className="progressive-result-heading">
        <strong>{upgraded?"Council upgraded the solution":"Council-selected verified solution"}</strong>
        <span className="badge" data-tone="good">Final E2B-verified winner</span>
      </div>
      <p>{primary?.language||"Primary language"} · Candidate {details.winner||report.winner||"?"}</p>
      {primary?.complexity&&<p>Reviewed complexity: {primary.complexity}</p>}
      {upgraded&&<>
        <p className="progressive-result-note">
          Provisional Candidate {details.upgrade?.from} was replaced by Council-selected
          Candidate {details.upgrade?.to}. The previous code is preserved below.
        </p>
        <details open className="council-upgrade-diff">
          <summary>What changed? View GitHub-style code diff</summary>
          <div className="council-diff-header">
            <span className="council-diff-removed-label">− Removed from provisional</span>
            <span className="council-diff-added-label">+ Added by final Council winner</span>
          </div>
          <div className="council-diff-lines" role="region" aria-label="Provisional to final code changes">
            {diff.map((line,index)=><div key={index} className="council-diff-line"
              data-kind={line.kind}>
              <span className="council-diff-number">{line.beforeLine??""}</span>
              <span className="council-diff-number">{line.afterLine??""}</span>
              <span className="council-diff-marker">
                {line.kind==="removed"?"−":line.kind==="added"?"+":" "}
              </span>
              <code>{line.text||" "}</code>
            </div>)}
          </div>
        </details>
        {details.upgrade?.reason&&<p className="progressive-result-note">
          Council decision: {details.upgrade.reason}
        </p>}
      </>}
      {earlyReady&&<details>
        <summary>{upgraded?"View previous provisional version":"View earlier provisional evidence"}</summary>
        <pre className="progressive-result-code">{early?.code}</pre>
      </details>}
      <details open>
        <summary>Copy the final {primary?.language||"primary"} code</summary>
        <pre className="progressive-result-code">{primary?.code}</pre>
      </details>
      {details.semanticBlueprint?.brief&&<details>
        <summary>How the verified code works — English translation guide</summary>
        <p>This supports language translation; it is not a separate proof of correctness.</p>
        <pre className="progressive-result-brief">{details.semanticBlueprint.brief}</pre>
      </details>}
    </>}

    {ports.length>0&&<div className="progressive-result-ports">
      <strong>Other language versions</strong>
      <p>{processing?"Translations are still being prepared and tested.":"Language verification finished."}</p>
      {ports.map(port=>{
        const accepted=port.status==="verified"&&Boolean(port.code);
        const rejected=port.status==="failed";
        return <details key={port.language||"unknown"}>
          <summary>{port.language||"Unknown language"} — {accepted?"E2B verified":rejected?"Not verified":"Preparing"}</summary>
          {accepted
            ? <>
                <pre className="progressive-result-code">{port.code}</pre>
                <p>{port.run?.passed??0} executable tests passed
                  {typeof port.run?.remoteElapsedMs==="number" && Number.isFinite(port.run.remoteElapsedMs)
                    ?" · Measured execution "+port.run?.remoteElapsedMs+" ms":""}
                </p>
              </>
            :rejected?<p>{port.error||"Failed independent verification."}</p>
              :<p>Awaiting independent translation and sandbox tests.</p>}
        </details>;
      })}
      <p className="progressive-result-note">
        Python, Rust and C++ execution times cannot be fairly ranked without equivalent controlled benchmarks.
      </p>
    </div>}
  </div>;
}
