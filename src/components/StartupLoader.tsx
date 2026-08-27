"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

/**
 * StartupLoader: user-friendly, animated launch screen.
 *
 * Replaces the blank dark screen while the application checks credentials,
 * database connectivity, and workspace readiness.
 */
export default function StartupLoader() {
  const [dots, setDots] = useState("");
  const [hintIndex, setHintIndex] = useState(0);

  const hints = [
    "Starting Council Editor",
    "Connecting workspace",
    "Preparing models and council",
    "Readying tools and environment",
  ];

  useEffect(() => {
    const dTimer = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? "" : prev + "."));
    }, 450);
    const hTimer = setInterval(() => {
      setHintIndex((prev) => (prev + 1) % hints.length);
    }, 2200);

    return () => {
      clearInterval(dTimer);
      clearInterval(hTimer);
    };
  }, [hints.length]);

  return (
    <div className="startup-screen" role="status" aria-live="polite">
      <div className="startup-ambient-glow" aria-hidden="true" />
      <div className="startup-card">
        <div className="startup-icon-wrapper">
          <Image
            src="/icon.png"
            alt="Council Editor"
            width={76}
            height={76}
            className="startup-icon"
            priority
          />
          <div className="startup-ring" aria-hidden="true" />
        </div>

        <h1 className="startup-title">Council Editor</h1>
        <p className="startup-subtitle">
          Independent multi-model solving, testing, and consensus
        </p>

        <div className="startup-status-box">
          <span className="startup-spinner" aria-hidden="true" />
          <span className="startup-status-text">
            {hints[hintIndex]}
            <span className="startup-dots">{dots}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
