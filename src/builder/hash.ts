// A Build's hash, which the Workspace makes before asking the Builder for a
// Build, so a Build of the same files is reused without sending them.
import packedTailwind from "../generated/tailwind.txt";
import { bundlingVersion, type FileSource } from "./bundling";

/** The platform's one Tailwind (ADR 0007), whose version goes into every Build's hash. */
export const tailwindVersion = (JSON.parse(packedTailwind) as { version: string }).version;

/**
 * SHA-256 of the version parts, then each path and its text in path order,
 * all joined by NUL characters. A file that isn't text gives its bytes, which
 * aren't UTF-8, so they can't match any text's (#110). It's fed to the digest
 * a megabyte at a time, so the files are never all in memory at once (#87).
 */
export async function hashOf(files: FileSource): Promise<string> {
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  const encoder = new TextEncoder();
  // The same files make a different Build after a Tailwind upgrade, or a change to how they're bundled.
  let pieces = [`tailwindcss ${tailwindVersion}`, `\0bundling ${bundlingVersion}`];
  let size = 0;
  for (const path of [...files.paths()].sort()) {
    const content = files.read(path) ?? "";
    pieces.push("\0", path, "\0");
    if (typeof content === "string") pieces.push(content);
    size += path.length + content.length;
    if (size >= 1 << 20 || typeof content !== "string") {
      await writer.write(encoder.encode(pieces.join("")));
      if (typeof content !== "string") await writer.write(content);
      pieces = [];
      size = 0;
    }
  }
  await writer.write(encoder.encode(pieces.join("")));
  await writer.close();
  return [...new Uint8Array(await digest.digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
