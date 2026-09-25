export const SUPPORTED_EXTENSIONS = [".jsonl", ".ndjson"] as const;

export type UploadValidationInput = {
  filename: string | null | undefined;
  content: string;
  maxBytes: number;
};

export type UploadValidation = { ok: true } | { ok: false; message: string };

/**
 * Validate an uploaded knowledge file before parsing.
 *
 * Enforces a supported machine-readable format (JSONL/NDJSON by extension),
 * rejects empty files, and rejects files over the configured size limit — each
 * with a clear message. These are the Uploader input-validation acceptance
 * criteria (supported format, empty file, oversized file).
 */
export function validateUpload(input: UploadValidationInput): UploadValidation {
  const { filename, content, maxBytes } = input;

  if (!filename || filename.trim().length === 0) {
    return { ok: false, message: "A filename is required." };
  }

  const lower = filename.toLowerCase();
  const hasSupportedExt = SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  if (!hasSupportedExt) {
    return {
      ok: false,
      message: `Unsupported file format. Supported formats: ${SUPPORTED_EXTENSIONS.join(", ")}.`
    };
  }

  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength === 0 || content.trim().length === 0) {
    return { ok: false, message: "The uploaded file is empty." };
  }

  if (byteLength > maxBytes) {
    const maxMb = (maxBytes / (1024 * 1024)).toFixed(1);
    return { ok: false, message: `File exceeds the maximum allowed size of ${maxMb} MB.` };
  }

  return { ok: true };
}

export function maxUploadBytes(): number {
  const mb = Number(process.env.KB_MAX_UPLOAD_MB ?? 5);
  const safe = Number.isFinite(mb) && mb > 0 ? mb : 5;
  return Math.floor(safe * 1024 * 1024);
}
