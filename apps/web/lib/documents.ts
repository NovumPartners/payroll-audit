/** Text from a Box document for the profile builder: PDF (unpdf), Word (mammoth), or plain text. null when unreadable. */
export async function readDocumentText(bytes: Uint8Array, name: string): Promise<string | null> {
  const lower = name.toLowerCase();
  try {
    if (lower.endsWith(".pdf")) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(bytes);
      const { text } = await extractText(pdf, { mergePages: true });
      return text.trim() || null;
    }
    if (lower.endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return value.trim() || null;
    }
    if (/\.(txt|md|csv)$/.test(lower)) return new TextDecoder("utf-8").decode(bytes).trim() || null;
  } catch {
    return null;
  }
  return null;
}
