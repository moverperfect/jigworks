import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { storeFiles } from "../src/files";

// The adapter between our Files interface and Think's file store. Unlike the
// platform's other tests, this one knows the store: it checks that the adapter
// reads the store's own encodings. It changes when the store does.
describe("storeFiles", () => {
  it("reads what Think's tools write, as text and as bytes, and hides attachments", async () => {
    const stub = env.WORKSPACES.getByName("files-adapter");
    // An async call starts Think's lifecycle, which the store needs for the object's name.
    await stub.exportFiles();
    await runInDurableObject(stub, async (instance, state) => {
      const store = instance.workspace;
      const files = storeFiles(store, state.storage);
      expect(files.list()).toEqual([]);

      const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
      await files.write("src/index.ts", "export {};\n");
      // Think's bash writes a file it changed back as bytes, which the store keeps as base64.
      await store.writeFileBytes("/src/edited.ts", new TextEncoder().encode("export const café = 1;\n"));
      await store.writeFileBytes("/public/logo.png", logo);
      await store.writeFile("/attachments/photo.txt", "a Conversation attachment");

      expect(files.list()).toEqual(["public/logo.png", "src/edited.ts", "src/index.ts"]);
      expect(files.readBytes("public/logo.png")).toEqual(logo);
      expect(files.read("src/edited.ts")).toBe("export const café = 1;\n");
      expect(files.snapshot().get("src/index.ts")).toBe("export {};\n");
      expect(files.bytes().get("public/logo.png")).toEqual(logo);
      expect(files.read("attachments/photo.txt")).toBeNull();
    });
  });

  it("puts the files and directories back as they were copied, leaving attachments as they are", async () => {
    const stub = env.WORKSPACES.getByName("files-copy");
    await stub.exportFiles();
    await runInDurableObject(stub, async (instance, state) => {
      const store = instance.workspace;
      const files = storeFiles(store, state.storage);
      const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
      await files.write("src/index.ts", "export {};\n");
      await store.writeFileBytes("/public/logo.png", logo);
      // An ordinary Workspace file, whose folder only differs in case from the hidden one.
      await files.write("Attachments/code.ts", "export {};\n");
      files.copyAside();

      await files.write("src/index.ts", "broken");
      await store.rm("/public", { recursive: true });
      await files.write("src/parts/new.ts", "export {};\n");
      await files.write("Attachments/code.ts", "broken");
      await files.write("Attachments/new.ts", "export {};\n");
      await store.writeFile("/attachments/photo.txt", "an attachment sent meanwhile");
      files.restoreCopy();

      expect(files.list()).toEqual(["Attachments/code.ts", "public/logo.png", "src/index.ts"]);
      expect(files.read("Attachments/code.ts")).toBe("export {};\n");
      expect(files.read("src/index.ts")).toBe("export {};\n");
      expect(files.readBytes("public/logo.png")).toEqual(logo);
      expect(await store.exists("/src/parts")).toBe(false);
      expect(await store.readFile("/attachments/photo.txt")).toBe("an attachment sent meanwhile");
    });
  });
});
