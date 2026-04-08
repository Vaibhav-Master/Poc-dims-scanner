"use client";

import { useState, useRef, useEffect } from "react";

interface ScannedPage {
  id: string;
  dataUrl: string;
}

interface ElectronAPI {
  getScanners: () => Promise<string[]>;
  scanDocument: (deviceName: string) => Promise<string>;
  uploadPdf: (data: {
    pdfBytes: Uint8Array;
    scanId: string;
    returnUrl: string;
  }) => Promise<{ success: boolean; path: string }>;
  onScanStart: (
    callback: (data: { scanId: string; returnUrl: string }) => void
  ) => void;
  removeScanStartListener: () => void;
  getPendingDeepLink: () => Promise<{ scanId: string; returnUrl: string } | null>;
}

interface DeepLinkScan {
  scanId: string;
  returnUrl: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export default function DocumentScanner() {
  const [pages, setPages] = useState<ScannedPage[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [scanning, setScanning] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanners, setScanners] = useState<string[]>([]);
  const [selectedScanner, setSelectedScanner] = useState<string>("");
  const [loadingScanners, setLoadingScanners] = useState(false);
  const [deepLinkScan, setDeepLinkScan] = useState<DeepLinkScan | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  // Listen for deep-link scan requests via push (IPC send) AND pull (polling)
  useEffect(() => {
    if (!window.electronAPI) return;

    // Method 1: Push — main process sends scan:start event
    if (window.electronAPI.onScanStart) {
      window.electronAPI.onScanStart((data) => {
        console.log("[DeepLink] Received via push:", data);
        setDeepLinkScan(data);
        setUploadSuccess(false);
      });
    }

    // Method 2: Pull — poll for pending deep links every 1 second (fallback)
    const pollInterval = setInterval(async () => {
      try {
        const data = await window.electronAPI!.getPendingDeepLink();
        if (data) {
          console.log("[DeepLink] Received via pull:", data);
          setDeepLinkScan(data);
          setUploadSuccess(false);
        }
      } catch {
        // IPC not ready yet
      }
    }, 1000);

    return () => {
      clearInterval(pollInterval);
      window.electronAPI?.removeScanStartListener?.();
    };
  }, []);

  useEffect(() => {
    async function fetchScanners() {
      if (!window.electronAPI) {
        setError("This app must be run inside the Electron desktop shell.");
        return;
      }
      setLoadingScanners(true);
      try {
        const devices = await window.electronAPI.getScanners();
        const unique = [...new Set<string>(devices)];
        setScanners(unique);
        if (unique.length > 0) {
          setSelectedScanner(unique[0]);
        }
      } catch {
        // Electron IPC not ready yet — user can retry
      } finally {
        setLoadingScanners(false);
      }
    }
    fetchScanners();
  }, []);

  async function handleScan() {
    if (!window.electronAPI) return;
    setScanning(true);
    setError(null);
    try {
      const dataUrl = await window.electronAPI.scanDocument(selectedScanner);
      const newPage: ScannedPage = { id: crypto.randomUUID(), dataUrl };
      setPages((prev) => {
        const next = [...prev, newPage];
        setActiveIndex(next.length - 1);
        return next;
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  function handleDelete(index: number) {
    setPages((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (activeIndex >= next.length) {
        setActiveIndex(Math.max(0, next.length - 1));
      } else if (index < activeIndex) {
        setActiveIndex((a) => a - 1);
      }
      return next;
    });
  }

  async function handleCompileAndUpload() {
    if (pages.length === 0) return;
    setCompiling(true);
    setError(null);
    try {
      const { PDFDocument } = await import("pdf-lib");
      const pdfDoc = await PDFDocument.create();

      for (const page of pages) {
        const imageBytes = dataUrlToUint8Array(page.dataUrl);
        const image = await pdfDoc.embedPng(imageBytes);
        const pdfPage = pdfDoc.addPage([image.width, image.height]);
        pdfPage.drawImage(image, {
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
        });
      }

      const pdfBytes = await pdfDoc.save();

      // If triggered via deep link, upload to the web app instead of downloading
      if (deepLinkScan && window.electronAPI?.uploadPdf) {
        await window.electronAPI.uploadPdf({
          pdfBytes: pdfBytes,
          scanId: deepLinkScan.scanId,
          returnUrl: deepLinkScan.returnUrl,
        });
        setDeepLinkScan(null);
        setUploadSuccess(true);
      } else {
        // Default: trigger a local browser download
        const pdfBlob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" });
        const url = URL.createObjectURL(pdfBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `scan_${new Date().toISOString().slice(0, 10)}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "PDF compilation failed");
    } finally {
      setCompiling(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col">
      {/* Header */}
      <header className="border-b border-[#DAA520]/30 px-6 py-4">
        <h1 className="text-2xl font-bold text-[#DAA520]">Free Scan</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Document Scanner &mdash; Scan, review, and compile to PDF
        </p>
      </header>

      <div className="flex flex-col flex-1 p-6 gap-6">
        {/* Action buttons */}
        <div className="flex gap-4 items-center flex-wrap">
          <select
            value={selectedScanner}
            onChange={(e) => setSelectedScanner(e.target.value)}
            disabled={loadingScanners}
            className="px-4 py-3 bg-[#0a0a0a] border-2 border-[#DAA520] text-[#DAA520] font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-[#DAA520]/50 disabled:opacity-50 transition-colors min-w-[200px]"
          >
            {loadingScanners ? (
              <option value="">Loading scanners...</option>
            ) : scanners.length === 0 ? (
              <option value="">No scanners found</option>
            ) : (
              scanners.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))
            )}
          </select>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="px-6 py-3 bg-[#DAA520] text-black font-semibold rounded-lg hover:bg-[#c4951a] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {scanning ? "Scanning..." : "Scan Page"}
          </button>
          <button
            onClick={handleCompileAndUpload}
            disabled={pages.length === 0 || compiling}
            className="px-6 py-3 border-2 border-[#DAA520] text-[#DAA520] font-semibold rounded-lg hover:bg-[#DAA520]/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {compiling
              ? "Compiling..."
              : deepLinkScan
                ? `Upload to Web App (${pages.length} page${pages.length !== 1 ? "s" : ""})`
                : `Upload Document (${pages.length} page${pages.length !== 1 ? "s" : ""})`}
          </button>
        </div>

        {/* Deep link mode banner */}
        {deepLinkScan && (
          <div className="bg-blue-900/40 border border-blue-500/50 text-blue-300 px-4 py-2 rounded-lg text-sm">
            Scanning for web application &mdash; document will be uploaded automatically to the website.
          </div>
        )}

        {/* Upload success banner */}
        {uploadSuccess && (
          <div className="bg-green-900/40 border border-green-500/50 text-green-300 px-4 py-2 rounded-lg text-sm">
            Document uploaded successfully to the web application!
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="bg-red-900/40 border border-red-500/50 text-red-300 px-4 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* Thumbnail strip */}
        {pages.length > 0 && (
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">
              Scanned Pages
            </h2>
            <div
              ref={stripRef}
              className="flex gap-3 overflow-x-auto pb-3 scrollbar-thin"
            >
              {pages.map((page, i) => (
                <div
                  key={page.id}
                  className="relative flex-shrink-0 cursor-pointer group"
                  onClick={() => setActiveIndex(i)}
                >
                  <div
                    className={`w-24 h-32 rounded-lg overflow-hidden border-2 transition-colors ${
                      i === activeIndex
                        ? "border-[#DAA520] shadow-[0_0_12px_rgba(218,165,32,0.3)]"
                        : "border-zinc-700 hover:border-zinc-500"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={page.dataUrl}
                      alt={`Page ${i + 1}`}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <span className="absolute bottom-1 left-1 text-[10px] bg-black/70 text-zinc-300 px-1.5 py-0.5 rounded">
                    {i + 1}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(i);
                    }}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-600 hover:bg-red-500 text-white text-xs rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Remove page"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Main preview */}
        <div className="flex-1 flex items-center justify-center border-2 border-dashed border-zinc-700 rounded-xl min-h-[400px]">
          {pages.length === 0 ? (
            <div className="text-center text-zinc-500">
              <svg
                className="mx-auto mb-3 w-12 h-12 text-zinc-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M7 21h10a2 2 0 002-2V9l-5-5H7a2 2 0 00-2 2v13a2 2 0 002 2z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M14 4v4a1 1 0 001 1h4"
                />
              </svg>
              <p className="text-lg">No pages scanned yet</p>
              <p className="text-sm mt-1">Click &quot;Scan Page&quot; to begin</p>
            </div>
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={pages[activeIndex]?.dataUrl}
              alt={`Page ${activeIndex + 1}`}
              className="max-h-[60vh] max-w-full object-contain rounded-lg"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── helpers ── */

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
