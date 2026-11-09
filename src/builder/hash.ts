// A Build's hash, which the Workspace makes before asking the Builder for a
// Build, so a Build of the same files is reused without sending them.
import packedTailwind from "../generated/tailwind.txt";
import { bundlingVersion, type FileSource } from "./bundling";

/** The platform's one Tailwind (ADR 0007), whose version goes into every Build's hash. */
export const tailwindVersion = (JSON.parse(packedTailwind) as { version: string }).version;

/**
 * SHA-256 of the version parts, then each path and its text in path order,
 * all joined by NUL characters. It's fed to the digest a megabyte at a time,
 * so the files are never all in memory at once (#87).
 */
export async function hashOf(files: FileSource): Promise<string> {
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  const encoder = new TextEncoder();
  // The same files make a different Build after a Tailwind upgrade, or a change to how they're bundled.
  let pieces = [`tailwindcss ${tailwindVersion}`, `\0bundling ${bundlingVersion}`];
  let size = 0;
  for (const path of [...files.paths()].sort()) {
    const text = files.read(path) ?? "";
    pieces.push("\0", path, "\0", text);
    size += path.length + text.length;
    if (size >= 1 << 20) {
      await writer.write(encoder.encode(pieces.join("")));
      pieces = [];
      size = 0;
    }
  }
  await writer.write(encoder.encode(pieces.join("")));
  await writer.close();
  return [...new Uint8Array(await digest.digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
