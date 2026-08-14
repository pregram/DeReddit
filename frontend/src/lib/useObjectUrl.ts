// src/lib/useObjectUrl.ts - Pairs a File (or File[]) with its blob: preview
// URL(s), created/revoked from the same setter the caller wires up to a
// FileInput's onChange - never from a render-time computation (disallowed
// by this repo's eslint-plugin-react-hooks config, which forbids reading or
// writing refs during render) and never from an effect that calls setState
// (flagged as a cascading-render anti-pattern by the same config). Driving
// URL.createObjectURL/revokeObjectURL from the change handler means it only
// ever runs once per actual file change, with no Strict Mode double-create.

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tracks a single file alongside its blob: preview URL.
 * @returns the current file, its preview URL (or null), and the setter to wire up to a FileInput's onChange
 */
export function useFilePreview(): {
  file: File | null;
  preview: string | null;
  setFile: (file: File | null) => void;
} {
  const [file, setFileState] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);

  const setFile = useCallback((next: File | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const url = next ? URL.createObjectURL(next) : null;
    previewRef.current = url;
    setPreview(url);
    setFileState(next);
  }, []);

  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  return { file, preview, setFile };
}

/**
 * Same as {@link useFilePreview} but for multiple files.
 * @returns the current files, their preview URLs, and the setter to wire up to a FileInput's onChange
 */
export function useFilesPreview(): {
  files: File[];
  previews: string[];
  setFiles: (files: File[]) => void;
} {
  const [files, setFilesState] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const previewsRef = useRef<string[]>([]);

  const setFiles = useCallback((next: File[]) => {
    previewsRef.current.forEach((url) => URL.revokeObjectURL(url));
    const urls = next.map((f) => URL.createObjectURL(f));
    previewsRef.current = urls;
    setPreviews(urls);
    setFilesState(next);
  }, []);

  useEffect(() => () => {
    previewsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  return { files, previews, setFiles };
}
