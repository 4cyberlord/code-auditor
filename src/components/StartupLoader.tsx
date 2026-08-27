"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

/**
 * StartupLoader: user-friendly, animated launch screen.
 *
 * Guaranteed vertical and horizontal centering across desktop webviews and browsers.
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
    <div
      className="startup-screen"
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg, #0b0d11)",
        color: "var(--text, #e7ebf0)",
        zIndex: 99999,
        overflow: "hidden",
      }}
    >
      {/* Window drag handle across the top */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 38,
          zIndex: 10,
        }}
        data-tauri-drag-region
      />

      <div className="startup-ambient-glow" aria-hidden="true" />

      <div
        className="startup-card"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          margin: "auto",
          maxWidth: 480,
          width: "90%",
          background: "transparent",
          border: "none",
          boxShadow: "none",
        }}
      >
        <div className="startup-icon-wrapper">
          <Image
            src="/icon.png"
            alt="Council Editor"
            width={82}
            height={82}
            className="startup-icon"
            priority
          />
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
